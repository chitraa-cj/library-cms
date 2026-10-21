/**
 * Persistence for structure jobs: the job/chunk rows in Postgres and the idempotent DDL
 * that creates both tables on first use. Mirrors server/ocr/store.ts — the prod box
 * deploys by pulling + pm2 restart, so a feature has to be able to install its own
 * tables rather than waiting for a manual migration (script/migrations has the record).
 */
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db";
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

/** Atomically fold one finished chunk's accounting into its job row. */
export async function addStructureChunkResultToJob(
  jobId: string,
  delta: {
    done: number;
    failed: number;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens?: number;
  },
): Promise<void> {
  // Every counter is coerced before it reaches the statement. An `undefined` here does
  // not come back as a type error from a JS caller — it renders as an EMPTY placeholder
  // and Postgres answers `syntax error at or near ","`, which is a confusing way to lose
  // a finished range's accounting.
  const n = (value: number | undefined | null) => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
  };
  await db
    .update(structureJobs)
    .set({
      chunksDone: sql`${structureJobs.chunksDone} + ${n(delta.done)}`,
      chunksFailed: sql`${structureJobs.chunksFailed} + ${n(delta.failed)}`,
      requestCount: sql`${structureJobs.requestCount} + ${n(delta.requests)}`,
      inputTokens: sql`${structureJobs.inputTokens} + ${n(delta.inputTokens)}`,
      outputTokens: sql`${structureJobs.outputTokens} + ${n(delta.outputTokens)}`,
      cachedInputTokens: sql`${structureJobs.cachedInputTokens} + ${n(delta.cachedInputTokens)}`,
      cacheWriteTokens: sql`${structureJobs.cacheWriteTokens} + ${n(delta.cacheWriteTokens)}`,
      updatedAt: new Date(),
    })
    .where(eq(structureJobs.id, jobId));
}

export async function updateStructureChunk(
  jobId: string,
  chunkIndex: number,
  patch: Partial<typeof structureJobChunks.$inferInsert>,
): Promise<void> {
  await db
    .update(structureJobChunks)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(structureJobChunks.jobId, jobId), eq(structureJobChunks.chunkIndex, chunkIndex)));
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
 * Tokens spent since `since`, across every analysis. The spend caps are enforced from
 * this, not from an in-memory tally: a restart, a second web process or a job someone
 * else started must all count against the same budget.
 */
export async function tokensSpentSince(since: Date): Promise<{
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  requests: number;
}> {
  const rows = await db.execute(sql`
    select
      coalesce(sum(input_tokens), 0)::bigint        as input_tokens,
      coalesce(sum(output_tokens), 0)::bigint       as output_tokens,
      coalesce(sum(cached_input_tokens), 0)::bigint as cached_input_tokens,
      coalesce(sum(cache_write_tokens), 0)::bigint  as cache_write_tokens,
      coalesce(sum(request_count), 0)::bigint       as requests
    from cms_structure_jobs
    where updated_at >= ${since}`);
  const row = (rows as any)?.rows?.[0] ?? {};
  const toNum = (value: unknown) => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    inputTokens: toNum(row.input_tokens),
    outputTokens: toNum(row.output_tokens),
    cachedInputTokens: toNum(row.cached_input_tokens),
    cacheWriteTokens: toNum(row.cache_write_tokens),
    requests: toNum(row.requests),
  };
}

export async function requeueFailedStructureChunks(jobId: string): Promise<number> {
  const rows = await db
    .update(structureJobChunks)
    .set({ status: "queued", attempts: 0, error: null, updatedAt: new Date() })
    .where(and(eq(structureJobChunks.jobId, jobId), inArray(structureJobChunks.status, ["failed", "skipped"])))
    .returning({ id: structureJobChunks.id });
  return rows.length;
}

export async function deleteStructureJob(jobId: string): Promise<void> {
  await db.delete(structureJobs).where(eq(structureJobs.id, jobId));
}
