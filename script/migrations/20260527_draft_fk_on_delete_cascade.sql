-- Rerunnable: sets ON DELETE CASCADE for portal draft dependents.
-- Apply after reviewing dry-run: npx tsx script/discard-draft-dependencies.ts --all
-- Safe to re-run: drops/recreates only the three draft_id FKs (and job_id on tasks).

BEGIN;

ALTER TABLE cms_publish_job_tasks
  DROP CONSTRAINT IF EXISTS cms_publish_job_tasks_job_id_cms_publish_jobs_id_fk;
ALTER TABLE cms_publish_job_tasks
  DROP CONSTRAINT IF EXISTS cms_publish_job_tasks_draft_id_content_drafts_id_fk;
ALTER TABLE cms_publish_jobs
  DROP CONSTRAINT IF EXISTS cms_publish_jobs_draft_id_content_drafts_id_fk;
ALTER TABLE cms_idempotency_keys
  DROP CONSTRAINT IF EXISTS cms_idempotency_keys_draft_id_content_drafts_id_fk;

ALTER TABLE cms_idempotency_keys
  ADD CONSTRAINT cms_idempotency_keys_draft_id_content_drafts_id_fk
  FOREIGN KEY (draft_id) REFERENCES content_drafts(id) ON DELETE CASCADE;

ALTER TABLE cms_publish_jobs
  ADD CONSTRAINT cms_publish_jobs_draft_id_content_drafts_id_fk
  FOREIGN KEY (draft_id) REFERENCES content_drafts(id) ON DELETE CASCADE;

ALTER TABLE cms_publish_job_tasks
  ADD CONSTRAINT cms_publish_job_tasks_draft_id_content_drafts_id_fk
  FOREIGN KEY (draft_id) REFERENCES content_drafts(id) ON DELETE CASCADE;

ALTER TABLE cms_publish_job_tasks
  ADD CONSTRAINT cms_publish_job_tasks_job_id_cms_publish_jobs_id_fk
  FOREIGN KEY (job_id) REFERENCES cms_publish_jobs(id) ON DELETE CASCADE;

COMMIT;
