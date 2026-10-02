-- Snapshots outgrew jsonb.
--
-- Postgres addresses the elements of a jsonb container with a 28-bit offset, so the
-- TOTAL content of any one jsonb value is capped at 268,435,455 bytes (~256 MB) — the
-- errors are "string too long to represent as jsonb string" for one oversized string
-- and "total size of jsonb array elements exceeds the maximum of 268435455 bytes" for
-- a container. Splitting the payload across an array does NOT help: the cap is on the
-- container's total, not on each element, and nesting only moves the sum up a level.
--
-- `grantha_backups.data` passed that ceiling in 2026-10 (230 MB at 30,521 manthras on
-- 2026-09-19, 41,014 manthras by 2026-10-02), so the gzip stream now lives in a bytea
-- column, which is a plain varlena with a 1 GB limit and no base64 inflation.
--
-- Non-destructive: `data` is kept exactly as it is so every snapshot taken before this
-- migration still restores. It only loses NOT NULL, because new rows store their
-- payload in `data_gz` instead. Safe to re-run.

ALTER TABLE grantha_backups ADD COLUMN IF NOT EXISTS data_gz bytea;

ALTER TABLE grantha_backups ALTER COLUMN data DROP NOT NULL;

-- A row must carry its payload in exactly one of the two columns.
ALTER TABLE grantha_backups DROP CONSTRAINT IF EXISTS grantha_backups_payload_present;
ALTER TABLE grantha_backups ADD CONSTRAINT grantha_backups_payload_present
  CHECK (data IS NOT NULL OR data_gz IS NOT NULL);
