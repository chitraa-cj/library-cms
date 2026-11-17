# Data-Feeder-CMS: API reference

Every HTTP route the CMS server exposes (129 routes), as of 2026-11-17. The routes were read
from the handler code in `server/auth.ts`, `server/routes.ts`, `server/strapi.ts`,
`server/acharyas.ts`, `server/migrate-vivekachudamani.ts`, `server/translation/routes.ts`,
`server/ocr/routes.ts` and `server/structure/routes.ts`.

## Contents

| # | Area | Base path | Source |
|---|---|---|---|
| 1 | Auth | `/api/auth` | `server/auth.ts` |
| 2 | App and Hermex | `/api/app-version`, `/api/hermex` | `server/routes.ts` |
| 3 | Drafts | `/api/drafts` | `server/routes.ts` |
| 4 | Publishing | `/api/drafts/:id/publish*` | `server/routes.ts`, `server/publish/*` |
| 5 | Grantha maintenance | `/api/granthas`, `/api/cms/manthras-unified` | `server/routes.ts` |
| 6 | Vocabulary | `/api/cms/vocabulary`, `/api/admin/cms/vocabulary` | `server/routes.ts` |
| 7 | Users | `/api/admin/users` | `server/routes.ts` |
| 8 | Backups and restore | `/api/admin/backup*`, `/api/admin/restore-jobs` | `server/routes.ts` |
| 9 | Grantha locks | `/api/granthas/locks`, `/api/admin/granthas/:docId/lock` | `server/routes.ts` |
| 10 | Strapi proxy | `/api/strapi` | `server/strapi.ts` |
| 11 | Acharyas | `/api/acharyas` | `server/acharyas.ts` |
| 12 | One-off migration | `/api/strapi/migrate` | `server/migrate-vivekachudamani.ts` |
| 13 | Permission gaps | none | none |
| 14 | Translation jobs | `/api/translation-jobs` | `server/translation/routes.ts` |
| 15 | OCR | `/api/admin/ocr` | `server/ocr/routes.ts` |
| 16 | OCR → Grantha (agentic) | `/api/admin/ocr/structure` | `server/structure/routes.ts` |

## Core CMS APIs

These are the routes outside the three job systems. Every `/api/*` response carries
`Cache-Control: no-store` (`server/http-cache.ts`). Errors are returned as
`{ "message": "…" }`.

**Auth column:**

- `public`: no login needed.
- `auth`: `requireAuth`. Returns 401 `Authentication required`.
- `admin`: `requireAuth` + `requireAdmin` (`user.role === "admin"`). Returns 403
  `Admin access required`.

The `/api/strapi*` and `/api/acharyas` routers apply `requireAuth` to all their routes
themselves.

### 1. Auth (`server/auth.ts`)

Sessions use express-session with a Postgres store (connect-pg-simple) and Passport
LocalStrategy with scrypt hashes. The cookie is `httpOnly` and `sameSite=lax`, and
`secure` only in production. It lasts 365 days (`SESSION_MAX_AGE_DAYS`) and is rolling,
so every request renews it.

| Method | Path | Auth | Request | Response / notes |
|---|---|---|---|---|
| POST | /api/auth/register | public | body: `username`, `password`, `displayName` (all required) | 201: the user without `password`. New users always get `role: "editor"` and are logged in straight away. 400 if a field is missing; 409 if the username is taken. |
| POST | /api/auth/login | public | body: `username`, `password` | 200: the user without `password`, and the session is set. 401 "Invalid username or password". |
| POST | /api/auth/logout | public | none | 200 `{message:"Logged out"}` |
| GET | /api/auth/user | public (checks the session itself) | none | 200: the current user. 401 "Not authenticated". |

### 2. App and Hermex (`server/routes.ts`)

| Method | Path | Auth | Request | Response / notes |
|---|---|---|---|---|
| GET | /api/app-version | public | none | `{buildId}`, from `APP_BUILD_ID`, then `dist/public/.build-id`, then `"dev"`. The client uses it to prompt a refresh after a deploy. |
| GET | /api/hermex/status | auth | none | `{enabled, python, script, ready, queueDepth, otherTranslationLanguageCount, otherTranslationLanguages[], sourceLanguages}` |
| GET | /api/hermex/health | admin | `?deep=1` makes one real Gemini call | `{ok, checks{enabled, pythonExists, scriptExists, chromeProfileExists, geminiSetupComplete, displayConfigured, displaySocketExists}, config, queueDepth, problems, checkedAt, deep?}`. 503 if the setup is incomplete; with `deep`, a failure returns 502 or the HermexError status. |
| POST | /api/hermex/translate | auth | zod: `sourceText` (1–120000 chars), `sourceLanguage` (`English` \| `Sanskrit`), `targetLanguages[]` (1–50, each from `otherTranslationLanguages`), `context?` (≤500), `chunkSize?` (1–10), `headless?`, `queryTimeoutSec?` (60–900) | `{translations:[{LanguageOfTranslation, TranslationText, isAiTranslated:true}]}`. A **synchronous**, single-text translation that runs in the request (unlike the job queue). 503 if `HERMEX_ENABLED` is off; 400 on invalid input; on failure `{message, reason, retryable}`. |

### 3. Drafts

A draft is a row in the local Postgres table `contentDrafts`. `strapiDocumentId` links a
draft to its published Strapi document.

- **Owner-scoped:** every lookup includes `createdBy = req.user.id`. Another user's draft
  returns 404.
- **Body size:** body limit is `BODY_LIMIT` (default 250mb).
- **Optimistic locking:** send `expectedUpdatedAt` (the draft's `updatedAt`, matched within
  ±750ms) on PUT and PATCH. A conflict returns 409 `{message, latest}`.
- **Idempotency:** PUT and PATCH accept an `Idempotency-Key` header, kept for 24h. The same
  key with a different body returns 409.
- **Snapshots:** every write records a local snapshot. Grantha create and PUT also write a
  versioned S3 backup when `S3_BACKUP_BUCKET` is set. A failed backup never fails the save.

| Method | Path | Auth | Request | Response / notes |
|---|---|---|---|---|
| GET | /api/drafts | auth (own) | `?contentType=`, `?full=1` | `Draft[]`, newest first. By default the list is **slim**: grantha drafts carry only a few header fields plus `_slim`/`_hasLocalEdits`. `full=1` returns the whole `data`. 400 on an invalid contentType. |
| GET | /api/drafts/structure-config/:strapiDocumentId | auth (own) | path | `{structureConfig}` from the user's latest grantha draft for that doc (portal-only config, never stored in Strapi) |
| GET | /api/drafts/:id | auth (own) | path `id` (int) | Full `Draft` `{id, contentType, title, data, strapiDocumentId, status, createdBy, createdAt, updatedAt}`. 400 / 404. |
| POST | /api/drafts | auth | body `{contentType, title, data, strapiDocumentId?}` | 201 `Draft` (status `draft`), plus `_backupKey` for granthas. 400 if a field is missing or the type is invalid. |
| PUT | /api/drafts/:id | auth (own) | body `{title?, data?, expectedUpdatedAt?}` (`data` replaces the whole blob) and header `Idempotency-Key?` | 200 `Draft`. If nothing changed, returns the row without writing. 404; 409 on a version conflict or idempotency reuse. Saves to one draft run one at a time. |
| PATCH | /api/drafts/:id/manthra | auth (own) | body `{adhyayaId, khandaId, padaId?, manthraId, manthraData, title?, expectedUpdatedAt?}` | 200 `Draft`. Fast path that merges one mantra into `data.hierarchy`. 400 / 404 / 409. |
| DELETE | /api/drafts/:id | auth (own) | path | `{message, removed:{idempotencyKeys, publishJobs, publishJobTasks}}`. Does not touch Strapi. |
| GET | /api/drafts/:id/backups | auth (own) | path | `{enabled, backups[]}` (S3 versions) |
| GET | /api/drafts/:id/backups/content | auth (own) | `?key=` (required) | The stored backup payload. 400 if the key is missing or belongs to another draft. |
| DELETE | /api/drafts/:id/backups | auth (own) | `?key=` (required) | `{message, key}` |
| POST | /api/drafts/:id/recover-latest | admin (and own draft) | path | `{draft, recoveredFrom}`. Overwrites title and data from the latest server snapshot. 404 if there is no snapshot. |
| POST | /api/drafts/:id/sync-mantra-slots | auth (own) | body `{adhyayaId?, khandaId?, padaId?, hierarchy?, onlyManthraIds?[]}` | `{ok, patches[], hierarchy, errors[], remainingPending, message}`. Creates Strapi rows for mantras that exist only in the portal and writes the hierarchy back. 400 if the draft has no `strapiDocumentId`. |

### 4. Publishing

Grantha publish is **queued**. `POST /publish` inserts a `cms_publish_jobs` row (`kind:
grantha_publish`) that the separate pm2 process `cms-publish-worker`
(`server/publish/worker.ts`) runs. With `PUBLISH_WORKER_INLINE=1` the job runs inside
the web process instead.

Job states are `queued`, `running`, `done`, `failed`, `cancelled` and
`failed_recoverable`. A failed job is re-queued while it has attempts left. Content types
other than grantha publish synchronously in the request.

| Method | Path | Auth | Request | Response / notes |
|---|---|---|---|---|
| POST | /api/drafts/:id/publish-preflight | auth (own) | none | `{ok, violationCount, errorCount, violations[≤40], message}`. No Strapi writes, but it may save a repaired hierarchy to the draft. |
| POST | /api/drafts/:id/publish-manthra | auth (own) | body `{adhyayaId, khandaId, padaId?, manthraId, manthraData?}` | `{async:true, jobId, message}`. Runs in the web process (`kind: manthra_publish`). If the same verse is already publishing, its existing job is reused. 400; 503 `schema_out_of_date`. |
| POST | /api/drafts/:id/publish-manthras-batch | auth (own) | body `{mantras:[{adhyayaId, khandaId, padaId?, manthraId}]}` | **Synchronous**. Publishes 8 at a time (`PUBLISH_MANTHRA_CONCURRENCY`, max 10). Returns `{publishedCount, failureCount, published, failures, warnings}`, or 500 if every target failed. |
| POST | /api/drafts/:id/publish | auth (own) | body `{allowRenumber?}`, header `Idempotency-Key?` | Grantha: `{jobId, async:true, message}`, reusing a running job for the same draft or grantha. Other types: `{draft, strapi, warnings?}`. Errors: 503 `schema_out_of_date`, 503 `publish_worker_down`, 403 `grantha_locked`, 400 `bhashyam_author_not_in_vocabulary`, 400 unknown type, 501 for a type Strapi doesn't route, 404. |
| GET | /api/drafts/:id/publish-status | auth | `?jobId=` (required; `:id` is unused) | `{status, progress:{done,total,current}, attempt?, maxAttempts?, result?, error?}`. 404 `job_not_found`; 403 if the job belongs to another user and the caller is not an admin. |

### 5. Grantha maintenance and the unified mantra list

| Method | Path | Auth | Request | Response / notes |
|---|---|---|---|---|
| GET | /api/granthas/:docId/orphan-manthras | auth | path `docId` (≥10 chars) | `{count, orphans[]}`: Strapi mantra rows with a blank `ShlokaManthraNumber` |
| POST | /api/granthas/:docId/cleanup-orphan-manthras | auth | body `{dryRun?}`. **Only a literal `true` means dry run; leaving it out deletes.** | `{dryRun, orphanCount, deletedCount, failedCount, deleted[], failed[], message}`. Deletes the rows in Strapi. |
| GET | /api/cms/manthras-unified | auth (own drafts) | none | `{pendingGranthaMantras[]}`: mantras in the user's drafts that are not yet in Strapi |

### 6. Vocabulary (shared lists)

| Method | Path | Auth | Request | Response / notes |
|---|---|---|---|---|
| GET | /api/cms/vocabulary | auth | none | The vocabulary object: built-in defaults merged with custom entries (`teekaAuthors`, `bhashyamAuthors`, `structureLevelOneNames`, …) |
| POST | /api/admin/cms/vocabulary | admin | body `{key, value}` (`key` from `portalVocabularyKeys`) | The updated vocabulary. 400 on an invalid key. |
| DELETE | /api/admin/cms/vocabulary | admin | body `{key, value}` | The updated vocabulary |

### 7. Users

| Method | Path | Auth | Request | Response / notes |
|---|---|---|---|---|
| GET | /api/admin/users | admin | none | Users, without passwords |
| POST | /api/admin/users | admin | body `{username, password (≥6), displayName?, role?}` | 201: the user. `role` is `admin`, or else `editor`. 400; 409 if the username exists. |
| PATCH | /api/admin/users/:id/role | admin | body `{role: "admin" \| "editor"}` | The user. 400 / 404. |
| PATCH | /api/admin/users/:id/password | admin | body `{password}` (≥6) | `{message:"Password updated"}`. 400 / 404. |
| DELETE | /api/admin/users/:id | admin | path | `{message:"User deleted"}`. 400 when deleting your own account; 404. |

### 8. Backups (snapshots) and restore

Snapshots are stored in the Postgres table `grantha_backups`:

- New snapshots are gzipped JSON in the `data_gz` bytea column. Older ones are in the
  `data` jsonb column.
- The `summary` column is precomputed for the summary view.
- Snapshots are not stored in S3. S3 is used only for the per-draft backups in §3.

Restore jobs and the snapshot status are kept **in the web process's memory**, so they
are lost on restart.

| Method | Path | Auth | Request | Response / notes |
|---|---|---|---|---|
| GET | /api/admin/backups | auth | none | List of backups |
| GET | /api/admin/backups/:id/data | auth | path | `{id, label, createdAt, granthaCount, sectionCount, manthraCount, data}` (the full decompressed snapshot) |
| GET | /api/admin/backups/:id/summary | auth | path | `{…counts, granthas, sections, acharyas}` |
| GET | /api/admin/backups/:id/sections/:sectionId/manthras | auth | path | The section's mantras from the snapshot, sorted by `order` |
| GET | /api/admin/backups/:id/download | auth | path | JSON file download |
| GET | /api/admin/backups/:id/export-sqlite | auth | path | `application/x-sqlite3` download |
| POST | /api/admin/backups/import | admin | body `{label?, granthaCount?, sectionCount?, manthraCount?, data}` (`data` may be `_compressed`) | 201 `{id, label}`. 400. |
| POST | /api/admin/backups/:id/restore-manthra | admin | body `{manthraDocumentId, granthaDocId, field?}` (`teekas`, `bhashyam`, `both`, `shloka_ot` or `all`, default `all`) | Synchronous. Fills **only empty** fields in live Strapi. Returns `{ok, manthra, documentId, restored, actions, skipped, errors, message}`. 404. |
| POST | /api/admin/backups/:id/restore-grantha | admin | body `{granthaDocId, field?}` (default `both`) | 202 `{jobId, total}`; poll restore-jobs. Fills only missing content. |
| POST | /api/admin/backups/:id/restore-grantha-full | admin | body `{granthaDocId}` (the id in the snapshot) | 202 `{jobId, total, willDeleteLive}`. **Destructive**: deletes the live grantha with the same name and rebuilds it with new documentIds. 409 if more than one live grantha has the name; 502 if the Strapi lookup fails; 404 / 400. |
| GET | /api/admin/restore-jobs/:jobId | auth | path | `{status: running \| done \| error, progress, total, restored, skipped, errored, results, errors, message}` |
| POST | /api/admin/backup | admin | none | 202 `{status:"started"}`. Takes a full snapshot (granthas, sections and manthras from Strapi, plus acharyas) in the background. 409 if a snapshot is already running. |
| GET | /api/admin/backup/status | auth | none | `{inProgress, lastError}` |

### 9. Grantha locks

A lock is enforced **only on grantha publish** (403 `grantha_locked`). Single-mantra
publish, batch publish and restores do not check it.

| Method | Path | Auth | Request | Response / notes |
|---|---|---|---|---|
| GET | /api/granthas/locks | auth | none | `[{id, granthaDocId, granthaName, lockedByUserId, lockedByUsername, lockedAt, reason}]` |
| POST | /api/admin/granthas/:docId/lock | admin | body `{reason?, granthaName?}` | 201: the lock row |
| DELETE | /api/admin/granthas/:docId/lock | admin | path | `{message:"Grantha unlocked"}`. 404 if there is no lock. |

### 10. Strapi proxy (`server/strapi.ts`, mounted at `/api/strapi`)

How the proxy calls Strapi:

- It calls `${STRAPI_URL}` with `Authorization: Bearer ${STRAPI_API_TOKEN}`.
- The timeout is `STRAPI_HTTP_TIMEOUT_MS` (40s, or 120s for large bodies).
- It makes 3 attempts, retrying 5xx, 408 and 429 responses and timeouts.
- If `STRAPI_URL` is unset it falls back to a hard-coded IP.

Fast paths and caches:

- **SQLite fast path:** `strapi-sqlite-skeleton.ts` reads Strapi's SQLite file read-only
  (`STRAPI_SQLITE_PATH`) for the mantra skeleton and the lite lists. Responses report
  `source: "sqlite" | "rest"`.
- **Caches:** in-memory and per process. `list-cache` keys (`list:*`) last 30s with
  stale-while-revalidate. The grantha bulk cache lasts 30–60s. Writes through the proxy
  clear them; edits made directly in Strapi appear after the TTL.

**Sections**

| Method | Path | Auth | Request | Response / notes |
|---|---|---|---|---|
| GET | /api/strapi/sections | auth | Any query string is passed through to Strapi | With a query: the raw Strapi response. Without one: every page merged into `{data, meta.pagination}`. |
| GET | /api/strapi/sections/by-grantha/:granthaDocId | auth | path | `{data: sections[] with manthras[] (id, documentId, ShlokaManthraNumber, order, ShlokaManthraEntry)}`. Bulk cache, 30s. |
| GET | /api/strapi/sections/:documentId | auth | path | Raw Strapi section (with up to 25 inline manthras) |
| POST | /api/strapi/sections | auth | body forwarded as-is: `{data:{…}}` | Raw Strapi response. Clears the bulk cache. |
| PUT | /api/strapi/sections/:documentId | auth | body forwarded as-is | Raw Strapi response |
| DELETE | /api/strapi/sections/:documentId | auth | path | Raw Strapi response |

**Manthras**

| Method | Path | Auth | Request | Response / notes |
|---|---|---|---|---|
| GET | /api/strapi/manthras | auth | none | `{data, meta:{pagination, cmsFetch:{rowsReturned, strapiTotal, pagesExpected, pagesFetched, complete, source}}}`. list-cache, 30s. |
| GET | /api/strapi/manthras/teekas-by-grantha/:granthaDocId | auth | path | `{data: {[manthraDocId]: Teekas[]}}`. Bulk cache, 60s. |
| GET | /api/strapi/manthras/full-by-grantha/:granthaDocId | auth | path | `{data: {[docId]: {ShlokaManthraEntry, BhashyamEntry, Teekas}}}`. Bulk cache, 60s. |
| GET | /api/strapi/manthras/resolve-for-edit | auth | `?label=&preferredDocId=&sectionDocId=` (needs `label` or `preferredDocId`) | `{data, documentId, corrected, contentScore}`: picks the best-content row for an ambiguous verse label. 400 / 404. |
| GET | /api/strapi/manthras/search | auth | `?q=` (≥2 chars), `?limit=` (1–1000, default 200) | `{data, meta:{query, count, truncated}}`. Substring match on the number and the Sanskrit/English verse text. |
| GET | /api/strapi/manthras/:documentId | auth | path | The full mantra (entry, bhashyam, teekas, wordMeanings) plus `section` and `grantha` |
| POST | /api/strapi/manthras/insert-between | auth | body `{afterDocumentId, sectionDocId, ShlokaManthraNumber, afterNum?}` | `{data, sortKey, recompacted, shiftedCount}`. Uses a fractional sort key under a per-section lock. 400 `blank_mantra_label`; 404. |
| POST | /api/strapi/manthras/batch-identity-sync | auth | body `{updates:[{documentId, order, ShlokaManthraNumber}] (≤500), sortKeysOnly?, configuredLeaf?, allowRenumber?}` | `{results:[{documentId, ok, error?, labelSkipped?, orphan?}]}`. 409 `duplicate_order_in_batch`. |
| POST | /api/strapi/manthras/create-blank-in-section | auth | body `{sectionDocumentId, ShlokaManthraNumber}` | `{data, sortKey}`. 400 (`bare_leaf_counter_label`); 409 `duplicate_suffix_in_section`. |
| POST | /api/strapi/manthras | auth | body forwarded as-is: `{data:{…}}` | Raw Strapi response |
| PUT | /api/strapi/manthras/:documentId | auth | body forwarded as-is | Raw Strapi response |
| DELETE | /api/strapi/manthras/:documentId | auth | path | Raw Strapi response |

**Granthas, teekas, upload, videos**

| Method | Path | Auth | Request | Response / notes |
|---|---|---|---|---|
| GET | /api/strapi/granthas | auth | Any query string is passed through | Without a query: every grantha (deep populate, with `sections[]` and absolute cover URLs). list-cache, 30s. |
| GET | /api/strapi/granthas/lite | auth | none | `{data:[{documentId, GranthaName, GranthaType, BhashyamName, BhashyamAuthor, slug, order, sections[], teekas[]}], meta:{source}}` |
| GET | /api/strapi/teekas/by-grantha/:granthaDocId | auth | path | Teekas `{documentId, TeekaName, TeekaAuthor}` (first 100 only) |
| POST | /api/strapi/upload | auth | JSON `{filename?, mimeType?, dataBase64}` (not multipart) | `{id, documentId, url, alternativeText, width, height, name}`. 400; 502. |
| GET | /api/strapi/video-resources/for-node | auth | `?type=grantha\|section\|manthra&docId=&ancestors=type:docId,…` | `{data:{videos, inheritedFrom}}`: the node's own videos, or the nearest ancestor's |
| GET | /api/strapi/video-resources/for-target/:type/:docId | auth | path | `{data:[{documentId, youtubeUrl, videoId, title, startSeconds, language, order}], available}` |
| PUT | /api/strapi/video-resources/for-target/:type/:docId | auth | body `{videos:[{documentId?, youtubeUrl, title?, startSeconds?, language?}], sectionType?}` | Replaces the whole ordered set; returns the GET shape. 400 if a link is not YouTube; 503 if the content type is missing. |
| GET / PUT | /api/strapi/video-resources/for-grantha/:granthaDocId | auth | as for-target | Alias of for-target with `type=grantha` |
| GET / POST / PUT / DELETE | /api/strapi/prasthana-thraya-screens[/:documentId] | auth | none | **Stub**: GET returns an empty list; the others return 501 ("manage it in Strapi") |

**Generic collection and single types.** These cover `granthas`, `teekas`, `articles`,
`authors`, `categories`, `chapters` and `video-resources`. The specific routes above win
where both match.

| Method | Path | Auth | Request | Response / notes |
|---|---|---|---|---|
| GET | /api/strapi/{type} | auth | Any query string is passed through | All pages merged, deep populate. list-cache, 30s. |
| GET | /api/strapi/{type}/:documentId | auth | path | Raw Strapi `?populate=*` |
| POST | /api/strapi/{type} | auth | the **bare** attributes object (the server wraps it as `{data}`) | 201: the raw Strapi response. Clears list caches. Every error returns 500. |
| PUT | /api/strapi/{type}/:documentId | auth | the bare attributes object | Raw Strapi response |
| DELETE | /api/strapi/{type}/:documentId | auth | path | 403 if a linked portal draft belongs to someone else. Also deletes the linked draft. |
| GET / PUT | /api/strapi/about, /api/strapi/global | auth | PUT takes the bare attributes object | Raw Strapi response (GET returns `{data:null}` on a Strapi 404) |

### 11. Acharyas (`server/acharyas.ts`, local Postgres)

| Method | Path | Auth | Request | Response / notes |
|---|---|---|---|---|
| GET | /api/acharyas/count | auth | none | `{count}` |
| GET | /api/acharyas | auth | none | `{data: AcharyaProfile[]}` |
| GET | /api/acharyas/granthas | auth | none | `{data:[{documentId, name, granthaType, bhashyamAuthor}]}` (Strapi index, cached 60s), for the grantha picker |
| POST | /api/acharyas | admin | zod: `name` required; optional `nameDevanagari`, `nameIast`, `dates`, `avatarUrl`, `aliases[]`, `biography`, `linkedGranthaDocIds[]` | 201: the row, with a slug generated from the name. 400 `{message, issues}`. |
| GET | /api/acharyas/:slug | auth | path | `{…acharya, granthas, teekas}` (manually linked granthas first, then author-name matches). 404. |
| PATCH | /api/acharyas/:slug | admin | any subset of `nameDisplay`, `nameDevanagari`, `nameIast`, `dates`, `avatarUrl`, `aliases`, `biography`, `linkedGranthaDocIds` | The updated row. 400 / 404. |
| POST | /api/acharyas/seed | admin | none | `{seeded}`. Upserts from `shared/data/acharya-profiles.seed.json`. |

### 12. One-off migration

| Method | Path | Auth | Request | Response / notes |
|---|---|---|---|---|
| POST | /api/strapi/migrate/split-vivekachudamani | auth | none | One-time job that **changes data**: splits combined Vivekachudamani manthras into one per verse. Returns `{ok, log[], warn[]}`. Does not clear caches. |

### 13. Permission gaps to know about

These came out of reading the handlers. They are not fixed, so raise them before
building on these routes.

- `POST /api/granthas/:docId/cleanup-orphan-manthras` is open to any logged-in editor
  and deletes rows by default.
- `POST /api/strapi/migrate/split-vivekachudamani` is open to any logged-in user and
  changes data.
- The backup **read** routes (list, data, summary, download, export-sqlite),
  `restore-jobs` and `backup/status` are `auth` only, although the code comments say
  admin.
- Single-mantra publish, batch publish and restores do not check the grantha lock.
- With a query string, GET on `/api/strapi/sections`, `/granthas` and `/{type}` is
  passed to Strapi unchecked, so the caller controls filters and populate.

## Job APIs (admin only)

All three are mounted behind `requireAuth, requireAdmin` in `server/routes.ts`.

### 14. Translation jobs

Base path: **`/api/translation-jobs`** (`server/translation/routes.ts`). Errors are
returned as `{ "message": "…" }`.

| Method | Path | Request | Response / notes |
| --- | --- | --- | --- |
| POST | `/` | Body: one of `granthaDocId`, `granthaName` or `items: [{ mantraDocId, mantraLabel?, originalText? }]`. Optional `targetLanguages: string[]` (empty means every missing language; values must be in `otherTranslationLanguages`). | **201** `{ job_id, status, total_items, queued_items, worker_enabled, job }`. 400 for bad input, an unknown language, or more than `TRANSLATION_MAX_ITEMS_PER_JOB` (20,000). 404 if the grantha has no mantras. Only the mantra id list is read; no translation happens. |
| GET | `/` | Query: `page` (1), `limit` (50, max 200), `sort` (`newest`, `oldest`, `grantha`, `status`, `progress`, `failed` or `activity`; default `newest`) | `{ jobs: JobView[], summary, page, limit, worker_enabled }` |
| GET | `/queue/overview` | none | `{ processing[≤10], upcoming[≤20], failed[≤20 unread], summary, worker_enabled, server_now }` (items as ItemView) |
| GET | `/granthas/status` | none | `{ granthas: [...] }`: the newest job per grantha, used to label the grantha picker |
| POST | `/failed/mark-read` | Body: `{ jobId?, itemId? }`. Neither means every unread failure. | Count of items marked read. Sets `dismissed_at`. |
| GET | `/:id` | none | JobView plus `counts`, `current_item`, `recent_errors[{ item_id, item, mantra, attempts, error, last_attempt_at }]`, `worker_enabled`, `server_now`. Counters are recounted from the rows on every read. |
| GET | `/:id/items` | Query: `status` (`queued`, `processing`, `completed` or `failed`), `page`, `limit` | `{ items: ItemView[], page, limit, total, page_count }` |
| POST | `/:id/cancel` | none | `{ cancelled: true, cancelledItems, note }`. The item in flight finishes. |
| POST | `/:id/retry` or `/:id/retry-failed` | Optional `itemId` in the body or query | `{ requeued, job }`. Resets attempts so the retry gets a full budget. |
| DELETE | `/:id` | none | `{ deleted }`. **409** while an item is processing. |

**JobView:** `id, job_id, status, grantha_name, grantha_doc_id, created_by,
target_languages, total, completed, processing, queued, failed, retry_count, progress (%),
error, created_at, started_at, last_activity_at, completed_at`.

**ItemView:** `id, job_id, sequence_number, mantra_doc_id, mantra_label, status, attempts,
error, translated_text, created_at, started_at, completed_at, last_attempt_at,
lease_expires_at`.

`worker_enabled` is `false` when `HERMEX_ENABLED=0`. Jobs still queue but nothing claims
them.

Example: queue three mantras in one language as an admin.

```bash
curl -b cookie.txt -H 'content-type: application/json' \
  -d '{"items":[{"mantraDocId":"abc123"},{"mantraDocId":"def456"},{"mantraDocId":"ghi789"}],"targetLanguages":["Tamil"]}' \
  https://<host>/api/translation-jobs
```


### 15. OCR

Base path: **`/api/admin/ocr`** (`server/ocr/routes.ts`).

| Method | Path | Request | Response / notes |
| --- | --- | --- | --- |
| GET | `/config` | none | Engine, limits and lane usage |
| GET | `/health` | Optional `?force=1` | Hermex readiness on the document profile. **200** if ready, **503** if not. Filesystem checks only; it never sends a prompt. Lists the Chrome profiles found. |
| GET | `/jobs` | none | `{ jobs, usage }` for recent jobs |
| POST | `/jobs` | **Raw body** (the file bytes). Query: `fileName`, `mimeType` (or the Content-Type header), `chunkSize`, `instructions` (≤ 2000 chars), `force=1` (skip reuse) | **201** `{ job, reused: false }`, or **200** `{ job, reused: true }` for an identical upload. 400 for an empty upload, 413 over `OCR_MAX_UPLOAD_MB` (120), 503 if Hermex is not ready. |
| GET | `/jobs/:id` | none | Job plus per-range status, live state and progress/ETA |
| GET | `/jobs/:id/document` | none | `{ job, pages… }`: merged pages, each with `meta` |
| GET | `/jobs/:id/download` | `?format=md` (default), `txt` or `raw` | Normalized Markdown or text, or the raw page texts |
| GET | `/jobs/:id/source` | none | The original upload. 404 once purged. |
| POST | `/jobs/:id/retry` | none | `{ requeued }`. 409 if already queued or running. |
| POST | `/jobs/:id/cancel` | none | `{ cancelled, wasActive }`. Finished pages are kept. |
| DELETE | `/jobs/:id` | none | `{ deleted: true }`. Cancels the job and removes its rows and the stored upload. |
| POST | `/maintenance/purge` | none | `{ purged }`: removes jobs past retention |


### 16. OCR → Grantha (agentic structure jobs)

Base path: **`/api/admin/ocr/structure`** (`server/structure/routes.ts`).

| Method | Path | Request | Response / notes |
| --- | --- | --- | --- |
| GET | `/config` | none | `{ configured, model, runtime{ problems, warnings, setupComplete }, limits{ maxDepth, maxPages, pagesPerChunk, maxInstructionChars, confidenceThreshold, maxRequestsPerJob, requestsPerDay }, usage }` |
| GET | `/health` | none | 200 if ready, 503 if not. Never opens a browser. |
| GET | `/estimate/:ocrJobId` | Query: `from`, `to` (optional page window) | `{ pages, window, availableFrom, availableTo, availablePages, estimate, model, remainingRequestsToday, withinLimits, blockers[], warnings[] }`. 409 if nothing is transcribed yet, 400 for an empty window. |
| GET | `/for-ocr/:ocrJobId` | none | `{ jobs }`: analyses for one OCR document |
| GET | `/jobs` | none | `{ jobs (latest 40), usage }` |
| POST | `/jobs` | Body: `{ ocrJobId, depth, levelNames[], pageFrom?, pageTo?, instructions?, voiceUsed? }` | **201** `{ job, reused: false }`, or **200** `{ job, reused: true }` if an identical job is in flight. 400 for invalid config or duplicate level names. 404 for an unknown OCR job. 409 if nothing is transcribed. **429** when the daily or per-job budget is exhausted (`code` gives the gate). 503 if the runtime is not ready. |
| GET | `/jobs/:id` | none | `{ job, chunks, active, live, usage, serverNow }`: the progress poll |
| GET | `/jobs/:id/result` | `?items=0` for counts only, used for cheap polling | `{ job, config, items, sections, verses, unassigned, ambiguities, warnings, teekaNames, languages, stats, validation, csv{ columns, rowCount, sectionLevels }, workflowState, missingRanges }` |
| PUT | `/jobs/:id/overrides` | Body: `{ overrides: [{ op: 'edit', id, patch } \| { op: 'delete', id } \| { op: 'merge', id } \| { op: 'split', id, at } \| { op: 'move', id, after }] }`. Allowed patch keys: `kind, level, number, title, text, script, teekaName, language, attachTo`. | The recomputed result. Replaces the whole list. **409** if someone else saved first (the stored list must be a prefix of the new one) or the job is already imported. |
| POST | `/jobs/:id/review` | none | `{ job, workflowState: 'ready_for_export' }`. **422** with `validation` while errors remain. |
| POST | `/jobs/:id/retry` | none | `{ requeued }`. 409 while running. |
| POST | `/jobs/:id/cancel` | none | `{ cancelled, wasActive }` |
| DELETE | `/jobs/:id` | none | `{ deleted: true }` |
| GET | `/jobs/:id/csv` | `?download=1` for a file with a UTF-8 BOM, otherwise JSON | `{ csv, columns, rowCount, sectionLevels, fileName, config, validation }`. 422 if invalid. |
| POST | `/jobs/:id/mapping` | Body: `{ target: { levelOneEnabled, levelOneName, levelTwoEnabled, levelTwoName, levelThreeEnabled, levelThreeName, leafName, teekas: [{ id, TeekaName, TeekaAuthor }] } }` | `{ mapping, teekas[{ sourceName, targetId, targetName, exact }], sectionLevels, csvColumns, rowCount, alreadyImported }` |
| POST | `/jobs/:id/import` | Body: `{ status: 'running' \| 'done' \| 'failed', granthaDocId?, summary?, error?, force? }` | `{ job }`. **409** if already imported (unless `force`) or the review is not confirmed. |

`workflowState` is computed from the job status, `reviewedAt` and `importStatus`. The UI
uses it to decide which wizard step to show.
