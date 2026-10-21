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

import type { StructureCostRates } from "@shared/ocr-structure";

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw == null || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function money(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw == null || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
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
   * Workspace for an API key that is not itself scoped to one.
   *
   * An organisation-level key carries no workspace, and the Messages API then refuses
   * every request with a 400: "This API key is not scoped to a workspace, so this request
   * must include the anthropic-workspace-id header". Setting this sends that header; a
   * workspace-scoped key needs nothing here and should leave it empty.
   */
  workspaceId: (process.env.ANTHROPIC_WORKSPACE_ID || "").trim(),

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

  /**
   * Sliding-window and hard daily caps on REQUESTS. These bound the burst rate; they do
   * not bound cost, because one request can carry 60k input and 32k output tokens. The
   * spend caps below are what bound the bill.
   */
  requestsPerMinute: num("STRUCTURE_REQUESTS_PER_MINUTE", 20, 1, 200),
  requestsPerDay: num("STRUCTURE_REQUESTS_PER_DAY", 800, 10, 20_000),

  /**
   * Prices per million tokens, used for BOTH the pre-flight estimate and the spend caps.
   * They are env vars rather than constants so that pointing STRUCTURE_MODEL at a
   * different model cannot leave the portal quoting a stale price: change the model,
   * change these. Defaults are Claude Opus 5 list prices (input $5, output $25, cache
   * reads 0.1x, cache writes 1.25x).
   */
  inputPricePer1M: money("STRUCTURE_PRICE_INPUT_PER_1M", 5, 0, 1_000),
  outputPricePer1M: money("STRUCTURE_PRICE_OUTPUT_PER_1M", 25, 0, 1_000),
  cacheReadPricePer1M: money("STRUCTURE_PRICE_CACHE_READ_PER_1M", 0.5, 0, 1_000),
  cacheWritePricePer1M: money("STRUCTURE_PRICE_CACHE_WRITE_PER_1M", 6.25, 0, 1_000),

  /** Estimator assumptions — pessimistic on purpose (see estimateStructureCost). */
  charsPerToken: money("STRUCTURE_CHARS_PER_TOKEN", 2.5, 0.5, 10),
  promptOverheadTokens: num("STRUCTURE_PROMPT_OVERHEAD_TOKENS", 1_800, 200, 20_000),
  outputRatio: money("STRUCTURE_OUTPUT_RATIO", 1.35, 0.2, 5),

  /**
   * The money gates. Spend is measured from the token counters the API itself returns,
   * summed over `cms_structure_jobs`, so a restart cannot hand out a fresh budget and a
   * runaway job cannot hide behind a request count.
   *
   * The defaults are sized against real books at Opus 5 list prices, measured with the
   * estimator rather than guessed:
   *
   *   100 pages ≈ 10 requests ≈ $6     300 pages ≈ 30 requests ≈ $23
   *   800 pages ≈ 80 requests ≈ $62
   *
   * So: one large grantha per job, two per day, and a month that cannot quietly become
   * four figures. Set any of them to 0 to disable that gate entirely (not recommended).
   *
   * The cheapest real lever is not these caps but STRUCTURE_EFFORT (low/medium on
   * cleanly printed, regularly numbered books) and STRUCTURE_MODEL — Claude Sonnet 5 is
   * roughly 2.5x cheaper per token than Opus. Change the model and change the prices
   * above with it.
   */
  maxSpendPerDayUsd: money("STRUCTURE_MAX_SPEND_PER_DAY_USD", 60, 0, 10_000),
  maxSpendPerMonthUsd: money("STRUCTURE_MAX_SPEND_PER_MONTH_USD", 400, 0, 100_000),
  /** One document may never cost more than this, however the day budget looks. */
  maxSpendPerJobUsd: money("STRUCTURE_MAX_SPEND_PER_JOB_USD", 30, 0, 5_000),
  /** Belt to the spend braces: a hard request ceiling for one document. */
  maxRequestsPerJob: num("STRUCTURE_MAX_REQUESTS_PER_JOB", 200, 1, 5_000),

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

/** The configured prices and estimator assumptions, in the shape the estimator takes. */
export function structureRates(): StructureCostRates {
  return {
    inputPer1M: structureConfig.inputPricePer1M,
    outputPer1M: structureConfig.outputPricePer1M,
    cacheReadPer1M: structureConfig.cacheReadPricePer1M,
    cacheWritePer1M: structureConfig.cacheWritePricePer1M,
    charsPerToken: structureConfig.charsPerToken,
    promptOverheadTokens: structureConfig.promptOverheadTokens,
    outputRatio: structureConfig.outputRatio,
  };
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
