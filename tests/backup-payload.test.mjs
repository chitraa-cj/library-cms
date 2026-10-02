/**
 * Snapshot payload format — regression tests.
 * ===========================================
 * `grantha_backups.data` used to hold ONE base64 string, which Postgres refused
 * once it passed its per-string jsonb ceiling (~256 MB): "string too long to
 * represent as jsonb string". Snapshots now write an array of chunks instead.
 *
 * What must keep holding:
 *   - a new payload round-trips, multi-byte text included;
 *   - every snapshot taken before 2026-10 (single `data` string) still reads,
 *     and so do the truly uncompressed rows older than that;
 *   - the identity the chunking leans on — base64 of 3-aligned slices,
 *     concatenated, is base64 of the whole buffer — so CHUNK_BYTES can change
 *     without rewriting stored snapshots.
 *
 * Run:  npm run test:backup-payload
 */
import assert from "node:assert";
import { gzipSync } from "node:zlib";
import {
  compressBackupData,
  decompressBackupData,
  isCompressedBackupPayload,
} from "../server/backup-payload.ts";

const payload = {
  timestamp: "2026-10-02T00:00:00.000Z",
  granthaCount: 1,
  granthas: [{ documentId: "g1", GranthaName: " Advaita Pañcaratnam" }],
  sections: [{ documentId: "s1", title: "अध्याय" }],
  manthras: [{ documentId: "m1", text: "ಕನ್ನಡ மொழி বাংলা" }],
};

// 1. Current format round-trips.
const packed = compressBackupData(payload);
assert.ok(Array.isArray(packed.chunks) && packed.chunks.length >= 1, "writes a chunks array");
assert.ok(!("data" in packed), "no single-string field is written any more");
assert.ok(isCompressedBackupPayload(packed), "current wrapper is recognised");
assert.deepStrictEqual(decompressBackupData(packed), payload, "round-trip");

// 2. Snapshots written before the chunking (ids 1–5) must still open.
const legacyCompressed = {
  _compressed: true,
  data: gzipSync(Buffer.from(JSON.stringify(payload), "utf8")).toString("base64"),
};
assert.ok(isCompressedBackupPayload(legacyCompressed), "pre-2026-10 wrapper is recognised");
assert.deepStrictEqual(decompressBackupData(legacyCompressed), payload, "pre-2026-10 round-trip");

// 3. Rows from before compression existed are returned untouched.
assert.deepStrictEqual(decompressBackupData(payload), payload, "uncompressed row passes through");
assert.ok(!isCompressedBackupPayload(payload), "uncompressed row is not mistaken for a wrapper");
assert.ok(!isCompressedBackupPayload(null), "null is not a wrapper");

// 4. Chunk boundaries must stay base64-group aligned.
const buf = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
for (const n of [3, 48, 300, 999]) {
  const parts = [];
  for (let i = 0; i < buf.length; i += n) {
    parts.push(buf.subarray(i, Math.min(i + n, buf.length)).toString("base64"));
  }
  assert.strictEqual(parts.join(""), buf.toString("base64"), `slice identity at ${n} bytes`);
  assert.ok(
    Buffer.concat(parts.map((p) => Buffer.from(p, "base64"))).equals(buf),
    `concat-decode at ${n} bytes`,
  );
}

console.log("backup-payload: all assertions passed");
