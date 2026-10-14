/**
 * Process-wide throttle for Claude structure calls. Same three bounded gates as
 * server/ocr/limiter.ts — a counting semaphore, a sliding 60s window and a UTC-day
 * counter — kept separate because the two features meter different providers and must
 * not be able to starve each other.
 *
 * Waiters are woken in FIFO order by an explicit queue: a chunk never polls and never
 * starves. The day counter is seeded once from the database so a restart does not hand
 * out a fresh daily budget.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";
import { structureConfig } from "./config";

type Waiter = { resolve: () => void; reject: (err: Error) => void; signal?: AbortSignal };

let inFlight = 0;
const waiters: Waiter[] = [];
let recentStarts: number[] = [];
let dayKey = "";
let dayCount = 0;
let daySeeded: Promise<void> | null = null;
let drainTimer: NodeJS.Timeout | null = null;

export class StructureBudgetError extends Error {
  status = 429;
  constructor(message: string) {
    super(message);
    this.name = "StructureBudgetError";
  }
}

function utcDayKey(at = new Date()): string {
  return at.toISOString().slice(0, 10);
}

async function ensureDaySeeded(): Promise<void> {
  const today = utcDayKey();
  if (dayKey === today) return;
  if (!daySeeded) {
    daySeeded = (async () => {
      try {
        const rows = await db.execute(
          sql`select coalesce(sum(request_count), 0)::int as used
              from cms_structure_jobs
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
  return inFlight < structureConfig.concurrency && recentStarts.length < structureConfig.requestsPerMinute;
}

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
  // Minute-window pressure: one wake-up for the moment the oldest start ages out.
  if (
    waiters.length > 0 &&
    inFlight < structureConfig.concurrency &&
    recentStarts.length > 0 &&
    !drainTimer
  ) {
    const waitMs = Math.max(50, recentStarts[0] + 60_000 - now);
    drainTimer = setTimeout(() => {
      drainTimer = null;
      drain();
    }, waitMs);
    drainTimer.unref?.();
  }
}

/**
 * Reserve one request slot. The caller MUST invoke the returned release() exactly once
 * (use try/finally).
 */
export async function acquireStructureSlot(signal?: AbortSignal): Promise<() => void> {
  await ensureDaySeeded();
  if (utcDayKey() !== dayKey) {
    dayKey = utcDayKey();
    dayCount = 0;
  }
  if (dayCount >= structureConfig.requestsPerDay) {
    throw new StructureBudgetError(
      `Daily Claude analysis budget reached (${structureConfig.requestsPerDay} requests). It resets at 00:00 UTC.`,
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
 * A retry made while a slot is already held spends provider quota like a first attempt,
 * so it presses on the minute window and the day budget. It cannot *wait* on them: a
 * lane that blocked on a second slot while holding one could deadlock the pool.
 */
export function recordExtraStructureRequest(): void {
  const now = Date.now();
  pruneWindow(now);
  recentStarts.push(now);
  if (utcDayKey() === dayKey) dayCount += 1;
}

export function structureUsageSnapshot() {
  pruneWindow(Date.now());
  return {
    inFlight,
    queued: waiters.length,
    lastMinute: recentStarts.length,
    perMinuteLimit: structureConfig.requestsPerMinute,
    today: dayCount,
    perDayLimit: structureConfig.requestsPerDay,
    concurrency: structureConfig.concurrency,
    day: dayKey || utcDayKey(),
  };
}
