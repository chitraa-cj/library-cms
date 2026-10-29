/**
 * StructureAnalyzer over Hermex: one browser session on the dedicated structure
 * profile per job, one line-referenced prompt per page range.
 *
 *   range ──► numbered lines ──► prompt ──► HermexPromptSession.ask ──► reply
 *         ──► resolveLineAnswer (text cut from the OCR lines, coverage + provenance
 *             checked) ──► StructureItem[]
 *
 * No API key, no SDK, no fallback: if Hermex cannot answer, the error says why and the
 * range stays retryable. There is no path from here to any other provider.
 */
import { StructureAnswerError } from "@shared/ocr-structure";
import { numberSourceLines, resolveLineAnswer } from "@shared/ocr-structure-lines";
import { HermexError } from "../hermex-translate";
import { HermexPromptSession } from "../hermex/prompt-session";
import { structureProfile } from "../hermex/task-profiles";
import {
  StructureAnalysisError,
  type StructureAnalyzer,
  type StructureChunkRequest,
  type StructureChunkResult,
} from "./analyzer";
import { sanitizeStructureError, structureConfig } from "./config";
import { buildStructurePrompt } from "./prompt";

/** Reasons that are about this server, not these pages: stop the job. */
const FATAL_REASONS = new Set(["unavailable", "login", "display", "busy"]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new StructureAnalysisError("Cancelled."));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface HermexAnalyzerOptions {
  /** Log prefix — the job id. */
  label: string;
  /** Tests inject a fake session factory; production opens the real browser. */
  openSession?: (signal?: AbortSignal) => Promise<Pick<HermexPromptSession, "ask" | "close" | "alive">>;
  /** Called before every request (the per-minute/day gate). */
  beforeRequest?: (signal?: AbortSignal) => Promise<void>;
}

export function createHermexStructureAnalyzer(opts: HermexAnalyzerOptions): StructureAnalyzer {
  let session: Pick<HermexPromptSession, "ask" | "close" | "alive"> | null = null;

  const open =
    opts.openSession ??
    (async (signal?: AbortSignal) => {
      const profile = structureProfile();
      if (!profile.ok) throw new HermexError("unavailable", profile.problems.join(" "));
      return HermexPromptSession.open({
        profile: profile.profile,
        launchTimeoutMs: structureConfig.launchTimeoutMs,
        label: opts.label,
        signal,
      });
    });

  async function liveSession(signal?: AbortSignal) {
    if (session && session.alive) return session;
    if (session) await session.close().catch(() => undefined);
    session = await open(signal);
    return session;
  }

  return {
    label: structureConfig.model,

    async analyse(req: StructureChunkRequest): Promise<StructureChunkResult> {
      const lines = numberSourceLines(req.pages);
      if (lines.length === 0) {
        throw new StructureAnalysisError("The page range has no transcribed text.");
      }
      const prompt = buildStructurePrompt({
        lines,
        startPage: req.startPage,
        endPage: req.endPage,
        totalPages: req.totalPages,
        config: req.config,
        instructions: req.instructions,
        maxInstructionChars: structureConfig.maxInstructionChars,
        analysisWindow: req.analysisWindow,
        carryOverText: req.carryOverText,
        openPath: req.openPath,
        knownTeekaNames: req.knownTeekaNames,
      });

      let lastError: StructureAnalysisError | null = null;
      for (let attempt = 1; attempt <= structureConfig.maxAttempts; attempt++) {
        if (req.signal?.aborted) throw new StructureAnalysisError("Cancelled.", { attempts: attempt - 1 });
        req.onProgress?.({ kind: "attempt", attempt });
        let delayMs = 0;
        try {
          await opts.beforeRequest?.(req.signal);
          const s = await liveSession(req.signal);
          const reply = await s.ask(prompt, { timeoutMs: structureConfig.requestTimeoutMs, signal: req.signal });
          const resolved = resolveLineAnswer(reply, {
            chunkIndex: req.chunkIndex,
            lines,
            knownTeekaNames: req.knownTeekaNames,
            instructions: req.instructions,
            inferredConfidenceCap: structureConfig.inferredConfidenceCap,
          });
          return { ...resolved, attempts: attempt, model: structureConfig.model };
        } catch (err: any) {
          if (req.signal?.aborted || err?.message === "Cancelled." || err?.message === "cancelled") {
            throw new StructureAnalysisError("Cancelled.", { attempts: attempt });
          }
          if (err instanceof StructureAnalysisError && err.fatal) throw err;
          if (err?.name === "StructureBudgetError") throw err;

          if (err instanceof HermexError) {
            if (FATAL_REASONS.has(err.reason)) {
              throw new StructureAnalysisError(sanitizeStructureError(err), { fatal: true, attempts: attempt });
            }
            lastError = new StructureAnalysisError(`Hermex (${err.reason}): ${sanitizeStructureError(err)}`, {
              retryable: true,
              attempts: attempt,
            });
            delayMs =
              err.reason === "transient"
                ? structureConfig.transientCooldownMs
                : Math.min(structureConfig.retryBaseDelayMs * 2 ** (attempt - 1), 120_000);
          } else if (err instanceof StructureAnswerError) {
            // The answer was unusable (no JSON, overlapping spans). The same prompt in a
            // fresh chat often comes back well-formed; it costs one more request.
            lastError = new StructureAnalysisError(
              `Pages ${req.startPage}–${req.endPage}: the answer could not be used (${err.message})`,
              { retryable: true, attempts: attempt },
            );
            delayMs = structureConfig.retryBaseDelayMs;
          } else {
            throw new StructureAnalysisError(sanitizeStructureError(err), { attempts: attempt });
          }
        }
        if (attempt < structureConfig.maxAttempts) {
          const jittered = delayMs + Math.floor(Math.random() * 1000);
          req.onProgress?.({ kind: "backoff", attempt, delayMs: jittered, error: lastError!.message });
          await sleep(jittered, req.signal);
        }
      }
      const final = lastError ?? new StructureAnalysisError("The page range could not be analysed.");
      throw new StructureAnalysisError(final.message, { retryable: false, attempts: structureConfig.maxAttempts });
    },

    async close() {
      const s = session;
      session = null;
      await s?.close().catch(() => undefined);
    },
  };
}
