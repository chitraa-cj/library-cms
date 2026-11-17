-- "Mark as read" for failed translation items.
--
-- An admin can acknowledge a failed item on the Translation Jobs page; it then no
-- longer shows in the "Recent errors" / "Failed items" panels. The flag is cleared
-- whenever the item is retried or fails again.
--
-- Additive. The server also installs this column itself on first use. Re-runnable.
-- Rollback (only after rolling the code back): the column is unused by older code
-- and can stay; to remove it, drop the column.

alter table cms_translation_items add column if not exists dismissed_at timestamp;
