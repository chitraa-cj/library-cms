-- Grantha publishing moves onto a durable, leased job queue drained by a separate
-- worker process (cms-publish-worker) instead of a detached promise inside the web
-- process. See server/publish/store.ts.
--
-- Additive and re-runnable: old web code never reads these columns, so this can be
-- applied before the new build is deployed.

BEGIN;

ALTER TABLE cms_publish_jobs
  -- Distinguishes a full grantha walk from the per-mantra jobs that
  -- /api/drafts/:id/publish-manthra also writes into this table. Several of those
  -- may legitimately run at once on one draft, so the worker, the uniqueness rules
  -- below and the web-side reclaimer all key off this.
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'grantha_publish',
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamp,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamp,
  -- Set when a failed attempt is requeued, so the worker does not re-claim it
  -- instantly and burn the retry budget on a Strapi brownout.
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamp,
  ADD COLUMN IF NOT EXISTS started_at timestamp,
  -- The publish flags the route resolved (allowRenumber, republishFresh): the worker
  -- runs the job long after the request is gone, so they cannot live in a closure.
  ADD COLUMN IF NOT EXISTS publish_options jsonb;

-- Lets /api/drafts/:id/publish answer "the publish worker is not running" instead of
-- accepting a job that would sit queued forever.
CREATE TABLE IF NOT EXISTS cms_worker_heartbeats (
  worker_kind text PRIMARY KEY,
  worker_id   text NOT NULL,
  beat_at     timestamp NOT NULL DEFAULT now()
);

COMMIT;

-- Deliberately OUTSIDE the transaction. If the table already holds a duplicate the
-- index creation fails on its own, loudly, instead of rolling back the columns above.
-- Settle duplicates first:
--   update cms_publish_jobs set status = 'failed_recoverable' where status = 'running';

-- The hard backstop behind the worker's advisory-locked claim: even a logic bug
-- cannot get two grantha publishes running against one grantha, or two active jobs
-- on one draft.
CREATE UNIQUE INDEX IF NOT EXISTS cms_publish_jobs_one_running_per_grantha
  ON cms_publish_jobs (grantha_doc_id)
  WHERE kind = 'grantha_publish' AND status = 'running' AND grantha_doc_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cms_publish_jobs_one_active_per_draft
  ON cms_publish_jobs (draft_id)
  WHERE kind = 'grantha_publish' AND status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS cms_publish_jobs_claim_idx
  ON cms_publish_jobs (kind, status, next_attempt_at, created_at);

-- Lease reaper.
CREATE INDEX IF NOT EXISTS cms_publish_jobs_lease_idx
  ON cms_publish_jobs (status, lease_expires_at)
  WHERE kind = 'grantha_publish';
