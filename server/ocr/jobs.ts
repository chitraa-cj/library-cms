/**
 * OCR job runner.
 *
 * Shape of the work: a job owns an ordered list of page-range chunks. A bounded
 * pool of workers drains that list; each worker slices its page range out of the
 * source PDF, waits for a global rate-limit slot, makes exactly one Gemini call
 * (with bounded internal retries) and writes the result straight back to its
 * chunk row. Nothing polls, nothing recurses, and every loop is over a finite
 * list that only ever shrinks:
 *
 *   jobs queue ──(maxActiveJobs)──► runJob ──(pool of `concurrency` workers)──►
 *        chunk ──(acquireOcrSlot)──► Gemini ──► chunk row ──► job counters
 *
 * Because state lives in the chunk rows, a crash, a cancel or a failed page
 * range never costs the pages that already succeeded: resuming re-runs only the
 * chunks that are not `done`.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { ocrJobChunks, ocrJobs, type OcrJob, type OcrPage, type OcrQuality } from "@shared/schema";
import { ocrConfig, isOcrConfigured } from "./config";
import { OcrGeminiError, ocrChunkWithGemini, splitChunkPages } from "./gemini";
import { acquireOcrSlot, OcrBudgetError, recordExtraOcrRequest } from "./limiter";
import { PdfSlicer, fitChunkSize, planChunks, readPdfPageCount } from "./pdf";
import { clearChunkLive, setChunkLive } from "./progress";
import {
  addChunkResultToJob,
  claimableChunks,
  ensureOcrSchema,
  getJob,
  hashBytes,
  insertChunks,
  insertJob,
  listChunks,
  readSourceFile,
  requeueFailedChunks,
  saveSourceFile,
  updateChunk,
  updateJob,
} from "./store";

/** Jobs currently being worked on in this process (cancellation handles). */
const activeJobs = new Map<string, AbortController>();

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
  instructions?: string | null;
}

export async function createOcrJob(input: CreateOcrJobInput): Promise<OcrJob> {
  await ensureOcrSchema();

  const isPdf = input.mimeType === "application/pdf";
  const pageCount = isPdf ? await readPdfPageCount(input.bytes) : 1;
  if (pageCount > ocrConfig.maxPages) {
    const err: any = new Error(
      `This document has ${pageCount} pages; the per-document limit is ${ocrConfig.maxPages}. Split it and upload the parts.`,
    );
    err.status = 400;
    throw err;
  }

  const quality: OcrQuality = input.quality === "accurate" ? "accurate" : "fast";
  const requestedChunk = input.chunkSize && input.chunkSize > 0 ? input.chunkSize : ocrConfig.defaultChunkSize;
  const chunkSize = isPdf ? fitChunkSize(requestedChunk, input.bytes.byteLength, pageCount) : 1;
  const ranges = isPdf ? planChunks(pageCount, chunkSize) : [{ startPage: 1, endPage: 1 }];

  const id = randomUUID();
  await saveSourceFile(id, input.mimeType, input.bytes);

  const job = await insertJob({
    id,
    userId: input.userId,
    fileName: input.fileName,
    mimeType: input.mimeType,
    fileSize: input.bytes.byteLength,
    fileHash: hashBytes(input.bytes),
    pageCount,
    chunkSize,
    quality,
    model: ocrConfig.models[quality],
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

  log(`job ${id} created — ${input.fileName}, ${pageCount}p, ${ranges.length} chunk(s) of ${chunkSize}p, ${job.model}`);
  pump();
  return job;
}

// ──────────────────────────────────────────────────────────────── scheduling
/** Start queued jobs until `maxActiveJobs` are running. Safe to call at any time. */
export function pump(): void {
  void (async () => {
    try {
      if (!isOcrConfigured()) return;
      while (activeJobs.size < ocrConfig.maxActiveJobs) {
        const [next] = await db
          .select()
          .from(ocrJobs)
          .where(eq(ocrJobs.status, "queued"))
          .orderBy(ocrJobs.createdAt)
          .limit(1);
        if (!next || activeJobs.has(next.id)) return;

        const controller = new AbortController();
        activeJobs.set(next.id, controller);
        // A fresh start time per run, so elapsed/ETA measure this run rather
        // than the idle gap before a retry or a restart.
        await updateJob(next.id, { status: "running", startedAt: new Date(), error: null });

        void runJob(next.id, controller.signal)
          .catch((err) => log(`job ${next.id} crashed: ${err?.message || err}`))
          .finally(() => {
            activeJobs.delete(next.id);
            pump();
          });
      }
    } catch (err: any) {
      log(`scheduler error: ${err?.message || err}`);
    }
  })();
}

export function cancelOcrJob(jobId: string): boolean {
  const controller = activeJobs.get(jobId);
  controller?.abort();
  return Boolean(controller);
}

export function isJobActive(jobId: string): boolean {
  return activeJobs.has(jobId);
}

/**
 * Resume a job: failed/skipped ranges go back in the queue, and any range that
 * never finished (e.g. after a cancel) is picked up again. Ranges already
 * transcribed are never re-requested, so resuming a half-finished 300-page book
 * costs only the pages that are actually missing.
 *
 * Returns how many ranges are queued to run.
 */
export async function retryOcrJob(jobId: string): Promise<number> {
  await requeueFailedChunks(jobId);
  const chunks = await listChunks(jobId);
  const done = chunks.filter((c) => c.status === "done").length;
  const pending = chunks.length - done;

  await updateJob(jobId, {
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
  const job = await getJob(jobId);
  if (!job) return;

  const pending = await claimableChunks(jobId);
  if (pending.length === 0) {
    await finalizeJob(jobId);
    return;
  }

  let source: Buffer;
  try {
    source = await readSourceFile(job);
  } catch (err: any) {
    await updateJob(jobId, {
      status: "failed",
      error: `Uploaded file is no longer on disk (${err?.code || err?.message}). Upload it again.`,
      finishedAt: new Date(),
    });
    return;
  }

  const isPdf = job.mimeType === "application/pdf";
  const slicer = isPdf ? await PdfSlicer.load(source) : null;

  // Shared cursor over a finite, immutable list — the pool's only loop.
  let cursor = 0;
  const workerCount = Math.min(ocrConfig.concurrency, pending.length);
  const started = Date.now();

  const worker = async () => {
    while (!signal.aborted) {
      const index = cursor++;
      if (index >= pending.length) return;
      const chunk = pending[index];
      await runChunk(job, chunk, slicer, source, signal);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (signal.aborted) {
    await db
      .update(ocrJobChunks)
      .set({ status: "queued", updatedAt: new Date() })
      .where(and(eq(ocrJobChunks.jobId, jobId), eq(ocrJobChunks.status, "running")));
    await updateJob(jobId, { status: "cancelled", finishedAt: new Date() });
    clearChunkLive(jobId);
    log(`job ${jobId} cancelled`);
    return;
  }

  await finalizeJob(jobId);
  clearChunkLive(jobId);
  log(`job ${jobId} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function runChunk(
  job: OcrJob,
  chunk: { chunkIndex: number; startPage: number; endPage: number; attempts: number },
  slicer: PdfSlicer | null,
  source: Buffer,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = Date.now();
  await updateChunk(job.id, chunk.chunkIndex, { status: "running", error: null });

  // The job's model first, then each fallback — Gemini meters the free tier per
  // model per day, so a spent daily quota is worth one immediate try on the next
  // model and nothing more. A finite list, one pass, no retry inside it.
  const models = [job.model, ...ocrConfig.fallbackModels.filter((m) => m !== job.model)];
  let requestsSpent = 0;
  let lastError: any = null;
  setChunkLive(job.id, chunk.chunkIndex, {
    model: job.model,
    attempt: 0,
    maxAttempts: ocrConfig.maxAttempts,
    phase: "slot",
  });

  try {
    const bytes = slicer
      ? await slicer.slice(chunk.startPage, chunk.endPage)
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);

    for (const model of models) {
      if (signal.aborted) break;
      setChunkLive(job.id, chunk.chunkIndex, { model, attempt: 0, phase: "slot", nextAttemptAt: null });
      const release = await acquireOcrSlot(signal);
      try {
        const result = await ocrChunkWithGemini({
          bytes,
          mimeType: job.mimeType,
          model,
          startPage: chunk.startPage,
          endPage: chunk.endPage,
          totalPages: job.pageCount,
          instructions: job.instructions,
          thinking: job.quality === "accurate",
          onRetryAttempt: recordExtraOcrRequest,
          onProgress: (event) => {
            if (event.kind === "attempt") {
              setChunkLive(job.id, chunk.chunkIndex, { attempt: event.attempt, phase: "request", nextAttemptAt: null });
            } else {
              setChunkLive(job.id, chunk.chunkIndex, {
                phase: "backoff",
                nextAttemptAt: Date.now() + event.delayMs,
                lastError: event.error,
              });
            }
          },
          // With fallbacks available, two 503s are enough to hand the range to
          // the next model; without them, keep the full retry budget.
          overloadAttempts: models.length > 1 ? Math.min(2, ocrConfig.maxAttempts) : ocrConfig.maxAttempts,
          signal,
        });
        requestsSpent += result.attempts;

        await updateChunk(job.id, chunk.chunkIndex, {
          status: "done",
          markdown: result.text,
          model,
          attempts: chunk.attempts + requestsSpent,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          durationMs: Date.now() - startedAt,
          error: null,
        });
        await addChunkResultToJob(job.id, {
          done: 1,
          failed: 0,
          requests: requestsSpent,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });
        if (model !== job.model) {
          const why = lastError instanceof OcrGeminiError && lastError.overloaded ? "busy" : "daily quota spent";
          log(`job ${job.id} chunk ${chunk.chunkIndex} fell back to ${model} (${job.model} ${why})`);
        }
        return;
      } catch (err: any) {
        lastError = err;
        requestsSpent += err instanceof OcrGeminiError ? err.attempts : 0;
        // A spent daily quota or an overloaded model is worth trying the next
        // model (separate quota, separate capacity); anything else (bad input,
        // safety block, cancellation) would fail there too.
        const handOver = err instanceof OcrGeminiError && (err.quotaExhausted || err.overloaded);
        if (!handOver) break;
        setChunkLive(job.id, chunk.chunkIndex, { lastError: String(err?.message || err) });
        if (err.overloaded) log(`job ${job.id} chunk ${chunk.chunkIndex}: ${model} overloaded (503), trying the next model`);
      } finally {
        release();
      }
    }

    throw lastError ?? new Error("No model produced a transcription.");
  } catch (err: any) {
    const cancelled = signal.aborted || err?.message === "cancelled";
    if (cancelled) {
      await updateChunk(job.id, chunk.chunkIndex, { status: "queued", durationMs: Date.now() - startedAt });
      if (requestsSpent > 0) {
        await addChunkResultToJob(job.id, {
          done: 0,
          failed: 0,
          requests: requestsSpent,
          inputTokens: 0,
          outputTokens: 0,
        });
      }
      return;
    }
    const budget = err instanceof OcrBudgetError;
    await updateChunk(job.id, chunk.chunkIndex, {
      status: budget ? "skipped" : "failed",
      attempts: chunk.attempts + Math.max(requestsSpent, 1),
      durationMs: Date.now() - startedAt,
      error: String(err?.message || err).slice(0, 1000),
    });
    await addChunkResultToJob(job.id, {
      done: 0,
      failed: 1,
      requests: requestsSpent,
      inputTokens: 0,
      outputTokens: 0,
    });
    log(`job ${job.id} chunk ${chunk.chunkIndex} (p${chunk.startPage}-${chunk.endPage}) failed: ${err?.message || err}`);
  } finally {
    clearChunkLive(job.id, chunk.chunkIndex);
  }
}

async function finalizeJob(jobId: string): Promise<void> {
  const chunks = await listChunks(jobId);
  const done = chunks.filter((c) => c.status === "done").length;
  const failed = chunks.filter((c) => c.status === "failed" || c.status === "skipped").length;
  const status = failed === 0 ? "done" : done === 0 ? "failed" : "partial";
  const firstError = chunks.find((c) => c.error)?.error ?? null;

  await updateJob(jobId, {
    status,
    chunksDone: done,
    chunksFailed: failed,
    finishedAt: new Date(),
    error: status === "done" ? null : firstError,
  });
}

// ───────────────────────────────────────────────────────────────── assembly
export interface OcrDocument {
  pages: OcrPage[];
  markdown: string;
  missingRanges: Array<{ startPage: number; endPage: number; error: string | null }>;
}

/** Merge the finished chunks into one page-ordered document. */
export async function buildOcrDocument(jobId: string): Promise<OcrDocument> {
  const chunks = await listChunks(jobId);
  const byPage = new Map<number, string>();
  const missingRanges: OcrDocument["missingRanges"] = [];

  for (const chunk of chunks) {
    if (chunk.status !== "done" || !chunk.markdown) {
      missingRanges.push({ startPage: chunk.startPage, endPage: chunk.endPage, error: chunk.error });
      continue;
    }
    for (const page of splitChunkPages(chunk.markdown, chunk.startPage, chunk.endPage)) {
      const existing = byPage.get(page.page);
      // A duplicate page number can only come from a marker the model repeated;
      // keep the longer transcription rather than dropping text.
      if (!existing || page.markdown.length > existing.length) byPage.set(page.page, page.markdown);
    }
  }

  const pages = [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, markdown]) => ({ page, markdown }));

  const markdown = pages.map((p) => `<!-- page ${p.page} -->\n\n${p.markdown}`).join("\n\n---\n\n");
  return { pages, markdown, missingRanges };
}

/**
 * After a restart, jobs left `running` own no worker. Put their in-flight chunks
 * back in the queue and let the scheduler resume them — only chunks that never
 * finished are re-requested, so resuming costs nothing for completed pages.
 */
export async function reconcileOcrJobsOnBoot(): Promise<void> {
  try {
    await ensureOcrSchema();
    await db
      .update(ocrJobChunks)
      .set({ status: "queued", updatedAt: new Date() })
      .where(inArray(ocrJobChunks.status, ["running"]));
    const stale = await db
      .update(ocrJobs)
      .set({ status: "queued", updatedAt: new Date() })
      .where(eq(ocrJobs.status, "running"))
      .returning({ id: ocrJobs.id });
    if (stale.length > 0) log(`requeued ${stale.length} job(s) interrupted by a restart`);
    pump();
  } catch (err: any) {
    log(`boot reconcile skipped: ${err?.message || err}`);
  }
}
