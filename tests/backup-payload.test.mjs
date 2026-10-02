/**
 * Snapshot payload format — regression tests.
 * ===========================================
 * `grantha_backups.data` was jsonb, and a jsonb value caps out at ~256 MB of content
 * (28-bit element offsets), which full-library snapshots passed in 2026-10. Chunking
 * across an array did not help — the cap is on the container's TOTAL — so the gzip
 * stream moved to the `data_gz` bytea column.
 *
 * What must keep holding:
 *   - a new payload round-trips as raw gzip bytes, multi-byte text included;
 *   - every older stored shape still reads, so old snapshots restore:
 *     the single-base64-string wrapper (backups #1–#27), the short-lived chunked
 *     wrapper, and the uncompressed rows older than either;
 *   - nothing is written back into a jsonb-bound shape.
 *
 * Run:  npm run test:backup-payload
 */
import assert from "node:assert";
import { gzipSync } from "node:zlib";
import {
  compressBackupData,
  decompressBackupData,
  decodeUtf8Buffer,
  isCompressedBackupPayload,
} from "../server/backup-payload.ts";

const payload = {
  timestamp: "2026-10-02T00:00:00.000Z",
  granthaCount: 1,
  granthas: [{ documentId: "g1", GranthaName: " Advaita Pañcaratnam" }],
  sections: [{ documentId: "s1", title: "अध्याय" }],
  manthras: [{ documentId: "m1", text: "ಕನ್ನಡ மொழி বাংলা" }],
};

// 1. Current format: raw gzip bytes, bound for a bytea column.
const packed = compressBackupData(payload);
assert.ok(Buffer.isBuffer(packed), "writes a Buffer, not a jsonb-bound object");
assert.ok(isCompressedBackupPayload(packed), "a Buffer is recognised as a payload");
assert.deepStrictEqual(decompressBackupData(packed), payload, "round-trip");

// 2. Backups #1–#27: one base64 string in the jsonb `data` column.
const legacySingle = {
  _compressed: true,
  data: gzipSync(Buffer.from(JSON.stringify(payload), "utf8")).toString("base64"),
};
assert.ok(isCompressedBackupPayload(legacySingle), "single-string wrapper recognised");
assert.deepStrictEqual(decompressBackupData(legacySingle), payload, "single-string round-trip");

// 3. The short-lived chunked wrapper (shipped 2026-10-02, never persisted — the
//    INSERT it was meant to fix failed on the container cap instead).
const gz = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
const chunked = { _compressed: true, chunks: [] };
for (let i = 0; i < gz.length; i += 9) {
  chunked.chunks.push(gz.subarray(i, Math.min(i + 9, gz.length)).toString("base64"));
}
assert.ok(chunked.chunks.length > 1, "test fixture actually spans several chunks");
assert.ok(isCompressedBackupPayload(chunked), "chunked wrapper recognised");
assert.deepStrictEqual(decompressBackupData(chunked), payload, "chunked round-trip");

// 4. Rows from before compression existed are returned untouched.
assert.deepStrictEqual(decompressBackupData(payload), payload, "uncompressed row passes through");
assert.ok(!isCompressedBackupPayload(payload), "uncompressed row is not mistaken for a payload");
assert.ok(!isCompressedBackupPayload(null), "null is not a payload");

// 5. decodeUtf8Buffer agrees with Buffer.toString on the sizes where both work.
const multibyte = Buffer.from("नाहं देहो ಕನ್ನಡ 日本語 ".repeat(5000), "utf8");
assert.strictEqual(decodeUtf8Buffer(multibyte), multibyte.toString("utf8"), "utf-8 decode parity");

console.log("backup-payload: all assertions passed");
