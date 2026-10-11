-- Baseline for the publish pipeline's own tables.
--
-- These were created by `drizzle-kit push` from shared/schema.ts and never had a file of
-- their own, which left the queue's schema with no reviewable record and made every later
-- file in this directory depend on a table nothing here creates. Sorted first (00000000)
-- so the ALTERs that follow have something to alter. The rest of the portal's tables
-- still come from drizzle push; this covers the publish path, which is what
-- `server/schema-guard.ts` verifies before accepting a publish.
--
-- On an existing database this is a no-op — every statement is IF NOT EXISTS and the
-- columns listed here already exist. It defines the table as of 20261003, so that
-- migration remains the record of what the queue added; nothing here replaces it.
--
-- Non-destructive: nothing is dropped, altered or backfilled.

CREATE TABLE IF NOT EXISTS cms_publish_jobs (
  id               varchar PRIMARY KEY,
  draft_id         integer NOT NULL,
  user_id          varchar,
  grantha_doc_id   text,
  status           text NOT NULL DEFAULT 'queued',
  kind             text NOT NULL DEFAULT 'grantha_publish',
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 3,
  lease_owner      text,
  lease_expires_at timestamp,
  last_heartbeat_at timestamp,
  next_attempt_at  timestamp,
  started_at       timestamp,
  publish_options  jsonb,
  progress_done    integer NOT NULL DEFAULT 0,
  progress_total   integer NOT NULL DEFAULT 0,
  progress_current text NOT NULL DEFAULT 'Starting…',
  result           jsonb,
  error            text,
  created_at       timestamp NOT NULL DEFAULT now(),
  updated_at       timestamp NOT NULL DEFAULT now()
);

-- Replay protection for a double-clicked Publish (server/routes.ts
-- loadOrReplayIdempotency). The draft_id FK is added by
-- 20260527_draft_fk_on_delete_cascade.sql.
CREATE TABLE IF NOT EXISTS cms_idempotency_keys (
  key             text PRIMARY KEY,
  route           text NOT NULL,
  request_hash    text NOT NULL,
  response_status integer NOT NULL,
  response_body   jsonb,
  user_id         varchar,
  draft_id        integer,
  created_at      timestamp NOT NULL DEFAULT now(),
  expires_at      timestamp NOT NULL
);

CREATE INDEX IF NOT EXISTS cms_idempotency_keys_expires_at_idx
  ON cms_idempotency_keys (expires_at);
