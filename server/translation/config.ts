/**
 * Translation-queue knobs. Every value is an env var with a sane default, so
 * nothing here is hard-coded at a call site. Mirrors server/ocr/config.ts.
 *
 * Jobs here run for days: a single grantha is thousands of mantras and each
 * mantra is one (or several) Gemini web round-trips through Hermex. The defaults
 * therefore favour "slow and survivable" over throughput.
 */

import { hermexHeadless } from "../hermex/config";

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw == null || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export const translationConfig = {
  /** Attempts per item before it is parked as `failed` (admin can still retry). */
  maxRetries: num("MAX_TRANSLATION_RETRIES", 3, 1, 10),

  /**
   * Hard ceiling for ONE item (one mantra, all its fields and languages). A long
   * teeka across 43 languages legitimately takes well over an hour, hence the
   * generous default. Hermex's own per-subprocess timeout is
   * HERMEX_TRANSLATE_TIMEOUT_MS and should stay BELOW this.
   */
  itemTimeoutMs: num("TRANSLATION_TIMEOUT", 2 * 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),

  /** How long the worker sleeps when the queue is empty. */
  pollIntervalMs: num("WORKER_POLL_INTERVAL", 15_000, 1_000, 10 * 60 * 1000),

  /** Pause between items — keeps the Gemini web session from looking abusive. */
  itemDelayMs: num("TRANSLATION_ITEM_DELAY_MS", 5_000, 0, 10 * 60 * 1000),

  /**
   * A claimed item's lease. The worker renews it every `leaseHeartbeatMs`; if the
   * process dies, the lease lapses and the reaper requeues the item. Must be
   * comfortably longer than the heartbeat and shorter than itemTimeoutMs.
   */
  leaseMs: num("TRANSLATION_LEASE_MS", 15 * 60 * 1000, 60_000, 6 * 60 * 60 * 1000),
  leaseHeartbeatMs: num("TRANSLATION_LEASE_HEARTBEAT_MS", 60_000, 5_000, 30 * 60 * 1000),

  /** Backoff before a requeued item becomes eligible again, per attempt made. */
  retryBackoffMs: num("TRANSLATION_RETRY_BACKOFF_MS", 60_000, 0, 60 * 60 * 1000),

  /** Guard on job size so one request cannot enqueue an unbounded list. */
  maxItemsPerJob: num("TRANSLATION_MAX_ITEMS_PER_JOB", 20_000, 1, 200_000),

  /** Rows per INSERT when creating a job's items. */
  insertBatchSize: num("TRANSLATION_INSERT_BATCH", 500, 50, 5_000),

  /** Hermex chunking, passed straight through to the existing runner. */
  chunkSize: num("HERMEX_CHUNK_SIZE", 3, 1, 10),
  chunkDelayMs: num("HERMEX_CHUNK_DELAY_MS", 8_000, 0, 10 * 60 * 1000),
  hermexMaxRetries: num("HERMEX_MAX_RETRIES", 3, 1, 10),

  /**
   * Headless or headful?
   *
   * Delegated to the Hermex config so there is ONE answer per host: under Xvfb on
   * EC2 the browser is headful on the virtual display (the mode proven on that
   * box), and a host with no display runs headless. TRANSLATION_WORKER_HEADLESS
   * still wins when it is set explicitly.
   */
  headless: (() => {
    const explicit = process.env.TRANSLATION_WORKER_HEADLESS?.trim().toLowerCase();
    if (explicit === "false" || explicit === "0" || explicit === "no") return false;
    if (explicit === "true" || explicit === "1" || explicit === "yes") return true;
    return hermexHeadless();
  })(),

  /**
   * Pass 1 — translate the Sanskrit original to English for any field that has
   * no English yet, before fanning English out to the other languages.
   *
   * On by default: without it a mantra that was entered with only its Sanskrit
   * is silently skipped forever, because every other language is translated
   * *from* English. Set TRANSLATION_ENGLISH_FIRST_PASS=0 to go back to
   * English-source-only (useful if the generated English must be reviewed by a
   * human before it becomes the source for 42 languages).
   */
  englishFirstPass: (() => {
    const raw = process.env.TRANSLATION_ENGLISH_FIRST_PASS?.trim().toLowerCase();
    if (raw === "false" || raw === "0" || raw === "no") return false;
    return true;
  })(),

  /** Identifies this worker in item leases and logs. */
  workerId:
    process.env.TRANSLATION_WORKER_ID?.trim() ||
    `worker-${process.pid}@${process.env.HOSTNAME || "local"}`,
} as const;

/** Max characters of a provider error we persist — keeps rows small, logs clean. */
export const TRANSLATION_ERROR_MAX = 1000;

/**
 * Error text is shown to admins and stored in Postgres, so it must never carry a
 * credential. Hermex failures quote browser/driver chatter that can include the
 * profile path or a URL with a token, so redact before persisting.
 */
export function sanitizeTranslationError(input: unknown): string {
  const raw = input instanceof Error ? input.message : String(input ?? "Unknown error");
  const redacted = raw
    // Query-string secrets: ?token=..., &key=..., access_token=...
    .replace(/([?&](?:access_)?(?:token|key|auth|password|secret|sid)=)[^&\s]+/gi, "$1[redacted]")
    // Bearer / cookie-ish blobs
    .replace(/\b(bearer|cookie|set-cookie|authorization)\b\s*[:=]\s*\S+/gi, "$1 [redacted]")
    // Anything that looks like a long opaque token
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    // Home directory of the browser profile
    .replace(/\/(?:home|Users)\/[^/\s]+/g, "~");
  return redacted.slice(0, TRANSLATION_ERROR_MAX);
}
