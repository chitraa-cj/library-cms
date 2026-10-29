/**
 * The contract between the OCR job runner and the engine (`hermex-engine.ts`):
 * what a transcribed range looks like, how a failure is classified, and the
 * progress events the live view shows.
 *
 * Output keeps the `<<<PAGE:n>>>` marker format the rest of the OCR feature (the
 * merger, the viewer, the structure step) reads.
 */
import path from "node:path";
import type { OcrPageMeta } from "@shared/ocr-quality";

export type OcrFailureKind =
  /** Hermex cannot work here (not logged in, no display, profile held): stop the job. */
  | "engine_unavailable"
  /** This input cannot be prepared (corrupt page). Retrying will not help. */
  | "bad_input"
  /** Ran out of attempts on something that might work later (timeouts, unusable answers). */
  | "transient"
  | "cancelled";

export class OcrTranscribeError extends Error {
  readonly kind: OcrFailureKind;
  readonly page: number | null;
  readonly attempts: number;
  constructor(kind: OcrFailureKind, message: string, opts: { page?: number | null; attempts?: number } = {}) {
    super(message);
    this.name = "OcrTranscribeError";
    this.kind = kind;
    this.page = opts.page ?? null;
    this.attempts = opts.attempts ?? 1;
  }
  get fatal(): boolean {
    return this.kind === "engine_unavailable";
  }
}

export type OcrRangeProgress =
  | { kind: "page"; page: number; attempt: number }
  | { kind: "backoff"; page: number; attempt: number; delayMs: number; error: string };

export interface TranscribeRangeResult {
  /** Normalized text with page markers — what is shown and analysed. */
  markdown: string;
  /** The answer's page texts as received, with page markers — kept for comparison. */
  raw: string;
  pages: OcrPageMeta[];
  /** Requests spent on the range, retries included. */
  attempts: number;
  engine: string;
}

export function workDirFor(jobDir: string, chunkIndex: number): string {
  return path.join(jobDir, `work-${chunkIndex}`);
}
