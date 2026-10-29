/**
 * PDF page accounting (pdf-lib, pure JS) and range planning. Page text and page
 * images come from poppler (`local-engine.ts`), which reads pages straight from
 * the stored original — the upload is never sliced, copied or rewritten.
 */
import { PDFDocument } from "pdf-lib";

export class OcrPdfError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "OcrPdfError";
  }
}

export async function readPdfPageCount(bytes: Uint8Array): Promise<number> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return doc.getPageCount();
  } catch (err: any) {
    throw new OcrPdfError(
      `Could not read this PDF (${err?.message || "unknown error"}). If it is password-protected, remove the password and upload again.`,
    );
  }
}

/** Split a page count into inclusive 1-based ranges of at most `chunkSize`. */
export function planChunks(pageCount: number, chunkSize: number): Array<{ startPage: number; endPage: number }> {
  const size = Math.max(1, chunkSize);
  const chunks: Array<{ startPage: number; endPage: number }> = [];
  for (let start = 1; start <= pageCount; start += size) {
    chunks.push({ startPage: start, endPage: Math.min(pageCount, start + size - 1) });
  }
  return chunks;
}
