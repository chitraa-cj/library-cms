-- Rerunnable: persistent grantha-level publish lock + manthra resolution checkpoint.
-- 1. cms_publish_jobs.grantha_doc_id: tracks which Strapi grantha a publish targets so
--    forked drafts pointing at the same grantha can't publish concurrently across processes.
-- 2. cms_publish_manthra_resolutions: per-job checkpoint of portal_manthra_id ->
--    strapi_document_id. Hydrated on retry so we never re-create rows for mantras
--    already published by a previous attempt.

BEGIN;

-- (1) granthaDocId column + index for the "running publish on this grantha?" lookup.
ALTER TABLE cms_publish_jobs
  ADD COLUMN IF NOT EXISTS grantha_doc_id TEXT;

CREATE INDEX IF NOT EXISTS cms_publish_jobs_grantha_doc_id_status_idx
  ON cms_publish_jobs (grantha_doc_id, status)
  WHERE grantha_doc_id IS NOT NULL;

-- (2) checkpoint table for portal -> Strapi manthra docId mappings, scoped per job.
CREATE TABLE IF NOT EXISTS cms_publish_manthra_resolutions (
  job_id              VARCHAR    NOT NULL,
  portal_manthra_id   TEXT       NOT NULL,
  strapi_document_id  TEXT       NOT NULL,
  created_at          TIMESTAMP  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (job_id, portal_manthra_id),
  CONSTRAINT cms_publish_manthra_resolutions_job_id_fk
    FOREIGN KEY (job_id) REFERENCES cms_publish_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cms_publish_manthra_resolutions_job_id_idx
  ON cms_publish_manthra_resolutions (job_id);

COMMIT;
