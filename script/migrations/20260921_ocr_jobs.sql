-- OCR Docs (admin-only Gemini transcription).
-- The server also runs this DDL itself on first use (server/ocr/store.ts
-- ensureOcrSchema), so a deploy needs no manual step; this file is the record
-- and the way to create the tables ahead of time.

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
);

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
);

alter table cms_ocr_job_chunks add column if not exists model text;

create unique index if not exists cms_ocr_job_chunks_job_idx on cms_ocr_job_chunks (job_id, chunk_index);
create index if not exists cms_ocr_jobs_created_idx on cms_ocr_jobs (created_at desc);
