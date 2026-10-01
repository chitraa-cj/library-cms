# Translation jobs (server-side Hermex queue)

Translating a grantha used to mean running `npm run hermex:grantha` on a laptop and
leaving the terminal open for days, with a JSON checkpoint file as the only memory.
This moves the same pipeline onto the server: an admin queues a job from the web UI,
a **separate worker process** drains it, and **Postgres** holds every byte of state.

Nothing about the Gemini integration changed. The worker calls the same
`script/lib/hermex-grantha-sync.ts` functions the CLI always did — only the driver is
new.

```
browser (admin)                 EC2
┌──────────────┐   POST     ┌──────────────────┐        ┌──────────────────────┐
│ /admin/      │ ─────────► │ cmslibrary (API) │ writes │  Postgres            │
│ translations │   polls    │  never translates│ ─────► │  cms_translation_jobs│
└──────────────┘ ◄───────── └──────────────────┘        │  cms_translation_items│
                                                        └──────────┬───────────┘
                                                 claims one row    │ FOR UPDATE
                                                 at a time         │ SKIP LOCKED
                                                        ┌──────────▼───────────┐
                                                        │ cms-translation-worker│
                                                        │  → Hermex → Chrome    │
                                                        │  → Gemini web         │
                                                        │  → Strapi write-back  │
                                                        └───────────────────────┘
```

The browser can close, the admin can go home, the box can reboot. The job continues.

## Why Postgres and not a queue broker

The project already runs one Postgres. A single worker drains thousands of rows over
days; the throughput a broker buys is irrelevant here, and the extra moving part is
one more place for state to disappear. `SELECT … FOR UPDATE SKIP LOCKED` gives the
only property that actually matters — never hand the same mantra to two workers — and
it is already safe for more workers the day a second Gemini profile exists.

## Unit of work

One **item = one mantra**. The worker expands it into field units (Shloka, Bhashyam,
each Teeka) at claim time using the existing `buildJobsForMantra`, so a job's size is
"number of mantras", which is what the admin thinks in.

Creating a job only needs the grantha's *mantra list* (a few paginated Strapi calls,
ids only). The heavy per-mantra read happens in the worker, never in a request.

## Idempotency — the important guarantee

A completed item is never translated again, and even an *interrupted* item costs
almost nothing to resume: `translateJobIncremental` re-reads Strapi before every
language group (`filterLangsStillMissing`), so a mantra that was half-finished when
Chrome died resumes at the first language genuinely absent. Gemini is never asked for
text that is already in the CMS.

## Crash recovery

A claimed item carries a **lease** (`lease_expires_at`), renewed every
`TRANSLATION_LEASE_HEARTBEAT_MS` while the mantra is in flight.

| What died | What happens |
| --- | --- |
| Worker killed / `pm2 restart` | On boot it requeues the items it owned (`lease_owner` match) — immediately, no waiting. |
| EC2 reboot, OOM kill, `kill -9` | The lease lapses; the reaper (`requeueExpiredLeases`) requeues the item. |
| Chrome / Hermex / Python exception | The item fails, the error is stored, it is requeued until `MAX_TRANSLATION_RETRIES`. |
| Network or Gemini failure | Same as above. |
| DB blip | The loop logs `WORKER ERROR` and sleeps; it never exits. |

Completed items are never touched by any of this.

## Status model

Job: `queued` → `processing` → `completed` | `partially_failed` | `failed` | `cancelled`
Item: `queued` → `processing` → `completed` | `failed`

Job counters are **recomputed from the item rows** (`refreshJobProgress`), not
incremented in memory, so a restart can never leave the numbers drifting.

## API (all admin-only)

Mounted in `server/routes.ts` behind `requireAuth, requireAdmin` — 401 anonymous,
403 non-admin, decided on the backend.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/translation-jobs` | `{granthaName}` or `{granthaDocId}` or `{items:[…]}`, plus optional `targetLanguages`. Returns immediately. |
| GET | `/api/translation-jobs` | List + summary tiles. `?page`, `?limit`. |
| GET | `/api/translation-jobs/queue/overview` | Processing / next-queued / failed, across all jobs. |
| GET | `/api/translation-jobs/:id` | Detail, recounted on read, with `current_item` and `recent_errors`. |
| GET | `/api/translation-jobs/:id/items` | Paginated. `?status=queued\|processing\|completed\|failed`, `?page`, `?limit` (max 200). |
| POST | `/api/translation-jobs/:id/cancel` | Stops queued items; the one in flight finishes. |
| POST | `/api/translation-jobs/:id/retry` · `/retry-failed` | All failed items, or one via `{itemId}`. |

## Admin UI

`/admin/translations` (sidebar → Administration → Translation Jobs). Summary tiles,
job table, job detail with progress bar / counts / current item / recent errors /
timestamps, a filterable + paginated item list, and a queue panel. Polling only —
every 6–10s while something is active, and it **stops** once all jobs are terminal.

---

# Running it

## Locally

```bash
# once: create the tables (the server also self-heals this on first use)
npm run migrate:translation-jobs

# terminal 1 — the website
npm run dev

# terminal 2 — the worker
npm run worker:translation
```

On a Mac, headless Chrome is unreliable for Hermex; run the worker with
`TRANSLATION_WORKER_HEADLESS=false` and leave the window alone.

## On EC2

```bash
cd ~/library/Data-Feeder-CMS           # repo root on the box
git pull
npm ci                                 # only if dependencies changed
npm run migrate:translation-jobs       # idempotent
npm run build                          # builds client, dist/index.cjs AND dist/translation-worker.cjs

pm2 restart cmslibrary                 # the API must restart or /api/translation-jobs 404s as SPA HTML
pm2 start ecosystem.config.cjs --only cms-translation-worker
pm2 save                               # survive reboot
pm2 startup                            # once per box, if not already done
```

`pm2 save` + `pm2 startup` are what make the worker come back after an EC2 restart.
It does not depend on an SSH session and is not a request handler.

### Verify the worker is running

```bash
pm2 list                               # cms-translation-worker should be "online"
pm2 logs cms-translation-worker --lines 50
# expect: JOB START worker worker-<pid>@<host> ready (poll …, lease …, max retries …)

# Is it actually claiming work?
psql "$DATABASE_URL" -c "select status, count(*) from cms_translation_items group by 1;"
psql "$DATABASE_URL" -c "select id, status, completed_items, total_items, last_activity_at
                         from cms_translation_jobs order by created_at desc limit 5;"
```

`last_activity_at` moving is the liveness signal; the worker touches it on every
heartbeat.

## Initialising the Gemini session on the box

The worker drives a **server-side authenticated Chrome profile**. There are no Google
credentials anywhere in this repo, the database, the API responses or the logs, and
nothing here automates password entry — a human signs in once, interactively:

```bash
# on the box, with a display forwarded (ssh -X) or a VNC/Xvfb session
cd ~/library/Data-Feeder-CMS
npm run hermex:install        # once — creates .venv-hermex
npm run hermex:setup          # opens Chrome at gemini.google.com

#  → sign in with the Google account in the window
#  → return to the terminal and press ENTER (not Ctrl+C) to save the session
```

The profile lives outside the repo (`~/.local/share/hermex/chrome_profile` or the
platform equivalent printed by setup). Re-run `npm run hermex:setup` whenever Google
expires the session — the symptom is every item failing with a Gemini/login error.

If Chrome wedges after a long run (a known failure mode, see `docs/HERMEX.md`):

```bash
pm2 stop cms-translation-worker
pkill -f chromedriver
rm -f "$HOME/.local/share/hermex/chrome_profile"/Singleton*
pm2 start cms-translation-worker
```

Queued items are untouched by this; in-flight ones come back via their lease.

## Test with 3–5 mantras first

Do **not** start with a 2,500-mantra grantha.

```bash
# 1. find a grantha and a few of its mantra documentIds
psql "$DATABASE_URL" -c "select 1"   # (ids come from Strapi, not Postgres)
#    easiest: open the grantha in the portal and copy 3 verse documentIds,
#    or curl Strapi from the box:
curl -s -H "Authorization: Bearer $STRAPI_API_TOKEN" \
  "$STRAPI_URL/api/manthras?filters[Section][grantha][documentId][\$eq]=<GRANTHA_ID>&fields[0]=documentId&fields[1]=ShlokaManthraNumber&pagination[pageSize]=5"

# 2. queue just those, in one language, as an admin (cookie from a browser session)
curl -s -X POST http://localhost:5000/api/translation-jobs \
  -H 'content-type: application/json' -b "connect.sid=<your admin session cookie>" \
  -d '{"items":[{"mantraDocId":"<id1>","mantraLabel":"1.1.1"},
                {"mantraDocId":"<id2>","mantraLabel":"1.1.2"},
                {"mantraDocId":"<id3>","mantraLabel":"1.1.3"}],
       "targetLanguages":["Tamil"]}'

# 3. watch it
pm2 logs cms-translation-worker
#    and /admin/translations in the browser

# 4. check the result landed in Strapi for those three verses, THEN queue the
#    whole grantha from the UI.
```

An explicit `items` list is the small-scale path; the UI's grantha field is the
all-mantras path.

## Logs

The worker prints one line per transition — `JOB START`, `ITEM CLAIMED`,
`ITEM SUCCESS`, `ITEM FAILED`, `ITEM RETRY`, `JOB PROGRESS`, `JOB COMPLETED`,
`WORKER ERROR`, `WORKER RESTART` — to `logs/translation-worker.{out,err}.log` via pm2.

Error text is run through `sanitizeTranslationError()` before it is logged or stored:
query-string tokens, bearer/cookie values, long opaque tokens and home-directory
paths are redacted. Credentials, cookies and browser session data are never logged.

## Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `MAX_TRANSLATION_RETRIES` | `3` | Attempts per mantra before it parks as `failed`. |
| `TRANSLATION_TIMEOUT` | `7200000` | Hard ceiling for ONE mantra (ms). Keep **above** `HERMEX_TRANSLATE_TIMEOUT_MS`. |
| `WORKER_POLL_INTERVAL` | `15000` | Idle sleep between polls (ms). |
| `TRANSLATION_ITEM_DELAY_MS` | `5000` | Pause between mantras (ms). |
| `TRANSLATION_LEASE_MS` | `900000` | Claim lease (ms). A lapsed lease means a dead worker. |
| `TRANSLATION_LEASE_HEARTBEAT_MS` | `60000` | Lease renewal interval (ms). |
| `TRANSLATION_RETRY_BACKOFF_MS` | `60000` | Multiplied by attempts already made. |
| `TRANSLATION_MAX_ITEMS_PER_JOB` | `20000` | Guard on one job's size. |
| `TRANSLATION_INSERT_BATCH` | `500` | Rows per INSERT when creating a job. |
| `TRANSLATION_WORKER_HEADLESS` | `true` | `false` on a desktop with a display. |
| `TRANSLATION_WORKER_ID` | `worker-<pid>@<host>` | Identifies the lease owner. |
| `HERMEX_ENABLED` | `true` | `0` parks the worker: it claims nothing and spends no retries. |
| `HERMEX_CHUNK_SIZE` / `HERMEX_CHUNK_DELAY_MS` / `HERMEX_MAX_RETRIES` | `3` / `8000` / `3` | Passed straight to the existing Hermex runner. |
| `HERMEX_MAX_SOURCE_CHARS` | `6000` | Largest source text sent to Gemini in ONE turn. A longer source is split at paragraph boundaries and translated part by part, then joined. See **Oversized sources** below. |
| `HERMEX_TRANSIENT_BACKOFF_SEC` | `60` | Base cool-off after Gemini answers with one of its own error strings. Multiplied by the attempt number. |
| `HERMEX_TRANSIENT_ABORT_AFTER` | `4` | Consecutive chunk attempts ending in a Gemini error reply that abort the job. `0` disables the breaker. |
| `TRANSLATION_WORKER_HEADLESS` / `HERMEX_HEADLESS` | unset | Leave unset: with `DISPLAY` set the browser runs **headful** under Xvfb, which is the mode proven on the box. |

## Oversized sources

A long `BhashyamEntry` (~18.5K chars) used to be sent as a single ~19.5K-char prompt asking
Gemini for a ~13K-char answer. Gemini's backend refuses that: the reply is one of its canned
error strings —

```
I'm having a hard time fulfilling your request. Can I help you with something else instead?
I seem to be encountering an error. Can I try something else for you?
I encountered an error doing what you asked. Could you try again?
```

— and retrying is useless because every attempt re-sends the identical prompt.
`_effective_chunk_size()` could not help: it shrinks the *language* list, which was already 1.

So `translate_cli.py` now splits the **source**:

- `_split_source()` packs whole paragraphs into pieces of at most `HERMEX_MAX_SOURCE_CHARS`,
  falling back to sentence ends (the Devanagari danda `।`/`॥` counts) and then to a hard slice.
- Each piece is sent in its own fresh chat, labelled `PART n of m`, with the previous piece's
  last 400 chars supplied as *do-not-translate* context so terminology stays consistent.
- The pieces are joined per language with a blank line.
- **A language that loses any one part is dropped entirely.** Storing a join that is silently
  missing its middle is worse than a gap, and the caller's single-language retry redoes all of
  its parts.

Those canned replies are now recognised (`_looks_like_gemini_error_reply`) and raised as
`GeminiTransientError` instead of surfacing as a parse failure. That gets them a minutes-long
backoff rather than 8s, and after `HERMEX_TRANSIENT_ABORT_AFTER` consecutive ones the job stops
instead of paying one oversized round trip per language for every remaining mantra.

## Tests

```bash
npm run test:translation-queue   # 67 assertions — claiming, leases, retries, counters,
                                 # cancel, pagination, filters (real Postgres, fake Hermex)
npm run test:translation-api     # 46 assertions — 401/403/200 per route, HTTP contract,
                                 # input validation (real middleware, real router)
```

```bash
npm run test:hermex-split        # 32 assertions — source splitting, part prompts, error-reply
                                 # detection, and the multi-part join with Gemini stubbed out
npm run test:hermex-overlay      # 17 assertions — popup dismissal (fake driver)
```

The first two need `DATABASE_URL`. None of them touch Gemini or spend a request.
