/**
 * Persistence for structure jobs: the job/chunk rows in Postgres and the idempotent DDL
 * that creates both tables on first use. Mirrors server/ocr/store.ts — the prod box
 * deploys by pulling + pm2 restart, so a feature has to be able to install its own
 * tables rather than waiting for a manual migration (script/migrations has the record).
 */
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { ensureLeaseColumns, fencedChunkUpdate, STRUCTURE_TABLES } from "../lib/job-lease";
import {
  structureJobChunks,
  structureJobs,
  type StructureJob,
  type StructureJobChunk,
} from "@shared/schema";

let ddlPromise: Promise<void> | null = null;

export function ensureStructureSchema(): Promise<void> {
  if (!ddlPromise) {
    ddlPromise = (async () => {
      await db.execute(sql`
        create table if not exists cms_structure_jobs (
          id varchar primary key,
          ocr_job_id varchar not null references cms_ocr_jobs(id) on delete cascade,
          user_id varchar references users(id) on delete set null,
          depth integer not null default 2,
          level_names jsonb not null default '[]'::jsonb,
          page_from integer,
          page_to integer,
          instructions text,
          voice_used boolean not null default false,
          model text not null,
          status text not null default 'queued',
          chunks_total integer not null default 0,
          chunks_done integer not null default 0,
          chunks_failed integer not null default 0,
          request_count integer not null default 0,
          input_tokens integer not null default 0,
          output_tokens integer not null default 0,
          cached_input_tokens integer not null default 0,
          cache_write_tokens integer not null default 0,
          overrides jsonb not null default '[]'::jsonb,
          reviewed_at timestamp,
          import_status text not null default 'none',
          import_grantha_doc_id text,
          import_summary jsonb,
          imported_at timestamp,
          error text,
          created_at timestamp not null default now(),
          updated_at timestamp not null default now(),
          started_at timestamp,
          finished_at timestamp
        )`);
      await db.execute(sql`
        create table if not exists cms_structure_job_chunks (
          id serial primary key,
          job_id varchar not null references cms_structure_jobs(id) on delete cascade,
          chunk_index integer not null,
          start_page integer not null,
          end_page integer not null,
          status text not null default 'queued',
          attempts integer not null default 0,
          model text,
          items jsonb,
          warnings jsonb,
          open_path jsonb,
          rejected_items integer not null default 0,
          input_tokens integer not null default 0,
          output_tokens integer not null default 0,
          cached_input_tokens integer not null default 0,
          cache_write_tokens integer not null default 0,
          duration_ms integer not null default 0,
          error text,
          updated_at timestamp not null default now()
        )`);
      // Added after the first release; keeps existing installs in step (see the migration).
      await db.execute(
        sql`alter table cms_structure_jobs add column if not exists cache_write_tokens integer not null default 0`,
      );
      await db.execute(
        sql`alter table cms_structure_job_chunks add column if not exists cache_write_tokens integer not null default 0`,
      );
      // The page window (see the 20261016 migration): null on every pre-existing row,
      // which is exactly "the whole document".
      await db.execute(sql`alter table cms_structure_jobs add column if not exists page_from integer`);
      await db.execute(sql`alter table cms_structure_jobs add column if not exists page_to integer`);
      await db.execute(
        sql`create unique index if not exists cms_structure_job_chunks_job_idx
            on cms_structure_job_chunks (job_id, chunk_index)`,
      );
      await db.execute(
        sql`create index if not exists cms_structure_jobs_ocr_idx
            on cms_structure_jobs (ocr_job_id, created_at desc)`,
      );
      await db.execute(
        sql`create index if not exists cms_structure_jobs_created_idx
            on cms_structure_jobs (created_at desc)`,
      );
      // Run token + heartbeat (script/migrations/20261029_local_ocr_and_job_leases.sql).
      await ensureLeaseColumns(STRUCTURE_TABLES);
    })().catch((err) => {
      ddlPromise = null; // let the next request retry instead of caching the failure
      throw err;
    });
  }
  return ddlPromise;
}

export async function insertStructureJob(row: typeof structureJobs.$inferInsert): Promise<StructureJob> {
  const [job] = await db.insert(structureJobs).values(row).returning();
  return job;
}

export async function insertStructureChunks(
  rows: Array<typeof structureJobChunks.$inferInsert>,
): Promise<void> {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(structureJobChunks).values(rows.slice(i, i + 500));
  }
}

export async function getStructureJob(jobId: string): Promise<StructureJob | undefined> {
  const [job] = await db.select().from(structureJobs).where(eq(structureJobs.id, jobId));
  return job;
}

export async function listStructureJobsForOcr(ocrJobId: string): Promise<StructureJob[]> {
  return db
    .select()
    .from(structureJobs)
    .where(eq(structureJobs.ocrJobId, ocrJobId))
    .orderBy(desc(structureJobs.createdAt));
}

export async function listStructureJobs(limit = 30): Promise<StructureJob[]> {
  return db.select().from(structureJobs).orderBy(desc(structureJobs.createdAt)).limit(limit);
}

/** Chunk rows without the (potentially huge) `items` payload — for progress polling. */
export async function listStructureChunkStatuses(jobId: string) {
  return db
    .select({
      chunkIndex: structureJobChunks.chunkIndex,
      startPage: structureJobChunks.startPage,
      endPage: structureJobChunks.endPage,
      status: structureJobChunks.status,
      attempts: structureJobChunks.attempts,
      model: structureJobChunks.model,
      rejectedItems: structureJobChunks.rejectedItems,
      durationMs: structureJobChunks.durationMs,
      error: structureJobChunks.error,
    })
    .from(structureJobChunks)
    .where(eq(structureJobChunks.jobId, jobId))
    .orderBy(structureJobChunks.chunkIndex);
}

export async function listStructureChunks(jobId: string): Promise<StructureJobChunk[]> {
  return db
    .select()
    .from(structureJobChunks)
    .where(eq(structureJobChunks.jobId, jobId))
    .orderBy(structureJobChunks.chunkIndex);
}

export async function claimableStructureChunks(jobId: string): Promise<StructureJobChunk[]> {
  return db
    .select()
    .from(structureJobChunks)
    .where(and(eq(structureJobChunks.jobId, jobId), inArray(structureJobChunks.status, ["queued", "running"])))
    .orderBy(structureJobChunks.chunkIndex);
}

export async function updateStructureJob(
  jobId: string,
  patch: Partial<typeof structureJobs.$inferInsert>,
): Promise<void> {
  await db
    .update(structureJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(structureJobs.id, jobId));
}

/**
 * Commentary names already used anywhere in this job, so the next range can be told to
 * spell the same sub-commentary the same way.
 *
 * Done in Postgres rather than by loading every chunk's `items`: the naive version reads
 * the whole growing answer set once per range, which is quadratic in the number of ranges
 * and megabytes per read on a long book.
 */
export async function distinctTeekaNames(jobId: string): Promise<string[]> {
  const rows = await db.execute(sql`
    select distinct trim(item->>'teekaName') as name
    from cms_structure_job_chunks c
    cross join lateral jsonb_array_elements(c.items) as item
    where c.job_id = ${jobId}
      and c.items is not null
      and jsonb_typeof(c.items) = 'array'
      and coalesce(trim(item->>'teekaName'), '') <> ''
    order by name
    limit 200`);
  return ((rows as any)?.rows ?? [])
    .map((row: any) => String(row.name ?? "").trim())
    .filter(Boolean);
}

/** The last analysed range before `chunkIndex`: its page span and the path it left open. */
export async function previousDoneChunk(
  jobId: string,
  chunkIndex: number,
): Promise<{ startPage: number; endPage: number; openPath: unknown[] | null } | undefined> {
  const [row] = await db
    .select({
      startPage: structureJobChunks.startPage,
      endPage: structureJobChunks.endPage,
      openPath: structureJobChunks.openPath,
    })
    .from(structureJobChunks)
    .where(
      and(
        eq(structureJobChunks.jobId, jobId),
        eq(structureJobChunks.status, "done"),
        lt(structureJobChunks.chunkIndex, chunkIndex),
      ),
    )
    .orderBy(desc(structureJobChunks.chunkIndex))
    .limit(1);
  return row;
}

/**
 * Requeue a finished job's failed/skipped/unfinished ranges in one transaction, only
 * while no run owns it — a double-clicked Retry cannot requeue a running job. Ranges
 * already analysed are left alone. Returns null when the job is queued or running.
 */
export async function requeueStructureJobForRetry(jobId: string): Promise<{ pending: number; done: number } | null> {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select({ status: structureJobs.status })
      .from(structureJobs)
      .where(eq(structureJobs.id, jobId))
      .for("update");
    if (!job || job.status === "running" || job.status === "queued") return null;
    await tx
      .update(structureJobChunks)
      .set({ status: "queued", attempts: 0, error: null, updatedAt: new Date() })
      .where(
        and(eq(structureJobChunks.jobId, jobId), inArray(structureJobChunks.status, ["failed", "skipped", "running"])),
      );
    const rows = await tx
      .select({ status: structureJobChunks.status })
      .from(structureJobChunks)
      .where(eq(structureJobChunks.jobId, jobId));
    const done = rows.filter((r) => r.status === "done").length;
    const pending = rows.length - done;
    await tx
      .update(structureJobs)
      .set({
        status: pending > 0 ? "queued" : "done",
        chunksDone: done,
        chunksFailed: 0,
        error: null,
        runToken: null,
        finishedAt: pending > 0 ? null : new Date(),
        updatedAt: new Date(),
      })
      .where(eq(structureJobs.id, jobId));
    return { pending, done };
  });
}

/** A range's outcome, written only if `token` still owns the job. */
export function writeStructureChunkResult(
  jobId: string,
  chunkIndex: number,
  token: string,
  result:
    | {
        status: "done";
        items: unknown[];
        warnings: string[];
        openPath: unknown[] | null;
        rejected: number;
        model: string;
        attempts: number;
        durationMs: number;
      }
    | { status: "failed" | "skipped" | "queued" | "running"; attempts?: number; durationMs?: number; error: string | null },
): Promise<boolean> {
  const assignments =
    result.status === "done"
      ? sql`status = 'done', items = ${JSON.stringify(result.items)}::jsonb,
            warnings = ${JSON.stringify(result.warnings)}::jsonb,
            open_path = ${result.openPath == null ? null : JSON.stringify(result.openPath)}::jsonb,
            rejected_items = ${result.rejected}, model = ${result.model},
            attempts = attempts + ${result.attempts}, duration_ms = ${result.durationMs}, error = null`
      : sql`status = ${result.status}, attempts = attempts + ${result.attempts ?? 0},
            duration_ms = ${result.durationMs ?? 0}, error = ${result.error}`;
  return fencedChunkUpdate(STRUCTURE_TABLES, jobId, chunkIndex, token, assignments);
}

/** Requests spent on this job (fenced like every other run write). */
export async function addStructureRequests(jobId: string, token: string, requests: number): Promise<void> {
  if (!(requests > 0)) return;
  await db.execute(sql`
    update cms_structure_jobs set request_count = request_count + ${Math.trunc(requests)}, updated_at = now()
     where id = ${jobId} and run_token = ${token}`);
}

/** JSON with object keys sorted at every depth — equality that survives a jsonb round trip. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Replace the review's edit list only if the stored list is a prefix of `next` (the
 * client appends). Any edit re-opens the review. Row-locked, so the check and the write
 * are one decision.
 */
export async function saveOverridesIfCurrent(jobId: string, next: unknown[]): Promise<"saved" | "conflict"> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ overrides: structureJobs.overrides })
      .from(structureJobs)
      .where(eq(structureJobs.id, jobId))
      .for("update");
    const stored = (row?.overrides ?? []) as unknown[];
    // jsonb does not keep object key order, so compare key-order-insensitively.
    const isPrefix =
      stored.length <= next.length && stored.every((entry, i) => canonicalJson(entry) === canonicalJson(next[i]));
    if (!isPrefix) return "conflict";
    await tx
      .update(structureJobs)
      .set({ overrides: next, reviewedAt: null, updatedAt: new Date() })
      .where(eq(structureJobs.id, jobId));
    return "saved";
  });
}

export async function deleteStructureJob(jobId: string): Promise<void> {
  await db.delete(structureJobs).where(eq(structureJobs.id, jobId));
}
