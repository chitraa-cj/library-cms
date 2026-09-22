/**
 * Process-wide throttle for Gemini OCR calls.
 *
 * Three independent gates, all bounded (no spin loops, no unbounded queues):
 *   1. a counting semaphore  -> at most `concurrency` requests in flight;
 *   2. a sliding 60s window  -> at most `requestsPerMinute` starts per minute;
 *   3. a UTC-day counter     -> at most `requestsPerDay` starts per day.
 *
 * Waiters are woken in FIFO order by an explicit queue, so a chunk never polls
 * and never starves. The day counter is seeded once from the DB so a restart
 * does not hand out a fresh daily budget.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";
import { ocrConfig } from "./config";

type Waiter = { resolve: () => void; reject: (err: Error) => void; signal?: AbortSignal };

let inFlight = 0;
const waiters: Waiter[] = [];
/** Start timestamps inside the current sliding window. */
let recentStarts: number[] = [];
let dayKey = "";
let dayCount = 0;
let daySeeded: Promise<void> | null = null;
let drainTimer: NodeJS.Timeout | null = null;

export class OcrBudgetError extends Error {
  status = 429;
  constructor(message: string) {
    super(message);
    this.name = "OcrBudgetError";
  }
}

function utcDayKey(at = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** Seed today's counter from persisted usage so restarts don't reset the cap. */
async function ensureDaySeeded(): Promise<void> {
  const today = utcDayKey();
  if (dayKey === today) return;
  if (!daySeeded) {
    daySeeded = (async () => {
      try {
        const rows = await db.execute(
          sql`select coalesce(sum(request_count), 0)::int as used
              from cms_ocr_jobs
              where updated_at >= date_trunc('day', now() at time zone 'utc')`,
        );
        const used = Number((rows as any)?.rows?.[0]?.used ?? 0);
        dayCount = Number.isFinite(used) ? used : 0;
      } catch {
        // Table may not exist yet on a first boot — start from zero.
        dayCount = 0;
      }
      dayKey = today;
      daySeeded = null;
    })();
  }
  await daySeeded;
}

function pruneWindow(now: number) {
  if (recentStarts.length === 0) return;
  const cutoff = now - 60_000;
  if (recentStarts[0] >= cutoff) return;
  recentStarts = recentStarts.filter((t) => t >= cutoff);
}

function canStart(now: number): boolean {
  pruneWindow(now);
  return inFlight < ocrConfig.concurrency && recentStarts.length < ocrConfig.requestsPerMinute;
}

/** Wake as many queued waiters as the gates currently allow. */
function drain() {
  const now = Date.now();
  while (waiters.length > 0 && canStart(now)) {
    const waiter = waiters.shift()!;
    if (waiter.signal?.aborted) {
      waiter.reject(new Error("cancelled"));
      continue;
    }
    inFlight += 1;
    recentStarts.push(now);
    waiter.resolve();
  }
  // If minute-window pressure is what's blocking, schedule one wake-up for the
  // moment the oldest start falls out of the window — no polling.
  if (waiters.length > 0 && inFlight < ocrConfig.concurrency && recentStarts.length > 0 && !drainTimer) {
    const waitMs = Math.max(50, recentStarts[0] + 60_000 - now);
    drainTimer = setTimeout(() => {
      drainTimer = null;
      drain();
    }, waitMs);
    drainTimer.unref?.();
  }
}

/**
 * Reserve one request slot. Resolves when all gates allow the call; the caller
 * MUST invoke the returned release() exactly once (use try/finally).
 */
export async function acquireOcrSlot(signal?: AbortSignal): Promise<() => void> {
  await ensureDaySeeded();
  if (utcDayKey() !== dayKey) {
    dayKey = utcDayKey();
    dayCount = 0;
  }
  if (dayCount >= ocrConfig.requestsPerDay) {
    throw new OcrBudgetError(
      `Daily Gemini OCR budget reached (${ocrConfig.requestsPerDay} requests). It resets at 00:00 UTC.`,
    );
  }
  dayCount += 1;

  await new Promise<void>((resolve, reject) => {
    waiters.push({ resolve, reject, signal });
    if (signal) {
      const onAbort = () => {
        const idx = waiters.findIndex((w) => w.signal === signal);
        if (idx >= 0) {
          waiters.splice(idx, 1);
          dayCount = Math.max(0, dayCount - 1);
          reject(new Error("cancelled"));
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
    drain();
  });

  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight = Math.max(0, inFlight - 1);
    drain();
  };
}

/**
 * Record a request that was NOT gated by acquireOcrSlot — i.e. a retry made
 * while a slot is already held. Retries spend the provider's quota just like
 * first attempts, so they have to press on the minute window and the day
 * budget; they cannot *wait* on them, because a lane that blocked on a second
 * slot while holding one could deadlock the pool.
 */
export function recordExtraOcrRequest(): void {
  const now = Date.now();
  pruneWindow(now);
  recentStarts.push(now);
  if (utcDayKey() === dayKey) dayCount += 1;
}

export function ocrUsageSnapshot() {
  pruneWindow(Date.now());
  return {
    inFlight,
    queued: waiters.length,
    lastMinute: recentStarts.length,
    perMinuteLimit: ocrConfig.requestsPerMinute,
    today: dayCount,
    perDayLimit: ocrConfig.requestsPerDay,
    concurrency: ocrConfig.concurrency,
    day: dayKey || utcDayKey(),
  };
}
