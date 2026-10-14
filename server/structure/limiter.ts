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
import { formatUsd, structureCostUsd } from "@shared/ocr-structure";
import { structureConfig, structureRates } from "./config";
import { tokensSpentSince } from "./store";

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
  /** Which gate stopped it, so the UI can say whether waiting helps. */
  readonly gate: "requests-per-day" | "spend-per-day" | "spend-per-month";
  constructor(message: string, gate: StructureBudgetError["gate"] = "requests-per-day") {
    super(message);
    this.name = "StructureBudgetError";
    this.gate = gate;
  }
}

// ───────────────────────────────────────────────────────────────── spend gates
/**
 * Money, as opposed to request count.
 *
 * A request cap bounds the burst, not the bill: one request can carry 60k input and 32k
 * output tokens, so 800 requests/day is a four-figure day at Opus prices. These gates are
 * computed from the token counters the API itself returned, summed in Postgres, so they
 * survive a restart and count every process.
 *
 * Cached for a few seconds because they are consulted before every range and on every
 * poll of the config endpoint; a few seconds of staleness cannot overshoot by more than
 * one range, which the per-job cap bounds anyway.
 */
interface SpendSnapshot {
  dayUsd: number;
  monthUsd: number;
  at: number;
}
let spendCache: SpendSnapshot | null = null;
const SPEND_CACHE_MS = 5_000;

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function structureSpend(force = false): Promise<{ dayUsd: number; monthUsd: number }> {
  if (!force && spendCache && Date.now() - spendCache.at < SPEND_CACHE_MS) {
    return { dayUsd: spendCache.dayUsd, monthUsd: spendCache.monthUsd };
  }
  const rates = structureRates();
  try {
    const [day, month] = await Promise.all([
      tokensSpentSince(startOfUtcDay()),
      tokensSpentSince(startOfUtcMonth()),
    ]);
    spendCache = {
      dayUsd: structureCostUsd(day, rates),
      monthUsd: structureCostUsd(month, rates),
      at: Date.now(),
    };
  } catch {
    // The table may not exist yet on a first boot. Report zero rather than blocking the
    // feature on a query that has not been able to run yet.
    spendCache = { dayUsd: 0, monthUsd: 0, at: Date.now() };
  }
  return { dayUsd: spendCache.dayUsd, monthUsd: spendCache.monthUsd };
}

/** Forget the cached figures — call after a job has spent anything. */
export function invalidateStructureSpend(): void {
  spendCache = null;
}

/**
 * Throw unless there is room for `estimatedUsd` more spend. Called before a job is
 * created (with the whole estimate) and before each range (with that range's share), so
 * a long job stops at the budget instead of sailing past it.
 */
export async function assertSpendBudget(estimatedUsd = 0): Promise<void> {
  const { dayUsd, monthUsd } = await structureSpend();
  if (structureConfig.maxSpendPerDayUsd > 0 && dayUsd + estimatedUsd > structureConfig.maxSpendPerDayUsd) {
    throw new StructureBudgetError(
      `Daily Claude budget reached: ${formatUsd(dayUsd)} of ${formatUsd(structureConfig.maxSpendPerDayUsd)} spent today` +
        (estimatedUsd > 0 ? `, and this would add about ${formatUsd(estimatedUsd)}` : "") +
        ". It resets at 00:00 UTC, or raise STRUCTURE_MAX_SPEND_PER_DAY_USD.",
      "spend-per-day",
    );
  }
  if (structureConfig.maxSpendPerMonthUsd > 0 && monthUsd + estimatedUsd > structureConfig.maxSpendPerMonthUsd) {
    throw new StructureBudgetError(
      `Monthly Claude budget reached: ${formatUsd(monthUsd)} of ${formatUsd(structureConfig.maxSpendPerMonthUsd)} spent this month` +
        (estimatedUsd > 0 ? `, and this would add about ${formatUsd(estimatedUsd)}` : "") +
        ". Raise STRUCTURE_MAX_SPEND_PER_MONTH_USD to continue.",
      "spend-per-month",
    );
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
  // Money first: a spent budget should stop the next request even when the request
  // counter still has room.
  await assertSpendBudget();
  await ensureDaySeeded();
  if (utcDayKey() !== dayKey) {
    dayKey = utcDayKey();
    dayCount = 0;
  }
  if (dayCount >= structureConfig.requestsPerDay) {
    throw new StructureBudgetError(
      `Daily Claude request cap reached (${structureConfig.requestsPerDay} requests). It resets at 00:00 UTC.`,
      "requests-per-day",
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
  const spend = spendCache ?? { dayUsd: 0, monthUsd: 0 };
  return {
    spentTodayUsd: spend.dayUsd,
    spentThisMonthUsd: spend.monthUsd,
    maxSpendPerDayUsd: structureConfig.maxSpendPerDayUsd,
    maxSpendPerMonthUsd: structureConfig.maxSpendPerMonthUsd,
    maxSpendPerJobUsd: structureConfig.maxSpendPerJobUsd,
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
