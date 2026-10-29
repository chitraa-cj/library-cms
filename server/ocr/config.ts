/**
 * OCR feature knobs. OCR has exactly one engine: each page range is uploaded to
 * Gemini's web UI through Hermex, on the dedicated document profile OCR → Grantha
 * also uses (never translation's). No API key, no local OCR engine, no fallback.
 *
 * Every value is an env var with a safe default, so no limit is hard-coded at a
 * call site and a box can be tuned without a code change.
 */

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw == null || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export const ocrConfig = {
  /** Recorded on jobs and pages as the engine. */
  engineLabel: "hermex/gemini-web",

  /** Ceiling for one range's answer; each extra page in a range adds `perPageTimeoutMs`. */
  requestTimeoutMs: num("OCR_HERMEX_TIMEOUT_MS", 300_000, 60_000, 3_600_000),
  perPageTimeoutMs: num("OCR_HERMEX_PER_PAGE_TIMEOUT_MS", 120_000, 0, 900_000),
  /** Launching Chrome, checking the login and warming Gemini up. */
  launchTimeoutMs: num("OCR_HERMEX_LAUNCH_TIMEOUT_MS", 360_000, 30_000, 1_800_000),
  retryBaseDelayMs: num("OCR_HERMEX_RETRY_BASE_MS", 15_000, 250, 300_000),
  /** Wait after Gemini answers with its own error text ("Something went wrong"). */
  transientCooldownMs: num("OCR_HERMEX_TRANSIENT_COOLDOWN_MS", 60_000, 1_000, 600_000),

  /**
   * Pages per request (= per chunk row, the unit of retry and resume). 1 is the
   * safest: a bad answer costs one page, and a short prompt + one-page upload is the
   * least likely to time out or be cut off. Raise it for clean, simple books to
   * spend fewer requests; every page of a range must still come back, marked.
   */
  defaultChunkSize: num("OCR_CHUNK_SIZE", 1, 1, 10),
  maxChunkSize: num("OCR_MAX_CHUNK_SIZE", 5, 1, 20),

  /**
   * One browser on one profile: one range at a time, one job at a time. Parallel
   * requests on one Gemini session could interleave answers, so there is no knob.
   */
  concurrency: 1,
  maxActiveJobs: 1,

  /** Upload guards. */
  maxUploadBytes: num("OCR_MAX_UPLOAD_MB", 120, 1, 512) * 1024 * 1024,
  maxPages: num("OCR_MAX_PAGES", 1500, 1, 5000),

  /** Requests per range for an unusable answer or a recoverable browser error — bounded. */
  maxAttempts: num("OCR_MAX_ATTEMPTS", 3, 1, 6),

  /** A running job whose heartbeat is older than this is presumed dead and requeued. */
  staleAfterMs: num("OCR_STALE_AFTER_MS", 120_000, 15_000, 3_600_000),

  /** Where uploads live on disk (job id per folder). */
  storageDir: process.env.OCR_STORAGE_DIR?.trim() || "",

  /** Finished jobs (and their uploads) are swept after this many days. */
  retentionDays: num("OCR_RETENTION_DAYS", 30, 1, 365),
} as const;

/**
 * Formats Gemini's upload accepts. TIFF and HEIC are not: Hermex's Gemini upload
 * refuses them, and this server has no image converter (adding one only to change
 * formats is a new native dependency) — convert them to PDF or PNG before upload.
 */
export const OCR_SUPPORTED_MIME = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
