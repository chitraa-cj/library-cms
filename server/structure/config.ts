/**
 * Knobs for the Claude-powered structure analysis. Mirrors server/ocr/config.ts:
 * every value is an env var with a sane default, so no limit is hard-coded at a call
 * site and a box can be tuned without a code change.
 *
 * The caps exist for the same reason the OCR ones do: one job can only ever issue
 * `ceil(pages / pagesPerChunk)` requests, the whole process can only ever have
 * `concurrency` requests in flight, and the per-minute/per-day windows bound what a bad
 * day can cost.
 */

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw == null || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return fallback;
}

export const structureConfig = {
  /** Claude API key. Without it the feature reports itself as unconfigured. */
  apiKey: (process.env.ANTHROPIC_API_KEY || "").trim(),
  /** Only set this to point at a gateway/proxy; the SDK's default is the public API. */
  baseUrl: process.env.ANTHROPIC_BASE_URL?.trim() || "",

  /**
   * One place for the model name. Claude Opus 5 is the default because the work is
   * exactly what it is good at — reading a page of Sanskrit and deciding what each
   * passage *is* — and a wrong classification costs an editor far more than the token
   * difference. Point STRUCTURE_MODEL at a cheaper model for bulk runs.
   */
  model: process.env.STRUCTURE_MODEL?.trim() || "claude-opus-5",

  /**
   * Thinking depth. `high` is the default; `low`/`medium` are worth trying on cleanly
   * printed, regularly numbered books, where the classification is nearly mechanical.
   */
  effort: (() => {
    const raw = process.env.STRUCTURE_EFFORT?.trim().toLowerCase();
    return raw === "low" || raw === "medium" || raw === "high" || raw === "xhigh" || raw === "max"
      ? (raw as "low" | "medium" | "high" | "xhigh" | "max")
      : ("high" as const);
  })(),

  /** OCR pages per Claude request, and the character ceiling that overrides it. */
  pagesPerChunk: num("STRUCTURE_PAGES_PER_CHUNK", 10, 1, 60),
  maxCharsPerChunk: num("STRUCTURE_MAX_CHARS_PER_CHUNK", 60_000, 4_000, 400_000),
  /** Tail of the previous range sent as read-only context, so a split verse still joins. */
  carryOverChars: num("STRUCTURE_CARRY_OVER_CHARS", 1_500, 0, 20_000),

  /** Output ceiling per request. Items carry the source text, so this has to be generous. */
  maxOutputTokens: num("STRUCTURE_MAX_OUTPUT_TOKENS", 32_000, 4_000, 64_000),

  /** Requests in flight across the whole process (all jobs, all users). */
  concurrency: num("STRUCTURE_CONCURRENCY", 2, 1, 8),
  /** Jobs actually being worked on at once; the rest wait in `queued`. */
  maxActiveJobs: num("STRUCTURE_MAX_ACTIVE_JOBS", 1, 1, 4),

  /** Sliding-window and hard daily caps on requests. */
  requestsPerMinute: num("STRUCTURE_REQUESTS_PER_MINUTE", 20, 1, 200),
  requestsPerDay: num("STRUCTURE_REQUESTS_PER_DAY", 800, 10, 20_000),

  /** Per-chunk retry policy — bounded, never a loop. */
  maxAttempts: num("STRUCTURE_MAX_ATTEMPTS", 3, 1, 6),
  retryBaseDelayMs: num("STRUCTURE_RETRY_BASE_MS", 2_000, 250, 60_000),
  requestTimeoutMs: num("STRUCTURE_REQUEST_TIMEOUT_MS", 600_000, 30_000, 1_800_000),

  /** Guard on how much document one job may analyse. */
  maxPages: num("STRUCTURE_MAX_PAGES", 1_500, 1, 5_000),
  /** Characters of editor instructions passed to the model. */
  maxInstructionChars: num("STRUCTURE_MAX_INSTRUCTION_CHARS", 8_000, 200, 40_000),

  /**
   * Below this, a classified passage is treated as uncertain: flagged in the review and
   * counted in the intervention metrics. Calibrate against labelled documents
   * (`script/structure-accuracy.ts`) rather than guessing.
   */
  confidenceThreshold: (() => {
    const raw = Number(process.env.STRUCTURE_CONFIDENCE_THRESHOLD);
    return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.7;
  })(),

  /** Cache the stable prompt prefix (rules + hierarchy + instructions) across ranges. */
  promptCaching: bool("STRUCTURE_PROMPT_CACHING", true),
} as const;

export function isStructureConfigured(): boolean {
  return structureConfig.apiKey.length > 0;
}

/** Max characters of a provider error we persist — keeps rows small and logs clean. */
export const STRUCTURE_ERROR_MAX = 1_000;

/**
 * Error text reaches Postgres and the admin UI, so it must never carry a credential.
 * The SDK quotes request context on some failures; redact before persisting.
 */
export function sanitizeStructureError(input: unknown): string {
  const raw = input instanceof Error ? input.message : String(input ?? "Unknown error");
  return raw
    .replace(/sk-ant-[A-Za-z0-9_\-]+/g, "[redacted]")
    .replace(/([?&](?:access_)?(?:token|key|auth|password|secret)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(x-api-key|authorization|bearer)\b\s*[:=]\s*\S+/gi, "$1 [redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    .slice(0, STRUCTURE_ERROR_MAX);
}
