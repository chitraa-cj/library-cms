/**
 * Structure-analysis job runner.
 *
 * Shape of the work — deliberately the same as the OCR runner, because the failure modes
 * are the same: a job owns an ordered list of page-range chunks, each chunk row is the
 * unit of work, of retry and of accounting, and all state lives in Postgres so a crash,
 * a cancel or a failed range never costs the ranges that already answered.
 *
 *   jobs queue ──(maxActiveJobs)──► runJob ──► chunk ──(acquireStructureSlot)──►
 *        Claude ──► validated items ──► chunk row ──► job counters
 *
 * One difference from OCR, and the reason it matters: the chunks of ONE job run in
 * sequence, not in parallel. Each range is told the section path still open at the end of
 * the previous range and is given its last paragraphs as read-only context, which is what
 * lets a chapter heading on page 40 keep governing page 41 and a verse split across the
 * page break stay one verse. Parallelism across jobs (and the process-wide request gate)
 * still bounds the load; `STRUCTURE_MAX_ACTIVE_JOBS` and `STRUCTURE_CONCURRENCY` are the
 * knobs.
 *
 * Nothing derived is stored: `items` per chunk is the only persisted model output, and
 * sections/verses/CSV are recomputed from it plus the job's `overrides` on every read
 * (`buildStructureResult`). A review edit therefore never needs another Claude call.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  structureJobChunks,
  structureJobs,
  type OcrJob,
  type OcrPage,
  type StructureJob,
} from "@shared/schema";
import {
  applyStructureOverrides,
  assembleStructure,
  buildStructureCsv,
  estimateStructureCost,
  formatUsd,
  planStructureChunks,
  selectPageWindow,
  structureCostUsd,
  normalizeHierarchyConfig,
  structureWorkflowState,
  validateStructure,
  type AssembledStructure,
  type StructureCsvResult,
  type StructureHierarchyConfig,
  type StructureItem,
  type StructureOverride,
  type StructureValidation,
  type StructureCostEstimate,
  type StructureWorkflowState,
} from "@shared/ocr-structure";
export type { StructureChunkRange } from "@shared/ocr-structure";
export { planStructureChunks, selectPageWindow } from "@shared/ocr-structure";
import { buildOcrDocument } from "../ocr/jobs";
import { analyseChunkWithClaude, StructureClaudeError } from "./claude";
import { isStructureConfigured, sanitizeStructureError, structureConfig, structureRates } from "./config";
import {
  acquireStructureSlot,
  assertSpendBudget,
  invalidateStructureSpend,
  recordExtraStructureRequest,
  StructureBudgetError,
} from "./limiter";
import {
  addStructureChunkResultToJob,
  claimableStructureChunks,
  distinctTeekaNames,
  ensureStructureSchema,
  getStructureJob,
  insertStructureChunks,
  insertStructureJob,
  listStructureChunkStatuses,
  listStructureChunks,
  previousDoneChunk,
  requeueFailedStructureChunks,
  updateStructureChunk,
  updateStructureJob,
} from "./store";

const activeJobs = new Map<string, AbortController>();

function log(msg: string) {
  console.log(`[structure] ${msg}`);
}

// ───────────────────────────────────────────────────── live, in-memory progress
/**
 * What the running range is doing between chunk-row changes ("attempt 2 of 3",
 * "rate limited, retrying in 12s"). Purely advisory: losing it on a restart loses
 * nothing but the countdown.
 */
export interface StructureChunkLive {
  chunkIndex: number;
  attempt: number;
  maxAttempts: number;
  phase: "slot" | "request" | "backoff";
  startedAt: number;
  phaseStartedAt: number;
  nextAttemptAt: number | null;
  lastError: string | null;
}
const live = new Map<string, StructureChunkLive>();

function setLive(jobId: string, patch: Partial<StructureChunkLive> & { chunkIndex: number }): void {
  const now = Date.now();
  const prev = live.get(jobId);
  const next: StructureChunkLive = {
    attempt: 0,
    maxAttempts: structureConfig.maxAttempts,
    phase: "slot",
    startedAt: now,
    phaseStartedAt: now,
    nextAttemptAt: null,
    lastError: null,
    ...(prev && prev.chunkIndex === patch.chunkIndex ? prev : {}),
    ...patch,
  };
  if (prev && patch.phase && patch.phase !== prev.phase && patch.phaseStartedAt == null) {
    next.phaseStartedAt = now;
  }
  live.set(jobId, next);
}

export function liveStructureChunk(jobId: string): StructureChunkLive | null {
  return live.get(jobId) ?? null;
}

// ──────────────────────────────────────────────────────────── cost and budget

/** The configured estimate for a planned set of ranges. */
export function estimateStructureCostFor(
  pages: readonly OcrPage[],
  ranges: readonly { startPage: number; endPage: number }[],
): StructureCostEstimate {
  return estimateStructureCost(pages, ranges, structureRates(), {
    carryOverChars: structureConfig.carryOverChars,
    promptCaching: structureConfig.promptCaching,
  });
}

/** What analysing a whole OCR document would cost, before any job exists. */
export function estimateStructureCostForPages(pages: readonly OcrPage[]): StructureCostEstimate {
  return estimateStructureCostFor(
    pages,
    planStructureChunks(pages, {
      pagesPerChunk: structureConfig.pagesPerChunk,
      maxChars: structureConfig.maxCharsPerChunk,
    }),
  );
}

/** What this job has actually cost so far, from the counters the API returned. */
export function structureJobSpendUsd(job: StructureJob): number {
  return structureCostUsd(job, structureRates());
}

/**
 * The per-document ceiling, checked before each range rather than only at creation.
 *
 * The creation estimate is pessimistic, so this should almost never fire — but "almost
 * never" is not "never", and a document whose pages are far denser than the estimate
 * assumed must stop at its cap rather than quietly spend the day's budget.
 */
function jobBudgetStop(job: StructureJob): string | null {
  if (
    structureConfig.maxRequestsPerJob > 0 &&
    job.requestCount >= structureConfig.maxRequestsPerJob
  ) {
    return `Stopped at the per-document request cap (${structureConfig.maxRequestsPerJob}). Raise STRUCTURE_MAX_REQUESTS_PER_JOB and press Retry failed ranges to continue.`;
  }
  const spent = structureJobSpendUsd(job);
  if (structureConfig.maxSpendPerJobUsd > 0 && spent >= structureConfig.maxSpendPerJobUsd) {
    return `Stopped at the per-document budget: ${formatUsd(spent)} of ${formatUsd(structureConfig.maxSpendPerJobUsd)}. Raise STRUCTURE_MAX_SPEND_PER_JOB_USD and press Retry failed ranges to continue.`;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────── creation

export interface CreateStructureJobInput {
  ocrJob: OcrJob;
  userId: string | null;
  config: StructureHierarchyConfig;
  instructions?: string | null;
  voiceUsed?: boolean;
  /** 1-based, inclusive page window; omit either bound for "to the end" / "from 1". */
  pageFrom?: number | null;
  pageTo?: number | null;
}

export async function createStructureJob(input: CreateStructureJobInput): Promise<StructureJob> {
  await ensureStructureSchema();

  const { pages: transcribed } = await buildOcrDocument(input.ocrJob.id);
  if (transcribed.length === 0) {
    const err: any = new Error(
      "This document has no transcribed pages yet. Finish (or retry) the OCR run first.",
    );
    err.status = 400;
    throw err;
  }

  // The page window is applied HERE, before anything is planned, estimated or billed:
  // the ranges, the cost and the result are all about the chosen pages only.
  const selection = selectPageWindow(transcribed, { from: input.pageFrom, to: input.pageTo });
  const pages = selection.pages;
  if (pages.length === 0) {
    const err: any = new Error(
      `No transcribed pages in ${input.pageFrom ?? selection.availableFrom}–${input.pageTo ?? selection.availableTo}. This document has transcribed pages ${selection.availableFrom}–${selection.availableTo}.`,
    );
    err.status = 400;
    throw err;
  }
  if (pages.length > structureConfig.maxPages) {
    const err: any = new Error(
      `That is ${pages.length} transcribed pages; the per-analysis limit is ${structureConfig.maxPages}. Choose a narrower page range.`,
    );
    err.status = 400;
    throw err;
  }

  const cfg = normalizeHierarchyConfig(input.config);
  const ranges = planStructureChunks(pages, {
    pagesPerChunk: structureConfig.pagesPerChunk,
    maxChars: structureConfig.maxCharsPerChunk,
  });

  // Nothing is sent to Claude until the bill has been looked at. The estimate is
  // deliberately pessimistic (see estimateStructureCost), so a job that passes here is
  // very unlikely to be stopped mid-run by the per-job cap.
  const estimate = estimateStructureCostFor(pages, ranges);
  if (ranges.length > structureConfig.maxRequestsPerJob) {
    const err: any = new Error(
      `This document needs ${ranges.length} Claude requests; the per-document cap is ${structureConfig.maxRequestsPerJob}. Analyse it in parts, raise STRUCTURE_PAGES_PER_CHUNK, or raise STRUCTURE_MAX_REQUESTS_PER_JOB.`,
    );
    err.status = 400;
    throw err;
  }
  if (structureConfig.maxSpendPerJobUsd > 0 && estimate.costUsd > structureConfig.maxSpendPerJobUsd) {
    const err: any = new Error(
      `Analysing this document would cost about ${formatUsd(estimate.costUsd)}; the per-document cap is ${formatUsd(structureConfig.maxSpendPerJobUsd)}. Analyse it in parts, or raise STRUCTURE_MAX_SPEND_PER_JOB_USD.`,
    );
    err.status = 400;
    throw err;
  }
  // Day and month budgets, counting what this job is expected to add.
  await assertSpendBudget(estimate.costUsd);

  const id = randomUUID();
  const job = await insertStructureJob({
    id,
    ocrJobId: input.ocrJob.id,
    userId: input.userId,
    depth: cfg.depth,
    levelNames: cfg.levelNames,
    pageFrom: selection.window?.from ?? null,
    pageTo: selection.window?.to ?? null,
    instructions: input.instructions?.trim()?.slice(0, structureConfig.maxInstructionChars) || null,
    voiceUsed: Boolean(input.voiceUsed),
    model: structureConfig.model,
    status: "queued",
    chunksTotal: ranges.length,
  });

  await insertStructureChunks(
    ranges.map((range, index) => ({
      jobId: id,
      chunkIndex: index,
      startPage: range.startPage,
      endPage: range.endPage,
      status: "queued" as const,
    })),
  );

  log(
    `job ${id} created for ocr ${input.ocrJob.id} — ${pages.length}p` +
      (selection.window ? ` (p${selection.window.from}-${selection.window.to} of ${selection.availableCount})` : "") +
      `, ${ranges.length} range(s), depth ${cfg.depth} (${cfg.levelNames.join(" › ")}), ${structureConfig.model}, estimated ${formatUsd(estimate.costUsd)}`,
  );
  pump();
  return job;
}

// ────────────────────────────────────────────────────────────────── scheduling

/** Start queued jobs until `maxActiveJobs` are running. Safe to call at any time. */
export function pump(): void {
  void (async () => {
    try {
      if (!isStructureConfigured()) return;
      while (activeJobs.size < structureConfig.maxActiveJobs) {
        const [next] = await db
          .select()
          .from(structureJobs)
          .where(eq(structureJobs.status, "queued"))
          .orderBy(structureJobs.createdAt)
          .limit(1);
        if (!next || activeJobs.has(next.id)) return;

        const controller = new AbortController();
        activeJobs.set(next.id, controller);
        await updateStructureJob(next.id, { status: "running", startedAt: new Date(), error: null });

        void runJob(next.id, controller.signal)
          .catch((err) => log(`job ${next.id} crashed: ${sanitizeStructureError(err)}`))
          .finally(() => {
            activeJobs.delete(next.id);
            live.delete(next.id);
            pump();
          });
      }
    } catch (err: any) {
      log(`scheduler error: ${sanitizeStructureError(err)}`);
    }
  })();
}

export function cancelStructureJob(jobId: string): boolean {
  const controller = activeJobs.get(jobId);
  controller?.abort();
  return Boolean(controller);
}

export function isStructureJobActive(jobId: string): boolean {
  return activeJobs.has(jobId);
}

/**
 * Resume a job: failed ranges go back in the queue, and any range that never finished
 * (e.g. after a cancel) is picked up again. Ranges already analysed are never re-sent,
 * so resuming a half-finished 300-page book costs only the ranges that are missing.
 */
export async function retryStructureJob(jobId: string): Promise<number> {
  await requeueFailedStructureChunks(jobId);
  const chunks = await listStructureChunkStatuses(jobId);
  const done = chunks.filter((c) => c.status === "done").length;
  const pending = chunks.length - done;

  await updateStructureJob(jobId, {
    status: pending > 0 ? "queued" : "done",
    chunksDone: done,
    chunksFailed: 0,
    error: null,
    finishedAt: pending > 0 ? null : new Date(),
  });
  pump();
  return pending;
}

// ─────────────────────────────────────────────────────────────────── running

async function runJob(jobId: string, signal: AbortSignal): Promise<void> {
  const job = await getStructureJob(jobId);
  if (!job) return;

  const pending = await claimableStructureChunks(jobId);
  if (pending.length === 0) {
    await finalizeJob(jobId);
    return;
  }

  const { pages } = await buildOcrDocument(job.ocrJobId);
  if (pages.length === 0) {
    await updateStructureJob(jobId, {
      status: "failed",
      error: "The OCR transcription is no longer available. Re-run the OCR job.",
      finishedAt: new Date(),
    });
    return;
  }
  const pageByNumber = new Map(pages.map((p) => [p.page, p]));

  const cfg: StructureHierarchyConfig = normalizeHierarchyConfig({
    depth: job.depth,
    levelNames: job.levelNames,
  });

  const analysisWindow =
    job.pageFrom != null && job.pageTo != null ? { from: job.pageFrom, to: job.pageTo } : null;

  const started = Date.now();
  // Ranges run in order so each one inherits the hierarchy the previous one left open.
  let stopReason: string | null = null;
  for (const chunk of pending) {
    if (signal.aborted) break;

    // Re-read the counters rather than trusting the row we booted with: they grow as
    // ranges finish, and the cap has to be checked against what has actually been spent.
    const current = await getStructureJob(jobId);
    if (!current) break;
    stopReason = jobBudgetStop(current);
    if (stopReason) {
      log(`job ${jobId} ${stopReason}`);
      break;
    }

    const carry = await carryOverFor(jobId, chunk.chunkIndex, pageByNumber);
    // A failure about the server's credentials, not about these pages: it would repeat
    // identically on every remaining range, so the job stops with the fix named instead
    // of marking thirty ranges failed with the same message.
    const fatal = await runChunk(job, cfg, chunk, pageByNumber, carry, analysisWindow, signal);
    if (fatal) {
      stopReason = fatal;
      log(`job ${jobId} stopped: ${fatal}`);
      break;
    }
  }

  if (signal.aborted) {
    await db
      .update(structureJobChunks)
      .set({ status: "queued", updatedAt: new Date() })
      .where(and(eq(structureJobChunks.jobId, jobId), eq(structureJobChunks.status, "running")));
    await updateStructureJob(jobId, { status: "cancelled", finishedAt: new Date() });
    log(`job ${jobId} cancelled`);
    return;
  }

  await finalizeJob(jobId, stopReason);
  const finished = await getStructureJob(jobId);
  log(
    `job ${jobId} finished in ${((Date.now() - started) / 1000).toFixed(1)}s` +
      (finished ? ` — spent ${formatUsd(structureJobSpendUsd(finished))} over ${finished.requestCount} request(s)` : ""),
  );
}

/**
 * Context for range N: the section path the previous range left open, the tail of its
 * text, and the commentary names already used in this document (so the same sub-commentary
 * is not called two different things on two pages).
 */
async function carryOverFor(
  jobId: string,
  chunkIndex: number,
  pageByNumber: Map<number, OcrPage>,
): Promise<{
  carryOverText: string | null;
  openPath: Array<{ level: number; number: string; title: string }> | null;
  knownTeekaNames: string[];
}> {
  if (chunkIndex === 0) {
    return { carryOverText: null, openPath: null, knownTeekaNames: [] };
  }
  // Both reads are narrow on purpose: one row's metadata and one aggregate, never the
  // whole answer set (see distinctTeekaNames).
  const [previous, knownTeekaNames] = await Promise.all([
    previousDoneChunk(jobId, chunkIndex),
    distinctTeekaNames(jobId),
  ]);

  if (!previous) return { carryOverText: null, openPath: null, knownTeekaNames };

  // The tail comes from the OCR text, not from the model's items: it is context for
  // continuity, and the transcription is the thing that was actually printed.
  let tail = "";
  if (structureConfig.carryOverChars === 0) {
    return {
      carryOverText: null,
      openPath: (previous.openPath as Array<{ level: number; number: string; title: string }> | null) ?? null,
      knownTeekaNames,
    };
  }
  for (let page = previous.endPage; page >= previous.startPage && tail.length < structureConfig.carryOverChars; page--) {
    const text = pageByNumber.get(page)?.markdown ?? "";
    tail = text ? `${text}\n${tail}` : tail;
  }
  return {
    carryOverText: tail.slice(-structureConfig.carryOverChars) || null,
    openPath:
      (previous.openPath as Array<{ level: number; number: string; title: string }> | null) ?? null,
    knownTeekaNames,
  };
}

/**
 * One page range, end to end. Returns null normally, or the message a configuration
 * failure should stop the whole job with.
 */
async function runChunk(
  job: StructureJob,
  cfg: StructureHierarchyConfig,
  chunk: { chunkIndex: number; startPage: number; endPage: number; attempts: number },
  pageByNumber: Map<number, OcrPage>,
  carry: Awaited<ReturnType<typeof carryOverFor>>,
  analysisWindow: { from: number; to: number } | null,
  signal: AbortSignal,
): Promise<string | null> {
  const startedAt = Date.now();
  await updateStructureChunk(job.id, chunk.chunkIndex, { status: "running", error: null });
  setLive(job.id, { chunkIndex: chunk.chunkIndex, phase: "slot", attempt: 0, nextAttemptAt: null });

  const pages: OcrPage[] = [];
  for (let page = chunk.startPage; page <= chunk.endPage; page++) {
    const found = pageByNumber.get(page);
    if (found) pages.push(found);
  }

  let requestsSpent = 0;
  let release: (() => void) | null = null;

  try {
    if (pages.length === 0) {
      // The OCR range never produced text (a failed/skipped OCR chunk). Nothing to ask
      // Claude about, and asking would spend a request on an empty page range.
      throw new StructureClaudeError(
        `Pages ${chunk.startPage}–${chunk.endPage} have no transcription — retry those pages in OCR Docs first.`,
        { retryable: false },
      );
    }

    release = await acquireStructureSlot(signal);
    const result = await analyseChunkWithClaude({
      pages,
      startPage: chunk.startPage,
      endPage: chunk.endPage,
      totalPages: pageByNumber.size,
      chunkIndex: chunk.chunkIndex,
      config: cfg,
      instructions: job.instructions,
      analysisWindow,
      carryOverText: carry.carryOverText,
      openPath: carry.openPath,
      knownTeekaNames: carry.knownTeekaNames,
      onRetryAttempt: recordExtraStructureRequest,
      onProgress: (event) => {
        if (event.kind === "attempt") {
          setLive(job.id, {
            chunkIndex: chunk.chunkIndex,
            attempt: event.attempt,
            phase: "request",
            nextAttemptAt: null,
          });
        } else {
          setLive(job.id, {
            chunkIndex: chunk.chunkIndex,
            phase: "backoff",
            nextAttemptAt: Date.now() + event.delayMs,
            lastError: event.error,
          });
        }
      },
      signal,
    });
    requestsSpent += result.attempts;

    await updateStructureChunk(job.id, chunk.chunkIndex, {
      status: "done",
      items: result.items,
      warnings: result.warnings,
      openPath: result.openPath ?? null,
      rejectedItems: result.rejected,
      model: result.model,
      attempts: chunk.attempts + requestsSpent,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cachedInputTokens: result.cachedInputTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      durationMs: Date.now() - startedAt,
      error: null,
    });
    await addStructureChunkResultToJob(job.id, {
      done: 1,
      failed: 0,
      requests: requestsSpent,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cachedInputTokens: result.cachedInputTokens,
      cacheWriteTokens: result.cacheWriteTokens,
    });
    // The day/month figures just changed; the next gate check must see the new ones.
    invalidateStructureSpend();
    if (result.rejected > 0) {
      log(
        `job ${job.id} range ${chunk.chunkIndex} (p${chunk.startPage}-${chunk.endPage}): ${result.rejected} item(s) failed the schema check and were dropped`,
      );
    }
    return null;
  } catch (err: any) {
    const cancelled = signal.aborted || err?.message === "cancelled" || err?.message === "Cancelled.";
    if (cancelled) {
      await updateStructureChunk(job.id, chunk.chunkIndex, {
        status: "queued",
        durationMs: Date.now() - startedAt,
      });
      if (requestsSpent > 0) {
        await addStructureChunkResultToJob(job.id, {
          done: 0,
          failed: 0,
          requests: requestsSpent,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
        });
      }
      return null;
    }
    const budget = err instanceof StructureBudgetError;
    const attempts = err instanceof StructureClaudeError ? err.attempts : 1;
    await updateStructureChunk(job.id, chunk.chunkIndex, {
      status: budget ? "skipped" : "failed",
      attempts: chunk.attempts + Math.max(attempts, 1),
      durationMs: Date.now() - startedAt,
      error: sanitizeStructureError(err),
    });
    await addStructureChunkResultToJob(job.id, {
      done: 0,
      failed: 1,
      requests: attempts,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });
    log(
      `job ${job.id} range ${chunk.chunkIndex} (p${chunk.startPage}-${chunk.endPage}) failed: ${sanitizeStructureError(err)}`,
    );
    return err instanceof StructureClaudeError && err.fatal ? err.message : null;
  } finally {
    release?.();
    live.delete(job.id);
  }
}

async function finalizeJob(jobId: string, stopReason: string | null = null): Promise<void> {
  const chunks = await listStructureChunkStatuses(jobId);
  const done = chunks.filter((c) => c.status === "done").length;
  const failed = chunks.filter((c) => c.status === "failed" || c.status === "skipped").length;
  const unanalysed = chunks.length - done - failed;

  // A stop (budget or configuration) leaves the remaining ranges untouched rather than
  // failed: the job is `partial`, the pages it did analyse are reviewable, and the
  // message names what to change before pressing Retry failed ranges.
  const status = stopReason
    ? done === 0
      ? "failed"
      : "partial"
    : failed === 0
      ? "done"
      : done === 0
        ? "failed"
        : "partial";
  const firstError = chunks.find((c) => c.error)?.error ?? null;
  const error = stopReason
    ? `${stopReason}${unanalysed > 0 ? ` ${unanalysed} page range(s) were not analysed.` : ""}`
    : status === "done"
      ? null
      : firstError;

  await updateStructureJob(jobId, {
    status,
    chunksDone: done,
    chunksFailed: failed,
    finishedAt: new Date(),
    error,
  });
}

/**
 * After a restart, jobs left `running` own no worker. Put their in-flight ranges back in
 * the queue and let the scheduler resume them — only ranges that never finished are
 * re-sent, so resuming costs nothing for ranges already analysed.
 */
export async function reconcileStructureJobsOnBoot(): Promise<void> {
  try {
    await ensureStructureSchema();
    await db
      .update(structureJobChunks)
      .set({ status: "queued", updatedAt: new Date() })
      .where(inArray(structureJobChunks.status, ["running"]));
    const stale = await db
      .update(structureJobs)
      .set({ status: "queued", updatedAt: new Date() })
      .where(eq(structureJobs.status, "running"))
      .returning({ id: structureJobs.id });
    if (stale.length > 0) log(`requeued ${stale.length} job(s) interrupted by a restart`);
    pump();
  } catch (err: any) {
    log(`boot reconcile skipped: ${sanitizeStructureError(err)}`);
  }
}

// ──────────────────────────────────────────────────────────────── the result

export interface StructureResult {
  job: StructureJob;
  config: StructureHierarchyConfig;
  items: StructureItem[];
  structure: AssembledStructure;
  validation: StructureValidation;
  csv: StructureCsvResult;
  workflowState: StructureWorkflowState;
  /** Ranges that have not produced items yet, so the review can say what is missing. */
  missingRanges: Array<{ startPage: number; endPage: number; error: string | null }>;
}

/**
 * Everything the review UI and the export need, recomputed from the stored items.
 *
 * This is the single place that turns persisted model output into a structure, so the
 * review, the CSV download and the import handoff can never disagree about what the
 * document says.
 */
export async function buildStructureResult(job: StructureJob): Promise<StructureResult> {
  const chunks = await listStructureChunks(job.id);
  const rawItems: StructureItem[] = [];
  const missingRanges: StructureResult["missingRanges"] = [];

  for (const chunk of chunks) {
    if (chunk.status !== "done" || !chunk.items) {
      missingRanges.push({ startPage: chunk.startPage, endPage: chunk.endPage, error: chunk.error });
      continue;
    }
    for (const item of chunk.items as StructureItem[]) rawItems.push(item);
  }

  const cfg = normalizeHierarchyConfig({ depth: job.depth, levelNames: job.levelNames });
  const overrides = (job.overrides ?? []) as StructureOverride[];
  const items = applyStructureOverrides(rawItems, overrides);
  const structure = assembleStructure(items, cfg, {
    confidenceThreshold: structureConfig.confidenceThreshold,
  });
  const validation = validateStructure(structure);
  const csv = buildStructureCsv(structure);

  return {
    job,
    config: cfg,
    items,
    structure,
    validation,
    csv,
    workflowState: structureWorkflowState({
      analysisStatus: job.status,
      importStatus: job.importStatus,
      openQuestions: structure.ambiguities.length,
      validationOk: validation.ok,
      hasVerses: structure.verses.length > 0,
      reviewed: Boolean(job.reviewedAt),
    }),
    missingRanges,
  };
}
