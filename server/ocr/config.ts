/**
 * OCR feature knobs. Transcription is fully local: embedded PDF text via poppler
 * (`pdftotext`), page images via poppler (`pdftoppm`), and recognition via
 * Tesseract. No AI provider, API key or network call is involved, so the limits
 * here are about CPU and memory on the box, not about anyone's quota.
 *
 * Every value is an env var with a safe default, so no limit is hard-coded at a
 * call site and a box can be tuned without a code change.
 */
import os from "node:os";

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw == null || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function str(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

/** Leave one core for the web app itself; never more than four OCR lanes by default. */
const defaultLanes = Math.max(1, Math.min(4, os.cpus().length - 1));

export const ocrConfig = {
  /** Binaries. Bare names resolve on PATH; set absolute paths when they are elsewhere. */
  binaries: {
    tesseract: str("OCR_TESSERACT_BIN", "tesseract"),
    pdftotext: str("OCR_PDFTOTEXT_BIN", "pdftotext"),
    pdftoppm: str("OCR_PDFTOPPM_BIN", "pdftoppm"),
  },
  /**
   * Tesseract's traineddata directory. Empty = Tesseract's own default (which is
   * where the Ubuntu `tesseract-ocr-*` packages install). Set it when the language
   * files live elsewhere, e.g. a Homebrew install split across two directories.
   */
  tessdataDir: process.env.OCR_TESSDATA_DIR?.trim() || "",

  /**
   * Tesseract language sets, chosen per page from the script Tesseract's own OSD
   * detects. Measured on Devanagari and IAST fixtures (docs/OCR.md, "Accuracy"):
   * `san` alone beats every combination on Devanagari pages, while `script/Latin`
   * is the only installed model that keeps most IAST diacritics (`eng` drops them
   * all while reporting high confidence). The fallback set is tried when the
   * detected script's own set comes back below `acceptConfidence`.
   */
  languages: {
    devanagari: str("OCR_LANGS_DEVANAGARI", "san"),
    latin: str("OCR_LANGS_LATIN", "script/Latin"),
    fallback: str("OCR_LANGS_FALLBACK", "san+script/Latin"),
  },

  /** Render resolution for scanned pages, per UI quality profile. */
  dpi: {
    fast: num("OCR_DPI_FAST", 200, 100, 600),
    accurate: num("OCR_DPI_ACCURATE", 300, 100, 600),
  } as const,

  /**
   * Confidence thresholds (Tesseract word confidence, 0–100, weighted by word
   * length). Calibrated on synthetic fixtures only: a clean Devanagari page with
   * ~2% character error averaged ~68, the same page read with the wrong model ~17.
   * Re-calibrate on real scans before trusting them as more than review hints.
   */
  acceptConfidence: num("OCR_ACCEPT_CONFIDENCE", 60, 0, 100),
  lowPageConfidence: num("OCR_LOW_PAGE_CONFIDENCE", 55, 0, 100),
  lowWordConfidence: num("OCR_LOW_WORD_CONFIDENCE", 30, 0, 100),

  /** Pages per chunk row. 1 = every page is its own unit of work, retry and resume. */
  defaultChunkSize: num("OCR_CHUNK_SIZE", 1, 1, 30),
  maxChunkSize: num("OCR_MAX_CHUNK_SIZE", 10, 1, 50),

  /** Page ranges processed at once across the whole process (each is one Tesseract run at a time). */
  concurrency: num("OCR_CONCURRENCY", defaultLanes, 1, 16),
  /** Jobs actually being worked on at once; the rest wait in `queued`. */
  maxActiveJobs: num("OCR_MAX_ACTIVE_JOBS", 2, 1, 6),
  /** `nice` level for OCR child processes, so a long book never starves the web app or translation. */
  niceLevel: num("OCR_NICE", 10, 0, 19),

  /** Upload guards. */
  maxUploadBytes: num("OCR_MAX_UPLOAD_MB", 120, 1, 512) * 1024 * 1024,
  maxPages: num("OCR_MAX_PAGES", 1500, 1, 5000),

  /** Per-chunk retry policy for transient failures (a child killed by the OS, a timeout) — bounded. */
  maxAttempts: num("OCR_MAX_ATTEMPTS", 3, 1, 6),
  retryBaseDelayMs: num("OCR_RETRY_BASE_MS", 1000, 100, 30_000),
  /** Ceiling for one external process (one page render, one recognition). */
  processTimeoutMs: num("OCR_PROCESS_TIMEOUT_MS", 120_000, 5_000, 900_000),

  /** A running job whose heartbeat is older than this is presumed dead and requeued. */
  staleAfterMs: num("OCR_STALE_AFTER_MS", 120_000, 15_000, 3_600_000),

  /** Where uploads live on disk (job id per folder). */
  storageDir: process.env.OCR_STORAGE_DIR?.trim() || "",

  /** Finished jobs (and their uploads) are swept after this many days. */
  retentionDays: num("OCR_RETENTION_DAYS", 30, 1, 365),
} as const;

/**
 * Formats the local engine can read. HEIC/HEIF are not accepted: neither poppler
 * nor Tesseract decodes them, and silently converting would add a dependency.
 */
export const OCR_SUPPORTED_MIME = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/tiff"]);
