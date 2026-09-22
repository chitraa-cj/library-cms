/**
 * OCR feature knobs. Every limit here exists to keep Gemini usage moderate and
 * predictable: a single job can only ever issue `ceil(pages / chunkSize)`
 * requests, the whole server can only ever have OCR_CONCURRENCY requests in
 * flight, and the sliding-window/day budgets bound what a bad day can cost.
 */

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw == null || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export const ocrConfig = {
  /** Gemini API key. Without it the feature reports itself as unconfigured. */
  apiKey: (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim(),
  apiBase: (process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, ""),

  /**
   * Model per UI quality profile. Both default to the current Flash model:
   * "fast" runs it with thinking switched off, "accurate" leaves the model's
   * own thinking on. Point OCR_MODEL_ACCURATE at a Pro model if the key has
   * Pro quota — Pro is not available on every plan.
   */
  models: {
    fast: process.env.OCR_MODEL_FAST?.trim() || "gemini-3.8-flash",
    accurate: process.env.OCR_MODEL_ACCURATE?.trim() || "gemini-3.8-flash",
  } as const,

  /**
   * Models to fall back to when the chosen model is out of daily quota OR is
   * answering 503 "high demand". Gemini meters requests per project PER MODEL
   * and spreads capacity per model, so a second model is a separate bucket for
   * both. Each fallback costs at most one extra (immediately failing) request
   * per page range; set OCR_FALLBACK_MODELS="" to disable.
   *
   * Keep only models the key can actually call: a retired one (e.g.
   * gemini-2.5-flash-lite, 404 "no longer available to new users") wastes a
   * request per range. `script/ocr-probe-models.mts` checks the list.
   */
  fallbackModels: (process.env.OCR_FALLBACK_MODELS ?? "gemini-3.5-flash,gemini-3.1-flash-lite")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean),

  /** Pages per request. Small chunks = more parallelism; large = fewer requests. */
  defaultChunkSize: num("OCR_CHUNK_SIZE", 8, 1, 30),
  maxChunkSize: num("OCR_MAX_CHUNK_SIZE", 30, 1, 50),

  /** Requests in flight across the whole process (all jobs, all users). */
  concurrency: num("OCR_CONCURRENCY", 4, 1, 12),
  /** Jobs actually being worked on at once; the rest wait in `queued`. */
  maxActiveJobs: num("OCR_MAX_ACTIVE_JOBS", 2, 1, 6),

  /**
   * Sliding-window request cap and hard daily cap (moderate by default).
   * Keep the per-minute value BELOW the API key's own per-minute quota — the
   * free tier allows 20/min for flash models and answers 429 the moment a
   * retry pushes past it. 12 leaves room for retries, which count too.
   */
  requestsPerMinute: num("OCR_REQUESTS_PER_MINUTE", 12, 1, 120),
  requestsPerDay: num("OCR_REQUESTS_PER_DAY", 1500, 10, 50_000),

  /** Upload guards. */
  maxUploadBytes: num("OCR_MAX_UPLOAD_MB", 120, 1, 512) * 1024 * 1024,
  maxPages: num("OCR_MAX_PAGES", 1500, 1, 5000),
  /** A single inline request payload Gemini will accept comfortably. */
  maxChunkBytes: num("OCR_MAX_CHUNK_MB", 14, 1, 18) * 1024 * 1024,

  /** Per-chunk retry policy — bounded, never a loop. */
  maxAttempts: num("OCR_MAX_ATTEMPTS", 4, 1, 6),
  retryBaseDelayMs: num("OCR_RETRY_BASE_MS", 2000, 250, 30_000),
  requestTimeoutMs: num("OCR_REQUEST_TIMEOUT_MS", 180_000, 10_000, 600_000),

  /** Where uploads live on disk (job id per folder). */
  storageDir: process.env.OCR_STORAGE_DIR?.trim() || "",

  /** Finished jobs (and their uploads) are swept after this many days. */
  retentionDays: num("OCR_RETENTION_DAYS", 30, 1, 365),
} as const;

export const OCR_SUPPORTED_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export function isOcrConfigured(): boolean {
  return ocrConfig.apiKey.length > 0;
}
