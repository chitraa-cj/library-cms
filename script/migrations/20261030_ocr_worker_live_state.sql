-- OCR runs in its own pm2 process (cms-ocr-worker) instead of the web app.
--
-- The worker writes what each range is doing right now ("attempt 2 of 3", "retrying
-- in 40s") to cms_ocr_job_chunks.live_state so the web app, which no longer runs OCR,
-- can still show it. Advisory only: null whenever the range is idle or finished.
--
-- Additive. The server also installs this column itself on first use. Re-runnable.
-- Rollback (only after rolling the code back): the column is unused by older code
-- and can stay; to remove it, drop the column.

alter table cms_ocr_job_chunks add column if not exists live_state jsonb;
