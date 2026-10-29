/**
 * OCR job runner.
 *
 * Shape of the work: a job owns an ordered list of page-range chunks (one page
 * each by default). A bounded pool of workers drains that list; each worker takes
 * a process-wide CPU lane, transcribes its pages with the LOCAL engine (PDF text
 * layer or Tesseract — no AI provider, no network) and writes the result straight
 * back to its chunk row:
 *
 *   queue ──claim (SKIP LOCKED)──► runJob ──(pool)──► chunk ──(acquireOcrSlot)──►
 *        transcribeRange ──► fenced chunk write ──► finalize (fenced release)
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
import { localEngine, localEngineSettings } from "./local-engine";
import { splitChunkPages } from "./pages";
import { readPdfPageCount, planChunks } from "./pdf";
import { clearChunkLive, setChunkLive } from "./progress";
import {
  claimableChunks,
  ensureOcrSchema,
  findReusableJob,
  getJob,
  hashBytes,
  insertChunks,
  insertJob,
  jobDir,
  listChunkStatuses,
  listChunkTexts,
  markChunkRunning,
  requeueJobForRetry,
  saveSourceFile,
  writeChunkResult,
} from "./store";
import { OcrTranscribeError, transcribeRange, workDirFor } from "./transcribe";
import { existsSync } from "node:fs";
import path from "node:path";

/** Runs owned by THIS process: cancellation handle + fencing token. */
const activeJobs = new Map<string, { controller: AbortController; token: string }>();

function log(msg: string) {
  console.log(`[ocr] ${msg}`);
}

// ────────────────────────────────────────────────────────────────── creation
export interface CreateOcrJobInput {
  userId: string | null;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  chunkSize?: number;
  quality?: OcrQuality;
  textMode?: OcrTextMode;
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

  const quality: OcrQuality = input.quality === "accurate" ? "accurate" : "fast";
  const textMode: OcrTextMode = input.textMode === "ocr" ? "ocr" : "auto";
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
  const job = await insertJob({
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
    model: availability.tesseractVersion ?? "local",
    instructions: input.instructions?.trim() || null,
    status: "queued",
    chunksTotal: ranges.length,
  });

  await insertChunks(
    ranges.map((range, index) => ({
      jobId: id,
      chunkIndex: index,
      startPage: range.startPage,
      endPage: range.endPage,
      status: "queued" as const,
    })),
  );

  log(`job ${id} created — ${input.fileName}, ${pageCount}p, ${ranges.length} range(s) of ${chunkSize}p, text=${textMode}, ${quality}`);
  pump();
  return { job, reused: false };
}

// ──────────────────────────────────────────────────────────────── scheduling
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
        const availability = await ocrEngineAvailability();
        if (!availability.ok) return; // jobs stay queued; the page shows why
        while (activeJobs.size < ocrConfig.maxActiveJobs) {
          const claim = await claimNextJob(OCR_TABLES);
          if (!claim) break;
          const controller = new AbortController();
          activeJobs.set(claim.id, { controller, token: claim.token });
          void runJob(claim.id, claim.token, controller.signal)
            .catch((err) => log(`job ${claim.id} crashed: ${err?.message || err}`))
            .finally(() => {
              activeJobs.delete(claim.id);
              clearChunkLive(claim.id);
              pump();
            });
        }
      } while (pumpAgain);
    } catch (err: any) {
      log(`scheduler error: ${err?.message || err}`);
    } finally {
      pumping = false;
    }
  })();
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
  return result;
}

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
  pump();
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
      // every page fail with a poppler exit code.
      fatal = "The uploaded file is no longer stored on the server (purged or removed). Upload it again.";
    }
    const dpi = ocrConfig.dpi[job.quality === "accurate" ? "accurate" : "fast"];
    const settings = localEngineSettings();
    let cursor = 0;
    // No workers at all when the job is already stopped; finalizeJob still records why.
    const workerCount = fatal ? 0 : Math.min(ocrConfig.concurrency, pending.length);

    const worker = async () => {
      while (!signal.aborted && !fatal) {
        const index = cursor++;
        if (index >= pending.length) return;
        const chunk = pending[index];
        const outcome = await runChunk(job, token, chunk, { sourcePath, dpi, settings }, signal);
        if (outcome) fatal = outcome;
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
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

function sourceFileName(mimeType: string): string {
  const ext = mimeType === "application/pdf" ? "pdf" : mimeType.split("/")[1] || "bin";
  return `source.${ext}`;
}

/** One range end to end. Returns null, or the message an engine failure should stop the job with. */
async function runChunk(
  job: OcrJob,
  token: string,
  chunk: { chunkIndex: number; startPage: number; endPage: number },
  ctx: { sourcePath: string; dpi: number; settings: ReturnType<typeof localEngineSettings> },
  signal: AbortSignal,
): Promise<string | null> {
  const startedAt = Date.now();
  const label = job.model;
  setChunkLive(job.id, chunk.chunkIndex, { model: label, attempt: 0, maxAttempts: ocrConfig.maxAttempts, phase: "slot" });

  let release: (() => void) | null = null;
  try {
    release = await acquireOcrSlot(signal);
    if (!(await markChunkRunning(job.id, chunk.chunkIndex, token))) return null; // lost the job

    const result = await transcribeRange({
      sourcePath: ctx.sourcePath,
      mimeType: job.mimeType,
      startPage: chunk.startPage,
      endPage: chunk.endPage,
      textMode: job.textMode === "ocr" ? "ocr" : "auto",
      dpi: ctx.dpi,
      workDir: workDirFor(jobDir(job.id), chunk.chunkIndex),
      deps: localEngine,
      settings: ctx.settings,
      maxAttempts: ocrConfig.maxAttempts,
      retryBaseDelayMs: ocrConfig.retryBaseDelayMs,
      signal,
      onProgress: (event) => {
        if (event.kind === "page") {
          setChunkLive(job.id, chunk.chunkIndex, { attempt: event.attempt, phase: "request", nextAttemptAt: null });
        } else {
          setChunkLive(job.id, chunk.chunkIndex, {
            phase: "backoff",
            nextAttemptAt: Date.now() + event.delayMs,
            lastError: `page ${event.page}: ${event.error}`,
          });
        }
      },
    });

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
async function sweep(): Promise<void> {
  try {
    const stale = await requeueStaleJobs(OCR_TABLES, ocrConfig.staleAfterMs);
    if (stale.length > 0) log(`requeued ${stale.length} job(s) whose run stopped responding`);
  } catch (err: any) {
    log(`stale sweep failed: ${err?.message || err}`);
  }
  pump();
}

/**
 * Boot: install the schema, sweep for dead runs, and keep sweeping. A run that
 * died with this process is requeued once its heartbeat is `OCR_STALE_AFTER_MS`
 * old — waiting that long is what makes the sweep safe with more than one process.
 */
export async function reconcileOcrJobsOnBoot(): Promise<void> {
  try {
    await ensureOcrSchema();
    await sweep();
    if (!sweepTimer) {
      sweepTimer = setInterval(() => void sweep(), Math.max(10_000, Math.floor(ocrConfig.staleAfterMs / 2)));
      sweepTimer.unref?.();
    }
    const availability = await ocrEngineAvailability();
    if (!availability.ok) log(`local OCR engine not ready: ${availability.problems.join(" ")}`);
  } catch (err: any) {
    log(`boot reconcile skipped: ${err?.message || err}`);
  }
}
