/**
 * Knobs for the OCR → Grantha structure analysis, which runs through Hermex on a
 * DEDICATED Gemini profile (server/hermex/task-profiles.ts) — never translation's
 * account, never an API key. Mirrors server/ocr/config.ts: every value is an env var
 * with a sane default.
 *
 * There is no money here any more: the web UI has no per-token bill. What remains are
 * the request caps, which protect the dedicated account's own web quota, and the
 * timeouts that keep a stuck browser from holding a job forever.
 */
import { structureHermexAvailability } from "../hermex/task-profiles";

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw == null || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export const structureConfig = {
  /** Shown on jobs and in the UI; not a provider model id. */
  model: "hermex/gemini-web",

  /**
   * Pages and characters of OCR text per request. Kept small on purpose: Gemini's web
   * UI refuses large prompts from the EC2 box (docs/HERMEX.md), and the answer is a
   * list of line spans, so small ranges cost little extra.
   */
  pagesPerChunk: num("STRUCTURE_PAGES_PER_CHUNK", 3, 1, 30),
  maxCharsPerChunk: num("STRUCTURE_MAX_CHARS_PER_CHUNK", 5_000, 1_000, 60_000),
  /** Tail of the previous range sent as read-only context. */
  carryOverChars: num("STRUCTURE_CARRY_OVER_CHARS", 600, 0, 5_000),

  /** One browser per dedicated profile: one document at a time, one request at a time. */
  maxActiveJobs: num("STRUCTURE_MAX_ACTIVE_JOBS", 1, 1, 1),

  /** Rolling-minute and UTC-day request caps on the dedicated account. */
  requestsPerMinute: num("STRUCTURE_REQUESTS_PER_MINUTE", 4, 1, 60),
  requestsPerDay: num("STRUCTURE_REQUESTS_PER_DAY", 300, 10, 5_000),
  /** Hard request ceiling for one document. */
  maxRequestsPerJob: num("STRUCTURE_MAX_REQUESTS_PER_JOB", 600, 1, 10_000),

  /** Per-range retry policy — bounded, never a loop. */
  maxAttempts: num("STRUCTURE_MAX_ATTEMPTS", 3, 1, 6),
  retryBaseDelayMs: num("STRUCTURE_RETRY_BASE_MS", 5_000, 250, 120_000),
  /**
   * Cool-down after Gemini's canned "something went wrong" reply. Measured on the box:
   * 10s failed where 60s succeeded (docs/HERMEX.md) — do not lower it.
   */
  transientCooldownMs: num("STRUCTURE_TRANSIENT_COOLDOWN_MS", 60_000, 1_000, 600_000),
  /** One request's ceiling, Node side (the Python side times out first). */
  requestTimeoutMs: num("STRUCTURE_REQUEST_TIMEOUT_MS", 900_000, 60_000, 3_600_000),
  /** Browser launch + login check + warm-up. */
  launchTimeoutMs: num("STRUCTURE_LAUNCH_TIMEOUT_MS", 360_000, 30_000, 1_800_000),
  /** A running job whose heartbeat is older than this is presumed dead and requeued. */
  staleAfterMs: num("STRUCTURE_STALE_AFTER_MS", 300_000, 30_000, 3_600_000),

  /** Guard on how much document one job may analyse. */
  maxPages: num("STRUCTURE_MAX_PAGES", 1_500, 1, 5_000),
  /** Characters of editor instructions passed to the model. */
  maxInstructionChars: num("STRUCTURE_MAX_INSTRUCTION_CHARS", 4_000, 200, 20_000),

  /**
   * Below this, a classified passage is flagged as uncertain. Items whose number or
   * commentary name was not found printed are capped at `inferredConfidenceCap`, so
   * they always fall below it.
   */
  confidenceThreshold: (() => {
    const raw = Number(process.env.STRUCTURE_CONFIDENCE_THRESHOLD);
    return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.7;
  })(),
  inferredConfidenceCap: 0.5,
} as const;

export function isStructureConfigured(): boolean {
  return structureHermexAvailability().ok;
}

/** Max characters of an error we persist — keeps rows small and logs clean. */
export const STRUCTURE_ERROR_MAX = 1_000;

/**
 * Error text reaches Postgres and the admin UI, so it must never carry a credential
 * or a server path.
 */
export function sanitizeStructureError(input: unknown): string {
  const raw = input instanceof Error ? input.message : String(input ?? "Unknown error");
  return raw
    .replace(/sk-ant-[A-Za-z0-9_\-]+/g, "[redacted]")
    .replace(/([?&](?:access_)?(?:token|key|auth|password|secret)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(x-api-key|authorization|bearer|cookie)\b\s*[:=]\s*\S+/gi, "$1 [redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    .replace(/\/(?:home|Users)\/[^/\s]+/g, "~")
    .slice(0, STRUCTURE_ERROR_MAX);
}
