/**
 * How a full-library snapshot is packed into the `grantha_backups.data` jsonb column.
 *
 * Shared by the portal (server/routes.ts) and the one-off restore/compare scripts in
 * script/, so every reader understands every writer. Keep it that way: a script that
 * re-implements the unwrap by hand silently stops working the next time the format
 * grows a wrapper.
 *
 * TWO SIZE CEILINGS bound this file, and snapshots have now hit both:
 *
 *   1. Postgres stores each STRING inside a jsonb value with a 28-bit length, so a
 *      single string may not exceed 2^28-1 bytes (~256 MB) — past that the INSERT
 *      fails with "string too long to represent as jsonb string". One base64 blob
 *      crossed that line in 2026-10 (it was already 230 MB on 2026-09-19, and the
 *      library grew from 30.5k to 41k manthras), which is why the payload is now
 *      split across `chunks` instead of a single `data` string.
 *   2. V8 caps any one string at 0x1fffffe8 units, which `Buffer.toString()` checks
 *      against the buffer's BYTE length — see decodeUtf8Buffer.
 *
 * Both wrapper shapes are readable. Only the chunked one is written.
 */
import { gzipSync, gunzipSync } from "node:zlib";
import { StringDecoder } from "node:string_decoder";

/**
 * Bytes of gzip per chunk, encoded independently. A multiple of 3 so each chunk is a
 * whole number of base64 groups and the concatenation of the encoded chunks equals
 * the base64 of the whole buffer. 48 MB of gzip encodes to a 64 MB string — a quarter
 * of the jsonb ceiling, so the format has room before it needs revisiting.
 */
const CHUNK_BYTES = 48 * 1024 * 1024;

export interface CompressedBackupPayload {
  _compressed: true;
  /** Base64 of consecutive gzip slices; concatenating them yields the whole stream. */
  chunks: string[];
}

/** Compress a snapshot payload for DB storage (gzip + chunked base64 wrapper). */
export function compressBackupData(data: any): CompressedBackupPayload {
  const jsonStr = JSON.stringify(data);
  const compressed = gzipSync(Buffer.from(jsonStr, "utf8"), { level: 6 });
  const chunks: string[] = [];
  for (let i = 0; i < compressed.length; i += CHUNK_BYTES) {
    chunks.push(compressed.subarray(i, Math.min(i + CHUNK_BYTES, compressed.length)).toString("base64"));
  }
  return { _compressed: true, chunks };
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

/** True for either compressed wrapper shape — chunked (current) or single-string (pre-2026-10). */
export function isCompressedBackupPayload(raw: any): boolean {
  if (!raw || raw._compressed !== true) return false;
  return Array.isArray(raw.chunks) || typeof raw.data === "string";
}

/** Gzip bytes out of either wrapper shape. */
function gzipBufferFromPayload(raw: any): Buffer {
  if (Array.isArray(raw.chunks)) {
    return Buffer.concat(raw.chunks.map((c: string) => Buffer.from(c, "base64")));
  }
  return Buffer.from(raw.data, "base64");
}

/** Decompress a snapshot payload returned from DB — handles chunked, single-string and legacy raw. */
export function decompressBackupData(raw: any): any {
  if (isCompressedBackupPayload(raw)) {
    return JSON.parse(decodeUtf8Buffer(gunzipSync(gzipBufferFromPayload(raw))));
  }
  return raw; // legacy uncompressed backups
}
