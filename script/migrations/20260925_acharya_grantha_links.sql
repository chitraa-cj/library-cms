-- Granthas placed under an acharya by hand in the portal. Alias matching against
-- Grantha.BhashyamAuthor still works; these are merged on top of it, so a grantha
-- whose author name doesn't match (or is blank) can still be filed under an acharya.
ALTER TABLE acharya_profiles
  ADD COLUMN IF NOT EXISTS linked_grantha_doc_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
