/**
 * Live, in-memory view of what each running page range is doing right now.
 *
 * The chunk rows in Postgres only change when a range starts, finishes or
 * fails. Everything in between — "attempt 2 of 4", "Gemini answered 503,
 * retrying in 12s", "waiting for a rate-limit slot" — lives here, in the
 * process that owns the worker, and is merged into the poll response so the
 * editor can see why a range is taking long instead of a blank spinner.
 *
 * Purely advisory: losing it (restart) loses nothing but the countdowns.
 *
 * Runs happen in cms-ocr-worker while the editor polls the web app, so the worker
 * installs a sink (`setLiveSink`) that mirrors each change onto the chunk row's
 * `live_state`; the web app reads it from there.
 */

export type ChunkPhase =
  /** Waiting for the process-wide concurrency / per-minute gate. */
  | "slot"
  /** A request is in flight to Gemini. */
  | "request"
  /** A transient error came back; sleeping before the next attempt. */
  | "backoff";

export interface ChunkLive {
  model: string;
  attempt: number;
  maxAttempts: number;
  phase: ChunkPhase;
  /** When work on this range began (first slot wait). */
  startedAt: number;
  /** When the current phase began. */
  phaseStartedAt: number;
  /** Backoff only: when the next attempt fires. */
  nextAttemptAt: number | null;
  /** The last transient error, shown while retrying. */
  lastError: string | null;
}

const live = new Map<string, Map<number, ChunkLive>>();

type LiveSink = (jobId: string, chunkIndex: number, state: ChunkLive | null) => Promise<unknown>;
let sink: LiveSink | null = null;
/** Writes are chained per range so they land in the order they happened. */
const sinkChains = new Map<string, Promise<unknown>>();

export function setLiveSink(next: LiveSink | null): void {
  sink = next;
}

function mirror(jobId: string, chunkIndex: number, state: ChunkLive | null): void {
  const write = sink;
  if (!write) return;
  const key = `${jobId}:${chunkIndex}`;
  const next = (sinkChains.get(key) ?? Promise.resolve())
    .then(() => write(jobId, chunkIndex, state))
    .catch(() => undefined); // advisory: a failed write costs a countdown, nothing else
  sinkChains.set(key, next);
  void next.finally(() => {
    if (sinkChains.get(key) === next) sinkChains.delete(key);
  });
}

export function setChunkLive(jobId: string, chunkIndex: number, patch: Partial<ChunkLive>): void {
  let byIndex = live.get(jobId);
  if (!byIndex) {
    byIndex = new Map();
    live.set(jobId, byIndex);
  }
  const now = Date.now();
  const prev = byIndex.get(chunkIndex);
  const next: ChunkLive = {
    model: "",
    attempt: 0,
    maxAttempts: 0,
    phase: "slot",
    startedAt: now,
    phaseStartedAt: now,
    nextAttemptAt: null,
    lastError: null,
    ...prev,
    ...patch,
  };
  // A phase change restarts the phase clock unless the caller set it.
  if (prev && patch.phase && patch.phase !== prev.phase && patch.phaseStartedAt == null) {
    next.phaseStartedAt = now;
  }
  byIndex.set(chunkIndex, next);
  mirror(jobId, chunkIndex, next);
}

export function clearChunkLive(jobId: string, chunkIndex?: number): void {
  if (chunkIndex == null) {
    for (const index of live.get(jobId)?.keys() ?? []) mirror(jobId, index, null);
    live.delete(jobId);
    return;
  }
  const byIndex = live.get(jobId);
  if (byIndex?.has(chunkIndex)) mirror(jobId, chunkIndex, null);
  byIndex?.delete(chunkIndex);
  if (byIndex && byIndex.size === 0) live.delete(jobId);
}

export function liveChunks(jobId: string): Record<number, ChunkLive> {
  const out: Record<number, ChunkLive> = {};
  for (const [index, state] of live.get(jobId) ?? []) out[index] = state;
  return out;
}
