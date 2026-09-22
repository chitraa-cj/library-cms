/**
 * PDF page accounting and page-range extraction (pdf-lib, pure JS — no native
 * deps, so it builds the same on macOS dev and the EC2 box).
 *
 * The source document is loaded once per job run and each chunk is materialised
 * as a small standalone PDF holding only its page range, so a Gemini request
 * carries ~8 pages instead of the whole 400-page file.
 */
import { PDFDocument } from "pdf-lib";
import { ocrConfig } from "./config";

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

/** A lazily-loaded source document that can hand out page-range slices. */
export class PdfSlicer {
  private constructor(private readonly doc: PDFDocument) {}

  static async load(bytes: Uint8Array): Promise<PdfSlicer> {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return new PdfSlicer(doc);
  }

  get pageCount(): number {
    return this.doc.getPageCount();
  }

  /** Extract pages [startPage, endPage] (1-based, inclusive) as its own PDF. */
  async slice(startPage: number, endPage: number): Promise<Uint8Array> {
    const total = this.doc.getPageCount();
    const from = Math.max(1, startPage);
    const to = Math.min(total, endPage);
    if (from > to) throw new OcrPdfError(`Invalid page range ${startPage}-${endPage} for a ${total}-page document.`);

    const out = await PDFDocument.create();
    const indices = Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
    const pages = await out.copyPages(this.doc, indices);
    for (const page of pages) out.addPage(page);
    return out.save({ useObjectStreams: true });
  }
}

/**
 * Pick pages-per-request so the produced slice stays inside the inline-request
 * budget. Uses the observed average page weight with a 1.6x safety factor
 * (scanned pages vary a lot) — one calculation, no probing loop.
 */
export function fitChunkSize(requested: number, fileSize: number, pageCount: number): number {
  const ceiling = Math.min(Math.max(1, requested), ocrConfig.maxChunkSize);
  if (pageCount <= 1 || fileSize <= 0) return 1;
  const avgPageBytes = (fileSize / pageCount) * 1.6;
  const byBytes = Math.floor(ocrConfig.maxChunkBytes / Math.max(avgPageBytes, 1));
  return Math.max(1, Math.min(ceiling, byBytes || 1));
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
