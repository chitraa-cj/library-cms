/**
 * Queue mechanics for grantha publish jobs, over `cms_publish_jobs`.
 *
 * Shaped after `server/translation/store.ts` — claim with FOR UPDATE SKIP LOCKED, hold a
 * lease, heartbeat it, reap expired ones — with one difference that matters: a publish is
 * exclusive per grantha. Two translation items may safely run side by side; two publishes
 * against one grantha corrupt it.
 *
 * EVERY interval is computed in SQL (`now() + make_interval(...)`). These columns are
 * `timestamp` WITHOUT time zone on a session whose TimeZone is Asia/Kolkata, so a JS
 * `Date` written into one lands 5h30m out — the trap documented in the translation store.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, pool } from "../db";
import {
  publishJobs,
  workerHeartbeats,
  type PublishJobOptions,
  type PublishJobRecord,
} from "@shared/schema";
import { PUBLISH_WORKER_KIND, publishConfig, sanitizePublishError } from "./config";

const KIND = "grantha_publish";

/** Jobs a worker may pick up, newest state first for the admin views. */
export async function listActivePublishJobs(limit = 20): Promise<PublishJobRecord[]> {
  return db
    .select()
    .from(publishJobs)
    .where(and(eq(publishJobs.kind, KIND), inArray(publishJobs.status, ["queued", "running"])))
    .orderBy(desc(publishJobs.updatedAt))
    .limit(limit);
}

/**
 * Claim one job, or return null.
 *
 * Three statements in ONE transaction, and all three are load-bearing:
 *
 *  1. Pick a candidate and row-lock it with SKIP LOCKED.
 *  2. Take a transaction-scoped advisory lock on the TARGET (grantha, or the draft when
 *     the grantha has no id yet). Step 1's lock is on the candidate ROW, so two workers
 *     looking at two *different* queued jobs for the *same* grantha would both see no
 *     running sibling and both commit. This is the statement that prevents that.
 *  3. Re-check the sibling condition under the lock, then take the job.
 *
 * The advisory lock must NOT be folded into step 1's WHERE: it would be evaluated per
 * candidate row in an order the planner chooses, taking locks on granthas never claimed.
 *
 * The partial unique indexes from the migration are the backstop; a 23505 here just means
 * someone else won, so it is treated as "no work" rather than an error.
 */
export async function claimNextJob(
  workerId: string,
  leaseMs = publishConfig.leaseMs,
): Promise<PublishJobRecord | null> {
  const leaseSecs = Math.round(leaseMs / 1000);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const picked = await client.query(
      `select j.id, j.draft_id, j.grantha_doc_id
         from cms_publish_jobs j
        where j.kind = $1
          and j.status = 'queued'
          and j.attempts < j.max_attempts
          and (j.next_attempt_at is null or j.next_attempt_at <= now())
          and not exists (
                select 1 from cms_publish_jobs r
                 where r.kind = $1
                   and r.status = 'running'
                   and ( (r.grantha_doc_id is not null and r.grantha_doc_id = j.grantha_doc_id)
                         or r.draft_id = j.draft_id )
              )
        order by j.created_at asc
          for update of j skip locked
        limit 1`,
      [KIND],
    );
    const row = picked.rows?.[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }

    const lockKey = row.grantha_doc_id
      ? `cms_publish:${row.grantha_doc_id}`
      : `cms_publish:draft:${row.draft_id}`;
    const locked = await client.query(
      "select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as got",
      [lockKey],
    );
    if (!locked.rows?.[0]?.got) {
      await client.query("ROLLBACK");
      return null;
    }

    const taken = await client.query(
      `update cms_publish_jobs t
          set status = 'running',
              attempts = t.attempts + 1,
              lease_owner = $2,
              lease_expires_at = now() + make_interval(secs => $3),
              last_heartbeat_at = now(),
              started_at = coalesce(t.started_at, now()),
              next_attempt_at = null,
              error = null,
              updated_at = now()
        where t.id = $1
          and t.status = 'queued'
          and not exists (
                select 1 from cms_publish_jobs r
                 where r.kind = $4
                   and r.status = 'running'
                   and r.id <> t.id
                   and ( (r.grantha_doc_id is not null and r.grantha_doc_id = t.grantha_doc_id)
                         or r.draft_id = t.draft_id )
              )
       returning t.*`,
      [row.id, workerId, leaseSecs, KIND],
    );
    if (!taken.rows?.length) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query("COMMIT");
    return mapJobRow(taken.rows[0]);
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    if (err?.code === "23505") return null; // lost the race; the unique index held
    throw err;
  } finally {
    client.release();
  }
}

/** Renew the lease. False means we no longer hold it — stop working. */
export async function heartbeatJob(
  jobId: string,
  workerId: string,
  leaseMs = publishConfig.leaseMs,
): Promise<boolean> {
  const seconds = Math.round(leaseMs / 1000);
  const updated = await db
    .update(publishJobs)
    .set({
      leaseExpiresAt: sql`now() + make_interval(secs => ${seconds})`,
      lastHeartbeatAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(publishJobs.id, jobId),
        eq(publishJobs.status, "running"),
        eq(publishJobs.leaseOwner, workerId),
      ),
    )
    .returning({ id: publishJobs.id });
  return updated.length > 0;
}

/** Progress tick. Never lowers a known total back to 0, and never clears a lease. */
export async function writeProgress(
  jobId: string,
  progress: { done: number; total: number; current: string },
): Promise<void> {
  await db
    .update(publishJobs)
    .set({
      progressDone: progress.done,
      // Attempt 2 re-reports the same total, but a transient 0 from an early tick must
      // not wipe a total the UI is already drawing a bar against.
      progressTotal: sql`greatest(${publishJobs.progressTotal}, ${progress.total})`,
      progressCurrent: progress.current,
      updatedAt: sql`now()`,
    })
    .where(eq(publishJobs.id, jobId));
}

export async function completeJob(jobId: string, result: unknown): Promise<void> {
  await db
    .update(publishJobs)
    .set({
      status: "done",
      result: result as any,
      error: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: sql`now()`,
    })
    .where(eq(publishJobs.id, jobId));
}

/**
 * Record a failed attempt. Requeues while attempts remain AND the error is worth retrying;
 * otherwise terminal. `failed_recoverable` is what the client renders as "safe to retry".
 */
export async function failJob(
  jobId: string,
  error: unknown,
  opts: { retryable: boolean; attempts: number; maxAttempts: number },
): Promise<"queued" | "failed" | "failed_recoverable"> {
  const message = sanitizePublishError(error);
  const canRetry = opts.retryable && opts.attempts < opts.maxAttempts;
  const status = canRetry ? "queued" : opts.retryable ? "failed_recoverable" : "failed";
  const backoffSecs = Math.round(publishConfig.retryBackoffMs / 1000);

  await db
    .update(publishJobs)
    .set({
      status,
      error: message,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: canRetry ? sql`now() + make_interval(secs => ${backoffSecs})` : null,
      updatedAt: sql`now()`,
    })
    .where(eq(publishJobs.id, jobId));
  return status;
}

/**
 * Hand a job back without spending an attempt — used on SIGTERM. A deploy is not a
 * failure, and a publish takes far too long to wait out during shutdown.
 */
export async function releaseJob(jobId: string, reason: string): Promise<void> {
  await db
    .update(publishJobs)
    .set({
      status: "queued",
      attempts: sql`greatest(${publishJobs.attempts} - 1, 0)`,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      error: reason,
      updatedAt: sql`now()`,
    })
    .where(eq(publishJobs.id, jobId));
}

/** Rows this worker owned before a restart are ours to take straight back. */
export async function requeueOwnedJobs(workerId: string): Promise<number> {
  const rows = await db
    .update(publishJobs)
    .set({
      status: "queued",
      attempts: sql`greatest(${publishJobs.attempts} - 1, 0)`,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      error: "Publish worker restarted; requeued automatically.",
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(publishJobs.kind, KIND),
        eq(publishJobs.status, "running"),
        eq(publishJobs.leaseOwner, workerId),
      ),
    )
    .returning({ id: publishJobs.id });
  return rows.length;
}

/**
 * Anything whose lease lapsed — a worker that died without releasing. Out of attempts
 * becomes `failed_recoverable` rather than looping forever.
 */
export async function requeueExpiredLeases(): Promise<number> {
  const backoffSecs = 10;
  const rows = await db
    .update(publishJobs)
    .set({
      status: sql`case when ${publishJobs.attempts} >= ${publishJobs.maxAttempts}
                       then 'failed_recoverable' else 'queued' end`,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: sql`now() + make_interval(secs => ${backoffSecs})`,
      error: "Publish worker stopped mid-job (lease expired); requeued automatically.",
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(publishJobs.kind, KIND),
        eq(publishJobs.status, "running"),
        sql`${publishJobs.leaseExpiresAt} is not null`,
        sql`${publishJobs.leaseExpiresAt} < now()`,
      ),
    )
    .returning({ id: publishJobs.id });
  return rows.length;
}

export async function getJob(jobId: string): Promise<PublishJobRecord | null> {
  const [job] = await db.select().from(publishJobs).where(eq(publishJobs.id, jobId));
  return job ?? null;
}

// ── worker liveness ───────────────────────────────────────────────────────────────
// So `POST /publish` can refuse a job nothing will drain, instead of accepting one that
// sits `queued` until the client's poll gives up.

export async function beatWorkerHeartbeat(
  workerId: string,
  kind = PUBLISH_WORKER_KIND,
): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({ workerKind: kind, workerId, beatAt: sql`now()` })
    .onConflictDoUpdate({
      target: workerHeartbeats.workerKind,
      set: { workerId, beatAt: sql`now()` },
    });
}

export async function isPublishWorkerAlive(
  staleMs = publishConfig.heartbeatStaleMs,
): Promise<boolean> {
  const seconds = Math.round(staleMs / 1000);
  const rows = await db
    .select({ id: workerHeartbeats.workerKind })
    .from(workerHeartbeats)
    .where(
      and(
        eq(workerHeartbeats.workerKind, PUBLISH_WORKER_KIND),
        sql`${workerHeartbeats.beatAt} > now() - make_interval(secs => ${seconds})`,
      ),
    );
  return rows.length > 0;
}

/** node-postgres returns snake_case for raw queries; drizzle's selects are camelCase. */
function mapJobRow(r: any): PublishJobRecord {
  return {
    id: r.id,
    draftId: r.draft_id,
    userId: r.user_id,
    granthaDocId: r.grantha_doc_id,
    status: r.status,
    kind: r.kind,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    leaseOwner: r.lease_owner,
    leaseExpiresAt: r.lease_expires_at,
    lastHeartbeatAt: r.last_heartbeat_at,
    nextAttemptAt: r.next_attempt_at,
    startedAt: r.started_at,
    publishOptions: (r.publish_options ?? null) as PublishJobOptions | null,
    progressDone: r.progress_done,
    progressTotal: r.progress_total,
    progressCurrent: r.progress_current,
    result: r.result,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  } as PublishJobRecord;
}
