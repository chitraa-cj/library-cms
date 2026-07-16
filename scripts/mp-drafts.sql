SELECT id,
       title,
       status,
       strapi_document_id,
       created_by,
       updated_at,
       pg_column_size(data) AS data_bytes
FROM content_drafts
WHERE title ILIKE '%maya%' OR title ILIKE '%panchakam%'
ORDER BY updated_at DESC;
