/**
 * Progress + time-remaining estimate for one OCR job. Pure: everything it
 * needs is passed in, so it is unit-testable and cheap to call on every poll.
 *
 * Time per page is taken from the best evidence available, in this order:
 *   1. measured  — ranges of THIS job that already finished;
 *   2. historical — finished ranges of earlier jobs on the same model;
 *   3. guess     — a fixed per-page figure for the quality profile.
 * The basis is reported so the UI can word the estimate honestly.
 *
 * Remaining time = the longest of
 *   - the slowest in-flight range's remaining time,
 *   - all remaining work spread over the worker lanes,
 *   - the rate-limit floor (N requests cannot start faster than the per-minute cap).
 */
import type { ChunkLive } from "./progress";

export interface EstimateChunk {
  chunkIndex: number;
  startPage: number;
  endPage: number;
  status: "queued" | "running" | "done" | "failed" | "skipped";
  durationMs: number;
}

export interface EstimateInput {
  chunks: EstimateChunk[];
  live: Record<number, ChunkLive>;
  now: number;
  /** Worker lanes available to this job. */
  concurrency: number;
  requestsPerMinute: number;
  /** Average ms per page from earlier jobs on this model (null when unknown). */
  historicalMsPerPage: number | null;
  quality: "fast" | "accurate";
  /** Job start (ms epoch) for the elapsed figure; null when not started. */
  startedAt: number | null;
  /** Job end (ms epoch) for a finished job, so elapsed stops growing; null while running. */
  endedAt?: number | null;
  /** Whether the job is still running (no ETA otherwise). */
  running: boolean;
}

export type EstimateBasis = "measured" | "historical" | "guess";

export interface JobEstimate {
  pagesTotal: number;
  pagesDone: number;
  pagesRunning: number;
  pagesFailed: number;
  pagesQueued: number;
  /** ms since the job started; null when not started. */
  elapsedMs: number | null;
  /** ms until the job should finish; null when not running. */
  etaMs: number | null;
  basis: EstimateBasis | null;
  /** The per-page figure the ETA was built on (ms). */
  msPerPage: number | null;
  /** How many ranges are currently sleeping out a transient error. */
  retrying: number;
}

/** Rough per-page cost when nothing has been measured yet. */
const GUESS_MS_PER_PAGE: Record<"fast" | "accurate", number> = { fast: 6_000, accurate: 11_000 };
/** Fixed per-request overhead (upload, model warm-up, response). */
const REQUEST_OVERHEAD_MS = 8_000;

const pagesOf = (c: { startPage: number; endPage: number }) => c.endPage - c.startPage + 1;

export function estimateJob(input: EstimateInput): JobEstimate {
  const { chunks, live, now } = input;
  const done = chunks.filter((c) => c.status === "done");
  const running = chunks.filter((c) => c.status === "running");
  const queued = chunks.filter((c) => c.status === "queued");
  const failed = chunks.filter((c) => c.status === "failed" || c.status === "skipped");

  const sum = (list: EstimateChunk[]) => list.reduce((s, c) => s + pagesOf(c), 0);
  const pagesTotal = sum(chunks);
  const pagesDone = sum(done);
  const pagesRunning = sum(running);
  const pagesQueued = sum(queued);
  const pagesFailed = sum(failed);

  const endAt = !input.running && input.endedAt != null ? input.endedAt : now;
  const elapsedMs = input.startedAt != null ? Math.max(0, endAt - input.startedAt) : null;
  const retrying = running.filter((c) => live[c.chunkIndex]?.phase === "backoff").length;

  if (!input.running || running.length + queued.length === 0) {
    return {
      pagesTotal,
      pagesDone,
      pagesRunning,
      pagesFailed,
      pagesQueued,
      elapsedMs,
      etaMs: null,
      basis: null,
      msPerPage: null,
      retrying,
    };
  }

  // 1. Choose the per-page figure and its basis.
  let msPerPage: number;
  let basis: EstimateBasis;
  const measured = done.filter((c) => c.durationMs > 0);
  if (measured.length > 0) {
    // Take the fixed per-request cost off each measured range before dividing,
    // so a short range does not inflate the per-page figure for long ones.
    const netMs = measured.reduce(
      (s, c) => s + Math.max(c.durationMs - REQUEST_OVERHEAD_MS, c.durationMs * 0.5),
      0,
    );
    msPerPage = netMs / Math.max(1, sum(measured));
    basis = "measured";
  } else if (input.historicalMsPerPage && input.historicalMsPerPage > 0) {
    msPerPage = input.historicalMsPerPage;
    basis = "historical";
  } else {
    msPerPage = GUESS_MS_PER_PAGE[input.quality];
    basis = "guess";
  }
  const expected = (c: EstimateChunk) => pagesOf(c) * msPerPage + REQUEST_OVERHEAD_MS;

  // 2. Remaining time of each in-flight range, from its live phase.
  let slowestRunning = 0;
  let runningRemaining = 0;
  for (const c of running) {
    const full = expected(c);
    const state = live[c.chunkIndex];
    let remaining: number;
    if (!state) {
      remaining = full;
    } else if (state.phase === "backoff") {
      remaining = Math.max(0, (state.nextAttemptAt ?? now) - now) + full;
    } else if (state.phase === "request") {
      const inFlightFor = now - state.phaseStartedAt;
      // Never claim a request is "about to finish" — keep at least a quarter of
      // its expected time on the clock until it actually returns.
      remaining = Math.max(full - inFlightFor, full * 0.25);
    } else {
      remaining = full; // waiting for a slot
    }
    slowestRunning = Math.max(slowestRunning, remaining);
    runningRemaining += remaining;
  }

  // 3. Queued work spread across the lanes.
  const queuedTotal = queued.reduce((s, c) => s + expected(c), 0);
  const lanes = Math.max(1, Math.min(input.concurrency, running.length + queued.length));
  const spread = (runningRemaining + queuedTotal) / lanes;

  // 4. Rate-limit floor: every remaining request needs a start slot.
  const remainingRequests = queued.length + retrying;
  const rateFloor = input.requestsPerMinute > 0 ? (remainingRequests / input.requestsPerMinute) * 60_000 : 0;

  const etaMs = Math.round(Math.max(slowestRunning, spread, rateFloor));

  return {
    pagesTotal,
    pagesDone,
    pagesRunning,
    pagesFailed,
    pagesQueued,
    elapsedMs,
    etaMs,
    basis,
    msPerPage: Math.round(msPerPage),
    retrying,
  };
}
