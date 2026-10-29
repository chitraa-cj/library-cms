# OCR Docs (admin-only)

Transcribe PDFs and scans with **Gemini's web UI through Hermex** — the same browser
automation translation uses, on a **separate, dedicated** Gemini account and Chrome
profile. There is no API key, no direct Gemini/Claude/OpenAI API call, no local OCR
engine (no Tesseract, no poppler OCR) and no fallback: if Hermex cannot work, the job
stops and says why.

Admins see **Administration → OCR Docs** (`/admin/ocr`); editors do not see the nav entry
and every API route returns 403 for them.

## Where it runs

OCR jobs run in their own pm2 process, **`cms-ocr-worker`** (`server/ocr/worker-main.ts`,
built to `dist/ocr-worker.cjs`). The web app (`cmslibrary`) only manages jobs: upload,
status, Retry, cancel, delete, purge, documents and downloads. It never claims a job or
opens a browser — `pump()` is inert there because only the worker calls
`startOcrScheduler()`, and importing the OCR modules starts no timer.

- **Discovery:** an upload or Retry commits the job rows, then sends
  `NOTIFY cms_ocr_queue`; the worker `LISTEN`s and claims at once. It also polls every
  `OCR_WORKER_POLL_MS` (5 s), so a lost notification, or a LISTEN connection that
  dropped, only delays a job by one poll.
- **Cancel:** the web app marks the job cancelled and clears its run token, then sends
  `NOTIFY cms_ocr_cancel`; the worker aborts the range in flight. Even without the
  notification, the run's next heartbeat fails and every write it attempts is fenced off.
- **Live progress** ("attempt 2 of 3", "retrying in 40 s") is written by the worker to
  `cms_ocr_job_chunks.live_state` and read by the web app; lane usage comes from the rows.
- **Shutdown** (SIGTERM from pm2): no new claims, the range in flight is aborted, and the
  job is handed back to the queue (fenced on its token) within ~20 s; finished pages are
  kept and the next boot resumes it. A run that dies without that is requeued by the stale
  sweep after `OCR_STALE_AFTER_MS`.
- **Shared profile:** OCR → Grantha still runs in the web app on the same Chrome profile.
  The two processes take turns through the profile's lock file: a session refused as
  "busy" waits and retries (`HERMEX_PROFILE_BUSY_WAIT_MS`, default 2 h) instead of failing.

## How a page is read

```
upload (stored once, never modified)            .ocr-store/<jobId>/source.pdf
   └─ page count (pdf-lib) + one chunk row per range      cms_ocr_job_chunks
        └─ job claimed (lease, run token, heartbeat)       server/ocr/jobs.ts
             └─ ONE browser session for the job            server/hermex/prompt-session.ts
                  └─ per range (1 page by default)         server/ocr/hermex-engine.ts
                       ├─ copy the range's pages into a small PDF (pdf-lib; the
                       │  upload itself is untouched) — or the image as it is
                       ├─ fresh Gemini chat: OCR prompt + that file attached
                       ├─ answer validated (markers, every page once, end marker)
                       └─ normalize whitespace only → review flags
                  └─ fenced write: raw page text + normalized text + per-page metadata
```

**The prompt** asks for a verbatim transcription: every character in its original script,
original line breaks, verse numbers, dandas and punctuation; no transliteration,
translation, correction, completion or summary; `[?]` where something cannot be read;
no commentary. The answer must be one code block (Gemini's rendered Markdown would
otherwise collapse line breaks), with `=== PAGE n ===` before each page and `=== END ===`
after the last.

**Validation before anything is stored** (`parseOcrReply`):

| Answer | Outcome |
| --- | --- |
| every page of the range, once, in order, then the end marker | stored |
| no end marker (cut off / truncated) | rejected, retried in a fresh chat |
| a page missing, repeated, out of order or with the wrong number | rejected, retried |
| no markers at all (a refusal, an explanation, a login page's text) | rejected, retried — never stored as page text |
| still unusable after `OCR_MAX_ATTEMPTS` | that range **fails**; the others are unaffected |

Only the text between the markers is kept, so anything Gemini's UI adds around the code
block ("Use code with caution", a language label) is never taken as page text.

What is kept, per page, and never mixed up:

| Stage | Where | What |
| --- | --- | --- |
| Original | `.ocr-store/<job>/source.*` | the upload, byte for byte |
| Raw | `cms_ocr_job_chunks.raw_text` | each page's text exactly as Gemini returned it (`Raw` download) |
| Normalized | `cms_ocr_job_chunks.markdown` | raw minus whitespace artefacts — what the viewer shows and OCR → Grantha reads |
| Metadata | `cms_ocr_job_chunks.pages_meta` | engine (`hermex/gemini-web`), word count, `[?]` count, review flags |
| Approved | the grantha | whatever an editor commits through the grantha editor |

**Nothing rewrites source text after transcription.** Normalization
(`shared/ocr-quality.ts`) only unifies line endings, drops form feeds, trailing spaces and
runs of 3+ blank lines. No character inside a line is changed, and no Unicode
normalization form is applied.

### Review flags

`empty`, `short`, `illegible` (Gemini marked something `[?]`), `invalid_unicode`,
`repeated_lines` (a transcription loop). Gemini reports no confidence score, so there is
no confidence flag on Hermex pages. A flag is a content warning for a reviewer; it is not a
processing failure and never fails a page. Pages stored by earlier engines keep their
old flags (`low_confidence`, `embedded_text_rejected`) and still display.

**Accuracy is not measured yet.** No real Gemini OCR request has run against a labelled
page from this deployment (the dedicated account was not logged in when this was built).
Measure on a labelled sample of the real corpus before trusting the output unreviewed;
Gemini can misread, and a fluent misreading is not flagged.

## Browser session, account and turn-taking

- Profile: `HERMEX_STRUCTURE_CHROME_PROFILE` — shared with OCR → Grantha, refused if it is
  translation's profile, inside it, hermex's default profile, or uses translation's lock
  (`server/hermex/task-profiles.ts`). One-time login: `npm run hermex:setup-structure`.
- One browser per job, reused for all its ranges (Chrome + Gemini warm-up is paid once),
  closed when the job ends.
- OCR and OCR → Grantha **take turns**: `HermexPromptSession.open` holds a per-profile gate,
  so a job waits for the other workflow's session to close instead of failing on the
  profile lock. One OCR job and one range run at a time — a single Gemini session never
  has two requests in flight, and every answer carries its request's correlation id.
- Login expiry: the Python session checks for Gemini's "Sign in" link before and after each
  request. A signed-out session ends the job with "login has expired — log in again, then
  Retry"; a login page is never accepted as an answer.
- Cleanup is scoped to this profile (`HERMEX_CLEANUP_SCOPE=profile`): it cannot kill
  translation's browser. Translation's own cleanup is unchanged.
- Memory: translation's live Chrome measured ≈ 2.7 GB PSS on the EC2 box with ≈ 3.2 GB
  available. Run large OCR jobs while no translation job is processing.

## Reliability

- **Unit of work = one range** (`OCR_CHUNK_SIZE`, default 1 page): a failure costs only
  that range; **Retry** re-runs only failed/unfinished ranges (finished rows are not
  rewritten).
- **Recoverable** browser errors (timeout, Gemini's canned "Something went wrong", a crashed
  browser) retry with backoff in a fresh chat, up to `OCR_MAX_ATTEMPTS` requests per range.
- **Setup** failures — not logged in / login expired, no display, profile locked by
  another process, Hermex not installed — stop the job and leave its pages **queued**, not
  failed. Fix the cause, press Retry.
- **Completion**: a job is `done` only when every range was stored after passing
  validation; otherwise `partial` / `failed` with the reason. A browser reply alone never
  completes anything.
- **Ownership** (`server/lib/job-lease.ts`): jobs are claimed with
  `FOR UPDATE SKIP LOCKED`; every write of a run is fenced on its run token; a heartbeat
  proves liveness. A run whose heartbeat is older than `OCR_STALE_AFTER_MS` is requeued by a
  periodic sweep. A cancelled or requeued run writes nothing. Cancel works across processes.
- **Idempotent upload**: the same bytes return the existing job (`reused: true`) as long as
  its stored upload still exists. `force=1` makes a new one.
- A job whose stored upload has gone fails once with that reason.

## Formats

PDF, PNG, JPEG, WebP. **TIFF and HEIC are refused** (415): Hermex's Gemini upload does not
accept them and this server has no image converter. Convert them to PDF or PNG first.

## Speed

Not measured against real Gemini yet. Each range costs one Gemini request in a fresh chat
plus the upload; the first range of a job also pays the browser launch. The progress
estimate starts from a 45 s/page placeholder (shown as a guess) and switches to this
job's measured times as soon as one range finishes.

## Setup (server)

```bash
# 1. a profile directory OUTSIDE the repo (deploys run git clean)
echo 'HERMEX_STRUCTURE_CHROME_PROFILE=/home/ubuntu/hermex-structure/chrome-profile' >> .env
# 2. its own Xvfb display, so the OCR browser never shares translation's :99
#    (Xvfb :98 must be running whenever OCR runs — make it a service like :99's)
echo 'HERMEX_STRUCTURE_DISPLAY=:98' >> .env
# 3. one-time login with the dedicated (non-translation) Google account, on :98 via VNC
npm run hermex:setup-structure
# 4. apply the live-progress column, start the worker and restart the web app
npm run migrate        # or psql -f script/migrations/20261030_ocr_worker_live_state.sql
pm2 start ecosystem.config.cjs --only cms-ocr-worker && pm2 save
pm2 restart cmslibrary
pm2 logs cms-ocr-worker --lines 20 --nostream   # "Hermex ready" + "WORKER READY"
```

No apt packages are needed for OCR.

## Configuration

See `.env.example` (OCR section). The variables `GEMINI_API_KEY`, `OCR_MODEL_*`,
`OCR_ENGINE`, `OCR_TESSDATA_DIR`, `OCR_LANGS_*`, `OCR_DPI_*`, `OCR_CONCURRENCY` and
`OCR_NICE` are not read by OCR.

## API

All routes are `requireAuth + requireAdmin`, mounted at `/api/admin/ocr`.

| Route | Purpose |
| --- | --- |
| `GET /config` | engine, limits, lane usage |
| `GET /health` | Hermex readiness on the document profile (200/503) — filesystem checks only, never a prompt |
| `GET /jobs` | recent jobs |
| `POST /jobs` | upload (raw body; `fileName`, `mimeType`, `chunkSize`, `force=1`) → 201 new / 200 `reused` |
| `GET /jobs/:id` | job + per-range status, live state, progress/ETA |
| `GET /jobs/:id/document` | merged pages, each with `meta` |
| `GET /jobs/:id/download?format=md\|txt\|raw` | normalized Markdown/text, or the raw page texts |
| `GET /jobs/:id/source` | the original upload |
| `POST /jobs/:id/retry` | requeue failed/unfinished ranges (409 while queued/running) |
| `POST /jobs/:id/cancel` | cancel (any process); finished pages are kept |
| `DELETE /jobs/:id` | cancel, delete rows + stored upload |

## Testing

```bash
npm run test:ocr-hermex           # prompt, answer validation (truncated/malformed/refusal),
                                  # range files, retries, login/busy stop the job, cancel,
                                  # shared-profile turn-taking (mock sessions + a fake
                                  # Python peer — no Chrome, no Gemini)
npm run test:provider-audit       # no provider SDK/endpoint/key/HTTP call, no local OCR
                                  # engine, no process other than the Hermex session
TEST_DATABASE_URL=postgresql://test@127.0.0.1:55433/cmstest npm run test:ocr-worker
                                  # the web app only queues; NOTIFY + poll discovery; two
                                  # worker processes never claim one job; stale recovery;
                                  # cancel via NOTIFY; SIGTERM hands the job back
TEST_DATABASE_URL=postgresql://test@127.0.0.1:55433/cmstest npm run test:ocr-structure-db
                                  # real Postgres + the real router, engine, validation and
                                  # persistence, with the browser session scripted
```

None of these talk to real Gemini. To verify the real leg, upload a 1–2 page PDF after the
setup above and compare the result with the page.
