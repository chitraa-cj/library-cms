/**
 * OCR job runner.
 *
 * Shape of the work: a job owns an ordered list of page-range chunks (one page
 * each by default). A bounded pool of workers drains that list; each worker takes
 * the process-wide lane, transcribes its pages with Gemini through Hermex (on the
 * dedicated document profile — one browser session per job, one lane; there is no
 * other engine and no fallback) and writes the result straight back to its chunk
 * row only after the answer passed validation:
 *
 *   queue ──claim (SKIP LOCKED)──► runJob ──(pool)──► chunk ──(acquireOcrSlot)──►
 *        transcribeRange ──► fenced chunk write ──► finalize (fenced release)
 *
 * Where it runs: ONLY in the `cms-ocr-worker` process (server/ocr/worker-main.ts),
 * which calls `startOcrScheduler()`. The web app imports this module for job
 * management (create, retry, cancel, delete, documents) and never claims a job:
 * until the scheduler is started, `pump()` returns without touching the queue, and
 * nothing here starts a timer at import time. The API wakes the worker with a
 * Postgres NOTIFY after it queues work; the worker also polls, so a lost
 * notification only delays a job by one poll.
 *
 * Ownership (server/lib/job-lease.ts): a job is claimed atomically, every write of
 * a run is fenced on its run token, and a heartbeat proves the run is alive. So:
 *   - two processes, or two pumps, can never run one job;
 *   - a run that lost its job (cancelled, or requeued as stale) writes nothing;
 *   - a crashed run's job is requeued once its heartbeat goes stale, and only its
 *     unfinished ranges run again — finished pages are never redone.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";
import type { OcrJob, OcrPage, OcrQuality, OcrTextMode } from "@shared/schema";
import type { OcrPageMeta } from "@shared/ocr-quality";
import {
  claimNextJob,
  heartbeat,
  OCR_TABLES,
  releaseJob,
  requeueStaleJobs,
} from "../lib/job-lease";
import { ocrEngineAvailability } from "./availability";
import { ocrConfig } from "./config";
import { acquireOcrSlot } from "./limiter";
import { createHermexOcrEngine, type HermexOcrEngine, type OcrSession } from "./hermex-engine";
import { splitChunkPages } from "./pages";
import { readPdfPageCount, planChunks } from "./pdf";
import { clearChunkLive, setChunkLive, setLiveSink } from "./progress";
import {
  claimableChunks,
  ensureOcrSchema,
  findReusableJob,
  getJob,
  hashBytes,
  insertJobWithChunks,
  jobDir,
  listChunkStatuses,
  listChunkTexts,
  markChunkRunning,
  requeueJobForRetry,
  saveSourceFile,
  writeChunkLive,
  writeChunkResult,
} from "./store";
import { OcrTranscribeError, workDirFor, type OcrRangeProgress } from "./transcribe";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Test seam: replaces the browser session the engine opens (the engine, its prompt,
 * its validation and the persistence around it stay real). Production never sets it.
 */
let sessionFactory: ((signal?: AbortSignal) => Promise<OcrSession>) | null = null;
export function setOcrSessionFactory(factory: typeof sessionFactory): void {
  sessionFactory = factory;
}

/** Runs owned by THIS process: cancellation handle + fencing token + the run itself. */
const activeJobs = new Map<string, { controller: AbortController; token: string; run: Promise<void> }>();

function log(msg: string) {
  console.log(`[ocr] ${msg}`);
}

/** Postgres channels between the web app (sender) and the OCR worker (listener). */
export const OCR_QUEUE_CHANNEL = "cms_ocr_queue";
export const OCR_CANCEL_CHANNEL = "cms_ocr_cancel";

/**
 * Best-effort wakeup for the worker. The database row is the truth; if this
 * notification is lost the worker's poll finds the job anyway.
 */
async function notifyWorker(channel: string, payload: string): Promise<void> {
  try {
    await db.execute(sql`select pg_notify(${channel}, ${payload})`);
  } catch (err: any) {
    log(`could not notify the OCR worker (${channel}); it will find the change on its next poll: ${err?.message || err}`);
  }
}

// ────────────────────────────────────────────────────────────────── creation
export interface CreateOcrJobInput {
  userId: string | null;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  chunkSize?: number;
  instructions?: string | null;
  /** Create a new job even when an identical upload already has one. */
  force?: boolean;
}

export interface CreateOcrJobResult {
  job: OcrJob;
  /** True when an existing job for the same bytes + settings was returned instead. */
  reused: boolean;
}

export async function createOcrJob(input: CreateOcrJobInput): Promise<CreateOcrJobResult> {
  await ensureOcrSchema();

  // Kept for the schema and old rows. Every page is transcribed by Gemini, so a job's
  // text mode is always "ocr"; resolution is Gemini's business ("fast" = unused label).
  const quality: OcrQuality = "fast";
  const textMode: OcrTextMode = "ocr";
  const fileHash = hashBytes(input.bytes);

  // Idempotency: the same bytes with the same settings are the same work. A double
  // click or a browser retry gets the existing job back instead of a duplicate.
  if (!input.force) {
    const existing = await findReusableJob(fileHash, textMode, quality);
    // Only a job whose original is still stored can be reused: a purged upload could
    // never be resumed or compared against.
    if (existing && existsSync(path.join(jobDir(existing.id), sourceFileName(existing.mimeType)))) {
      log(`upload of ${input.fileName} matches job ${existing.id} (${existing.status}) — reusing it`);
      return { job: existing, reused: true };
    }
  }

  const isPdf = input.mimeType === "application/pdf";
  const pageCount = isPdf ? await readPdfPageCount(input.bytes) : 1;
  if (pageCount === 0) {
    const err: any = new Error("This PDF has no pages.");
    err.status = 400;
    throw err;
  }
  if (pageCount > ocrConfig.maxPages) {
    const err: any = new Error(
      `This document has ${pageCount} pages; the per-document limit is ${ocrConfig.maxPages}. Split it and upload the parts.`,
    );
    err.status = 400;
    throw err;
  }

  const requested = input.chunkSize && input.chunkSize > 0 ? input.chunkSize : ocrConfig.defaultChunkSize;
  const chunkSize = isPdf ? Math.min(Math.max(1, Math.floor(requested)), ocrConfig.maxChunkSize) : 1;
  const ranges = isPdf ? planChunks(pageCount, chunkSize) : [{ startPage: 1, endPage: 1 }];

  const id = randomUUID();
  // The original upload is written once and never modified; every stage reads it.
  await saveSourceFile(id, input.mimeType, input.bytes);

  const availability = await ocrEngineAvailability();
  // Job and ranges commit together (see insertJobWithChunks); the NOTIFY below is
  // sent only after that commit.
  const job = await insertJobWithChunks({
    id,
    userId: input.userId,
    fileName: input.fileName,
    mimeType: input.mimeType,
    fileSize: input.bytes.byteLength,
    fileHash,
    pageCount,
    chunkSize,
    quality,
    textMode,
    model: availability.engineLabel,
    instructions: input.instructions?.trim() || null,
    status: "queued",
    chunksTotal: ranges.length,
  }, ranges.map((range, index) => ({
    jobId: id,
    chunkIndex: index,
    startPage: range.startPage,
    endPage: range.endPage,
    status: "queued" as const,
  })));

  log(`job ${id} created — ${input.fileName}, ${pageCount}p, ${ranges.length} range(s) of ${chunkSize}p`);
  await notifyWorker(OCR_QUEUE_CHANNEL, id);
  return { job, reused: false };
}

// ──────────────────────────────────────────────────────────────── scheduling
/** Set by startOcrScheduler (the worker); while false nothing here claims a job. */
let schedulerRunning = false;
let pumping = false;
let pumpAgain = false;
let lastNotReady: string | null = null;

/**
 * Start queued jobs until `maxActiveJobs` run in this process. A no-op unless this
 * process started the scheduler — the web app calls nothing that reaches a claim.
 * Never overlaps itself: a call during a pass schedules one more pass.
 */
export function pump(): void {
  if (!schedulerRunning) return;
  if (pumping) {
    pumpAgain = true;
    return;
  }
  pumping = true;
  void (async () => {
    try {
      do {
        pumpAgain = false;
        const availability = await ocrEngineAvailability();
        if (!availability.ok) {
          // Jobs stay queued; the page shows why. Logged once per change, not per poll.
          const why = availability.problems.join(" ");
          if (why !== lastNotReady) log(`not claiming jobs — OCR (Hermex) not ready: ${why}`);
          lastNotReady = why;
          return;
        }
        if (lastNotReady) log("OCR (Hermex) is ready — claiming queued jobs");
        lastNotReady = null;
        while (schedulerRunning && activeJobs.size < ocrConfig.maxActiveJobs) {
          const claim = await claimNextJob(OCR_TABLES);
          if (!claim) break;
          if (!schedulerRunning) {
            // Shutdown began while this claim was in flight: hand it straight back.
            await releaseJob(OCR_TABLES, claim.id, claim.token, sql`status = 'queued'`).catch(() => undefined);
            break;
          }
          log(`claimed job ${claim.id}`);
          const controller = new AbortController();
          const run = runJob(claim.id, claim.token, controller.signal)
            .catch((err) => log(`job ${claim.id} crashed: ${err?.message || err}`))
            .finally(() => {
              activeJobs.delete(claim.id);
              clearChunkLive(claim.id);
              pump();
            });
          activeJobs.set(claim.id, { controller, token: claim.token, run });
        }
      } while (pumpAgain && schedulerRunning);
    } catch (err: any) {
      log(`scheduler error: ${err?.message || err}`);
    } finally {
      pumping = false;
    }
  })();
}

export interface OcrSchedulerOptions {
  /** Fallback poll for queued jobs (a NOTIFY normally wakes the worker sooner). */
  pollMs?: number;
  /** How often runs with a stale heartbeat are requeued. */
  sweepMs?: number;
  /** Disable LISTEN (tests of the polling fallback). */
  listen?: boolean;
}

let pollTimer: NodeJS.Timeout | null = null;
let listener: { client: any; reconnect: NodeJS.Timeout | null } | null = null;

/**
 * Worker only: install the schema, requeue dead runs, then claim and run jobs —
 * woken by NOTIFY from the web app, by a poll as the fallback, and after every job.
 * Idempotent.
 */
export async function startOcrScheduler(opts: OcrSchedulerOptions = {}): Promise<void> {
  if (schedulerRunning) return;
  await ensureOcrSchema();
  schedulerRunning = true;
  // Live progress is written to the chunk rows so the web app can show it.
  setLiveSink((jobId, chunkIndex, state) => writeChunkLive(jobId, chunkIndex, state));
  const pollMs = opts.pollMs ?? ocrConfig.pollMs;
  const sweepMs = opts.sweepMs ?? Math.max(10_000, Math.floor(ocrConfig.staleAfterMs / 2));
  pollTimer = setInterval(() => pump(), pollMs);
  sweepTimer = setInterval(() => void sweep(), sweepMs);
  if (opts.listen !== false) await listen();
  log(`scheduler started (poll ${pollMs}ms, stale sweep ${sweepMs}ms, NOTIFY ${listener ? "on" : "off"})`);
  await sweep();
}

async function listen(): Promise<void> {
  const { pool } = await import("../db");
  const state: { client: any; reconnect: NodeJS.Timeout | null } = { client: null, reconnect: null };
  listener = state;
  const retry = () => {
    if (!schedulerRunning || listener !== state || state.reconnect) return;
    state.reconnect = setTimeout(() => {
      state.reconnect = null;
      void connect();
    }, 5_000);
  };
  const connect = async () => {
    if (!schedulerRunning || listener !== state) return;
    try {
      const client = await pool.connect();
      client.on("notification", (msg: { channel: string; payload?: string }) => {
        if (msg.channel === OCR_QUEUE_CHANNEL) pump();
        else if (msg.channel === OCR_CANCEL_CHANNEL && msg.payload) {
          const local = activeJobs.get(msg.payload);
          if (local) {
            log(`job ${msg.payload} cancelled from the web app — stopping`);
            local.controller.abort();
          }
        }
      });
      let lost = false;
      const onLost = (err?: Error) => {
        if (lost) return;
        lost = true;
        if (!schedulerRunning || listener !== state) return;
        log(`NOTIFY connection lost (${err?.message ?? "closed"}); polling continues, reconnecting`);
        try {
          client.release(err ?? new Error("closed"));
        } catch {}
        if (state.client === client) state.client = null;
        retry();
      };
      client.on("error", (err: Error) => onLost(err));
      client.on("end", () => onLost());
      await client.query(`LISTEN ${OCR_QUEUE_CHANNEL}`);
      await client.query(`LISTEN ${OCR_CANCEL_CHANNEL}`);
      state.client = client;
      if (!schedulerRunning || listener !== state) {
        client.release();
        state.client = null;
      }
    } catch (err: any) {
      log(`could not LISTEN for new jobs (${err?.message || err}); polling only, retrying`);
      retry();
    }
  };
  await connect();
}

export interface StopOcrSchedulerResult {
  /** Jobs this process was running, handed back to the queue for the next boot. */
  requeued: string[];
}

/**
 * Worker shutdown: stop claiming (timers, LISTEN, pump), stop the runs in flight
 * and hand their jobs straight back to the queue — fenced on each run's token, so a
 * job cancelled meanwhile stays cancelled and a job already taken over is not
 * touched. Finished pages are kept; the next run does only what is missing. Runs
 * that do not wind up within `graceMs` are left to the stale sweep.
 */
export async function stopOcrScheduler(opts: { graceMs?: number } = {}): Promise<StopOcrSchedulerResult> {
  schedulerRunning = false;
  if (pollTimer) clearInterval(pollTimer);
  if (sweepTimer) clearInterval(sweepTimer);
  pollTimer = null;
  sweepTimer = null;
  const l = listener;
  listener = null;
  if (l) {
    if (l.reconnect) clearTimeout(l.reconnect);
    if (l.client) {
      await l.client.query(`UNLISTEN *`).catch(() => undefined);
      try {
        l.client.release();
      } catch {}
    }
  }

  const runs = [...activeJobs.entries()];
  for (const [, run] of runs) run.controller.abort();
  const graceMs = opts.graceMs ?? 20_000;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled(runs.map(([, r]) => r.run)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, graceMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  const requeued: string[] = [];
  for (const [jobId, run] of runs) {
    const handedBack = await releaseJob(OCR_TABLES, jobId, run.token, sql`status = 'queued'`).catch(() => false);
    if (handedBack) {
      await db
        .execute(sql`update cms_ocr_job_chunks set status = 'queued', updated_at = now() where job_id = ${jobId} and status = 'running'`)
        .catch(() => undefined);
      requeued.push(jobId);
    }
  }
  setLiveSink(null);
  if (requeued.length) log(`shutdown: handed ${requeued.length} job(s) back to the queue: ${requeued.join(", ")}`);
  log("scheduler stopped");
  return { requeued };
}

export function isOcrSchedulerRunning(): boolean {
  return schedulerRunning;
}

/**
 * Cancel a job wherever it runs. Locally the run is aborted; in the database the
 * job is marked cancelled and its token cleared, so a run in ANOTHER process sees
 * its heartbeat fail, stops, and has every remaining write fenced off.
 * Finished pages are kept.
 */
export async function cancelOcrJob(jobId: string): Promise<boolean> {
  activeJobs.get(jobId)?.controller.abort();
  const result = await db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      update cms_ocr_jobs set status = 'cancelled', run_token = null, finished_at = now(), updated_at = now()
       where id = ${jobId} and status in ('queued', 'running')
      returning id`);
    await tx.execute(sql`
      update cms_ocr_job_chunks set status = 'queued', updated_at = now()
       where job_id = ${jobId} and status = 'running'`);
    return ((updated as any).rows ?? []).length > 0;
  });
  // The worker stops at once instead of at its next heartbeat; the cleared token
  // already fences every write it could still make.
  if (result) await notifyWorker(OCR_CANCEL_CHANNEL, jobId);
  return result;
}

/** Is THIS process running the job? Only meaningful in the worker. */
export function isJobActive(jobId: string): boolean {
  return activeJobs.has(jobId);
}

/**
 * Resume a job: failed/skipped ranges go back in the queue, and any range that
 * never finished (e.g. after a cancel) is picked up again. Ranges already
 * transcribed are never re-run. Returns null when the job is still queued/running.
 */
export async function retryOcrJob(jobId: string): Promise<number | null> {
  const outcome = await requeueJobForRetry(jobId);
  if (!outcome) return null;
  if (outcome.pending > 0) await notifyWorker(OCR_QUEUE_CHANNEL, jobId);
  return outcome.pending;
}

// ─────────────────────────────────────────────────────────────────── running
async function runJob(jobId: string, token: string, signal: AbortSignal): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  const started = Date.now();

  // Liveness: refresh the heartbeat while running; losing ownership aborts the run.
  const beatEvery = Math.max(5_000, Math.floor(ocrConfig.staleAfterMs / 4));
  const local = activeJobs.get(jobId);
  const beat = setInterval(() => {
    heartbeat(OCR_TABLES, jobId, token)
      .then((owned) => {
        if (!owned && !signal.aborted) {
          log(`job ${jobId} no longer owned by this run — stopping`);
          local?.controller.abort();
        }
      })
      .catch((err) => log(`job ${jobId} heartbeat failed: ${err?.message || err}`));
  }, beatEvery);
  beat.unref?.();

  let fatal: string | null = null;
  try {
    const pending = await claimableChunks(jobId);
    const sourcePath = path.join(jobDir(job.id), sourceFileName(job.mimeType));
    if (!existsSync(sourcePath)) {
      // Nothing can be (re)transcribed without the original; say so instead of letting
      // every page fail on a missing file.
      fatal = "The uploaded file is no longer stored on the server (purged or removed). Upload it again.";
    }
    const engine = createHermexOcrEngine({ label: jobId, openSession: sessionFactory ?? undefined });
    let cursor = 0;
    // No workers at all when the job is already stopped; finalizeJob still records why.
    const workerCount = fatal ? 0 : Math.min(ocrConfig.concurrency, pending.length);

    const worker = async () => {
      while (!signal.aborted && !fatal) {
        const index = cursor++;
        if (index >= pending.length) return;
        const chunk = pending[index];
        const outcome = await runChunk(job, token, chunk, { sourcePath, engine }, signal);
        if (outcome) fatal = outcome;
      }
    };
    try {
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    } finally {
      // The browser lives for the job, not the process: free the profile for the next job.
      await engine.close();
    }
  } finally {
    clearInterval(beat);
  }

  if (signal.aborted) {
    // Either a cancel (already recorded by cancelOcrJob) or lost ownership: in both
    // cases this run has nothing more to say. The fence makes any write a no-op.
    log(`job ${jobId} stopped after ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return;
  }

  await finalizeJob(jobId, token, fatal);
  log(`job ${jobId} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function withWorkDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true });
  try {
    return await fn();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function sourceFileName(mimeType: string): string {
  const ext = mimeType === "application/pdf" ? "pdf" : mimeType.split("/")[1] || "bin";
  return `source.${ext}`;
}

/** One range end to end. Returns null, or the message an engine failure should stop the job with. */
async function runChunk(
  job: OcrJob,
  token: string,
  chunk: { chunkIndex: number; startPage: number; endPage: number },
  ctx: { sourcePath: string; engine: HermexOcrEngine },
  signal: AbortSignal,
): Promise<string | null> {
  const startedAt = Date.now();
  const label = job.model;
  setChunkLive(job.id, chunk.chunkIndex, { model: label, attempt: 0, maxAttempts: ocrConfig.maxAttempts, phase: "slot" });

  let release: (() => void) | null = null;
  try {
    release = await acquireOcrSlot(signal);
    if (!(await markChunkRunning(job.id, chunk.chunkIndex, token))) return null; // lost the job

    const onProgress = (event: OcrRangeProgress) => {
      if (event.kind === "page") {
        setChunkLive(job.id, chunk.chunkIndex, { attempt: event.attempt, phase: "request", nextAttemptAt: null });
      } else {
        setChunkLive(job.id, chunk.chunkIndex, {
          phase: "backoff",
          nextAttemptAt: Date.now() + event.delayMs,
          lastError: `page ${event.page}: ${event.error}`,
        });
      }
    };
    const workDir = workDirFor(jobDir(job.id), chunk.chunkIndex);
    const result = await withWorkDir(workDir, () =>
      ctx.engine.transcribeRange({
        sourcePath: ctx.sourcePath,
        mimeType: job.mimeType,
        startPage: chunk.startPage,
        endPage: chunk.endPage,
        workDir,
        instructions: job.instructions,
        maxAttempts: ocrConfig.maxAttempts,
        signal,
        onProgress,
      }),
    );

    // Validate before persisting: exactly the pages of this range, in order, once each.
    const expected = chunk.endPage - chunk.startPage + 1;
    const pages = result.pages.map((p) => p.page);
    const inOrder = pages.every((p, i) => p === chunk.startPage + i);
    if (pages.length !== expected || !inOrder) {
      throw new OcrTranscribeError(
        "bad_input",
        `Internal check failed: range ${chunk.startPage}-${chunk.endPage} produced pages [${pages.join(", ")}].`,
      );
    }

    await writeChunkResult(job.id, chunk.chunkIndex, token, {
      status: "done",
      markdown: result.markdown,
      rawText: result.raw,
      pagesMeta: result.pages,
      model: result.engine,
      attempts: result.attempts,
      durationMs: Date.now() - startedAt,
    });
    return null;
  } catch (err: any) {
    const cancelled =
      signal.aborted || err?.message === "cancelled" || (err instanceof OcrTranscribeError && err.kind === "cancelled");
    if (cancelled) {
      await writeChunkResult(job.id, chunk.chunkIndex, token, {
        status: "queued",
        durationMs: Date.now() - startedAt,
        error: null,
      }).catch(() => undefined);
      return null;
    }
    const message = String(err?.message || err).slice(0, 1000);
    const fatal = err instanceof OcrTranscribeError && err.fatal;
    // An engine-wide failure leaves the range queued (Retry resumes it once the
    // engine is fixed); a page-specific one marks the range failed.
    await writeChunkResult(job.id, chunk.chunkIndex, token, {
      status: fatal ? "queued" : "failed",
      attempts: err instanceof OcrTranscribeError ? err.attempts : 1,
      durationMs: Date.now() - startedAt,
      error: message,
    });
    log(`job ${job.id} range ${chunk.chunkIndex} (p${chunk.startPage}-${chunk.endPage}) ${fatal ? "stopped" : "failed"}: ${message}`);
    return fatal ? `The OCR engine is not usable on this server: ${message}` : null;
  } finally {
    release?.();
    clearChunkLive(job.id, chunk.chunkIndex);
  }
}

async function finalizeJob(jobId: string, token: string, stopReason: string | null): Promise<void> {
  const chunks = await listChunkStatuses(jobId);
  if (chunks.length === 0) {
    // Never report an empty job as done.
    await releaseJob(OCR_TABLES, jobId, token, sql`status = 'failed', error = 'This job has no page ranges. Upload the file again.', finished_at = now()`);
    return;
  }
  const done = chunks.filter((c) => c.status === "done").length;
  const failed = chunks.filter((c) => c.status === "failed" || c.status === "skipped").length;
  const unfinished = chunks.length - done - failed;
  const status =
    stopReason || unfinished > 0
      ? done === 0
        ? "failed"
        : "partial"
      : failed === 0
        ? "done"
        : done === 0
          ? "failed"
          : "partial";
  const firstError = chunks.find((c) => c.error)?.error ?? null;
  const error =
    status === "done"
      ? null
      : stopReason
        ? `${stopReason}${unfinished > 0 ? ` ${unfinished} range(s) were not transcribed — press Retry once it is fixed.` : ""}`
        : firstError;

  // Completion is written only after every range's result is persisted, and only
  // by the run that still owns the job.
  await releaseJob(
    OCR_TABLES,
    jobId,
    token,
    sql`status = ${status}, chunks_done = ${done}, chunks_failed = ${failed},
        error = ${error}, finished_at = now()`,
  );
}

// ───────────────────────────────────────────────────────────────── assembly
export interface OcrDocument {
  pages: OcrPage[];
  markdown: string;
  missingRanges: Array<{ startPage: number; endPage: number; error: string | null }>;
}

/** Merge the finished ranges into one page-ordered document. */
export async function buildOcrDocument(jobId: string): Promise<OcrDocument> {
  const chunks = await listChunkTexts(jobId);
  const byPage = new Map<number, OcrPage>();
  const missingRanges: OcrDocument["missingRanges"] = [];

  for (const chunk of chunks) {
    if (chunk.status !== "done" || chunk.markdown == null) {
      missingRanges.push({ startPage: chunk.startPage, endPage: chunk.endPage, error: chunk.error });
      continue;
    }
    const metas = new Map(((chunk.pagesMeta ?? []) as OcrPageMeta[]).map((m) => [m.page, m]));
    for (const page of splitChunkPages(chunk.markdown, chunk.startPage, chunk.endPage)) {
      const existing = byPage.get(page.page);
      // Only rows from the old model path can repeat a page; keep the longer text.
      if (!existing || page.markdown.length > existing.markdown.length) {
        const meta = metas.get(page.page);
        byPage.set(page.page, meta ? { ...page, meta } : page);
      }
    }
  }

  const pages = [...byPage.values()].sort((a, b) => a.page - b.page);
  const markdown = pages.map((p) => `<!-- page ${p.page} -->\n\n${p.markdown}`).join("\n\n---\n\n");
  return { pages, markdown, missingRanges };
}

// ─────────────────────────────────────────────────────────────── recovery
let sweepTimer: NodeJS.Timeout | null = null;

/** Requeue runs whose heartbeat went stale, then schedule. Never touches a live run. */
export async function sweep(): Promise<void> {
  try {
    const stale = await requeueStaleJobs(OCR_TABLES, ocrConfig.staleAfterMs);
    if (stale.length > 0) log(`requeued ${stale.length} job(s) whose run stopped responding`);
  } catch (err: any) {
    log(`stale sweep failed: ${err?.message || err}`);
  }
  pump();
}

/**
 * Web app boot: install the schema and report readiness. It claims nothing, sweeps
 * nothing and starts no timer — that is the worker's job (startOcrScheduler).
 */
export async function prepareOcrApi(): Promise<void> {
  try {
    await ensureOcrSchema();
    const availability = await ocrEngineAvailability();
    if (!availability.ok) log(`OCR (Hermex) not ready: ${availability.problems.join(" ")}`);
  } catch (err: any) {
    log(`schema bootstrap skipped: ${err?.message || err}`);
  }
}
