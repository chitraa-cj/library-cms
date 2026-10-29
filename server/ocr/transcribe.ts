/**
 * Transcribe one chunk row's page range with the local engine.
 *
 * Pages are processed in order inside the range (the range is the unit of retry
 * and persistence; parallelism comes from running several ranges at once). Each
 * page gets its own bounded retry for transient failures — a Tesseract process
 * killed under memory pressure, a render that timed out — so one bad moment never
 * costs the other pages of the range.
 *
 * Output keeps the `<<<PAGE:n>>>` marker format the rest of the OCR feature (the
 * merger, the viewer, the structure step) already reads, so nothing downstream
 * needed to change when the engine did.
 */
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { OcrPageMeta } from "@shared/ocr-quality";
import { ProcessError } from "../lib/run-process";
import { processPage, type PageEngineDeps, type PageEngineSettings } from "./engine";
import { formatPageMarker } from "./pages";

export type OcrFailureKind =
  /** Engine not installed / misconfigured: every page would fail — stop the job. */
  | "engine_unavailable"
  /** This input cannot be read (corrupt page, unsupported image). Retrying will not help. */
  | "bad_input"
  /** Ran out of attempts on something that might work later (timeouts, killed processes). */
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

export interface TranscribeRangeRequest {
  sourcePath: string;
  mimeType: string;
  startPage: number;
  endPage: number;
  textMode: "auto" | "ocr";
  dpi: number;
  /** Scratch directory for page images; created and removed here. */
  workDir: string;
  deps: PageEngineDeps;
  settings: PageEngineSettings;
  maxAttempts: number;
  retryBaseDelayMs: number;
  onProgress?: (event: OcrRangeProgress) => void;
  signal?: AbortSignal;
}

export interface TranscribeRangeResult {
  /** Normalized text with page markers — what is shown and analysed. */
  markdown: string;
  /** Untouched engine output with page markers — kept for comparison and diagnosis. */
  raw: string;
  pages: OcrPageMeta[];
  /** Engine runs across the range, retries included. */
  attempts: number;
  engine: string;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new OcrTranscribeError("cancelled", "Cancelled."));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function classifyOcrFailure(err: unknown): OcrFailureKind {
  if (err instanceof OcrTranscribeError) return err.kind;
  if (err instanceof ProcessError) {
    if (err.kind === "cancelled") return "cancelled";
    if (err.kind === "missing") return "engine_unavailable";
    if (err.transient) return "transient";
    // Tesseract exits non-zero when a language set is not installed: configuration, not input.
    if (/Failed loading language|Error opening data file|tessdata/i.test(err.stderr || err.message)) {
      return "engine_unavailable";
    }
    return "bad_input";
  }
  return "bad_input";
}

export async function transcribeRange(req: TranscribeRangeRequest): Promise<TranscribeRangeResult> {
  const isPdf = req.mimeType === "application/pdf";
  const marked: string[] = [];
  const rawMarked: string[] = [];
  const metas: OcrPageMeta[] = [];
  let attempts = 0;
  let engine = "";

  await mkdir(req.workDir, { recursive: true });
  try {
    for (let page = req.startPage; page <= req.endPage; page++) {
      for (let attempt = 1; ; attempt++) {
        if (req.signal?.aborted) throw new OcrTranscribeError("cancelled", "Cancelled.");
        attempts++;
        req.onProgress?.({ kind: "page", page, attempt });
        try {
          const out = await processPage(
            isPdf ? { kind: "pdf", path: req.sourcePath, page } : { kind: "image", path: req.sourcePath, page },
            { textMode: req.textMode, dpi: req.dpi, workDir: req.workDir, signal: req.signal },
            req.deps,
            req.settings,
          );
          marked.push(formatPageMarker(page), out.text);
          rawMarked.push(formatPageMarker(page), out.raw);
          metas.push(out.meta);
          if (out.meta.source === "ocr" && !engine) engine = out.meta.engine.split(" (")[0];
          break;
        } catch (err: any) {
          const kind = classifyOcrFailure(err);
          if (kind === "cancelled") throw new OcrTranscribeError("cancelled", "Cancelled.", { page, attempts });
          if (kind !== "transient" || attempt >= req.maxAttempts) {
            const message = `Page ${page}: ${String(err?.message || err).slice(0, 400)}`;
            throw new OcrTranscribeError(kind, message, { page, attempts });
          }
          const delayMs =
            Math.min(req.retryBaseDelayMs * 2 ** (attempt - 1), 30_000) + Math.floor(Math.random() * 250);
          req.onProgress?.({ kind: "backoff", page, attempt, delayMs, error: String(err?.message || err) });
          await sleep(delayMs, req.signal);
        }
      }
    }
  } finally {
    await rm(req.workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    markdown: marked.join("\n"),
    raw: rawMarked.join("\n"),
    pages: metas,
    attempts,
    engine: engine || (metas.every((m) => m.source === "embedded") ? "pdftotext" : "local"),
  };
}

export function workDirFor(jobDir: string, chunkIndex: number): string {
  return path.join(jobDir, `work-${chunkIndex}`);
}
