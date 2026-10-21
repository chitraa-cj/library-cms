-- OCR → Grantha: the page window an analysis covers.
--
-- A structure job used to be "this whole OCR document". These two columns record the
-- 1-based, inclusive page range the editor chose instead, so only those pages are
-- planned into ranges, sent to Claude and billed — which is how a single 100-page slice
-- of a long scan can be analysed (and re-analysed) without paying for the rest.
--
-- Null means the whole transcription, which is what every row created before this
-- migration meant, so there is nothing to backfill. Re-runnable.

alter table cms_structure_jobs add column if not exists page_from integer;
alter table cms_structure_jobs add column if not exists page_to integer;
