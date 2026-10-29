/**
 * The contract between the structure job runner and whatever classifies a page
 * range. The runner (jobs.ts) depends only on this; the Hermex implementation lives
 * in hermex-analyzer.ts and tests substitute their own.
 */
import type { StructureHierarchyConfig, StructureItem } from "@shared/ocr-structure";

export type StructureProgressEvent =
  | { kind: "attempt"; attempt: number }
  | { kind: "backoff"; attempt: number; delayMs: number; error: string };

export interface StructureChunkRequest {
  /** OCR pages in this range, in order. */
  pages: Array<{ page: number; markdown: string }>;
  startPage: number;
  endPage: number;
  totalPages: number;
  chunkIndex: number;
  config: StructureHierarchyConfig;
  /** The editor's structuring instructions (typed and/or dictated). */
  instructions?: string | null;
  analysisWindow?: { from: number; to: number } | null;
  /** Tail of the previous range, as read-only context. */
  carryOverText?: string | null;
  /** Section path still open when the previous range ended. */
  openPath?: Array<{ level: number; number: string; title: string }> | null;
  /** Teeka names already seen in this document. */
  knownTeekaNames?: string[];
  onProgress?: (event: StructureProgressEvent) => void;
  signal?: AbortSignal;
}

export interface StructureChunkResult {
  items: StructureItem[];
  warnings: string[];
  rejected: number;
  unclassifiedLines: number;
  openPath: Array<{ level: number; number: string; title: string }> | undefined;
  /** Requests actually sent, retries included. */
  attempts: number;
  /** What answered, e.g. "hermex/gemini-web". */
  model: string;
}

/**
 * Error taxonomy:
 *   fatal      about this server's setup (no login, no display, engine missing) — every
 *              range would fail the same way, so the runner stops the job; ranges stay
 *              queued for Retry;
 *   retryable  transient (timeout, browser died, Gemini's canned error reply);
 *   neither    about this range (answer unusable after its retries) — the range fails.
 */
export class StructureAnalysisError extends Error {
  readonly retryable: boolean;
  readonly fatal: boolean;
  attempts: number;
  constructor(message: string, opts: { retryable?: boolean; fatal?: boolean; attempts?: number } = {}) {
    super(message);
    this.name = "StructureAnalysisError";
    this.retryable = Boolean(opts.retryable);
    this.fatal = Boolean(opts.fatal);
    this.attempts = opts.attempts ?? 1;
  }
}

export interface StructureAnalyzer {
  readonly label: string;
  analyse(req: StructureChunkRequest): Promise<StructureChunkResult>;
  /** Release the runtime (browser session). Safe to call twice. */
  close(): Promise<void>;
}
