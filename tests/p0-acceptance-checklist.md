# P0 Reliability Acceptance Checklist

- No duplicate running publish jobs for the same draft (`publish_jobs` gate in API).
- Refresh during publish resumes polling by persisted `jobId` and DB-backed status endpoint.
- Stale save writes return `409` when `expectedUpdatedAt` does not match current draft.
- `Idempotency-Key` replay returns cached response; key reuse with different payload returns `409`.
- Snapshot recovery endpoint restores latest draft snapshot payload.
- Strapi upstream failures are classified and retried with bounded backoff.
