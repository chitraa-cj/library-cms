-- Admin-only Hermex/Gemini translation queue.
-- The server also runs this DDL itself on first use (server/translation/store.ts
-- ensureTranslationSchema), so a deploy needs no manual step; this file is the
-- record and the way to create the tables ahead of time.

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
);

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
);

-- The worker's hot path is "oldest queued item, any job" and "oldest queued item
-- of THIS job", so both orderings are covered.
create index if not exists cms_translation_items_job_idx on cms_translation_items (job_id);
create index if not exists cms_translation_items_status_idx on cms_translation_items (status);
create index if not exists cms_translation_items_job_status_idx on cms_translation_items (job_id, status);
create index if not exists cms_translation_items_claim_idx
  on cms_translation_items (status, job_id, sequence_number);
create index if not exists cms_translation_items_seq_idx on cms_translation_items (job_id, sequence_number);
create index if not exists cms_translation_items_created_idx on cms_translation_items (created_at);
-- Lease expiry scan for crash recovery.
create index if not exists cms_translation_items_lease_idx on cms_translation_items (status, lease_expires_at);
-- One row per mantra per job: makes re-running job creation idempotent.
create unique index if not exists cms_translation_items_job_seq_uidx
  on cms_translation_items (job_id, sequence_number);

create index if not exists cms_translation_jobs_status_idx on cms_translation_jobs (status);
create index if not exists cms_translation_jobs_created_idx on cms_translation_jobs (created_at desc);
