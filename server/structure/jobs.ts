/**
 * Structure-analysis job runner.
 *
 * Shape of the work — the same as the OCR runner, because the failure modes are the
 * same: a job owns an ordered list of page-range chunks, each chunk row is the unit of
 * work, of retry and of accounting, and all state lives in Postgres so a crash, a cancel
 * or a failed range never costs the ranges that already answered.
 *
 *   queue ──claim (SKIP LOCKED)──► runJob ──► chunk ──(request gate)──►
 *        Hermex (dedicated Gemini profile) ──► line spans ──► validated items ──►
 *        fenced chunk write ──► finalize (fenced release)
 *
 * Ranges of ONE job run in sequence: each is told the section path still open at the
 * end of the previous range and given its last lines as read-only context, which keeps
 * a chapter heading on page 40 governing page 41. One browser session serves the whole
 * job, so Chrome is launched once per job rather than once per range.
 *
 * Ownership (server/lib/job-lease.ts): atomic claim, fencing token on every write,
 * heartbeat-based recovery — a job that lost its run (cancelled, requeued as stale)
 * cannot have a late answer written over the new run's.
 *
 * Nothing derived is stored: `items` per chunk is the only persisted model output, and
 * sections/verses/CSV are recomputed from it plus the job's `overrides` on every read
 * (`buildStructureResult`). A review edit therefore never needs another model call.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";
import type { OcrJob, OcrPage, StructureJob } from "@shared/schema";
import {
  applyStructureOverrides,
  assembleStructure,
  buildStructureCsv,
  planStructureChunks,
  selectPageWindow,
  normalizeHierarchyConfig,
  structureWorkflowState,
  validateStructure,
  type AssembledStructure,
  type StructureCsvResult,
  type StructureHierarchyConfig,
  type StructureItem,
  type StructureOverride,
  type StructureValidation,
  type StructureWorkflowState,
} from "@shared/ocr-structure";
export type { StructureChunkRange } from "@shared/ocr-structure";
export { planStructureChunks, selectPageWindow } from "@shared/ocr-structure";
import { buildOcrDocument } from "../ocr/jobs";
import { claimNextJob, heartbeat, releaseJob, requeueStaleJobs, STRUCTURE_TABLES } from "../lib/job-lease";
import { StructureAnalysisError, type StructureAnalyzer } from "./analyzer";
import { isStructureConfigured, sanitizeStructureError, structureConfig } from "./config";
import { createHermexStructureAnalyzer } from "./hermex-analyzer";
import { awaitStructureRequestSlot, StructureBudgetError } from "./limiter";
import {
  addStructureRequests,
  claimableStructureChunks,
  distinctTeekaNames,
  ensureStructureSchema,
  getStructureJob,
  insertStructureChunks,
  insertStructureJob,
  listStructureChunkStatuses,
  listStructureChunks,
  previousDoneChunk,
  requeueStructureJobForRetry,
  writeStructureChunkResult,
} from "./store";

const activeJobs = new Map<string, { controller: AbortController; token: string }>();

function log(msg: string) {
  console.log(`[structure] ${msg}`);
}

/**
 * How a job gets its analyzer. Production: Hermex on the dedicated profile, gated by
 * the request limiter. Tests replace it (`setStructureAnalyzerFactory`) — the runner
 * itself never knows which runtime answers.
 */
type AnalyzerFactory = (jobId: string) => StructureAnalyzer;
let analyzerFactory: AnalyzerFactory = (jobId) =>
  createHermexStructureAnalyzer({ label: jobId.slice(0, 8), beforeRequest: awaitStructureRequestSlot });
let readinessCheck: () => boolean = isStructureConfigured;

export function setStructureAnalyzerFactory(factory: AnalyzerFactory | null, ready?: () => boolean): void {
  analyzerFactory =
    factory ?? ((jobId) => createHermexStructureAnalyzer({ label: jobId.slice(0, 8), beforeRequest: awaitStructureRequestSlot }));
  readinessCheck = ready ?? isStructureConfigured;
}

// ───────────────────────────────────────────────────── live, in-memory progress
/**
 * What the running range is doing between chunk-row changes ("attempt 2 of 3",
 * "cooling down for 60s"). Purely advisory: losing it on a restart loses nothing but
 * the countdown.
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

// ──────────────────────────────────────────────────────────────── estimates

export interface StructureRequestEstimate {
  pages: number;
  requests: number;
  /** One line the UI can show as is. */
  basis: string;
}

/** How many requests analysing these pages takes — the only figure that matters now. */
export function estimateStructureRequests(pages: readonly OcrPage[]): StructureRequestEstimate {
  const ranges = planStructureChunks(pages, {
    pagesPerChunk: structureConfig.pagesPerChunk,
    maxChars: structureConfig.maxCharsPerChunk,
  });
  return {
    pages: pages.length,
    requests: ranges.length,
    basis: `${ranges.length} request(s) of up to ${structureConfig.pagesPerChunk} page(s) / ${structureConfig.maxCharsPerChunk.toLocaleString("en")} characters, plus retries`,
  };
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

  // The page window is applied HERE, before anything is planned or sent.
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
  if (ranges.length > structureConfig.maxRequestsPerJob) {
    const err: any = new Error(
      `This document needs ${ranges.length} requests; the per-document cap is ${structureConfig.maxRequestsPerJob}. Analyse it in parts or raise STRUCTURE_MAX_REQUESTS_PER_JOB.`,
    );
    err.status = 400;
    throw err;
  }

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
      `, ${ranges.length} range(s), depth ${cfg.depth} (${cfg.levelNames.join(" › ")}), ${structureConfig.model}`,
  );
  pump();
  return job;
}

// ────────────────────────────────────────────────────────────────── scheduling
let pumping = false;
let pumpAgain = false;

/** Start queued jobs until `maxActiveJobs` run in this process. Safe to call at any time. */
export function pump(): void {
  if (pumping) {
    pumpAgain = true;
    return;
  }
  pumping = true;
  void (async () => {
    try {
      do {
        pumpAgain = false;
        if (!readinessCheck()) return; // jobs stay queued; the wizard shows why
        while (activeJobs.size < structureConfig.maxActiveJobs) {
          const claim = await claimNextJob(STRUCTURE_TABLES);
          if (!claim) break;
          const controller = new AbortController();
          activeJobs.set(claim.id, { controller, token: claim.token });
          void runJob(claim.id, claim.token, controller.signal)
            .catch((err) => log(`job ${claim.id} crashed: ${sanitizeStructureError(err)}`))
            .finally(() => {
              activeJobs.delete(claim.id);
              live.delete(claim.id);
              pump();
            });
        }
      } while (pumpAgain);
    } catch (err: any) {
      log(`scheduler error: ${sanitizeStructureError(err)}`);
    } finally {
      pumping = false;
    }
  })();
}

/** Cancel wherever it runs: abort locally, and fence off any other process's run. */
export async function cancelStructureJob(jobId: string): Promise<boolean> {
  activeJobs.get(jobId)?.controller.abort();
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      update cms_structure_jobs set status = 'cancelled', run_token = null, finished_at = now(), updated_at = now()
       where id = ${jobId} and status in ('queued', 'running')
      returning id`);
    await tx.execute(sql`
      update cms_structure_job_chunks set status = 'queued', updated_at = now()
       where job_id = ${jobId} and status = 'running'`);
    return ((updated as any).rows ?? []).length > 0;
  });
}

export function isStructureJobActive(jobId: string): boolean {
  return activeJobs.has(jobId);
}

/**
 * Resume a job: failed/skipped ranges go back in the queue, and any range that never
 * finished is picked up again. Ranges already analysed are never re-sent. Returns null
 * while the job is queued or running.
 */
export async function retryStructureJob(jobId: string): Promise<number | null> {
  const outcome = await requeueStructureJobForRetry(jobId);
  if (!outcome) return null;
  pump();
  return outcome.pending;
}

// ─────────────────────────────────────────────────────────────────── running

async function runJob(jobId: string, token: string, signal: AbortSignal): Promise<void> {
  const job = await getStructureJob(jobId);
  if (!job) return;
  const local = activeJobs.get(jobId);

  const beat = setInterval(() => {
    heartbeat(STRUCTURE_TABLES, jobId, token)
      .then((owned) => {
        if (!owned && !signal.aborted) {
          log(`job ${jobId} no longer owned by this run — stopping`);
          local?.controller.abort();
        }
      })
      .catch((err) => log(`job ${jobId} heartbeat failed: ${sanitizeStructureError(err)}`));
  }, Math.max(5_000, Math.floor(structureConfig.staleAfterMs / 4)));
  beat.unref?.();

  const analyzer = analyzerFactory(jobId);
  const started = Date.now();
  let stopReason: string | null = null;

  try {
    const pending = await claimableStructureChunks(jobId);
    const { pages } = await buildOcrDocument(job.ocrJobId);
    if (pages.length === 0) {
      stopReason = "The OCR transcription is no longer available. Re-run the OCR job.";
    } else {
      const pageByNumber = new Map(pages.map((p) => [p.page, p]));
      const cfg = normalizeHierarchyConfig({ depth: job.depth, levelNames: job.levelNames });
      const analysisWindow =
        job.pageFrom != null && job.pageTo != null ? { from: job.pageFrom, to: job.pageTo } : null;

      // Ranges run in order so each one inherits the hierarchy the previous one left open.
      for (const chunk of pending) {
        if (signal.aborted) break;
        const current = await getStructureJob(jobId);
        if (!current) break;
        if (structureConfig.maxRequestsPerJob > 0 && current.requestCount >= structureConfig.maxRequestsPerJob) {
          stopReason = `Stopped at the per-document request cap (${structureConfig.maxRequestsPerJob}). Raise STRUCTURE_MAX_REQUESTS_PER_JOB and press Retry failed ranges to continue.`;
          break;
        }
        const carry = await carryOverFor(jobId, chunk.chunkIndex, pageByNumber);
        const fatal = await runChunk(job, token, analyzer, cfg, chunk, pageByNumber, carry, analysisWindow, signal);
        if (fatal) {
          stopReason = fatal;
          log(`job ${jobId} stopped: ${fatal}`);
          break;
        }
      }
    }
  } finally {
    clearInterval(beat);
    await analyzer.close();
  }

  if (signal.aborted) {
    log(`job ${jobId} stopped after ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return;
  }

  await finalizeJob(jobId, token, stopReason);
  log(`job ${jobId} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

/**
 * Context for range N: the section path the previous range left open, the tail of its
 * text, and the commentary names already used in this document.
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
  const [previous, knownTeekaNames] = await Promise.all([
    previousDoneChunk(jobId, chunkIndex),
    distinctTeekaNames(jobId),
  ]);
  if (!previous) return { carryOverText: null, openPath: null, knownTeekaNames };

  const openPath = (previous.openPath as Array<{ level: number; number: string; title: string }> | null) ?? null;
  if (structureConfig.carryOverChars === 0) return { carryOverText: null, openPath, knownTeekaNames };

  // The tail comes from the OCR text, not from the model: it is what was printed.
  let tail = "";
  for (let page = previous.endPage; page >= previous.startPage && tail.length < structureConfig.carryOverChars; page--) {
    const text = pageByNumber.get(page)?.markdown ?? "";
    tail = text ? `${text}\n${tail}` : tail;
  }
  return { carryOverText: tail.slice(-structureConfig.carryOverChars) || null, openPath, knownTeekaNames };
}

/** One page range end to end. Returns null, or the message a setup failure should stop the job with. */
async function runChunk(
  job: StructureJob,
  token: string,
  analyzer: StructureAnalyzer,
  cfg: StructureHierarchyConfig,
  chunk: { chunkIndex: number; startPage: number; endPage: number },
  pageByNumber: Map<number, OcrPage>,
  carry: Awaited<ReturnType<typeof carryOverFor>>,
  analysisWindow: { from: number; to: number } | null,
  signal: AbortSignal,
): Promise<string | null> {
  const startedAt = Date.now();
  if (!(await writeStructureChunkResult(job.id, chunk.chunkIndex, token, { status: "running", error: null }))) {
    return null; // this run no longer owns the job
  }
  setLive(job.id, { chunkIndex: chunk.chunkIndex, phase: "slot", attempt: 0, nextAttemptAt: null });

  const pages: OcrPage[] = [];
  for (let page = chunk.startPage; page <= chunk.endPage; page++) {
    const found = pageByNumber.get(page);
    if (found) pages.push(found);
  }

  try {
    if (pages.length === 0) {
      throw new StructureAnalysisError(
        `Pages ${chunk.startPage}–${chunk.endPage} have no transcription — retry those pages in OCR Docs first.`,
      );
    }
    const result = await analyzer.analyse({
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
      signal,
      onProgress: (event) => {
        if (event.kind === "attempt") {
          setLive(job.id, { chunkIndex: chunk.chunkIndex, attempt: event.attempt, phase: "request", nextAttemptAt: null });
        } else {
          setLive(job.id, {
            chunkIndex: chunk.chunkIndex,
            phase: "backoff",
            nextAttemptAt: Date.now() + event.delayMs,
            lastError: event.error,
          });
        }
      },
    });

    await writeStructureChunkResult(job.id, chunk.chunkIndex, token, {
      status: "done",
      items: result.items,
      warnings: result.warnings,
      openPath: result.openPath ?? null,
      rejected: result.rejected,
      model: result.model,
      attempts: result.attempts,
      durationMs: Date.now() - startedAt,
    });
    await addStructureRequests(job.id, token, result.attempts);
    if (result.rejected > 0 || result.unclassifiedLines > 0) {
      log(
        `job ${job.id} range ${chunk.chunkIndex} (p${chunk.startPage}-${chunk.endPage}): ${result.rejected} item(s) rejected, ${result.unclassifiedLines} line(s) left unclassified for review`,
      );
    }
    return null;
  } catch (err: any) {
    // A budget stop happens before the request is sent: it costs nothing.
    const attempts = err instanceof StructureAnalysisError ? err.attempts : err instanceof StructureBudgetError ? 0 : 1;
    const cancelled = signal.aborted || err?.message === "Cancelled." || err?.message === "cancelled";
    if (cancelled) {
      await writeStructureChunkResult(job.id, chunk.chunkIndex, token, {
        status: "queued",
        durationMs: Date.now() - startedAt,
        error: null,
      }).catch(() => undefined);
      return null;
    }
    const budget = err instanceof StructureBudgetError;
    const fatal = err instanceof StructureAnalysisError && err.fatal;
    // A setup failure leaves the range queued (Retry resumes it once fixed); a budget
    // stop skips it; anything about these pages fails it.
    await writeStructureChunkResult(job.id, chunk.chunkIndex, token, {
      status: fatal ? "queued" : budget ? "skipped" : "failed",
      attempts,
      durationMs: Date.now() - startedAt,
      error: sanitizeStructureError(err),
    });
    await addStructureRequests(job.id, token, attempts);
    log(`job ${job.id} range ${chunk.chunkIndex} (p${chunk.startPage}-${chunk.endPage}) failed: ${sanitizeStructureError(err)}`);
    return fatal ? sanitizeStructureError(err) : budget ? sanitizeStructureError(err) : null;
  } finally {
    live.delete(job.id);
  }
}

async function finalizeJob(jobId: string, token: string, stopReason: string | null): Promise<void> {
  const chunks = await listStructureChunkStatuses(jobId);
  const done = chunks.filter((c) => c.status === "done").length;
  const failed = chunks.filter((c) => c.status === "failed" || c.status === "skipped").length;
  const unanalysed = chunks.length - done - failed;

  const status =
    stopReason || unanalysed > 0
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

  await releaseJob(
    STRUCTURE_TABLES,
    jobId,
    token,
    sql`status = ${status}, chunks_done = ${done}, chunks_failed = ${failed}, error = ${error}, finished_at = now()`,
  );
}

let sweepTimer: NodeJS.Timeout | null = null;

async function sweep(): Promise<void> {
  try {
    const stale = await requeueStaleJobs(STRUCTURE_TABLES, structureConfig.staleAfterMs);
    if (stale.length > 0) log(`requeued ${stale.length} job(s) whose run stopped responding`);
  } catch (err: any) {
    log(`stale sweep failed: ${sanitizeStructureError(err)}`);
  }
  pump();
}

/**
 * Boot: install the schema, requeue runs whose heartbeat went stale, keep sweeping.
 * Only ranges that never finished are re-sent.
 */
export async function reconcileStructureJobsOnBoot(): Promise<void> {
  try {
    await ensureStructureSchema();
    await sweep();
    if (!sweepTimer) {
      sweepTimer = setInterval(() => void sweep(), Math.max(15_000, Math.floor(structureConfig.staleAfterMs / 2)));
      sweepTimer.unref?.();
    }
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
