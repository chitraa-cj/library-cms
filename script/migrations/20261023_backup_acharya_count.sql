-- Snapshots now carry the acharya profiles (they live only in this portal's Postgres,
-- never in Strapi). The Snapshots list shows how many each one holds, read from this
-- column so the list never has to open the multi-MB `summary` jsonb of every row.
--
-- Snapshots taken before 2026-10-23 captured no acharyas, so 0 is accurate for them.
-- Additive and safe to re-run.

ALTER TABLE grantha_backups ADD COLUMN IF NOT EXISTS acharya_count integer NOT NULL DEFAULT 0;
