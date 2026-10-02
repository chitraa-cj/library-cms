/**
 * Grantha publish worker loop.
 *
 * Runs in its OWN process (worker-main.ts, pm2 app `cms-publish-worker`). The publish walk
 * makes hundreds of Strapi calls and used to run inside the web process, where it competed
 * with every HTTP request on one event loop. Here it costs the website nothing.
 *
 * The loop is the same boring shape as the translation worker:
 *
 *   claim one job (advisory-locked, FOR UPDATE SKIP LOCKED)
 *     → heartbeat its lease while publishing
 *     → done, or requeued/failed with the error recorded
 *   nothing to claim → sleep PUBLISH_POLL_INTERVAL
 *
 * What differs: a job is one whole grantha, not one item. Mantras are not independently
 * schedulable — every one needs `teekaNameToDocId` and its section's docId, both built
 * during the walk — so the unit of work is the walk, which keeps its own in-process
 * per-mantra task queue (`cms_publish_job_tasks`) internally.
 */
import { storage } from "../storage";
import {
  finalizePublishSuccess,
  isRetryablePublishError,
  publishFailureDetails,
  publishGranthaWithHierarchy,
} from "../routes";
import type { PublishJobRecord } from "@shared/schema";
import { PUBLISH_WORKER_KIND, publishConfig, sanitizePublishError } from "./config";
import {
  beatWorkerHeartbeat,
  claimNextJob,
  completeJob,
  failJob,
  heartbeatJob,
  releaseJob,
  requeueExpiredLeases,
  requeueOwnedJobs,
  writeProgress,
} from "./store";

export function workerLog(event: string, detail: string): void {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${stamp}] [publish-worker] ${event} ${detail}`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** What the worker needs from the publish walk. Swappable so tests never touch Strapi. */
export type PublishFn = typeof publishGranthaWithHierarchy;

export interface PublishWorkerOptions {
  workerId?: string;
  signal?: AbortSignal;
  /** Stop after this many jobs — tests only. */
  maxJobs?: number;
  /** Return as soon as the queue is empty instead of polling — tests only. */
  exitWhenIdle?: boolean;
  publish?: PublishFn;
}

/** Jobs the worker currently holds, so a SIGTERM can hand them back. */
const inFlight = new Set<string>();

/**
 * Run one job, start to finish. Exported so tests can drive a single pass.
 * Returns "idle" when there was nothing to claim.
 */
export async function processOnePublishJob(
  opts: PublishWorkerOptions = {},
): Promise<"done" | "idle"> {
  const workerId = opts.workerId ?? publishConfig.workerId;
  const publish = opts.publish ?? publishGranthaWithHierarchy;

  const job = await claimNextJob(workerId);
  if (!job) return "idle";
  inFlight.add(job.id);

  workerLog(
    "JOB CLAIMED",
    `${job.id} draft ${job.draftId}${job.granthaDocId ? ` grantha ${job.granthaDocId}` : ""} attempt ${job.attempts}/${job.maxAttempts}`,
  );

  // Renew the lease while the walk is in flight; without this a long publish would outlive
  // its lease and the reaper would hand the same grantha to a second worker.
  const heartbeat = setInterval(() => {
    void heartbeatJob(job.id, workerId).then((held) => {
      if (!held) workerLog("WORKER ERROR", `lost the lease on job ${job.id}`);
    });
  }, publishConfig.leaseHeartbeatMs);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  try {
    const draft = await storage.getDraftById(job.draftId);
    if (!draft) throw Object.assign(new Error("Draft no longer exists."), { status: 404 });

    // Tasks left by a previous attempt must go: `claimNextPublishJobTask` is job-wide, not
    // section-scoped, so they would drain during this attempt's first leaf section and push
    // the progress count past the total, and the per-section failed-task sweep would
    // re-count the old attempt's failures once per section. The mantra RESOLUTIONS stay —
    // they are the checkpoint that makes this attempt cheap.
    const cleared = await storage.deletePublishJobTasks(job.id);
    if (cleared) workerLog("JOB RETRY", `cleared ${cleared} stale task(s) from job ${job.id}`);

    const result = await publish(
      draft,
      job.id,
      makeProgressReporter(job),
      {
        ...(job.publishOptions ?? {}),
        // Resume onto the grantha an earlier attempt created, so a retried FIRST publish
        // updates it instead of creating a second one.
        ...(job.granthaDocId ? { resumeGranthaDocId: job.granthaDocId } : {}),
      },
    );

    const responseBody = await finalizePublishSuccess(
      { draftId: job.draftId, userId: job.userId ?? "", jobId: job.id, draft },
      result,
    );
    await completeJob(job.id, responseBody);
    workerLog("JOB COMPLETED", `${job.id} finished as done`);
  } catch (err: any) {
    const retryable = isRetryablePublishError(err);
    const status = await failJob(job.id, err, {
      retryable,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
    });
    const details = publishFailureDetails(err);
    if (details) await storage.updatePublishJob(job.id, { result: details }).catch(() => {});
    workerLog(
      status === "queued" ? "JOB RETRY" : "JOB FAILED",
      `${job.id} attempt ${job.attempts}/${job.maxAttempts} → ${status}: ${sanitizePublishError(err)}`,
    );
  } finally {
    clearInterval(heartbeat);
    inFlight.delete(job.id);
  }

  return "done";
}

/**
 * Adapt the walk's `onProgress` to the job row.
 *
 * Throttled: the walk ticks once per mantra, which on Suta Samhita is 6,058 single-row
 * UPDATEs, all of them WAL. Attempt 2 honestly restarts at 0/total rather than clamping to
 * the previous attempt's `done` — clamping would freeze the bar for minutes while the walk
 * re-covers ground — so the attempt is named in `current` instead, which the UI already
 * renders verbatim.
 */
function makeProgressReporter(job: PublishJobRecord) {
  let lastWrite = 0;
  let pending: { done: number; total: number; current: string } | null = null;
  const prefix = job.attempts > 1 ? `[attempt ${job.attempts}/${job.maxAttempts}] ` : "";

  return (done: number, total: number, current: string) => {
    pending = { done, total, current: `${prefix}${current}` };
    const now = Date.now();
    if (now - lastWrite < publishConfig.progressWriteIntervalMs) return;
    lastWrite = now;
    const snapshot = pending;
    pending = null;
    void writeProgress(job.id, snapshot).catch((e) =>
      console.warn(`[publish-worker] progress write failed for ${job.id}: ${e?.message ?? e}`),
    );
  };
}

/**
 * Startup reconciliation. Rows this worker owned before a restart come straight back;
 * anything else waits for its lease to lapse, so we never yank a job from a live sibling.
 */
export async function reconcileOnBoot(workerId = publishConfig.workerId): Promise<void> {
  const mine = await requeueOwnedJobs(workerId);
  const expired = await requeueExpiredLeases();
  if (mine || expired) {
    workerLog("WORKER RESTART", `requeued ${mine} own job(s) and ${expired} expired lease(s)`);
  }
}

/**
 * Hand back everything in flight, without spending an attempt. A publish runs for many
 * minutes and cannot be waited out during a deploy; the next boot re-claims and re-walks,
 * which the resolution checkpoint makes cheap for work already done.
 */
export async function releaseInFlight(reason: string): Promise<void> {
  const held = [...inFlight];
  if (!held.length) return;
  workerLog("WORKER RESTART", `releasing ${held.length} in-flight job(s)`);
  await Promise.all(held.map((id) => releaseJob(id, reason).catch(() => {})));
  inFlight.clear();
}

/** The long-running loop. Returns when the signal aborts (or per PublishWorkerOptions). */
export async function runWorker(opts: PublishWorkerOptions = {}): Promise<void> {
  const workerId = opts.workerId ?? publishConfig.workerId;
  await reconcileOnBoot(workerId);
  workerLog(
    "WORKER START",
    `${workerId} ready (poll ${publishConfig.pollIntervalMs}ms, lease ${publishConfig.leaseMs}ms, max attempts ${publishConfig.maxAttempts})`,
  );

  let processed = 0;
  let lastReap = 0;
  let lastBeat = 0;

  while (!opts.signal?.aborted) {
    try {
      // Liveness, so POST /publish can refuse work nothing would drain.
      if (Date.now() - lastBeat > 15_000) {
        lastBeat = Date.now();
        await beatWorkerHeartbeat(workerId, PUBLISH_WORKER_KIND).catch(() => {});
      }

      // Rescue jobs a sibling abandoned, even while we are otherwise idle.
      if (Date.now() - lastReap > publishConfig.leaseMs) {
        lastReap = Date.now();
        const reaped = await requeueExpiredLeases();
        if (reaped) workerLog("WORKER RESTART", `reaped ${reaped} expired lease(s)`);
      }

      const outcome = await processOnePublishJob({ ...opts, workerId });
      if (outcome === "done") {
        processed += 1;
        if (opts.maxJobs && processed >= opts.maxJobs) return;
        continue;
      }

      if (opts.exitWhenIdle) return;
      await sleep(publishConfig.pollIntervalMs, opts.signal);
    } catch (err: any) {
      // The loop must never die: a DB blip or an unexpected throw lands here and we wait.
      workerLog("WORKER ERROR", sanitizePublishError(err));
      if (opts.exitWhenIdle) return;
      await sleep(publishConfig.pollIntervalMs, opts.signal);
    }
  }
}
