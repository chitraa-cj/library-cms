-- Emit only the base64 gzip payload for one snapshot id (passed as :id).
-- Safe: reads a single row; no decompression happens on the box.
SELECT data->>'data' FROM grantha_backups WHERE id = :id;
