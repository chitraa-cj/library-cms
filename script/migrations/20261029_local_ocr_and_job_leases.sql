-- Local OCR engine + job ownership for OCR and OCR → Grantha jobs.
--
-- OCR no longer calls the Gemini API: pages are read from the PDF's own text layer or
-- recognised by Tesseract on the box. These columns keep what that pipeline produces
-- apart from what is shown:
--   cms_ocr_job_chunks.raw_text    the engine's untouched output (markdown holds the
--                                  normalized text the viewer and the structure step read)
--   cms_ocr_job_chunks.pages_meta  per page: text layer or OCR, engine + language set,
--                                  confidence, and review flags
--   cms_ocr_jobs.text_mode         'auto' (use a usable text layer) or 'ocr' (always OCR)
--
-- Both job tables gain the fencing token + heartbeat used by server/lib/job-lease.ts:
-- a job is claimed atomically (FOR UPDATE SKIP LOCKED), every write of a run is fenced
-- on its token, and only a job whose heartbeat went stale is requeued.
--
-- Additive only: existing rows keep their text and read exactly as before (null
-- raw_text/pages_meta = a job transcribed by the old Gemini path). The server also
-- installs these columns itself on first use. Re-runnable.
--
-- Rollback (only after rolling the code back): the columns are unused by older code and
-- can stay; to remove them, drop the six columns and the two indexes below.

alter table cms_ocr_job_chunks add column if not exists raw_text text;
alter table cms_ocr_job_chunks add column if not exists pages_meta jsonb;
alter table cms_ocr_jobs add column if not exists text_mode text not null default 'auto';

alter table cms_ocr_jobs add column if not exists run_token varchar;
alter table cms_ocr_jobs add column if not exists heartbeat_at timestamp;
create index if not exists cms_ocr_jobs_status_idx on cms_ocr_jobs (status, created_at);

alter table cms_structure_jobs add column if not exists run_token varchar;
alter table cms_structure_jobs add column if not exists heartbeat_at timestamp;
create index if not exists cms_structure_jobs_status_idx on cms_structure_jobs (status, created_at);
