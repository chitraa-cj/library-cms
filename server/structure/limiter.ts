/**
 * Request gate for the structure analysis on its dedicated Gemini account.
 *
 * Every request — first attempts and retries alike — passes `awaitStructureRequestSlot`
 * before it is sent (the analyzer's `beforeRequest`):
 *   - rolling minute: waits until the oldest request in the window ages out;
 *   - UTC day: stops with a StructureBudgetError; the range is `skipped` and Retry after
 *     midnight resumes it. Seeded once from Postgres, so a restart is no fresh budget.
 *
 * Concurrency needs no gate here: the account has one browser, and the runner holds
 * one session per job with `STRUCTURE_MAX_ACTIVE_JOBS = 1`. These caps are separate from
 * translation's by construction — different account, different process, different lock.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";
import { structureConfig } from "./config";

export class StructureBudgetError extends Error {
  status = 429;
  readonly gate = "requests-per-day" as const;
  constructor(message: string) {
    super(message);
    this.name = "StructureBudgetError";
  }
}

let recentStarts: number[] = [];
let dayKey = "";
let dayCount = 0;
let daySeeded: Promise<void> | null = null;

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
        dayCount = 0; // table may not exist yet on a first boot
      }
      dayKey = today;
      daySeeded = null;
    })();
  }
  await daySeeded;
}

function prune(now: number): void {
  const cutoff = now - 60_000;
  if (recentStarts.length > 0 && recentStarts[0] < cutoff) recentStarts = recentStarts.filter((t) => t >= cutoff);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Book one request against the day and minute budgets, waiting for the minute window if needed. */
export async function awaitStructureRequestSlot(signal?: AbortSignal): Promise<void> {
  await ensureDaySeeded();
  if (utcDayKey() !== dayKey) {
    dayKey = utcDayKey();
    dayCount = 0;
  }
  if (dayCount >= structureConfig.requestsPerDay) {
    throw new StructureBudgetError(
      `Daily request cap for the structure Gemini account reached (${structureConfig.requestsPerDay}). It resets at 00:00 UTC — press Retry failed ranges then, or raise STRUCTURE_REQUESTS_PER_DAY.`,
    );
  }
  for (;;) {
    const now = Date.now();
    prune(now);
    if (recentStarts.length < structureConfig.requestsPerMinute) break;
    await sleep(Math.max(50, recentStarts[0] + 60_000 - now), signal);
  }
  recentStarts.push(Date.now());
  dayCount += 1;
}

export function structureUsageSnapshot() {
  prune(Date.now());
  return {
    lastMinute: recentStarts.length,
    perMinuteLimit: structureConfig.requestsPerMinute,
    today: dayCount,
    perDayLimit: structureConfig.requestsPerDay,
    day: dayKey || utcDayKey(),
  };
}
