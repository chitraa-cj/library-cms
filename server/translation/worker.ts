/**
 * Translation worker loop.
 *
 * Runs in its OWN process (server/translation/worker-main.ts, pm2 app
 * `cms-translation-worker`) — never inside an HTTP request. The web API only
 * writes rows; this process is the only thing that talks to Chrome, so a job
 * that runs for a week costs the website nothing and closing the browser that
 * started it changes nothing.
 *
 * The loop is deliberately boring:
 *
 *   claim one item (FOR UPDATE SKIP LOCKED)
 *     → heartbeat its lease while translating
 *     → completed, or requeued/failed with the error recorded
 *     → recount the job from its rows
 *   nothing to claim → sleep WORKER_POLL_INTERVAL
 *
 * Everything that matters is a row in Postgres, so a crash at any line above
 * loses at most the one mantra in flight — and even that one resumes at the
 * first language still missing, because the Hermex pipeline re-checks Strapi.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { translationItems, translationJobs, type TranslationItem } from "@shared/schema";
import { sanitizeTranslationError, translationConfig } from "./config";
import { TranslationDisabledError, translateMantra } from "./hermex-runner";
import {
  claimNextItem,
  ensureTranslationSchema,
  failItem,
  completeItem,
  getTranslationJob,
  heartbeatItem,
  markJobStarted,
  refreshJobProgress,
  releaseItem,
  requeueExpiredLeases,
  requeueOwnedItems,
  touchJob,
} from "./store";

export function workerLog(event: string, detail: string): void {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${stamp}] [translation-worker] ${event} ${detail}`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** Reject the item if a single mantra somehow runs past TRANSLATION_TIMEOUT. */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} exceeded TRANSLATION_TIMEOUT (${Math.round(ms / 1000)}s)`));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface WorkerOptions {
  workerId?: string;
  signal?: AbortSignal;
  /** Stop after this many items — used by tests; undefined means run forever. */
  maxItems?: number;
  /** Stop as soon as the queue is empty instead of polling — used by tests. */
  exitWhenIdle?: boolean;
  /** Swappable for tests so the loop can be exercised without Chrome. */
  translate?: typeof translateMantra;
}

/**
 * One item, start to finish. Exported so tests can drive a single pass without
 * the surrounding loop.
 */
export async function processOneItem(opts: WorkerOptions = {}): Promise<"done" | "idle"> {
  const workerId = opts.workerId ?? translationConfig.workerId;
  const translate = opts.translate ?? translateMantra;

  const item = await claimNextItem(workerId);
  if (!item) return "idle";

  const job = await getTranslationJob(item.jobId);
  if (!job) {
    // The job vanished (deleted) between claim and read — drop the orphan.
    await failItem(item.id, "Parent job no longer exists.", translationConfig.maxRetries);
    return "done";
  }

  // A job cancelled while this item sat in the queue: hand it back untouched
  // rather than spending a Gemini round-trip on work nobody wants.
  if (job.status === "cancelled") {
    await releaseItem(item.id, "Job cancelled before this item ran.");
    await db
      .update(translationItems)
      .set({ status: "failed", error: "Job cancelled by an administrator." })
      .where(and(eq(translationItems.id, item.id), eq(translationItems.status, "queued")));
    await refreshJobProgress(job.id);
    return "done";
  }

  await markJobStarted(job.id);
  // Recount now, not just when the item lands: a mantra can take an hour, and
  // until this runs the job LIST endpoint (which reads the stored counters
  // rather than recomputing) would still show the item as queued.
  await refreshJobProgress(job.id);
  workerLog("ITEM CLAIMED", `job ${job.id} item #${item.sequenceNumber} (${item.mantraLabel ?? item.mantraDocId}) attempt ${item.attempts}`);

  // Renew the lease while the mantra is in flight. Without this a long teeka
  // would outlive its lease and the reaper would hand it to a second worker.
  const heartbeat = setInterval(() => {
    void heartbeatItem(item.id, workerId).then((held) => {
      if (!held) workerLog("WORKER ERROR", `lost the lease on item ${item.id} (another worker may have taken it)`);
    });
    void touchJob(job.id);
  }, translationConfig.leaseHeartbeatMs);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  try {
    const result = await withTimeout(
      translate({
        jobId: job.id,
        mantraDocId: item.mantraDocId ?? "",
        mantraLabel: item.mantraLabel ?? String(item.sequenceNumber),
        granthaName: job.granthaName ?? "",
        targetLanguages: Array.isArray(job.targetLanguages) ? job.targetLanguages : [],
        signal: opts.signal,
      }),
      translationConfig.itemTimeoutMs,
      `Item #${item.sequenceNumber}`,
    );

    await completeItem(item.id, result.summary);
    workerLog("ITEM SUCCESS", `job ${job.id} item #${item.sequenceNumber} — ${result.ok} language(s) across ${result.units} field(s)`);
  } catch (err: any) {
    if (err instanceof TranslationDisabledError) {
      // Nothing can succeed until an operator intervenes: give the item back
      // without burning its retry budget and let the loop idle.
      await releaseItem(item.id, sanitizeTranslationError(err));
      clearInterval(heartbeat);
      throw err;
    }
    const message = sanitizeTranslationError(err);
    const outcome = await failItem(item.id, message, item.attempts);
    if (outcome === "failed") {
      workerLog("ITEM FAILED", `job ${job.id} item #${item.sequenceNumber} after ${item.attempts} attempt(s): ${message}`);
    } else {
      workerLog("ITEM RETRY", `job ${job.id} item #${item.sequenceNumber} attempt ${item.attempts}/${translationConfig.maxRetries}: ${message}`);
    }
  } finally {
    clearInterval(heartbeat);
  }

  const progress = await refreshJobProgress(job.id);
  if (progress) {
    workerLog(
      "JOB PROGRESS",
      `job ${job.id} ${progress.completedItems}/${progress.totalItems} done, ${progress.failedItems} failed, ${progress.queuedItems} queued`,
    );
    if (
      progress.status === "completed" ||
      progress.status === "partially_failed" ||
      progress.status === "failed"
    ) {
      workerLog("JOB COMPLETED", `job ${job.id} finished as ${progress.status}`);
    }
  }

  return "done";
}

/**
 * Startup reconciliation. Items this worker owned before a restart are ours to
 * take back immediately; anything else waits for its lease to lapse so we never
 * yank an item out from under a worker that is still alive.
 */
export async function reconcileOnBoot(workerId = translationConfig.workerId): Promise<void> {
  await ensureTranslationSchema();
  const mine = await requeueOwnedItems(workerId);
  const expired = await requeueExpiredLeases();
  if (mine || expired) {
    workerLog("WORKER RESTART", `requeued ${mine} item(s) left by this worker and ${expired} expired lease(s)`);
  }

  // Jobs left `processing` with nothing in flight are simply resumed; their
  // counters are recomputed from the rows so the UI never shows a stale number.
  const stuck = await db
    .select({ id: translationJobs.id })
    .from(translationJobs)
    .where(inArray(translationJobs.status, ["processing", "queued"]));
  for (const job of stuck) await refreshJobProgress(job.id);
}

/** The long-running loop. Returns when the signal aborts (or per WorkerOptions). */
export async function runWorker(opts: WorkerOptions = {}): Promise<void> {
  const workerId = opts.workerId ?? translationConfig.workerId;
  await reconcileOnBoot(workerId);
  workerLog("JOB START", `worker ${workerId} ready (poll ${translationConfig.pollIntervalMs}ms, lease ${translationConfig.leaseMs}ms, max retries ${translationConfig.maxRetries})`);

  let processed = 0;
  let lastReap = 0;

  while (!opts.signal?.aborted) {
    try {
      // Cheap periodic reaper so a worker that is up but idle still rescues
      // items a sibling process abandoned.
      if (Date.now() - lastReap > translationConfig.leaseMs) {
        lastReap = Date.now();
        const reaped = await requeueExpiredLeases();
        if (reaped) workerLog("WORKER RESTART", `reaped ${reaped} expired lease(s)`);
      }

      const outcome = await processOneItem({ ...opts, workerId });
      if (outcome === "done") {
        processed += 1;
        if (opts.maxItems && processed >= opts.maxItems) return;
        await sleep(translationConfig.itemDelayMs, opts.signal);
        continue;
      }

      if (opts.exitWhenIdle) return;
      await sleep(translationConfig.pollIntervalMs, opts.signal);
    } catch (err: any) {
      // The loop itself must never die: a DB blip, a disabled Hermex or an
      // unexpected Python exception all come back here and we simply wait.
      workerLog("WORKER ERROR", sanitizeTranslationError(err));
      if (opts.exitWhenIdle) return;
      await sleep(translationConfig.pollIntervalMs, opts.signal);
    }
  }
}
