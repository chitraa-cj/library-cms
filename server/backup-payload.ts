/**
 * How a full-library snapshot is packed into `grantha_backups`.
 *
 * Shared by the portal (server/routes.ts) and the one-off restore/compare scripts in
 * script/, so every reader understands every writer. Keep it that way: a script that
 * re-implements the unwrap by hand silently stops working the next time the format
 * changes.
 *
 * WHY THE PAYLOAD LEFT jsonb. Postgres addresses the elements of a jsonb container
 * with a 28-bit offset, so the TOTAL content of any one jsonb value is capped at
 * 268,435,455 bytes (~256 MB):
 *
 *   - one oversized string → "string too long to represent as jsonb string"
 *   - an oversized container → "total size of jsonb array elements exceeds the
 *     maximum of 268435455 bytes"
 *
 * Splitting the payload across an array does NOT get past this — the cap is on the
 * container's total, not on each element, and nesting only moves the sum up a level.
 * Snapshots crossed the line in 2026-10 (230 MB of base64 at 30,521 manthras on
 * 2026-09-19; 41,014 manthras by 2026-10-02), so the gzip stream now goes to the
 * `data_gz` bytea column — a plain varlena, 1 GB, and no base64 inflation on the way.
 *
 * Every older shape is still READ, so snapshots taken before the move still restore:
 *   Buffer                                raw gzip in data_gz        (current)
 *   { _compressed: true, chunks: [...] }  chunked base64 in data     (2026-10, never
 *                                                                     persisted — the
 *                                                                     INSERT failed)
 *   { _compressed: true, data: "<b64>" }  single base64 in data      (backups #1–#27)
 *   plain object                          uncompressed in data       (oldest)
 *
 * The remaining ceiling is V8's, not Postgres's: `JSON.stringify` of the snapshot and
 * the UTF-8 decode on the way back both have to fit in one string (0x1fffffe8 units).
 * decodeUtf8Buffer below handles the read side; the write side is still a single
 * stringify and will need a streaming encoder before the library roughly doubles again.
 */
import { gzipSync, gunzipSync } from "node:zlib";
import { StringDecoder } from "node:string_decoder";

/** Compress a snapshot payload for storage in `grantha_backups.data_gz`. */
export function compressBackupData(data: any): Buffer {
  const jsonStr = JSON.stringify(data);
  return gzipSync(Buffer.from(jsonStr, "utf8"), { level: 6 });
}

/**
 * Decode a UTF-8 Buffer to a string, chunk by chunk.
 *
 * `Buffer.prototype.toString("utf8")` (and TextDecoder) throw
 * `Cannot create a string longer than 0x1fffffe8 characters` whenever the
 * buffer's BYTE length exceeds V8's max string length — a conservative
 * pre-check that fires even when the DECODED string would fit (multi-byte
 * text such as Devanagari collapses to far fewer UTF-16 code units than
 * bytes). Large snapshots (e.g. a 576 MB buffer that decodes to only ~362 M
 * code units) tripped this and became unreadable. Decoding via a streaming
 * StringDecoder only ever materializes the final (in-limit) string, so it
 * succeeds where a single toString() cannot.
 */
export function decodeUtf8Buffer(buf: Buffer): string {
  // Fast path: small buffers can't exceed the limit — decode directly.
  const MAX_SAFE_BYTES = 0x1fffffe8; // V8 kStringMaxLength
  if (buf.length <= MAX_SAFE_BYTES) return buf.toString("utf8");
  const decoder = new StringDecoder("utf8");
  const CHUNK = 64 * 1024 * 1024; // 64 MB
  const parts: string[] = [];
  for (let i = 0; i < buf.length; i += CHUNK) {
    parts.push(decoder.write(buf.subarray(i, Math.min(i + CHUNK, buf.length))));
  }
  parts.push(decoder.end());
  return parts.join("");
}

/** True for anything holding a gzipped snapshot — a bytea Buffer or either jsonb wrapper. */
export function isCompressedBackupPayload(raw: any): boolean {
  if (Buffer.isBuffer(raw)) return true;
  if (!raw || raw._compressed !== true) return false;
  return Array.isArray(raw.chunks) || typeof raw.data === "string";
}

/** Gzip bytes out of any stored shape. */
function gzipBufferFromPayload(raw: any): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw.chunks)) {
    return Buffer.concat(raw.chunks.map((c: string) => Buffer.from(c, "base64")));
  }
  return Buffer.from(raw.data, "base64");
}

/** Decompress a stored snapshot payload. Uncompressed legacy rows pass straight through. */
export function decompressBackupData(raw: any): any {
  if (isCompressedBackupPayload(raw)) {
    return JSON.parse(decodeUtf8Buffer(gunzipSync(gzipBufferFromPayload(raw))));
  }
  return raw; // legacy uncompressed backups
}
