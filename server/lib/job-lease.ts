/**
 * Ownership of a long-running job row, shared by the OCR and structure runners.
 *
 *   claim      queued → running, atomically, with FOR UPDATE SKIP LOCKED — two
 *              processes (or two pumps in one) can never start the same job;
 *   run token  a fresh UUID per claim. Every write the runner makes is fenced on
 *              it, so a worker that lost its job (requeued as stale, cancelled and
 *              restarted elsewhere) writes nothing — its late answer cannot land
 *              on top of the new run's;
 *   heartbeat  `heartbeat_at`, refreshed while the runner is alive. A running job
 *              whose heartbeat is older than the stale window is requeued — that
 *              is crash recovery, and it never touches a live job.
 *
 * Timestamps here are ALWAYS the database's own `now()`, compared with `now()`:
 * the database runs in Asia/Kolkata and Node may not, and mixing the two clocks in
 * one `timestamp` column is a known trap in this codebase.
 *
 * Table names come from the fixed `LeasedTables` below, never from input.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";

export interface LeasedTables {
  jobs: "cms_ocr_jobs" | "cms_structure_jobs";
  chunks: "cms_ocr_job_chunks" | "cms_structure_job_chunks";
}

export const OCR_TABLES: LeasedTables = { jobs: "cms_ocr_jobs", chunks: "cms_ocr_job_chunks" };
export const STRUCTURE_TABLES: LeasedTables = { jobs: "cms_structure_jobs", chunks: "cms_structure_job_chunks" };

/** DDL both job tables need; idempotent, run from each feature's ensure*Schema(). */
export async function ensureLeaseColumns(tables: LeasedTables): Promise<void> {
  const jobs = sql.identifier(tables.jobs);
  await db.execute(sql`alter table ${jobs} add column if not exists run_token varchar`);
  await db.execute(sql`alter table ${jobs} add column if not exists heartbeat_at timestamp`);
  await db.execute(
    sql`create index if not exists ${sql.identifier(`${tables.jobs}_status_idx`)} on ${jobs} (status, created_at)`,
  );
}

function rowsOf(result: unknown): any[] {
  return ((result as any)?.rows ?? []) as any[];
}

/** Atomically take the oldest queued job. Returns its id and this run's token, or null. */
export async function claimNextJob(tables: LeasedTables): Promise<{ id: string; token: string } | null> {
  const jobs = sql.identifier(tables.jobs);
  const token = randomUUID();
  const result = await db.execute(sql`
    update ${jobs}
       set status = 'running', run_token = ${token}, heartbeat_at = now(),
           started_at = now(), error = null, updated_at = now()
     where id = (
       select id from ${jobs}
        where status = 'queued'
        order by created_at
        for update skip locked
        limit 1)
    returning id`);
  const row = rowsOf(result)[0];
  return row ? { id: String(row.id), token } : null;
}

/** Refresh the heartbeat. False means this run no longer owns the job — stop. */
export async function heartbeat(tables: LeasedTables, jobId: string, token: string): Promise<boolean> {
  const result = await db.execute(sql`
    update ${sql.identifier(tables.jobs)}
       set heartbeat_at = now()
     where id = ${jobId} and run_token = ${token} and status = 'running'
    returning id`);
  return rowsOf(result).length > 0;
}

/** Does this run still own the job? Read-only twin of `heartbeat`. */
export async function stillOwns(tables: LeasedTables, jobId: string, token: string): Promise<boolean> {
  const result = await db.execute(sql`
    select 1 as ok from ${sql.identifier(tables.jobs)}
     where id = ${jobId} and run_token = ${token} and status = 'running'`);
  return rowsOf(result).length > 0;
}

/**
 * Update one chunk row only if `token` still owns its job. Returns whether it
 * applied. The fence and the write are one statement, so there is no window in
 * which a requeue can slip between the check and the write.
 */
export async function fencedChunkUpdate(
  tables: LeasedTables,
  jobId: string,
  chunkIndex: number,
  token: string,
  assignments: ReturnType<typeof sql>,
): Promise<boolean> {
  const chunks = sql.identifier(tables.chunks);
  const jobs = sql.identifier(tables.jobs);
  const result = await db.execute(sql`
    update ${chunks} c
       set ${assignments}, updated_at = now()
     where c.job_id = ${jobId} and c.chunk_index = ${chunkIndex}
       and exists (select 1 from ${jobs} j where j.id = c.job_id and j.run_token = ${token})
    returning c.id`);
  return rowsOf(result).length > 0;
}

/**
 * Release a job at the end of a run: set its final status only if this run still
 * owns it, and clear the token so nothing from this run can write again.
 */
export async function releaseJob(
  tables: LeasedTables,
  jobId: string,
  token: string,
  assignments: ReturnType<typeof sql>,
): Promise<boolean> {
  const result = await db.execute(sql`
    update ${sql.identifier(tables.jobs)}
       set ${assignments}, run_token = null, updated_at = now()
     where id = ${jobId} and run_token = ${token}
    returning id`);
  return rowsOf(result).length > 0;
}

/**
 * Crash recovery: running jobs whose heartbeat is older than `staleAfterMs` (or
 * that never had one — rows from before this column existed) go back to the
 * queue, with their in-flight chunks. Finished chunks are untouched, so the
 * resumed run only does what is missing. One transaction per sweep.
 */
export async function requeueStaleJobs(tables: LeasedTables, staleAfterMs: number): Promise<string[]> {
  const jobs = sql.identifier(tables.jobs);
  const chunks = sql.identifier(tables.chunks);
  const seconds = Math.max(1, Math.round(staleAfterMs / 1000));
  return db.transaction(async (tx) => {
    const stale = rowsOf(
      await tx.execute(sql`
        update ${jobs}
           set status = 'queued', run_token = null, updated_at = now()
         where status = 'running'
           and (heartbeat_at is null or heartbeat_at < now() - make_interval(secs => ${seconds}))
        returning id`),
    ).map((r) => String(r.id));
    if (stale.length > 0) {
      await tx.execute(sql`
        update ${chunks} set status = 'queued', updated_at = now()
         where status = 'running' and job_id in (${sql.join(stale.map((id) => sql`${id}`), sql`, `)})`);
    }
    return stale;
  });
}
