/**
 * Postgres-backed translation queue.
 *
 * Postgres IS the queue — there is no Redis/SQS here and the project does not
 * need one: a single worker drains thousands of rows over days, and the only
 * thing a broker would add is another moving part to lose state in.
 *
 * The one rule everything else rests on: an item is claimed with
 *
 *     SELECT … WHERE status='queued' … FOR UPDATE SKIP LOCKED LIMIT 1
 *     UPDATE … SET status='processing', lease_expires_at = now() + lease
 *
 * inside ONE transaction. SKIP LOCKED means a second worker (today there is one,
 * tomorrow there may be more) steps over the locked row instead of blocking or —
 * far worse — reading it and translating the same mantra twice.
 *
 * Crash recovery falls out of the same row: the lease is a deadline, not a lock
 * held in memory, so a worker that dies mid-mantra simply stops renewing it and
 * `requeueExpiredLeases` hands the item back after it lapses.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  translationItems,
  translationJobs,
  type TranslationItem,
  type TranslationItemStatus,
  type TranslationJob,
  type TranslationJobStatus,
} from "@shared/schema";
import { translationConfig } from "./config";

let ddlPromise: Promise<void> | null = null;

/**
 * Lease deadline, computed by POSTGRES rather than by Node.
 *
 * These are `timestamp without time zone` columns and the queue compares them
 * against `now()`. Writing a JS `Date` instead mixes two clocks in one column:
 * the local DB runs in Asia/Kolkata while a developer's Node process may be in
 * another zone, and the skew makes every lease look either already expired
 * (every item instantly "recovered" out from under the live worker) or hours in
 * the future (a crashed worker's item never recovered). Every wall-clock value
 * in this file therefore comes from `now()`.
 */
function leaseExpiry(leaseMs: number) {
  return sql`now() + make_interval(secs => ${Math.round(leaseMs / 1000)})`;
}

/**
 * Create the tables/indexes if they are not there yet (same self-healing deploy
 * story as server/ocr/store.ts — the SQL file in script/migrations is the record).
 */
export function ensureTranslationSchema(): Promise<void> {
  if (!ddlPromise) {
    ddlPromise = (async () => {
      await db.execute(sql`
        create table if not exists cms_translation_jobs (
          id varchar primary key,
          created_by varchar references users(id) on delete set null,
          status text not null default 'queued',
          grantha_doc_id varchar,
          grantha_name text,
          target_languages jsonb not null default '[]'::jsonb,
          total_items integer not null default 0,
          completed_items integer not null default 0,
          failed_items integer not null default 0,
          processing_items integer not null default 0,
          queued_items integer not null default 0,
          retry_count integer not null default 0,
          error text,
          input_ref text,
          output_ref text,
          created_at timestamp not null default now(),
          started_at timestamp,
          completed_at timestamp,
          last_activity_at timestamp not null default now(),
          updated_at timestamp not null default now()
        )`);
      await db.execute(sql`
        create table if not exists cms_translation_items (
          id serial primary key,
          job_id varchar not null references cms_translation_jobs(id) on delete cascade,
          sequence_number integer not null,
          mantra_doc_id varchar,
          mantra_label text,
          original_text text,
          translated_text text,
          status text not null default 'queued',
          attempts integer not null default 0,
          error text,
          lease_expires_at timestamp,
          lease_owner text,
          created_at timestamp not null default now(),
          started_at timestamp,
          completed_at timestamp,
          last_attempt_at timestamp
        )`);
      for (const stmt of [
        sql`create index if not exists cms_translation_items_job_idx on cms_translation_items (job_id)`,
        sql`create index if not exists cms_translation_items_status_idx on cms_translation_items (status)`,
        sql`create index if not exists cms_translation_items_job_status_idx on cms_translation_items (job_id, status)`,
        sql`create index if not exists cms_translation_items_claim_idx on cms_translation_items (status, job_id, sequence_number)`,
        sql`create index if not exists cms_translation_items_seq_idx on cms_translation_items (job_id, sequence_number)`,
        sql`create index if not exists cms_translation_items_created_idx on cms_translation_items (created_at)`,
        sql`create index if not exists cms_translation_items_lease_idx on cms_translation_items (status, lease_expires_at)`,
        sql`create unique index if not exists cms_translation_items_job_seq_uidx on cms_translation_items (job_id, sequence_number)`,
        sql`create index if not exists cms_translation_jobs_status_idx on cms_translation_jobs (status)`,
        sql`create index if not exists cms_translation_jobs_created_idx on cms_translation_jobs (created_at desc)`,
      ]) {
        await db.execute(stmt);
      }
    })();
  }
  return ddlPromise;
}

// ────────────────────────────────────────────────────────────────── creation
export interface NewTranslationItem {
  mantraDocId: string | null;
  mantraLabel: string | null;
  originalText?: string | null;
}

export interface CreateTranslationJobInput {
  createdBy: string | null;
  granthaDocId: string | null;
  granthaName: string | null;
  targetLanguages: string[];
  inputRef?: string | null;
  items: NewTranslationItem[];
}

/**
 * Create a job and all of its items in ONE transaction: either the whole job
 * exists with every mantra queued, or nothing does. A half-written job would
 * silently translate part of a grantha and report success.
 */
export async function createTranslationJob(
  input: CreateTranslationJobInput,
): Promise<TranslationJob> {
  await ensureTranslationSchema();
  const id = randomUUID();
  const total = input.items.length;

  return db.transaction(async (tx) => {
    const [job] = await tx
      .insert(translationJobs)
      .values({
        id,
        createdBy: input.createdBy,
        status: "queued",
        granthaDocId: input.granthaDocId,
        granthaName: input.granthaName,
        targetLanguages: input.targetLanguages,
        totalItems: total,
        queuedItems: total,
        inputRef: input.inputRef ?? null,
      })
      .returning();

    // Chunked multi-row inserts: one statement per 10k mantras would exceed the
    // bind-parameter limit, and one statement per row would make a 10k-mantra
    // job take minutes inside an HTTP request.
    for (let i = 0; i < input.items.length; i += translationConfig.insertBatchSize) {
      const slice = input.items.slice(i, i + translationConfig.insertBatchSize);
      await tx.insert(translationItems).values(
        slice.map((item, offset) => ({
          jobId: id,
          sequenceNumber: i + offset + 1,
          mantraDocId: item.mantraDocId,
          mantraLabel: item.mantraLabel,
          originalText: item.originalText ?? null,
          status: "queued" as const,
        })),
      );
    }

    return job;
  });
}

// ─────────────────────────────────────────────────────────────────── reading
export async function getTranslationJob(id: string): Promise<TranslationJob | null> {
  await ensureTranslationSchema();
  const [job] = await db.select().from(translationJobs).where(eq(translationJobs.id, id)).limit(1);
  return job ?? null;
}

export async function listTranslationJobs(limit = 50, offset = 0): Promise<TranslationJob[]> {
  await ensureTranslationSchema();
  return db
    .select()
    .from(translationJobs)
    .orderBy(desc(translationJobs.createdAt))
    .limit(limit)
    .offset(offset);
}

export interface ListItemsOptions {
  status?: TranslationItemStatus;
  page?: number;
  limit?: number;
}

/** Items of one job, always paginated — a job can hold 10k+ rows. */
export async function listTranslationItems(
  jobId: string,
  opts: ListItemsOptions = {},
): Promise<{ items: TranslationItem[]; page: number; limit: number; total: number }> {
  await ensureTranslationSchema();
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
  const where = opts.status
    ? and(eq(translationItems.jobId, jobId), eq(translationItems.status, opts.status))
    : eq(translationItems.jobId, jobId);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(translationItems)
    .where(where);

  const items = await db
    .select()
    .from(translationItems)
    .where(where)
    .orderBy(asc(translationItems.sequenceNumber))
    .limit(limit)
    .offset((page - 1) * limit);

  return { items, page, limit, total: count };
}

/** Live counts straight from the item rows — the number the UI can trust. */
export async function countItemsByStatus(
  jobId: string,
): Promise<Record<TranslationItemStatus, number>> {
  await ensureTranslationSchema();
  const rows = await db
    .select({ status: translationItems.status, count: sql<number>`count(*)::int` })
    .from(translationItems)
    .where(eq(translationItems.jobId, jobId))
    .groupBy(translationItems.status);

  const out: Record<TranslationItemStatus, number> = {
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
  };
  for (const row of rows) out[row.status as TranslationItemStatus] = row.count;
  return out;
}

/** Items currently being worked on, across all jobs — the admin queue view. */
export async function listProcessingItems(limit = 20): Promise<TranslationItem[]> {
  await ensureTranslationSchema();
  return db
    .select()
    .from(translationItems)
    .where(eq(translationItems.status, "processing"))
    .orderBy(asc(translationItems.startedAt))
    .limit(limit);
}

/** What the worker will pick up next, in the order it will pick them. */
export async function listUpcomingItems(limit = 20): Promise<TranslationItem[]> {
  await ensureTranslationSchema();
  const activeJobs = db
    .select({ id: translationJobs.id })
    .from(translationJobs)
    .where(inArray(translationJobs.status, ["queued", "processing"]));
  return db
    .select()
    .from(translationItems)
    .where(
      and(
        eq(translationItems.status, "queued"),
        inArray(translationItems.jobId, activeJobs),
      ),
    )
    .orderBy(asc(translationItems.createdAt), asc(translationItems.sequenceNumber))
    .limit(limit);
}

export async function listRecentFailedItems(limit = 20, jobId?: string): Promise<TranslationItem[]> {
  await ensureTranslationSchema();
  const where = jobId
    ? and(eq(translationItems.status, "failed"), eq(translationItems.jobId, jobId))
    : eq(translationItems.status, "failed");
  return db
    .select()
    .from(translationItems)
    .where(where)
    .orderBy(desc(translationItems.lastAttemptAt))
    .limit(limit);
}

// ─────────────────────────────────────────────────────────────────── claiming
/**
 * Atomically take the next queued item of a runnable job.
 *
 * SKIP LOCKED is what makes this safe to run from more than one worker: a row
 * another transaction is holding is stepped over, not waited on and never read
 * twice. Items whose retry backoff has not elapsed are left for later.
 */
export async function claimNextItem(
  workerId: string,
  leaseMs = translationConfig.leaseMs,
): Promise<TranslationItem | null> {
  await ensureTranslationSchema();

  return db.transaction(async (tx) => {
    const picked = await tx.execute(sql`
      select i.id
      from cms_translation_items i
      join cms_translation_jobs j on j.id = i.job_id
      where i.status = 'queued'
        and j.status in ('queued', 'processing')
        and (
          i.last_attempt_at is null
          or i.last_attempt_at <= now() - (${translationConfig.retryBackoffMs} || ' milliseconds')::interval * greatest(i.attempts, 1)
        )
      order by i.created_at asc, i.sequence_number asc
      for update of i skip locked
      limit 1
    `);

    const row = (picked.rows ?? picked)[0] as { id: number } | undefined;
    if (!row) return null;

    const [claimed] = await tx
      .update(translationItems)
      .set({
        status: "processing",
        attempts: sql`${translationItems.attempts} + 1`,
        startedAt: sql`coalesce(${translationItems.startedAt}, now())`,
        lastAttemptAt: sql`now()`,
        leaseOwner: workerId,
        leaseExpiresAt: leaseExpiry(leaseMs),
        error: null,
      })
      .where(eq(translationItems.id, row.id))
      .returning();

    return claimed ?? null;
  });
}

/** Push the lease deadline out; proof the worker is still alive on this item. */
export async function heartbeatItem(
  itemId: number,
  workerId: string,
  leaseMs = translationConfig.leaseMs,
): Promise<boolean> {
  const updated = await db
    .update(translationItems)
    .set({ leaseExpiresAt: leaseExpiry(leaseMs) })
    .where(
      and(
        eq(translationItems.id, itemId),
        eq(translationItems.status, "processing"),
        eq(translationItems.leaseOwner, workerId),
      ),
    )
    .returning({ id: translationItems.id });
  return updated.length > 0;
}

export async function completeItem(itemId: number, translatedText: string | null): Promise<void> {
  await db
    .update(translationItems)
    .set({
      status: "completed",
      translatedText,
      error: null,
      completedAt: sql`now()`,
      leaseExpiresAt: null,
      leaseOwner: null,
    })
    .where(eq(translationItems.id, itemId));
}

/**
 * Record a failure. Under the retry ceiling the item goes back to `queued` (the
 * backoff in claimNextItem keeps it from spinning); at the ceiling it parks as
 * `failed` until an admin retries it.
 */
export async function failItem(
  itemId: number,
  error: string,
  attempts: number,
  maxRetries = translationConfig.maxRetries,
): Promise<TranslationItemStatus> {
  const next: TranslationItemStatus = attempts >= maxRetries ? "failed" : "queued";
  await db
    .update(translationItems)
    .set({
      status: next,
      error,
      leaseExpiresAt: null,
      leaseOwner: null,
      completedAt: next === "failed" ? sql`now()` : null,
    })
    .where(eq(translationItems.id, itemId));
  return next;
}

/** Put an item back without spending an attempt (cancellation, shutdown). */
export async function releaseItem(itemId: number, reason: string | null): Promise<void> {
  await db
    .update(translationItems)
    .set({
      status: "queued",
      error: reason,
      leaseExpiresAt: null,
      leaseOwner: null,
    })
    .where(eq(translationItems.id, itemId));
}

/**
 * Crash recovery. Any item still `processing` whose lease has lapsed belonged to
 * a worker that is gone — a kill -9, an EC2 reboot, a Chrome crash that took the
 * process with it. Completed items are never touched, so nothing already
 * translated is paid for twice.
 */
export async function requeueExpiredLeases(): Promise<number> {
  await ensureTranslationSchema();
  const rows = await db
    .update(translationItems)
    .set({
      status: "queued",
      leaseExpiresAt: null,
      leaseOwner: null,
      error: "Worker stopped mid-item (lease expired); requeued automatically.",
    })
    .where(
      and(
        eq(translationItems.status, "processing"),
        sql`${translationItems.leaseExpiresAt} is not null`,
        sql`${translationItems.leaseExpiresAt} < now()`,
      ),
    )
    .returning({ id: translationItems.id });
  return rows.length;
}

/** Same, but unconditional — used at worker startup for leases it owns itself. */
export async function requeueOwnedItems(workerId: string): Promise<number> {
  await ensureTranslationSchema();
  const rows = await db
    .update(translationItems)
    .set({
      status: "queued",
      leaseExpiresAt: null,
      leaseOwner: null,
      error: "Worker restarted; requeued automatically.",
    })
    .where(and(eq(translationItems.status, "processing"), eq(translationItems.leaseOwner, workerId)))
    .returning({ id: translationItems.id });
  return rows.length;
}

// ──────────────────────────────────────────────────────────── job bookkeeping
export async function markJobStarted(jobId: string): Promise<void> {
  await db
    .update(translationJobs)
    .set({
      status: "processing",
      startedAt: sql`coalesce(${translationJobs.startedAt}, now())`,
      lastActivityAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(translationJobs.id, jobId), eq(translationJobs.status, "queued")));
}

export async function touchJob(jobId: string): Promise<void> {
  await db
    .update(translationJobs)
    .set({ lastActivityAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(translationJobs.id, jobId));
}

/**
 * Recompute a job's counters from its items and settle its status when the queue
 * for it is empty. Counting the rows (rather than incrementing in memory) means a
 * restart mid-job can never leave the totals drifting from reality.
 */
export async function refreshJobProgress(jobId: string): Promise<TranslationJob | null> {
  const job = await getTranslationJob(jobId);
  if (!job) return null;

  const counts = await countItemsByStatus(jobId);
  const [{ retries }] = await db
    .select({ retries: sql<number>`coalesce(sum(greatest(attempts - 1, 0)), 0)::int` })
    .from(translationItems)
    .where(eq(translationItems.jobId, jobId));

  const outstanding = counts.queued + counts.processing;
  let status: TranslationJobStatus = job.status;
  /** SQL, not a JS Date — see the note on leaseExpiry(). */
  let completedAt: any = sql`coalesce(${translationJobs.completedAt}, now())`;

  if (job.status === "cancelled") {
    // A cancelled job stays cancelled; only its counters are refreshed.
  } else if (outstanding > 0) {
    status = job.status === "queued" && counts.processing === 0 ? "queued" : "processing";
    completedAt = null;
  } else {
    status =
      counts.failed === 0
        ? "completed"
        : counts.completed === 0
          ? "failed"
          : "partially_failed";
  }

  const [updated] = await db
    .update(translationJobs)
    .set({
      status,
      totalItems: counts.queued + counts.processing + counts.completed + counts.failed,
      completedItems: counts.completed,
      failedItems: counts.failed,
      processingItems: counts.processing,
      queuedItems: counts.queued,
      retryCount: retries,
      completedAt,
      lastActivityAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(translationJobs.id, jobId))
    .returning();

  return updated ?? null;
}

export async function setJobError(jobId: string, error: string | null): Promise<void> {
  await db
    .update(translationJobs)
    .set({ error, lastActivityAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(translationJobs.id, jobId));
}

/**
 * Cancel a job: stop handing out its queued items. The item being processed right
 * now is left alone — the worker notices the cancellation when it finishes and
 * releases it — so Chrome is never killed mid-answer.
 */
export async function cancelTranslationJob(jobId: string): Promise<{ cancelledItems: number }> {
  await ensureTranslationSchema();
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(translationItems)
      .set({
        status: "failed",
        error: "Job cancelled by an administrator before this item ran.",
        completedAt: sql`now()`,
        leaseExpiresAt: null,
        leaseOwner: null,
      })
      .where(and(eq(translationItems.jobId, jobId), eq(translationItems.status, "queued")))
      .returning({ id: translationItems.id });

    await tx
      .update(translationJobs)
      .set({
        status: "cancelled",
        completedAt: sql`now()`,
        lastActivityAt: sql`now()`,
        updatedAt: sql`now()`,
        queuedItems: 0,
      })
      .where(eq(translationJobs.id, jobId));

    return { cancelledItems: rows.length };
  });
}

/**
 * Hand failed items back to the queue. Attempts are deliberately NOT zeroed — the
 * history of how often a mantra has fought us is worth keeping — but the retry
 * budget is extended by resetting status, and claimNextItem's ceiling is checked
 * against `attempts` at failure time, so an admin retry always buys more tries.
 */
export async function retryFailedItems(
  jobId: string,
  itemId?: number,
): Promise<{ requeued: number }> {
  await ensureTranslationSchema();
  const where = itemId
    ? and(
        eq(translationItems.jobId, jobId),
        eq(translationItems.id, itemId),
        eq(translationItems.status, "failed"),
      )
    : and(eq(translationItems.jobId, jobId), eq(translationItems.status, "failed"));

  const rows = await db
    .update(translationItems)
    .set({
      status: "queued",
      error: null,
      completedAt: null,
      lastAttemptAt: null,
      leaseExpiresAt: null,
      leaseOwner: null,
    })
    .where(where)
    .returning({ id: translationItems.id });

  if (rows.length > 0) {
    await db
      .update(translationJobs)
      .set({
        status: "queued",
        completedAt: null,
        error: null,
        lastActivityAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(translationJobs.id, jobId));
    await refreshJobProgress(jobId);
  }
  return { requeued: rows.length };
}

/**
 * Admin retry resets the per-item attempt budget. Kept separate from
 * retryFailedItems so the plain retry can preserve history when that is wanted.
 */
export async function resetAttemptsForJob(jobId: string): Promise<void> {
  await db
    .update(translationItems)
    .set({ attempts: 0 })
    .where(and(eq(translationItems.jobId, jobId), eq(translationItems.status, "queued")));
}

/** Jobs a worker could still pick work from. */
export async function hasRunnableWork(): Promise<boolean> {
  await ensureTranslationSchema();
  const [row] = await db
    .select({ id: translationItems.id })
    .from(translationItems)
    .innerJoin(translationJobs, eq(translationJobs.id, translationItems.jobId))
    .where(
      and(
        eq(translationItems.status, "queued"),
        inArray(translationJobs.status, ["queued", "processing"]),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Dashboard tiles: one row of totals over all jobs. */
export async function translationSummary(): Promise<{
  totalJobs: number;
  activeJobs: number;
  queuedJobs: number;
  completedJobs: number;
  failedJobs: number;
  cancelledJobs: number;
  queuedItems: number;
  processingItems: number;
  failedItems: number;
}> {
  await ensureTranslationSchema();
  const [jobs] = await db
    .select({
      totalJobs: sql<number>`count(*)::int`,
      activeJobs: sql<number>`count(*) filter (where status = 'processing')::int`,
      queuedJobs: sql<number>`count(*) filter (where status = 'queued')::int`,
      completedJobs: sql<number>`count(*) filter (where status = 'completed')::int`,
      failedJobs: sql<number>`count(*) filter (where status in ('failed','partially_failed'))::int`,
      cancelledJobs: sql<number>`count(*) filter (where status = 'cancelled')::int`,
    })
    .from(translationJobs);

  const [items] = await db
    .select({
      queuedItems: sql<number>`count(*) filter (where status = 'queued')::int`,
      processingItems: sql<number>`count(*) filter (where status = 'processing')::int`,
      failedItems: sql<number>`count(*) filter (where status = 'failed')::int`,
    })
    .from(translationItems);

  return { ...jobs, ...items };
}
