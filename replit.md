# Ekatmadham Library - Content Management Portal

## Overview
A data feeding website for the Ekatmadham Library that connects to a Strapi CMS backend. Users can log in, create content as drafts in the local database, and explicitly publish to Strapi CMS when ready. Published content is displayed on the Ekatmadham Library website.

## Architecture
- **Frontend**: React + TypeScript with Vite, shadcn/ui components, TanStack Query, wouter routing
- **Backend**: Express.js server with session-based authentication (passport-local), Strapi API proxy, draft management
- **Database**: PostgreSQL (user authentication + content drafts)
- **CMS**: Strapi CMS running on AWS EC2 (13.53.121.15:1337 / https://admincms.xoidlabs.com)

## Content Flow
1. User creates/edits content → saved as **draft** in local PostgreSQL
2. User clicks **Publish** → content is sent to Strapi CMS
3. Published content appears on the Ekatmadham Library website (dev.ekatmdhamlibrary.xoidlabs.com)

## Content Types (from Strapi — Collection Types)
- **Grantha** (`api::grantha.grantha`): Sacred texts — GranthaName, slug, GranthaType (enum), BhashyamName, BhashyamAuthor (enum), IntroductionToTextEnglish (blocks), BhashyakaraIntroduction (shared.text-and-translation), NumberOfTeekas, introVideoId, introVideoTitle, GranthaNameTranslations (shared.translations[]), coverImage (media), sections[], teekas[]
- **Section** (`api::section.section`): Structural divisions — title, order, type (enum: adhyay|khanda|valli|pada|kanda|sukta|varga|anuvaka|prakarana|chapter|part|section|book), titleTranslations (shared.translations[]), grantha (manyToOne), parent (manyToOne→Section), sub_sections (oneToMany→Section), manthras (oneToMany→Manthra)
- **Manthra** (`api::manthra.manthra`): Individual verse/mantra entries — ShlokaManthraNumber (string), order, Section (manyToOne, capital S), ShlokaManthraEntry (shared.text-and-translation), BhashyamEntry (shared.text-and-translation), Teekas (default.bhashya-entries[]), wordMeanings (shared.word-meaning[])
- **Teeka** (`api::teeka.teeka`): Commentary works — TeekaName, TeekaAuthor (enum), grantha (manyToOne)
- **Article** (`api::article.article`): Blog articles — title, description, slug, cover (media), author, category, blocks (dynamiczone), **seo** (`shared.seo`: metaTitle, metaDescription, shareImage). Portal enforces SEO fields, JSON-LD in draft, and publishes meta via `description` + `seo` component (`shared/article-seo.ts`).
- **Author** (`api::author.author`): Author profiles — name, avatar (media), email, articles (oneToMany)
- **Category** (`api::category.category`): Content categories — name, slug, description, articles (oneToMany)
- **User**: Strapi user accounts

## Single Types (from Strapi)
- **About** (`api::about.about`): title (string), blocks (dynamiczone)
- **Global** (`api::global.global`): siteName, favicon (media), siteDescription, defaultSeo (shared.seo)

## Strapi Shared Components
- **shared.text-and-translation**: SanskritTextEntry (blocks), IASTTransliteration (blocks), EnglishTranslationText (blocks), OtherTranslations (shared.translations[])
- **shared.translations**: TranslationText (blocks), LanguageOfTranslation (enum — 45 languages), isAiTranslated (boolean)
- **shared.word-meaning**: word (text), meaning (text), position (integer)
- **shared.seo**: metaTitle, metaDescription, shareImage (media)
- **default.bhashya-entries**: teeka (relation→Teeka), TeekaEntry (shared.text-and-translation)

## Key Components
- **TextAndTranslation**: Reusable component for Sanskrit text + English translation + other languages (51 language dropdown)
- **BhashyaEntryFields**: Repeatable Teeka/commentary entries with nested TextAndTranslation (4 Teeka authors)
- **DataTable**: Generic data table with search, CRUD actions, status badges (Draft/Published), Publish button, `headerContent` slot
- **StrapiSyncBar**: Sync status badge shown in every list view — green dot + "Synced X ago", spinning during fetch, manual refresh button
- **useDrafts hook**: Shared hook for draft CRUD + publish workflow across all content pages
- **useStrapiSync hook**: Provides `syncAll()` + `isSyncing` + `lastSyncedAt` by watching `useIsFetching` across all `/api/strapi` queries

## Strapi Sync Behaviour
- All Strapi queries use `refetchInterval: 30_000` (30 s) + `refetchOnWindowFocus: true`
- Any content added directly in Strapi is automatically picked up within 30 seconds
- Every list page shows a `StrapiSyncBar` in the header with last-sync time and a manual refresh button
- Utility functions `blocksToText` / `textToBlocks` live in `client/src/lib/strapi-blocks.ts`

## Database Tables
- `users` - User accounts (id, username, password, displayName, role)
- `session` - Express sessions (connect-pg-simple)
- `content_drafts` - Draft content (id, content_type, strapi_document_id, title, data as JSONB, status, created_by, timestamps)
- `grantha_backups` - Strapi data snapshots (id, label, timestamps, grantha/section/manthra counts, data as JSONB)
- `grantha_locks` - Grantha edit blockers (id, grantha_doc_id UNIQUE, grantha_name, locked_by_user_id, locked_by_username, locked_at, reason)

## File Structure
- `shared/schema.ts` - Database schema (users + content_drafts) + Strapi TypeScript interfaces + enums
- `server/auth.ts` - Passport.js authentication with session management, trust proxy for production
- `server/strapi.ts` - Strapi API proxy routes (all CRUD operations), exported strapiRequest function
- `server/routes.ts` - Draft API routes with user-scoped access control and input validation
- `server/db.ts` - PostgreSQL database connection
- `client/src/hooks/use-drafts.ts` - Shared draft management hook
- `client/src/pages/` - All page components (login, dashboard, granthas, chapters, articles, authors, categories, prasthana-thraya)
- `client/src/components/` - Reusable components (dashboard-layout, data-table, text-translation-fields, bhashya-entry-fields)

## Multi-User Data Entry
- Sessions are stored in PostgreSQL — multiple users can log in and work simultaneously
- Each mantra is an independent Strapi record — users working on different mantras do not conflict
- User roles: `admin` (full access + user management) and `editor` (data entry only)
- Admin user management at `/admin/users` — create/delete users, reset passwords, change roles
- Self-registration is enabled — anyone can create an account via the Register tab; new accounts get the "editor" role automatically
- Admin API routes: `GET/POST /api/admin/users`, `PATCH /api/admin/users/:id/role`, `PATCH /api/admin/users/:id/password`, `DELETE /api/admin/users/:id`
- "Administration" section in sidebar visible only to admin-role users
- **Grantha blocker**: Admins can lock (block editing on) any published grantha via the lock icon on the grantha card. Locked granthas are read-only for ALL users. Admins can unlock at any time. API: `GET /api/granthas/locks`, `POST /api/admin/granthas/:docId/lock`, `DELETE /api/admin/granthas/:docId/lock`

## Security
- All draft operations are user-scoped (users can only see/edit/delete their own drafts)
- Content type validation on draft creation
- Draft ID validation (NaN protection)
- Session cookies: httpOnly, secure in production, sameSite lax
- Trust proxy enabled for production deployment behind reverse proxy
- Self-registration enabled; new users automatically receive the "editor" role; admins can still manage users via `/api/admin/users`

## Environment Variables
- `DATABASE_URL` - PostgreSQL connection string
- `SESSION_SECRET` - Express session secret (required, no fallback)
- `STRAPI_URL` - Strapi CMS URL (http://13.53.121.15:1337)
- **Note**: Strapi connection uses curl subprocess (execFile) with `-g` flag to handle special characters in query strings. Node.js native fetch/https cannot reach this server from the workflow process.
- `STRAPI_API_TOKEN` - Strapi API authentication token

## Data Safety: Merge Logic for Repeatable Components (CRITICAL)

Strapi treats any repeatable component array (`Teekas`, `OtherTranslations`) as a **complete replacement** on every PUT. Sending a partial array silently wipes everything else. Both publish paths (`buildManthraData` and `buildManthraPayloadAsync`) now apply merge protection to prevent this.

### Teeka Merge
**`buildManthraData`** (used by bulk publish + individual mantra publish):
1. Resolve local draft teekas via `resolveManthraTeekas`
2. **Fetch existing Strapi teekas** for this mantra docId
3. Build merged array: keep every Strapi entry, overwrite only the ones the local draft edited, append brand-new entries
4. Send the merged array — no existing teeka is ever wiped

**`buildManthraPayloadAsync`** (used by standalone draft publish):
- Same merge logic applied

### OtherTranslations Merge (CRITICAL — added 2026-05-07)
Same replacement risk applies to `ShlokaManthraEntry.OtherTranslations` and `BhashyamEntry.OtherTranslations`. Root cause of recurring wipe: broken `populate=*` (now fixed with explicit nested populate) returned null → local state had no translations → publish sent `OtherTranslations:[Tamil]` → Strapi replaced all 43 with 1.

**Fix** — both publish paths now:
1. Detect if the mantra already exists in Strapi (`strapiDocumentId` present)
2. Fetch current Strapi `ShlokaManthraEntry.OtherTranslations` + `BhashyamEntry.OtherTranslations`
3. If local has fewer translations than Strapi, merge: Strapi is the base, local overrides by language, new local languages appended
4. Send merged set — no translation is ever silently wiped
- Helper: `mergeOtherTranslations(localOT, strapiOT)` in `server/routes.ts`
- Restore script: `scripts/restore_mandukya_ot.mjs` — restored 81 Mandukya mantras damaged 2026-05-07

### OtherTranslations field names (CRITICAL)
Strapi stores multilingual content as:
```json
{ "LanguageOfTranslation": "Tamil", "TranslationText": [...blocks] }
```
**NOT** `{ "Language": "Tamil", "Translation": [...] }`. Any restore/import script must use the correct field names or all 43 language translations will be silently dropped.

### When no local teekas → omit Teekas from PUT payload
If the user hasn't edited any teeka on a mantra, Teekas is omitted from the payload entirely so Strapi preserves whatever it already holds.

## Tests

### Regression Test Suite
`tests/teeka-merge-regression.mjs` — run with `node tests/teeka-merge-regression.mjs`

Covers:
1. Strapi baseline: verifies 43 OtherTranslations present on Mantra 1.1.1
2. **Destructive PUT proof**: confirms a single-teeka PUT wipes other teekas (why merge is essential)
3. **Merge PUT**: verifies that sending merged array preserves all teekas
4. OtherTranslations field name validation (LanguageOfTranslation + TranslationText)
5. Portal login + Strapi proxy correctness
6. OtherTranslations round-trip through portal draft save/load

All 24 assertions pass.

### E2E UI Test
Run via testing skill. Verifies:
- Login → open Katho Upanishad → navigate to Book Structure → open mantra dialog
- Dialog shows Mantra 1.1.1 with Sanskrit content + OtherTranslations
- Close via Escape → re-open → content still intact (auto-save on close works)

## Backup & Restore

### Backup format (grantha_backups table)
- Backups are gzip-compressed JSON stored as base64 in `grantha_backups.data._compressed`
- OtherTranslations format: `{ LanguageOfTranslation, TranslationText, isAiTranslated }`
- Teeka structure: `{ teeka: { TeekaName, documentId }, TeekaEntry }`

### Restore script
`scripts/force_restore_katho.mjs` — restores all 120 Katho Upanishad manthras from backup #210
- Sends OtherTranslations in batches of 15 (Strapi 413 prevention)
- Uses concurrency=6; run in slices for manthras > 100 due to 2-min timeout
- Final 20 manthras (indices 100-119) restored separately due to ordering



 npm run hermex:grantha -- "Brihadaranyaka Upanishad"