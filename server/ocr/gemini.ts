/**
 * Minimal Gemini REST client for OCR. No SDK: one POST per page-range chunk,
 * the slice inlined as base64, plain-text Markdown back.
 *
 * Reliability rules that keep usage moderate:
 *   - temperature 0 and (on flash) thinking disabled — deterministic, cheap;
 *   - a hard request timeout so a hung call can't hold a concurrency slot;
 *   - retries ONLY for transient transport/quota errors, capped at
 *     `ocrConfig.maxAttempts`, with honour for the server's Retry-After;
 *   - a truncated answer (MAX_TOKENS) is a permanent failure for that chunk,
 *     never a retry — retrying identical input would burn quota for the same
 *     truncation. The UI asks for a smaller chunk size instead.
 */
import { ocrConfig } from "./config";

export interface OcrChunkRequest {
  bytes: Uint8Array;
  mimeType: string;
  model: string;
  startPage: number;
  endPage: number;
  totalPages: number;
  instructions?: string | null;
  /** Let the model think before transcribing (the "high accuracy" profile). */
  thinking?: boolean;
  /**
   * Called before every attempt after the first. A retry spends provider quota
   * exactly like a first attempt, so the caller books it against the rate
   * window instead of letting retries slip past the cap.
   */
  onRetryAttempt?: (attempt: number) => void;
  /** Live progress: an attempt is starting, or the call is sleeping out a transient error. */
  onProgress?: (event: OcrProgressEvent) => void;
  /**
   * Attempts to spend on a model that answers 503 (overloaded) before giving
   * up on it. The caller sets this below `maxAttempts` when fallback models
   * exist, so a busy model hands the range over instead of retrying into the
   * same wall four times.
   */
  overloadAttempts?: number;
  signal?: AbortSignal;
}

export type OcrProgressEvent =
  | { kind: "attempt"; attempt: number; model: string }
  | { kind: "backoff"; attempt: number; model: string; delayMs: number; error: string };

export interface OcrChunkResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  attempts: number;
}

export class OcrGeminiError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  /** The model's own daily quota is spent — another attempt on it cannot help. */
  quotaExhausted = false;
  /** The model answered 503 (high demand); a sibling model may have capacity. */
  overloaded = false;
  /** How many requests were actually spent before giving up (for usage accounting). */
  attempts = 1;
  constructor(message: string, opts: { retryable: boolean; status?: number; attempts?: number }) {
    super(message);
    this.name = "OcrGeminiError";
    this.retryable = opts.retryable;
    this.status = opts.status;
    if (opts.attempts) this.attempts = opts.attempts;
  }
}

const PAGE_MARKER = "<<<PAGE:";

function buildPrompt(req: OcrChunkRequest): string {
  const range =
    req.startPage === req.endPage
      ? `page ${req.startPage}`
      : `pages ${req.startPage}–${req.endPage}`;
  const extra = req.instructions?.trim()
    ? `\n\nDocument-specific notes from the editor (follow them):\n${req.instructions.trim()}`
    : "";

  return `You are a precise OCR engine. Transcribe the attached document excerpt, which is ${range} of a ${req.totalPages}-page document.

Rules:
1. Start every page with a marker line on its own: ${PAGE_MARKER}n>>> where n is the absolute page number in the full document. The first page of this excerpt is page ${req.startPage}; number consecutively from there.
2. Transcribe ALL visible text in reading order, exactly as printed. Never translate, transliterate, modernise, summarise, correct or comment.
3. Preserve the original scripts and diacritics exactly (Devanagari, IAST, Greek, etc.), including anusvara, visarga and vowel marks.
4. Use Markdown for structure: # / ## for headings by visual hierarchy, blank lines between paragraphs, - or 1. for lists, > for block quotations, | tables | for tabular layouts, --- for horizontal rules.
5. Keep verse line breaks as they appear; end a verse line with two spaces so the break survives.
6. Footnotes: transcribe them at the end of their page under a "---" rule, keeping their markers.
7. Figures/photographs with no text: write *[figure: short description]* on its own line.
8. Unreadable text: write [illegible] for the affected words only — never invent content.
9. Output the transcription only. No preamble, no explanation, no code fences around the whole answer.${extra}`;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Google returns its own wait hint as `error.details[].retryDelay: "26s"`. */
function parseGoogleRetryDelay(body: string): number | null {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? Math.min(seconds * 1000 + 500, 90_000) : null;
}

function retryDelayMs(
  attempt: number,
  opts: { retryAfterHeader?: string | null; body?: string; quota?: boolean } = {},
): number {
  const header = opts.retryAfterHeader ? Number(opts.retryAfterHeader) : NaN;
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 90_000);
  const hinted = opts.body ? parseGoogleRetryDelay(opts.body) : null;
  if (hinted != null) return hinted;
  // A 429 means the key's own per-minute quota is spent, and that window is up
  // to a minute long — backing off 2s would only burn another attempt.
  if (opts.quota) return Math.min(15_000 * attempt, 60_000) + Math.floor(Math.random() * 1000);
  // Transport/5xx: 2s, 4s, 8s … with jitter, capped.
  const base = ocrConfig.retryBaseDelayMs * 2 ** (attempt - 1);
  return Math.min(base, 30_000) + Math.floor(Math.random() * 500);
}

/**
 * Turn a Gemini error body into one readable sentence (these end up in the
 * chunk row and on screen) plus the quota ids that classify it.
 */
function describeApiError(res: Response, raw: string): { message: string; quotaIds: string } {
  let apiMessage = "";
  let quotaIds = "";
  try {
    const parsed = JSON.parse(raw);
    apiMessage = String(parsed?.error?.message ?? "");
    for (const detail of parsed?.error?.details ?? []) {
      for (const violation of detail?.violations ?? []) {
        if (violation?.quotaId) quotaIds += ` ${violation.quotaId}`;
        if (violation?.quotaValue) quotaIds += `=${violation.quotaValue}`;
      }
    }
  } catch {
    apiMessage = raw.slice(0, 300);
  }
  // Google's quota message carries a paragraph of links; the first sentence and
  // the advertised wait are the only parts an editor can act on.
  const firstLine = apiMessage.split("\n")[0].trim();
  const retryHint = /retry in ([\d.]+)s/i.exec(apiMessage);
  const quotaValue = /=(\d+)/.exec(quotaIds)?.[1];
  const suffix =
    res.status === 429
      ? ` (limit ${quotaValue ?? "?"}${/PerDay/i.test(quotaIds) ? "/day" : "/min"}${retryHint ? `, retry in ${Math.ceil(Number(retryHint[1]))}s` : ""})`
      : "";
  return {
    message: `Gemini ${res.status}: ${firstLine || res.statusText}${suffix}`.slice(0, 500),
    quotaIds,
  };
}

/** One Gemini call (plus bounded transient retries) for one page range. */
export async function ocrChunkWithGemini(req: OcrChunkRequest): Promise<OcrChunkResponse> {
  if (!ocrConfig.apiKey) {
    throw new OcrGeminiError("GEMINI_API_KEY is not set on the server.", { retryable: false });
  }
  if (req.bytes.byteLength > ocrConfig.maxChunkBytes) {
    throw new OcrGeminiError(
      `Page range ${req.startPage}-${req.endPage} is ${(req.bytes.byteLength / 1024 / 1024).toFixed(1)}MB, over the ${(ocrConfig.maxChunkBytes / 1024 / 1024).toFixed(0)}MB per-request limit. Re-run with a smaller chunk size.`,
      { retryable: false },
    );
  }

  const url = `${ocrConfig.apiBase}/models/${encodeURIComponent(req.model)}:generateContent`;
  const body: Record<string, unknown> = {
    contents: [
      {
        role: "user",
        parts: [
          { inline_data: { mime_type: req.mimeType, data: toBase64(req.bytes) } },
          { text: buildPrompt(req) },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      topP: 0.95,
      maxOutputTokens: 32768,
      responseMimeType: "text/plain",
      // Straight transcription needs no deliberation, and thinking tokens are
      // billed: the fast profile switches it off. The accurate profile leaves
      // the model's own default thinking in place (some models cannot disable
      // it, so nothing is sent rather than a value they would reject).
      ...(req.thinking ? {} : { thinkingConfig: { thinkingBudget: 0 } }),
    },
    safetySettings: [
      "HARM_CATEGORY_HARASSMENT",
      "HARM_CATEGORY_HATE_SPEECH",
      "HARM_CATEGORY_SEXUALLY_EXPLICIT",
      "HARM_CATEGORY_DANGEROUS_CONTENT",
    ].map((category) => ({ category, threshold: "BLOCK_NONE" })),
  };

  let lastError: OcrGeminiError | null = null;

  for (let attempt = 1; attempt <= ocrConfig.maxAttempts; attempt++) {
    if (attempt > 1) req.onRetryAttempt?.(attempt);
    req.onProgress?.({ kind: "attempt", attempt, model: req.model });
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), ocrConfig.requestTimeoutMs);
    const onOuterAbort = () => timeout.abort();
    req.signal?.addEventListener("abort", onOuterAbort, { once: true });

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": ocrConfig.apiKey },
        body: JSON.stringify(body),
        signal: timeout.signal,
      });

      if (!res.ok) {
        const raw = await res.text().catch(() => "");
        const { message, quotaIds } = describeApiError(res, raw);
        // A per-DAY quota does not refill in the next few seconds: retrying the
        // same model just spends attempts. Fail fast and let the caller move to
        // another model (a separate quota bucket) or stop.
        const dailyQuota = res.status === 429 && /PerDay/i.test(quotaIds || raw);
        const retryable = !dailyQuota && (res.status === 429 || res.status === 408 || res.status >= 500);
        lastError = new OcrGeminiError(message, { retryable, status: res.status, attempts: attempt });
        lastError.quotaExhausted = dailyQuota;
        lastError.overloaded = res.status === 503;
        const attemptCap = lastError.overloaded
          ? Math.min(ocrConfig.maxAttempts, Math.max(1, req.overloadAttempts ?? ocrConfig.maxAttempts))
          : ocrConfig.maxAttempts;
        if (!retryable || attempt >= attemptCap) throw lastError;
        const delayMs = retryDelayMs(attempt, {
          retryAfterHeader: res.headers.get("retry-after"),
          body: raw,
          quota: res.status === 429,
        });
        req.onProgress?.({ kind: "backoff", attempt, model: req.model, delayMs, error: message });
        await sleep(delayMs, req.signal);
        continue;
      }

      const json: any = await res.json();
      const candidate = json?.candidates?.[0];
      const finish = candidate?.finishReason;
      const text: string = (candidate?.content?.parts ?? [])
        .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
        .join("");

      if (finish === "MAX_TOKENS") {
        throw new OcrGeminiError(
          `Pages ${req.startPage}-${req.endPage} produced more text than one response can hold. Re-run this document with a smaller chunk size.`,
          { retryable: false },
        );
      }
      if (!text.trim()) {
        const reason = finish || json?.promptFeedback?.blockReason || "empty response";
        // A blocked/empty answer occasionally clears on a retry; a hard block does not.
        const retryable = reason !== "SAFETY" && reason !== "PROHIBITED_CONTENT" && attempt < ocrConfig.maxAttempts;
        lastError = new OcrGeminiError(`Gemini returned no text (${reason}).`, { retryable });
        if (!retryable) throw lastError;
        const delayMs = retryDelayMs(attempt);
        req.onProgress?.({ kind: "backoff", attempt, model: req.model, delayMs, error: lastError.message });
        await sleep(delayMs, req.signal);
        continue;
      }

      const usage = json?.usageMetadata ?? {};
      return {
        text,
        inputTokens: Number(usage.promptTokenCount ?? 0) || 0,
        outputTokens:
          (Number(usage.candidatesTokenCount ?? 0) || 0) + (Number(usage.thoughtsTokenCount ?? 0) || 0),
        attempts: attempt,
      };
    } catch (err: any) {
      if (err instanceof OcrGeminiError) {
        err.attempts = attempt;
        // An overloaded error only reaches here once its attempt cap is spent.
        if (!err.retryable || err.overloaded || attempt === ocrConfig.maxAttempts) throw err;
        lastError = err;
      } else if (req.signal?.aborted || err?.message === "cancelled") {
        throw new OcrGeminiError("Cancelled.", { retryable: false, attempts: attempt });
      } else {
        const timedOut = err?.name === "AbortError";
        lastError = new OcrGeminiError(
          timedOut
            ? `Gemini did not answer within ${Math.round(ocrConfig.requestTimeoutMs / 1000)}s.`
            : `Network error calling Gemini: ${err?.message || err}`,
          { retryable: true, attempts: attempt },
        );
        if (attempt === ocrConfig.maxAttempts) throw lastError;
        const delayMs = retryDelayMs(attempt);
        req.onProgress?.({ kind: "backoff", attempt, model: req.model, delayMs, error: lastError.message });
        await sleep(delayMs, req.signal);
      }
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  throw lastError ?? new OcrGeminiError("Gemini request failed.", { retryable: false });
}

/**
 * Split a chunk's transcription into pages on the marker lines. Falls back to a
 * single block for the whole range if the model skipped the markers, so a
 * missing marker degrades pagination instead of losing text.
 */
export function splitChunkPages(
  text: string,
  startPage: number,
  endPage: number,
): Array<{ page: number; markdown: string }> {
  const re = /^\s*<<<PAGE:\s*(\d+)\s*>>>\s*$/gm;
  const matches = [...text.matchAll(re)];
  if (matches.length === 0) {
    return [{ page: startPage, markdown: text.trim() }];
  }

  const pages: Array<{ page: number; markdown: string }> = [];
  matches.forEach((match, i) => {
    const from = (match.index ?? 0) + match[0].length;
    const to = i + 1 < matches.length ? matches[i + 1].index ?? text.length : text.length;
    const declared = Number(match[1]);
    // Trust the declared number only when it lands inside this chunk's range;
    // otherwise fall back to positional numbering.
    const page = declared >= startPage && declared <= endPage ? declared : startPage + i;
    pages.push({ page, markdown: text.slice(from, to).trim() });
  });
  return pages;
}
