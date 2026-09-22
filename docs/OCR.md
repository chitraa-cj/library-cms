# OCR Docs (admin-only)

Transcribe scanned books, manuscripts and PDFs with Gemini, from inside the CMS
portal. Admins see **Administration → OCR Docs** (`/admin/ocr`); editors do not
see the nav entry and every API route returns 403 for them.

## How a document is processed

```
upload (raw bytes)
   └─ PDF page count + size-aware chunk plan      server/ocr/pdf.ts
        └─ N chunk rows, each an inclusive page range        (cms_ocr_job_chunks)
             └─ worker pool (OCR_CONCURRENCY lanes)          server/ocr/jobs.ts
                  └─ global gate: in-flight / per-minute / per-day
                                                             server/ocr/limiter.ts
                       └─ ONE Gemini request per page range  server/ocr/gemini.ts
                            └─ Markdown with <<<PAGE:n>>> markers
                                 └─ merged, page-ordered document
```

The chunk row is the unit of work, of retry and of accounting:

- a page range that fails never costs the ranges that succeeded — **Retry failed**
  re-runs only the failed rows;
- a server restart requeues in-flight rows and resumes automatically
  (`reconcileOcrJobsOnBoot`), again without re-running finished pages;
- the viewer reads the merged document while the job is still running, so pages
  appear as their range lands instead of after the last request.

Nothing polls a queue and nothing recurses: waiters are woken by an explicit
FIFO queue, retries are capped at `OCR_MAX_ATTEMPTS`, and every loop walks a
finite list of chunks.

## Keeping Gemini usage moderate

| Gate | Default | Env |
| --- | --- | --- |
| Pages per request | 8 (auto-reduced for heavy scans) | `OCR_CHUNK_SIZE` |
| Requests in flight (whole server) | 4 | `OCR_CONCURRENCY` |
| Documents worked on at once | 2 | `OCR_MAX_ACTIVE_JOBS` |
| Requests per rolling minute | 12 | `OCR_REQUESTS_PER_MINUTE` |
| Requests per UTC day | 1500 | `OCR_REQUESTS_PER_DAY` |
| Attempts per page range | 4 | `OCR_MAX_ATTEMPTS` |
| Upload size / page count | 120MB / 1500 pages | `OCR_MAX_UPLOAD_MB`, `OCR_MAX_PAGES` |

A 400-page book at 8 pages per request is **50 Gemini requests**, not 400. The
day counter is seeded from the database on boot, so a restart does not hand out
a fresh daily budget. When the day budget runs out, remaining ranges are marked
`skipped` and the job finishes as `partial` — press Retry failed after reset
(00:00 UTC).

Retries count too: an attempt made while a slot is already held is booked
against the minute window and the day counter (`recordExtraOcrRequest`), so a
burst of 503s cannot quietly push past the cap.

### The API key's own quota comes first

Our caps only matter while they are *stricter* than the key's. A **free-tier**
Gemini key is metered per project **per model per day** — currently 20
requests/day/model — which is a few dozen pages, not a book. Two consequences:

- for documents of hundreds of pages, enable billing on the Google AI Studio
  project; nothing in this feature can create quota that the key does not have;
- when a model's daily quota is spent, the runner does not retry it (a per-day
  quota will not refill in 30s). It moves the page range to the next model in
  `OCR_FALLBACK_MODELS` — a separate quota bucket — at the cost of one
  immediately-failing request per exhausted model. The viewer names any model
  that served ranges this way, because transcription quality can differ.

Transcription is deterministic (temperature 0) and, on the **Fast** profile,
runs with thinking disabled — thinking tokens are billed and add nothing to a
straight transcription. The **High accuracy** profile leaves the model's own
thinking on.

### Progress, ETA and busy models

The page polls `GET /jobs/:id` every 1.5s. Between chunk-row changes the worker
keeps an in-memory record per running range (`server/ocr/progress.ts`), so the
poll can say "attempt 2 of 4", "Gemini busy (503), retrying in 12s" or "waiting
for a request slot" instead of a bare spinner. `server/ocr/estimate.ts` turns the
chunk rows plus that live state into a page-based ETA; it is a pure function
with unit tests, and its `basis` is shown so a first-minute guess is never
dressed up as a measurement.

A `503 high demand` answer means the model itself is short of capacity, not the
key. With fallback models configured, a range spends at most two attempts on the
busy model and then hands over to the next model (a separate capacity pool),
exactly as it does for a spent daily quota. Without fallbacks it keeps the full
`OCR_MAX_ATTEMPTS` budget on the one model.

Keep the fallback list to models the key can really call. Gemini retires models
(`404 … no longer available to new users`), and a dead entry costs one wasted
request per page range:

```bash
node --import tsx --env-file=.env script/ocr-probe-models.mts
```

It spends one tiny request per configured model and exits non-zero only for a
model that can never work; `503` (busy) and `429` (quota spent) are reported as
transient, because those are what the fallback chain is for.

## Configuration

```
GEMINI_API_KEY=...            # required; without it the page says "not configured"
OCR_MODEL_FAST=gemini-3.8-flash
OCR_MODEL_ACCURATE=gemini-3.8-flash   # point at a Pro model if the key has Pro quota
OCR_FALLBACK_MODELS=gemini-3.5-flash,gemini-3.1-flash-lite,gemini-2.5-flash-lite
                              # tried, in order, when the chosen model's DAILY quota is spent
OCR_STORAGE_DIR=              # defaults to <repo>/.ocr-store
OCR_RETENTION_DAYS=30
```

Uploaded files live in `.ocr-store/<jobId>/` (git-ignored) and are deleted with
the job, or swept after `OCR_RETENTION_DAYS` via
`POST /api/admin/ocr/maintenance/purge`.

The two tables (`cms_ocr_jobs`, `cms_ocr_job_chunks`) are created on first use by
`ensureOcrSchema()`, so a deploy needs no manual migration step;
`script/migrations/20260921_ocr_jobs.sql` (`npm run migrate:ocr`) is the same DDL
if you prefer to create them ahead of time.

## API

All routes are `requireAuth + requireAdmin`, mounted at `/api/admin/ocr`.

| Route | Purpose |
| --- | --- |
| `GET /config` | limits, models, live usage snapshot |
| `GET /jobs` | recent jobs |
| `POST /jobs` | upload (raw body; `fileName`, `mimeType`, `quality`, `chunkSize`, `instructions` as query params) |
| `GET /jobs/:id` | job + per-chunk status (cheap, for polling), each running chunk's `live` state (attempt, phase `slot`/`request`/`backoff`, next-attempt time, last transient error), a `progress` estimate (pages done/running/failed/queued, `elapsedMs`, `etaMs`, and its `basis`: `measured` from this job's finished ranges, `historical` from earlier jobs on the same model, or `guess`), and `serverNow` so the client can turn absolute stamps into countdowns |
| `GET /jobs/:id/document` | merged pages + markdown + missing ranges |
| `GET /jobs/:id/download?format=md\|txt` | file download |
| `GET /jobs/:id/source` | the original upload |
| `POST /jobs/:id/retry` | resume: requeue failed/skipped/unfinished ranges, never the done ones |
| `POST /jobs/:id/cancel` | abort; finished pages are kept |
| `DELETE /jobs/:id` | delete rows + uploaded file |

## Testing

```bash
node --import tsx tests/ocr-pipeline.test.mjs           # units: chunking, slicing, marker
                                                        # parsing, rendering, limiter,
                                                        # progress estimate, 503 hand-over
node --import tsx tests/ocr-pipeline.test.mjs --live    # + one real Gemini request

# Full path (upload → chunk → Gemini → poll → merge → download) against the
# local database, with the router mounted on a throwaway Express app:
OCR_E2E_NO_SSL=1 node --import tsx script/ocr-e2e-local.mts path/to/file.pdf [pagesPerRequest]
```

`OCR_E2E_NO_SSL=1` is no longer needed: `server/db.ts` switches TLS off for a
`localhost` DATABASE_URL on its own (and `DATABASE_SSL=false` forces it off
anywhere). The flag is still honoured for older checkouts.

## Output format

Gemini is asked for Markdown with one `<<<PAGE:n>>>` marker per page: headings by
visual hierarchy, verse line breaks preserved, footnotes under a rule, tables as
Markdown tables, `[illegible]` for unreadable words and `*[figure: …]*` for
images — never a translation, a correction or a summary. If the model skips the
markers, the range is kept as one block rather than losing text.

The viewer renders that Markdown with a small escape-first renderer
(`client/src/lib/ocr-markdown.ts`): transcribed text is HTML-escaped before any
markup is produced, so a scan can never inject markup into the portal.
