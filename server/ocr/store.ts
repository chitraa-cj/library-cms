/**
 * Persistence for OCR jobs: the uploaded file on disk, the job/chunk rows in
 * Postgres, and the idempotent DDL that creates those two tables on first use
 * (the prod box deploys by pulling + pm2 restart, so the feature has to be able
 * to install its own tables rather than waiting for a manual migration).
 *
 * Writes a running job makes to its chunk rows are FENCED on the run's token
 * (`fencedChunkUpdate`): a worker that no longer owns the job writes nothing.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { ocrJobChunks, ocrJobs, type OcrJob, type OcrJobChunk } from "@shared/schema";
import { ensureLeaseColumns, fencedChunkUpdate, OCR_TABLES } from "../lib/job-lease";
import { ocrConfig } from "./config";

// ───────────────────────────────────────────────────────────── schema bootstrap
let ddlPromise: Promise<void> | null = null;

export function ensureOcrSchema(): Promise<void> {
  if (!ddlPromise) {
    ddlPromise = (async () => {
      await db.execute(sql`
        create table if not exists cms_ocr_jobs (
          id varchar primary key,
          user_id varchar references users(id) on delete set null,
          file_name text not null,
          mime_type text not null,
          file_size integer not null default 0,
          file_hash text,
          page_count integer not null default 1,
          chunk_size integer not null default 8,
          quality text not null default 'fast',
          model text not null,
          instructions text,
          status text not null default 'queued',
          chunks_total integer not null default 0,
          chunks_done integer not null default 0,
          chunks_failed integer not null default 0,
          request_count integer not null default 0,
          input_tokens integer not null default 0,
          output_tokens integer not null default 0,
          error text,
          created_at timestamp not null default now(),
          updated_at timestamp not null default now(),
          started_at timestamp,
          finished_at timestamp
        )`);
      await db.execute(sql`
        create table if not exists cms_ocr_job_chunks (
          id serial primary key,
          job_id varchar not null references cms_ocr_jobs(id) on delete cascade,
          chunk_index integer not null,
          start_page integer not null,
          end_page integer not null,
          status text not null default 'queued',
          attempts integer not null default 0,
          model text,
          markdown text,
          input_tokens integer not null default 0,
          output_tokens integer not null default 0,
          duration_ms integer not null default 0,
          error text,
          updated_at timestamp not null default now()
        )`);
      await db.execute(
        sql`create unique index if not exists cms_ocr_job_chunks_job_idx on cms_ocr_job_chunks (job_id, chunk_index)`,
      );
      // Added after the first release; keeps existing installs in step.
      await db.execute(sql`alter table cms_ocr_job_chunks add column if not exists model text`);
      // Local engine (script/migrations/20261029_local_ocr_and_job_leases.sql).
      await db.execute(sql`alter table cms_ocr_job_chunks add column if not exists raw_text text`);
      await db.execute(sql`alter table cms_ocr_job_chunks add column if not exists pages_meta jsonb`);
      await db.execute(sql`alter table cms_ocr_jobs add column if not exists text_mode text not null default 'auto'`);
      // cms-ocr-worker (script/migrations/20261030_ocr_worker_live_state.sql).
      await db.execute(sql`alter table cms_ocr_job_chunks add column if not exists live_state jsonb`);
      await ensureLeaseColumns(OCR_TABLES);
      await db.execute(
        sql`create index if not exists cms_ocr_jobs_created_idx on cms_ocr_jobs (created_at desc)`,
      );
    })().catch((err) => {
      ddlPromise = null; // let the next request retry instead of caching the failure
      throw err;
    });
  }
  return ddlPromise;
}

// ────────────────────────────────────────────────────────────── file storage
function storageRoot(): string {
  return ocrConfig.storageDir || path.join(process.cwd(), ".ocr-store");
}

export function jobDir(jobId: string): string {
  return path.join(storageRoot(), jobId);
}

function sourcePath(jobId: string, mimeType: string): string {
  const ext = mimeType === "application/pdf" ? "pdf" : mimeType.split("/")[1] || "bin";
  return path.join(jobDir(jobId), `source.${ext}`);
}

export async function saveSourceFile(jobId: string, mimeType: string, bytes: Buffer): Promise<string> {
  await mkdir(jobDir(jobId), { recursive: true });
  const target = sourcePath(jobId, mimeType);
  await writeFile(target, bytes);
  return target;
}

export async function readSourceFile(job: OcrJob): Promise<Buffer> {
  return readFile(sourcePath(job.id, job.mimeType));
}

export async function deleteSourceFile(jobId: string): Promise<void> {
  await rm(jobDir(jobId), { recursive: true, force: true });
}

export function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ────────────────────────────────────────────────────────────────── job rows
export async function insertJob(row: typeof ocrJobs.$inferInsert): Promise<OcrJob> {
  const [job] = await db.insert(ocrJobs).values(row).returning();
  return job;
}

/**
 * A new job and all its ranges in ONE transaction. The job is `queued` the moment it
 * commits and the worker may claim it right then (poll or NOTIFY), so its ranges must
 * already exist: a job claimed with no ranges would finish as "done" with no pages.
 */
export async function insertJobWithChunks(
  row: typeof ocrJobs.$inferInsert,
  chunks: Array<typeof ocrJobChunks.$inferInsert>,
): Promise<OcrJob> {
  return db.transaction(async (tx) => {
    const [job] = await tx.insert(ocrJobs).values(row).returning();
    // One statement per 500 rows keeps the parameter count well inside Postgres' limit.
    for (let i = 0; i < chunks.length; i += 500) {
      await tx.insert(ocrJobChunks).values(chunks.slice(i, i + 500));
    }
    return job;
  });
}

export async function insertChunks(rows: Array<typeof ocrJobChunks.$inferInsert>): Promise<void> {
  if (rows.length === 0) return;
  // One statement per 500 rows keeps the parameter count well inside Postgres' limit.
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(ocrJobChunks).values(rows.slice(i, i + 500));
  }
}

export async function getJob(jobId: string): Promise<OcrJob | undefined> {
  const [job] = await db.select().from(ocrJobs).where(eq(ocrJobs.id, jobId));
  return job;
}

export async function listJobs(limit = 30): Promise<OcrJob[]> {
  return db.select().from(ocrJobs).orderBy(desc(ocrJobs.createdAt)).limit(limit);
}

/** Chunk rows without the (potentially huge) markdown column — for progress polling. */
export async function listChunkStatuses(jobId: string) {
  return db
    .select({
      chunkIndex: ocrJobChunks.chunkIndex,
      startPage: ocrJobChunks.startPage,
      endPage: ocrJobChunks.endPage,
      status: ocrJobChunks.status,
      attempts: ocrJobChunks.attempts,
      model: ocrJobChunks.model,
      durationMs: ocrJobChunks.durationMs,
      error: ocrJobChunks.error,
    })
    .from(ocrJobChunks)
    .where(eq(ocrJobChunks.jobId, jobId))
    .orderBy(ocrJobChunks.chunkIndex);
}

/**
 * Average milliseconds per page that `model` has needed on finished ranges of
 * earlier jobs — the ETA's basis before the current job has measured anything.
 * Cached briefly: it is asked for on every progress poll.
 */
const historyCache = new Map<string, { at: number; value: number | null }>();
export async function historicalMsPerPage(model: string): Promise<number | null> {
  const cached = historyCache.get(model);
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  let value: number | null = null;
  try {
    const rows = await db.execute(sql`
      select sum(duration_ms)::float8 / nullif(sum(end_page - start_page + 1), 0) as ms_per_page
      from cms_ocr_job_chunks
      where status = 'done' and duration_ms > 0 and model = ${model}
        and updated_at > now() - interval '60 days'`);
    const parsed = Number((rows as any)?.rows?.[0]?.ms_per_page);
    value = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    value = null;
  }
  historyCache.set(model, { at: Date.now(), value });
  return value;
}

export async function listChunks(jobId: string): Promise<OcrJobChunk[]> {
  return db.select().from(ocrJobChunks).where(eq(ocrJobChunks.jobId, jobId)).orderBy(ocrJobChunks.chunkIndex);
}

/** What the merged document needs — not `raw_text`, which would double the read. */
export async function listChunkTexts(jobId: string) {
  return db
    .select({
      chunkIndex: ocrJobChunks.chunkIndex,
      startPage: ocrJobChunks.startPage,
      endPage: ocrJobChunks.endPage,
      status: ocrJobChunks.status,
      markdown: ocrJobChunks.markdown,
      pagesMeta: ocrJobChunks.pagesMeta,
      error: ocrJobChunks.error,
    })
    .from(ocrJobChunks)
    .where(eq(ocrJobChunks.jobId, jobId))
    .orderBy(ocrJobChunks.chunkIndex);
}

/** Raw engine output per range, for the raw-vs-normalized comparison download. */
export async function listChunkRawTexts(jobId: string) {
  return db
    .select({
      startPage: ocrJobChunks.startPage,
      endPage: ocrJobChunks.endPage,
      status: ocrJobChunks.status,
      rawText: ocrJobChunks.rawText,
      markdown: ocrJobChunks.markdown,
    })
    .from(ocrJobChunks)
    .where(eq(ocrJobChunks.jobId, jobId))
    .orderBy(ocrJobChunks.chunkIndex);
}

/**
 * An existing job for the same bytes and the same settings that is not failed or
 * cancelled — what a repeated upload (double click, browser retry) should get back
 * instead of a second, identical transcription.
 */
export async function findReusableJob(fileHash: string, textMode: string, quality: string): Promise<OcrJob | undefined> {
  const [job] = await db
    .select()
    .from(ocrJobs)
    .where(
      and(
        eq(ocrJobs.fileHash, fileHash),
        eq(ocrJobs.textMode, textMode as any),
        eq(ocrJobs.quality, quality as any),
        inArray(ocrJobs.status, ["queued", "running", "done", "partial"]),
      ),
    )
    .orderBy(desc(ocrJobs.createdAt))
    .limit(1);
  return job;
}

export async function claimableChunks(jobId: string): Promise<OcrJobChunk[]> {
  return db
    .select()
    .from(ocrJobChunks)
    .where(and(eq(ocrJobChunks.jobId, jobId), inArray(ocrJobChunks.status, ["queued", "running"])))
    .orderBy(ocrJobChunks.chunkIndex);
}

export async function updateJob(jobId: string, patch: Partial<typeof ocrJobs.$inferInsert>): Promise<void> {
  await db
    .update(ocrJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(ocrJobs.id, jobId));
}

/** Atomically fold one finished chunk's accounting into its job row. */
export async function addChunkResultToJob(
  jobId: string,
  delta: { done: number; failed: number; requests: number; inputTokens: number; outputTokens: number },
): Promise<void> {
  await db
    .update(ocrJobs)
    .set({
      chunksDone: sql`${ocrJobs.chunksDone} + ${delta.done}`,
      chunksFailed: sql`${ocrJobs.chunksFailed} + ${delta.failed}`,
      requestCount: sql`${ocrJobs.requestCount} + ${delta.requests}`,
      inputTokens: sql`${ocrJobs.inputTokens} + ${delta.inputTokens}`,
      outputTokens: sql`${ocrJobs.outputTokens} + ${delta.outputTokens}`,
      updatedAt: new Date(),
    })
    .where(eq(ocrJobs.id, jobId));
}

export async function updateChunk(
  jobId: string,
  chunkIndex: number,
  patch: Partial<typeof ocrJobChunks.$inferInsert>,
): Promise<void> {
  await db
    .update(ocrJobChunks)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(ocrJobChunks.jobId, jobId), eq(ocrJobChunks.chunkIndex, chunkIndex)));
}

/**
 * Requeue a finished job's failed/skipped/unfinished ranges, in one transaction and
 * only while no run owns it — so a double-clicked Retry, or a Retry racing the
 * scheduler, can never put a running job back in the queue under its own feet.
 * Ranges already `done` are left alone. Returns null when the job is busy.
 */
export async function requeueJobForRetry(jobId: string): Promise<{ pending: number; done: number } | null> {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select({ status: ocrJobs.status })
      .from(ocrJobs)
      .where(eq(ocrJobs.id, jobId))
      .for("update");
    if (!job || job.status === "running" || job.status === "queued") return null;
    await tx
      .update(ocrJobChunks)
      .set({ status: "queued", attempts: 0, error: null, updatedAt: new Date() })
      .where(and(eq(ocrJobChunks.jobId, jobId), inArray(ocrJobChunks.status, ["failed", "skipped", "running"])));
    const rows = await tx
      .select({ status: ocrJobChunks.status })
      .from(ocrJobChunks)
      .where(eq(ocrJobChunks.jobId, jobId));
    const done = rows.filter((r) => r.status === "done").length;
    const pending = rows.length - done;
    await tx
      .update(ocrJobs)
      .set({
        status: pending > 0 ? "queued" : "done",
        chunksDone: done,
        chunksFailed: 0,
        error: null,
        runToken: null,
        finishedAt: pending > 0 ? null : new Date(),
        updatedAt: new Date(),
      })
      .where(eq(ocrJobs.id, jobId));
    return { pending, done };
  });
}

/** A finished range's result, written only if `token` still owns the job. */
export function writeChunkResult(
  jobId: string,
  chunkIndex: number,
  token: string,
  result:
    | { status: "done"; markdown: string; rawText: string; pagesMeta: unknown[]; model: string; attempts: number; durationMs: number }
    | { status: "failed" | "queued"; attempts?: number; durationMs: number; error: string | null },
): Promise<boolean> {
  const assignments =
    result.status === "done"
      ? sql`status = 'done', markdown = ${result.markdown}, raw_text = ${result.rawText},
            pages_meta = ${JSON.stringify(result.pagesMeta)}::jsonb, model = ${result.model},
            attempts = attempts + ${result.attempts}, duration_ms = ${result.durationMs}, error = null,
            live_state = null`
      : sql`status = ${result.status}, attempts = attempts + ${result.attempts ?? 0},
            duration_ms = ${result.durationMs}, error = ${result.error}, live_state = null`;
  return fencedChunkUpdate(OCR_TABLES, jobId, chunkIndex, token, assignments);
}

/** The worker's live view of a range (progress.ts), for the web app to read. Advisory, unfenced. */
export async function writeChunkLive(jobId: string, chunkIndex: number, state: unknown | null): Promise<void> {
  await db.execute(sql`
    update cms_ocr_job_chunks set live_state = ${state == null ? null : JSON.stringify(state)}::jsonb
     where job_id = ${jobId} and chunk_index = ${chunkIndex}`);
}

/** Live state of a job's ranges, as written by the worker. */
export async function listChunkLive(jobId: string): Promise<Record<number, any>> {
  const result = await db.execute(sql`
    select chunk_index, live_state from cms_ocr_job_chunks
     where job_id = ${jobId} and live_state is not null and status in ('queued', 'running')`);
  const out: Record<number, any> = {};
  for (const row of ((result as any).rows ?? []) as any[]) out[Number(row.chunk_index)] = row.live_state;
  return out;
}

/**
 * Lane usage seen from the database, so the web app reports what the worker is
 * doing: ranges being read now, and jobs waiting their turn.
 */
export async function ocrQueueUsage(concurrency: number): Promise<{ inFlight: number; waiting: number; concurrency: number }> {
  const result = await db.execute(sql`
    select (select count(*) from cms_ocr_job_chunks c join cms_ocr_jobs j on j.id = c.job_id
             where c.status = 'running' and j.status = 'running')::int as in_flight,
           (select count(*) from cms_ocr_jobs where status = 'queued')::int as waiting`);
  const row = (((result as any).rows ?? []) as any[])[0] ?? {};
  return { inFlight: Number(row.in_flight ?? 0), waiting: Number(row.waiting ?? 0), concurrency };
}

export function markChunkRunning(jobId: string, chunkIndex: number, token: string): Promise<boolean> {
  return fencedChunkUpdate(OCR_TABLES, jobId, chunkIndex, token, sql`status = 'running', error = null`);
}

export async function deleteJob(jobId: string): Promise<void> {
  await db.delete(ocrJobs).where(eq(ocrJobs.id, jobId));
  await deleteSourceFile(jobId);
}

/** Sweep jobs past the retention window (rows + uploaded files). */
export async function purgeExpiredJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - ocrConfig.retentionDays * 24 * 60 * 60 * 1000);
  const stale = await db
    .select({ id: ocrJobs.id })
    .from(ocrJobs)
    .where(lt(ocrJobs.createdAt, cutoff));
  for (const row of stale) await deleteJob(row.id);
  return stale.length;
}
