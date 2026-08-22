# Data Feeder CMS — Complete Documentation

**Ekatmadham Library Content Management Portal**

| Item | Value |
|------|-------|
| Repository | `Data-Feeder-CMS` (aka `library-cms`) |
| Production portal | [admincms.xoidlabs.com](https://admincms.xoidlabs.com) |
| Public library site | [dev.ekatmdhamlibrary.xoidlabs.com](https://dev.ekatmdhamlibrary.xoidlabs.com) |
| CMS backend | Strapi on AWS EC2 (`13.53.121.15:1337`) |

---

## Table of contents

1. [Introduction](#1-introduction)
2. [Features](#2-features)
3. [Application structure](#3-application-structure)
4. [Usage guide](#4-usage-guide)
5. [Environment & local setup](#5-environment--local-setup)
6. [REST API overview](#6-rest-api-overview)
7. [Authentication API](#7-authentication-api)
8. [Draft API](#8-draft-api)
9. [Publish API](#9-publish-api)
10. [Strapi proxy API](#10-strapi-proxy-api)
11. [Hermex translation API](#11-hermex-translation-api)
12. [Admin API](#12-admin-api)
13. [Acharya API](#13-acharya-api)
14. [Database schema](#14-database-schema)
15. [Strapi content model](#15-strapi-content-model)
16. [Publish pipeline (grantha)](#16-publish-pipeline-grantha)
17. [Data safety rules](#17-data-safety-rules)
18. [Scripts & maintenance](#18-scripts--maintenance)
19. [Production deployment](#19-production-deployment)
20. [Troubleshooting](#20-troubleshooting)

---

## 1. Introduction

### What this application is

The **Data Feeder CMS** is a content-management and data-entry portal for the **Ekatmadham Library**. Editors log in, create and edit sacred-text content as **drafts in PostgreSQL**, and explicitly **publish** to a **Strapi CMS** when ready. Published content is consumed by the public Ekatmadham Library website.

The portal is **not** the public reading site. It is the editorial workspace that feeds Strapi.

### Core content flow

```
Editor → Portal draft (PostgreSQL JSONB)
       → Save (local only)
       → Save & Publish → Strapi CMS
       → Public library website
```

Every meaningful edit starts as a **portal draft**. Strapi is updated only when an editor publishes (or when incremental mantra/section sync runs for linked published granthas).

### Who uses it

| Role | Access |
|------|--------|
| **editor** | Create/edit drafts, publish content, view backups |
| **admin** | Everything editors can do, plus user management, vocabulary, grantha locks, backup restore, acharya edits |

Self-registration creates **editor** accounts. Admins promote users via `/admin/users`.

### Technology summary

| Layer | Technology |
|-------|------------|
| Frontend | React 18, TypeScript, Vite, wouter, TanStack Query, shadcn/ui, Tailwind, TipTap |
| Backend | Express 5, TypeScript (`tsx`), Passport local auth, session in PostgreSQL |
| Portal DB | PostgreSQL via Drizzle ORM |
| CMS | Strapi v5 (collection + single types) |
| AI translation | Hermex + Gemini browser automation (optional) |
| Analytics | PostHog |
| Optional backups | AWS S3 versioned draft backups |

---

## 2. Features

### Grantha (sacred text) management

- Full wizard: **Configuration → Book Structure → Build Content**
- Configurable hierarchy labels (Adhyaya, Khanda, Shloka, Parichchedha, Vishaya, etc.)
- Nested sections synced to Strapi as `Section` records
- Per-verse editor: Sanskrit, IAST, English, **43+ other languages**, Bhashyam, Teekas, word meanings
- **Insert between verses** with automatic label renumbering and CMS sync
- CSV bulk import of structure/verses
- Portal draft overlay on published Strapi granthas (edit without losing live data until publish)
- **Grantha locking** — admins block editing/publishing on finalized texts
- Publish integrity preflight (duplicate verse suffixes, misplaced mantras)
- Background publish jobs with progress, idempotency, crash recovery

### Other content types

| Type | Description |
|------|-------------|
| **Sections** | Standalone section CRUD (linked to granthas) |
| **Manthras** | Unified mantra list across granthas |
| **Teekas** | Commentary works per grantha |
| **Chapters** | Chapter-style content with nested structure |
| **Articles** | Blog with enforced SEO (metaTitle, metaDescription, shareImage, JSON-LD) |
| **Authors / Categories** | Article taxonomy |
| **About / Global** | Strapi single types |
| **Acharyas** | Guru profiles (portal Postgres, linked to Strapi texts) |
| **Prasthana Thraya** | Special screen content (draft-only; no Strapi publish route) |

### Operational features

- **Strapi live sync** — lists refetch every 30s + on window focus; manual refresh via `StrapiSyncBar`
- **Draft backups** — gzip snapshots on save; optional S3 durable backups
- **Strapi snapshots** — full grantha backup/restore in admin UI
- **Hermex/Gemini** — batch translate verses into all OtherTranslations languages
- **Portal vocabulary** — admins extend structure label dropdowns (Adhyaya names, leaf types, teeka authors)
- **Reconnect banner** — session preserved during server restarts mid-publish
- **App version prompt** — prompts reload after deploy

---

## 3. Application structure

### Repository layout

```
Data-Feeder-CMS/
├── client/src/
│   ├── App.tsx                 # Routes, auth gate, PostHog, reconnect banner
│   ├── pages/                  # One screen per content domain
│   ├── components/             # Shared UI (data-table, rich-text, SEO panels, sync bar)
│   ├── hooks/                  # use-auth, use-drafts, use-strapi-sync, use-portal-vocabulary
│   └── lib/                    # Strapi blocks, grantha sync, mantra cache, query client
├── server/
│   ├── index.ts                # Express bootstrap, body limits (250mb), job recovery
│   ├── auth.ts                 # Passport, PostgreSQL sessions
│   ├── routes.ts               # Draft CRUD, publish orchestration, admin, Hermex
│   ├── strapi.ts               # Strapi REST proxy (curl-based strapiRequest)
│   ├── storage.ts              # Database access layer
│   ├── db.ts / env.ts          # Postgres + env loading
│   ├── acharyas.ts             # Acharya profile API
│   ├── s3-backup.ts            # Optional S3 draft backups
│   ├── grantha-*.ts            # Publish integrity, hierarchy repair, orphan cleanup
│   └── hermex-translate.ts       # Python Hermex bridge
├── shared/
│   ├── schema.ts               # Drizzle tables + Strapi TypeScript interfaces
│   ├── grantha-publish-integrity.ts
│   ├── portal-draft-meta.ts    # Keys stripped before Strapi write
│   ├── article-seo.ts
│   └── mantra-sort-key.ts
├── script/                     # TypeScript maintenance + SQL migrations
├── scripts/                    # Node .mjs repair/restore + Python scrapers
├── python/hermex_translate/    # Gemini browser automation CLI
├── docs/                       # Documentation (this file, HERMEX.md, investigations)
└── package.json
```

### Frontend routes (wouter)

| Path | Page | Purpose |
|------|------|---------|
| `/` `/dashboard` | Dashboard | Overview counts, quick links |
| `/granthas` | Granthas | Main sacred-text editor (largest module) |
| `/sections` | Sections | Section list/CRUD |
| `/teekas` | Teekas | Teeka list |
| `/manthras` | Manthras | Cross-grantha mantra browser |
| `/articles` | Articles | Blog CMS with SEO panel |
| `/authors` | Authors | Article authors |
| `/categories` | Categories | Article categories |
| `/acharyas` | Acharyas | Guru parampara profiles |
| `/about` | About | Strapi single type |
| `/global` | Global | Site-wide Strapi settings |
| `/admin/users` | Admin users | User CRUD (admin only) |
| `/admin/vocabulary` | Admin vocabulary | Shared dropdown values |
| `/admin/backups` | Backups | Strapi snapshot management |
| `/admin/backups/:id` | Backup detail | Browse/restore snapshot |

Unauthenticated users see `/login` only.

### Portal-only vs Strapi-persisted data

These fields live **only** in portal draft JSON (`content_drafts.data`), never in Strapi:

- `hierarchy` — editor tree (adhyayas → khandas → padas → manthras)
- `structureConfig` — book structure wizard labels (Adhyaya/Khanda/Shloka names)
- `teekas` — teeka definitions for the wizard
- `deletedStrapiSectionDocIds` / `deletedStrapiManthraDocIds` — tombstones for publish
- `publishScope` — incremental publish tracking

See `shared/portal-draft-meta.ts` for the canonical list.

---

## 4. Usage guide

### 4.1 Login & registration

1. Open the portal URL.
2. **Login** with username/password, or **Register** (creates `editor` role).
3. Session cookie is httpOnly, rolling (365-day default), stored in PostgreSQL.

### 4.2 Creating a new grantha

**Step 1 — Configuration**

- Grantha Name (required), type, Bhashyam metadata, intro text, video IDs, name translations.

**Step 2 — Book Structure**

- Choose top-level division name (e.g. Adhyaya, Parichchedha).
- Toggle sub-sections (Khanda, Vishaya, etc.) or use flat structure (verses directly under chapter).
- Choose leaf entry type (Mantra, Shloka, Vyakhyaya, etc.).
- Click **Next: Build Content**.

**Step 3 — Build Content**

- Add chapters/sections and verses.
- Click a verse to open the mantra dialog (Sanskrit, translations, teekas, bhashyam).
- **+ between verses** — insert and renumber labels; syncs to CMS when publishing.
- **Save** — writes portal draft only (fast).
- **Save & Publish** — syncs verse slots/labels to CMS, then full Strapi publish.

### 4.3 Editing a published granthas

1. Open from **All the Granthas** list.
2. Portal loads Strapi sections + merges with any in-progress draft.
3. Published snapshot drafts (`status: published`) are not used as overlay — live Strapi + in-progress draft only.
4. **Discard portal draft** returns to live Strapi view.

### 4.4 Articles

- Rich text blocks, cover image, author, category.
- SEO panel enforces metaTitle, metaDescription, shareImage before publish.
- JSON-LD generated in draft (`shared/article-seo.ts`).

### 4.5 Hermex translation (in mantra dialog)

1. Enter English or Sanskrit source text.
2. Click **Translate missing** or **Translate all 43 languages**.
3. Save draft, then publish — merge logic protects existing Strapi translations.

See `docs/HERMEX.md` for setup.

### 4.6 Admin: lock a grantha

1. On grantha list, click lock icon (admin only).
2. All users see read-only editor; publish blocked until unlock.

---

## 5. Environment & local setup

### Prerequisites

- Node.js 20+
- PostgreSQL 14+
- (Optional) Python 3.11+ for Hermex
- (Optional) AWS credentials for S3 backups

### Install & run

```bash
git clone <repo-url>
cd Data-Feeder-CMS
npm install
cp .env.example .env   # fill all required values
npm run db:push        # apply Drizzle schema to Postgres
npm run dev            # API + Vite dev server (default PORT=5001)
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | Express session signing secret |
| `STRAPI_URL` | Yes | Strapi base URL (e.g. `http://host:1337`) |
| `STRAPI_API_TOKEN` | Yes | Strapi API token with read/write |
| `PORT` | No | Server port (default `5001`) |
| `BODY_LIMIT` | No | JSON body limit (default `250mb` for large granthas) |
| `SESSION_MAX_AGE_DAYS` | No | Session cookie TTL (default `365`) |
| `S3_BACKUP_BUCKET` | No | S3 bucket for draft backups (empty = disabled) |
| `AWS_REGION` | No | AWS region for S3 |
| `AWS_ACCESS_KEY_ID` | No | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | No | AWS secret key |
| `HERMEX_ENABLED` | No | Enable Gemini translation (`true`/`false`) |
| `HERMEX_PYTHON` | No | Path to Python binary (default `.venv-hermex/bin/python3`) |
| `HERMEX_*` | No | Chunk size, timeout, retries — see `docs/HERMEX.md` |
| `PUBLISH_MANTHRA_CONCURRENCY` | No | Parallel mantra publish workers (default 10) |
| `PUBLISH_ADHYAYA_CONCURRENCY` | No | Parallel section publish workers (default 4) |

Example `.env`:

```env
DATABASE_URL=postgresql://postgres:password@localhost:5432/ekatmadham
SESSION_SECRET=your-long-random-secret
STRAPI_URL=http://13.53.121.15:1337
STRAPI_API_TOKEN=your-strapi-token
PORT=5001
HERMEX_ENABLED=true
```

### Build for production

```bash
npm run build    # bundles client + server → dist/
npm run start    # NODE_ENV=production node dist/index.cjs
```

### Database migrations

SQL migrations live in `script/migrations/`. Apply with npm scripts:

```bash
npm run migrate:draft-fk-cascade
npm run migrate:portal-vocabulary
npm run migrate:acharyas
```

Schema changes also sync via `npm run db:push` (Drizzle).

---

## 6. REST API overview

### Base URL

- Local: `http://localhost:5001`
- Production: `https://admincms.xoidlabs.com`

### Conventions

| Topic | Behavior |
|-------|----------|
| Auth | Session cookie (`connect.sid`) — most routes require login |
| Content-Type | `application/json` for POST/PUT/PATCH |
| Errors | `{ "message": "..." }` with appropriate HTTP status |
| Idempotency | Publish/save supports `Idempotency-Key` header |
| Strapi proxy | All `/api/strapi/*` require auth and forward to Strapi via server-side `curl` |

### Route map (summary)

| Prefix | Module | Auth |
|--------|--------|------|
| `/api/auth/*` | Login, register, logout, current user | Mixed |
| `/api/drafts/*` | Portal draft CRUD + publish | Auth |
| `/api/strapi/*` | Strapi CMS proxy | Auth |
| `/api/strapi/migrate/*` | One-off migration endpoints | Auth |
| `/api/hermex/*` | AI translation | Auth |
| `/api/cms/*` | Vocabulary, unified mantra list | Auth |
| `/api/granthas/*` | Locks, orphan mantra cleanup | Auth |
| `/api/acharyas/*` | Acharya profiles | Auth |
| `/api/admin/*` | Users, backups, vocabulary, locks | Auth + admin |
| `/api/app-version` | Deploy version check | Public |

---

## 7. Authentication API

### `POST /api/auth/register`

Create a new editor account.

**Body:**
```json
{
  "username": "editor1",
  "password": "secret123",
  "displayName": "Editor One"
}
```

**Response:** `201` — user object (no password).

---

### `POST /api/auth/login`

**Body:**
```json
{
  "username": "editor1",
  "password": "secret123"
}
```

**Response:** `200` — `{ id, username, displayName, role }` + session cookie.

---

### `POST /api/auth/logout`

Destroys session. **Response:** `200`.

---

### `GET /api/auth/user`

Returns current user or `401` if not authenticated.

**Response:**
```json
{
  "id": "uuid",
  "username": "editor1",
  "displayName": "Editor One",
  "role": "editor"
}
```

---

## 8. Draft API

Drafts are scoped to the authenticated user (`createdBy`).

### Valid `contentType` values

`granthas`, `sections`, `teekas`, `articles`, `authors`, `categories`, `manthras`, `chapters`, `prasthana-thraya-screens`

(`prasthana-thraya-screens` saves locally only — cannot publish to Strapi.)

---

### `GET /api/drafts`

List drafts for current user.

**Query:** `?contentType=granthas` (optional filter)

**Response:** Array of draft records.

---

### `GET /api/drafts/:id`

Get one draft (must belong to user).

---

### `POST /api/drafts`

Create draft.

**Body:**
```json
{
  "contentType": "granthas",
  "title": "Chandogya Upanishad",
  "data": { "...portal payload..." },
  "strapiDocumentId": "optional-strapi-doc-id"
}
```

**Response:** `201` — draft record; may include `_backupKey` if S3 backup written.

---

### `PUT /api/drafts/:id`

Update draft (full replace of `title`/`data`).

**Body:**
```json
{
  "title": "Updated title",
  "data": { "...full payload..." },
  "expectedUpdatedAt": "2026-06-04T10:00:00.000Z"
}
```

Supports `Idempotency-Key` header. Uses draft lock to prevent concurrent clobbering.

---

### `PATCH /api/drafts/:id/manthra`

Patch a single mantra node inside a grantha draft (fast save from mantra dialog).

**Body:**
```json
{
  "title": "Grantha Name",
  "adhyayaId": "local-id",
  "khandaId": "local-id",
  "padaId": "optional",
  "manthraId": "local-id",
  "manthraData": { "ShlokaManthraEntry": {}, "title": "Shloka 1.1.1" }
}
```

---

### `DELETE /api/drafts/:id`

Delete draft and dependent publish jobs.

---

### Draft backups (S3 / local snapshots)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/drafts/:id/backups` | List backup keys for draft |
| GET | `/api/drafts/:id/backups/content?key=...` | Download backup JSON |
| DELETE | `/api/drafts/:id/backups?key=...` | Delete one backup |
| POST | `/api/drafts/:id/recover-latest` | Admin: restore from latest snapshot |

---

### `POST /api/drafts/:id/sync-mantra-slots`

Create CMS mantra rows for portal-only verses and sync labels (pre-publish helper).

---

## 9. Publish API

### `POST /api/drafts/:id/publish-preflight`

Validate grantha hierarchy before publish (integrity scan).

**Response:**
```json
{ "ok": true }
```
or `{ "ok": false, "message": "...", "violations": [...] }`

---

### `POST /api/drafts/:id/publish`

Start publish job. For large granthas, returns immediately with `jobId` for polling.

**Body (optional):**
```json
{ "allowRenumber": true }
```

`allowRenumber` — required after structural verse insert/delete so suffix-stability guard allows shifted labels.

**Response (async):**
```json
{
  "jobId": "uuid",
  "async": true,
  "message": "Publish started"
}
```

**Response (sync / small):**
```json
{
  "draft": { "...updated draft..." },
  "strapi": { "...strapi response..." },
  "warnings": []
}
```

Supports `Idempotency-Key` header.

---

### `GET /api/drafts/:id/publish-status?jobId=...`

Poll background publish progress.

**Response:**
```json
{
  "status": "running|done|failed|failed_recoverable",
  "progress": { "done": 120, "total": 500, "current": "Shloka 1.2.3" },
  "result": {},
  "error": null
}
```

---

### Single-mantra publish

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/drafts/:id/publish-manthra` | Publish one verse from open editor |
| POST | `/api/drafts/:id/publish-manthras-batch` | Batch publish multiple verses |

---

### Grantha maintenance

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/granthas/:docId/orphan-manthras` | List mantras not linked to hierarchy |
| POST | `/api/granthas/:docId/cleanup-orphan-manthras` | Delete orphan mantras (with dry-run option) |

---

### Grantha locks

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/granthas/locks` | Auth | List active locks |
| POST | `/api/admin/granthas/:docId/lock` | Admin | Lock grantha |
| DELETE | `/api/admin/granthas/:docId/lock` | Admin | Unlock grantha |

**Lock body:**
```json
{ "reason": "Finalized for publication" }
```

---

## 10. Strapi proxy API

All routes under `/api/strapi` require authentication. The server forwards requests to Strapi using `strapiRequest()` (curl subprocess with `-g` for complex query strings).

### Generic collection CRUD

For each content type below, these routes exist:

| Method | Path | Strapi equivalent |
|--------|------|-------------------|
| GET | `/api/strapi/{type}` | List (auto-paginates all pages) |
| GET | `/api/strapi/{type}/:documentId` | Get one (`populate=*`) |
| POST | `/api/strapi/{type}` | Create |
| PUT | `/api/strapi/{type}/:documentId` | Update |
| DELETE | `/api/strapi/{type}/:documentId` | Delete (+ cleans linked portal draft) |

**Collection types:** `granthas`, `teekas`, `articles`, `authors`, `categories`, `chapters`

### Grantha list (enriched)

**GET `/api/strapi/granthas`**

Returns all granthas with nested `sections[]` metadata attached (documentId, title, type, order, parent). Cover image URLs are absolutized.

### Sections (specialized)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/strapi/sections` | List sections |
| GET | `/api/strapi/sections/by-grantha/:granthaDocId` | Full tree + mantras for one grantha |
| GET | `/api/strapi/sections/:documentId` | One section |
| POST | `/api/strapi/sections` | Create section |
| PUT | `/api/strapi/sections/:documentId` | Update section |
| DELETE | `/api/strapi/sections/:documentId` | Delete section |

**Create section body:**
```json
{
  "data": {
    "title": "Prathama Adhyaya",
    "type": "adhyay",
    "order": 1,
    "grantha": "grantha-document-id",
    "parent": "optional-parent-document-id"
  }
}
```

### Manthras (specialized)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/strapi/manthras` | Paginated mantra list |
| GET | `/api/strapi/manthras/:documentId` | Full mantra with populated components |
| GET | `/api/strapi/manthras/full-by-grantha/:granthaDocId` | Bulk fetch for editor hydration |
| GET | `/api/strapi/manthras/teekas-by-grantha/:granthaDocId` | Teeka map keyed by mantra docId |
| GET | `/api/strapi/manthras/resolve-for-edit` | Resolve mantra for editor by docId/label |
| POST | `/api/strapi/manthras` | Create mantra |
| PUT | `/api/strapi/manthras/:documentId` | Update mantra |
| DELETE | `/api/strapi/manthras/:documentId` | Delete mantra |
| POST | `/api/strapi/manthras/insert-between` | CMS insert-between with sort-key shift |
| POST | `/api/strapi/manthras/batch-identity-sync` | Batch label/order sync |
| POST | `/api/strapi/manthras/create-blank-in-section` | Create empty CMS row for new verse |

### Teekas by grantha

**GET `/api/strapi/teekas/by-grantha/:granthaDocId`**

### Media upload

**POST `/api/strapi/upload`**

Proxies multipart upload to Strapi media library.

### Single types

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/strapi/about` | About page |
| PUT | `/api/strapi/about` | Update About |
| GET | `/api/strapi/global` | Global settings |
| PUT | `/api/strapi/global` | Update Global |

### Prasthana Thraya screens

Routes exist but return admin-only note — manage in Strapi Content Manager directly.

### Migration endpoints

**POST `/api/strapi/migrate/split-vivekachudamani`** — one-off structural migration.

---

## 11. Hermex translation API

Requires `HERMEX_ENABLED=true` and Python venv setup (`npm run hermex:install`).

### `GET /api/hermex/status`

```json
{
  "enabled": true,
  "python": ".venv-hermex/bin/python3",
  "otherTranslationLanguageCount": 43,
  "otherTranslationLanguages": ["Tamil", "..."],
  "sourceLanguages": ["English", "Sanskrit"]
}
```

### `POST /api/hermex/translate`

**Body:**
```json
{
  "sourceText": "The Self is pure consciousness.",
  "sourceLanguage": "English",
  "targetLanguages": ["Tamil", "Kannada", "Hindi"],
  "context": "Shloka 1.1.1",
  "chunkSize": 5,
  "headless": false,
  "queryTimeoutSec": 300
}
```

**Response:**
```json
{
  "translations": [
    {
      "LanguageOfTranslation": "Tamil",
      "TranslationText": [{ "type": "paragraph", "children": [{ "type": "text", "text": "..." }] }],
      "isAiTranslated": true
    }
  ]
}
```

CLI batch: `npm run hermex:grantha -- "Grantha Name"`

---

## 12. Admin API

All `/api/admin/*` routes require `role: admin` unless noted.

### Users

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/users` | List users |
| POST | `/api/admin/users` | Create user |
| PATCH | `/api/admin/users/:id/role` | Change role |
| PATCH | `/api/admin/users/:id/password` | Reset password |
| DELETE | `/api/admin/users/:id` | Delete user |

### Portal vocabulary

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/cms/vocabulary` | Merged vocabulary (defaults + custom) |
| POST | `/api/admin/cms/vocabulary` | Add custom vocabulary entry |
| DELETE | `/api/admin/cms/vocabulary` | Remove custom entry |

Vocabulary keys: `teekaAuthors`, `bhashyamAuthors`, `structureLevelOneNames`, `structureLevelTwoNames`, `structureLevelThreeNames`, `structureLeafNames`

### Strapi backups

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/backups` | List snapshots |
| GET | `/api/admin/backups/:id/data` | Full backup JSON |
| GET | `/api/admin/backups/:id/summary` | Counts + grantha names |
| GET | `/api/admin/backups/:id/sections/:sectionId/manthras` | Mantras in section from backup |
| GET | `/api/admin/backups/:id/download` | Download gzip JSON |
| GET | `/api/admin/backups/:id/export-sqlite` | Export as SQLite |
| POST | `/api/admin/backups/import` | Import uploaded snapshot |
| POST | `/api/admin/backup` | Take new live Strapi snapshot |
| GET | `/api/admin/backup/status` | Snapshot job status |
| POST | `/api/admin/backups/:id/restore-manthra` | Restore one mantra from backup |
| POST | `/api/admin/backups/:id/restore-grantha` | Partial grantha restore |
| POST | `/api/admin/backups/:id/restore-grantha-full` | Full grantha restore (background job) |
| GET | `/api/admin/restore-jobs/:jobId` | Poll restore job |

### Unified mantra list

**GET `/api/cms/manthras-unified`**

Cross-grantha mantra index for the Manthras page (search, filters).

### App version

**GET `/api/app-version`** (public)

```json
{ "buildId": "abc123" }
```

Used by client to prompt reload after deploy.

---

## 13. Acharya API

Acharya profiles live in **portal PostgreSQL** (`acharya_profiles`), not Strapi.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/acharyas` | Auth | List all acharyas |
| GET | `/api/acharyas/:slug` | Auth | One acharya + linked granthas/teekas |
| PATCH | `/api/acharyas/:slug` | Admin | Update profile |
| POST | `/api/acharyas/seed` | Admin | Re-seed from scraped data |

Seed script: `npm run seed:acharyas`

---

## 14. Database schema

### Portal tables (PostgreSQL)

| Table | Purpose |
|-------|---------|
| `users` | Portal accounts (id, username, password hash, role) |
| `session` | Express sessions (connect-pg-simple) |
| `content_drafts` | Draft JSONB payloads |
| `grantha_backups` | Strapi snapshot storage |
| `grantha_locks` | Edit blockers per Strapi grantha docId |
| `cms_publish_jobs` | Background publish job state |
| `cms_publish_job_tasks` | Per-mantra task queue |
| `cms_publish_manthra_resolutions` | Crash-recovery docId checkpoints |
| `cms_idempotency_keys` | Publish/save idempotency cache |
| `cms_portal_vocabulary` | Custom dropdown values |
| `acharya_profiles` | Guru parampara data |
| `cms_draft_snapshots` | Audit trail of draft changes |

### Draft record shape

```typescript
{
  id: number;
  contentType: string;           // e.g. "granthas"
  strapiDocumentId: string | null;
  title: string;
  data: Record<string, unknown>;  // JSONB — full portal payload
  status: "draft" | "published";
  createdBy: string;              // user id
  createdAt: Date;
  updatedAt: Date;
}
```

### Grantha draft `data` (key fields)

```typescript
{
  GranthaName: string;
  GranthaType: string;
  structureConfig: {
    levelOneEnabled: boolean;
    levelOneName: string;       // e.g. "Adhyaya"
    levelTwoEnabled: boolean;
    levelTwoName: string;
    levelThreeEnabled: boolean;
    levelThreeName: string;
    leafName: string;           // e.g. "Shloka"
  };
  hierarchy: AdhyayaNode[];     // full editor tree
  teekas: TeekaDefinition[];
  // ... Strapi-mapped grantha fields ...
}
```

---

## 15. Strapi content model

### Collection types

**Grantha** — Sacred text root record.

**Section** — Nestable structural division.

- `type` enum: `adhyay`, `khanda`, `valli`, `pada`, `kanda`, `sukta`, `varga`, `anuvaka`, `prakarana`, `brahmana`, `chapter`, `part`, `section`, `book`
- Relations: `grantha`, `parent`, `sub_sections`, `manthras`

**Manthra** — Individual verse.

- `ShlokaManthraNumber`, `order`, `Section`
- `ShlokaManthraEntry`, `BhashyamEntry` (shared.text-and-translation)
- `Teekas[]` (default.bhashya-entries)
- `wordMeanings[]`

**Teeka**, **Article**, **Author**, **Category**, **Chapter**

### Shared components

**shared.text-and-translation**
- `SanskritTextEntry`, `IASTTransliteration`, `EnglishTranslationText` (Strapi blocks)
- `OtherTranslations[]` → `{ LanguageOfTranslation, TranslationText, isAiTranslated }`

**shared.seo** — `metaTitle`, `metaDescription`, `shareImage`

### Single types

- **About** — `{ title, blocks }`
- **Global** — `{ siteName, favicon, siteDescription, defaultSeo }`

---

## 16. Publish pipeline (grantha)

High-level steps when `POST /api/drafts/:id/publish` runs for a grantha:

1. **Preflight** — integrity scan (duplicate suffixes, bare labels, cross-grantha docIds)
2. **Lock** — reject if grantha is admin-locked or another publish job is running for same grantha
3. **Grantha record** — POST or PUT `/api/granthas` (portal meta stripped from payload)
4. **Teekas** — create/update teeka definitions
5. **Sections** — traverse hierarchy L1 → L2 → L3, `findOrCreateSection` by title+parent+grantha
6. **Mantras** — create/update each verse; merge existing Strapi text/teekas/translations
7. **Deletes** — remove tombstoned sections/mantras from Strapi
8. **Draft update** — write back `strapiDocumentId` on hierarchy nodes; mark draft `published`
9. **Job completion** — return warnings for partial failures

Large publishes run in background with:
- Worker pool for mantras (configurable concurrency)
- Checkpoint table for crash recovery
- Idempotency keys to prevent double-publish on retry

Structural changes (insert/delete verses) may trigger **fresh republish** (new Strapi grantha) when `allowRenumber: true`.

Key server files:
- `server/routes.ts` — `publishGranthaWithHierarchy()`
- `server/grantha-mantra-slot-sync.ts` — slot/label sync
- `shared/grantha-publish-integrity.ts` — validation rules

---

## 17. Data safety rules

### CRITICAL: Strapi repeatable arrays are full replacements

On every PUT, Strapi **replaces** entire arrays for:
- `Teekas`
- `OtherTranslations`
- `GranthaNameTranslations`

**Never** send partial arrays. The publish path always:
1. Fetches existing Strapi data
2. Merges local changes by language/teeka name
3. Sends the merged complete array

Helper: `mergeOtherTranslations()` in `server/routes.ts`.

### Correct OtherTranslations field names

```json
{
  "LanguageOfTranslation": "Tamil",
  "TranslationText": [{ "type": "paragraph", "children": [{ "type": "text", "text": "..." }] }]
}
```

Not `Language` / `Translation`.

### Portal-only keys never sent to Strapi

See `shared/portal-draft-meta.ts` — `scrubLeakedPortalKeysFromStrapiPayload()` is the last-line guard.

### Book structure (`structureConfig`)

Stored **only** in portal drafts, not in Strapi. Reopening a published grantha without an in-progress draft may show default structure labels (Adhyaya/Khanda/Mantra) even when CMS section titles use custom names.

---

## 18. Scripts & maintenance

### Test scripts

```bash
npm run test:mantra-index
npm run test:publish-integrity
npm run test:grantha-payload-strip
npm run test:mantra-cms-cache
```

### Repair / audit

```bash
npm run audit:grantha-mantras
npm run repair:section-mantras
npm run repair:grantha-mantras
npm run repair:misplaced-adhyaya-mantras
npm run migrate:canonical-mantras
```

### Hermex

```bash
npm run hermex:install
npm run hermex:setup
npm run hermex:grantha -- "Grantha Name"
```

### Draft management

```bash
npm run discard:grantha-draft
npm run discard:draft-deps
```

---

## 19. Production deployment

### AWS topology (current)

| Component | Location |
|-----------|----------|
| Portal + API | EC2 `13.53.121.15` → `admincms.xoidlabs.com` (pm2: `cms-library`) |
| Strapi | Same EC2 (pm2: `strapi`) |
| PostgreSQL | AWS RDS `strapi-db.*.rds.amazonaws.com` / database `ekatmadham` |
| Public site | Separate deployment |

Checkouts on EC2 under `~/library/`:
- `library-cms` — this repo
- `strapi-backend` — Strapi instance

### Deploy checklist

1. Set all env vars on server (never commit secrets).
2. `npm run build && npm run start` (or pm2 restart).
3. Verify `SESSION_SECRET` is stable across deploys (or all users logout).
4. Confirm `STRAPI_API_TOKEN` is valid.
5. Monitor publish jobs for large granthas (504 gateway timeouts possible — jobs continue in background).

---

## 20. Troubleshooting

### Publish blocked — integrity check

Fix duplicate verse labels or empty titles shown in toast. Use **Sync verse numbers to CMS** if labels drifted.

### "Some sections are missing titles"

On step 2 → 3, ensure chapters have titles. The portal auto-fills blank titles with defaults (e.g. `Prathama Adhyaya`) when possible.

### Book structure shows wrong labels after publish

`structureConfig` is portal-only. Reopen via in-progress draft or recover snapshot. Published snapshot drafts are intentionally not used as overlay.

### Content changed after Save / insert-between

Save used to run aggressive full-tree renumber; this is fixed to preserve list-order labels from insert-between. Save draft before Save & Publish.

### 504 Gateway Timeout on publish

Large granthas publish in background. Poll `/api/drafts/:id/publish-status?jobId=...` — do not retry immediately (idempotency may return stale job).

### Strapi 403 during Hermex batch

WAF/rate limit — wait and retry. Confirm `STRAPI_API_TOKEN`.

### Hermex Chrome stuck

```bash
pkill -f translate_cli.py
pkill -f "hermex/chrome_profile"
rm -f "$HOME/Library/Application Support/hermex/chrome_profile"/Singleton*
```

### Session lost mid-edit

Use reconnect banner **Retry now**. Work in tab is preserved; session cookie may still be valid.

---

## Related documents

| Document | Topic |
|----------|-------|
| [LIBRARY.md](./LIBRARY.md) | General library overview and editor/admin checklists |
| [GO-LIVE-BACKLOG.md](./GO-LIVE-BACKLOG.md) | One backlog for going live |
| [PROJECT_OVERVIEW.md](./PROJECT_OVERVIEW.md) | Developer onboarding (shorter) |
| [HERMEX.md](./HERMEX.md) | AI translation setup |
| [orphan-manthras-investigation.md](./orphan-manthras-investigation.md) | Orphan mantra debugging |
| [../replit.md](../replit.md) | Deep architecture + merge behavior reference |

---

*Last updated: June 2026 — Data Feeder CMS / Ekatmadham Library*
