-- OCR → Grantha structure analysis (admin-only, Claude).
--
-- One structure job per attempt at organising a finished OCR job into a grantha
-- hierarchy; one chunk row per page range, which is the unit of work and of retry.
--
-- The server also runs this DDL itself on first use (server/structure/store.ts
-- ensureStructureSchema), the same way the OCR tables install themselves, so a deploy
-- needs no manual step. This file is the record and the way to create the tables ahead
-- of time. Re-runnable.

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
);

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
  duration_ms integer not null default 0,
  error text,
  updated_at timestamp not null default now()
);

create unique index if not exists cms_structure_job_chunks_job_idx
  on cms_structure_job_chunks (job_id, chunk_index);
create index if not exists cms_structure_jobs_ocr_idx
  on cms_structure_jobs (ocr_job_id, created_at desc);
create index if not exists cms_structure_jobs_created_idx
  on cms_structure_jobs (created_at desc);

-- Cache WRITES bill at 1.25x and cache reads at 0.1x, so the two are counted separately:
-- the spend caps are computed from these counters, and folding writes into reads would
-- under-bill the budget.
alter table cms_structure_jobs add column if not exists cache_write_tokens integer not null default 0;
alter table cms_structure_job_chunks add column if not exists cache_write_tokens integer not null default 0;
