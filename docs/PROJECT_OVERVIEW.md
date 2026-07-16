# Ekatmadham Library — Data Feeder CMS (Developer Onboarding)

> A single-doc onboarding guide. Read this end-to-end and you can run the app,
> understand the architecture, and start contributing without a walkthrough.

---

## 1. What this project is

A **content-management / data-entry portal** for the Ekatmadham Library. Editors
log in, create/edit content as **drafts in a local PostgreSQL DB**, then explicitly
**publish** to a **Strapi CMS** backend. Published content renders on the public
Ekatmadham Library website.

- **Local repo / dir:** `Data-Feeder-CMS` (aka `library-cms`, repo `chitraa-cj/library-cms`)
- **Domain focus:** Sanskrit sacred texts (Granthas → Sections → Manthras/verses),
  their commentaries (Teekas/Bhashyam), multi-language translations (43 langs),
  blog Articles, and Acharya profiles.
- **Portal (prod):** `admincms.xoidlabs.com` — **Public site:** `dev.ekatmdhamlibrary.xoidlabs.com`

**Content flow:** `Edit → draft in Postgres → Publish → Strapi CMS → public site`.

---

## 2. Tech stack

| Layer | Tech |
|-------|------|
| Frontend | React 18 + TypeScript, Vite, **wouter** (routing), **TanStack Query**, shadcn/ui (Radix), Tailwind, TipTap (rich text), framer-motion |
| Backend | **Express 5** + `tsx`, session auth via **passport-local**, Strapi API proxy |
| DB | **PostgreSQL** via **Drizzle ORM** (`drizzle-kit push`) |
| CMS | **Strapi** (collection + single types) on AWS EC2 |
| Analytics | PostHog (`client/src/lib/posthog.ts`) |
| AI translation | **Hermex** — browser-drives free Gemini web UI (no API key). See `docs/HERMEX.md` |
| Backups | Postgres `grantha_backups` table + optional **AWS S3** versioned draft backups |

---

## 3. Major capabilities

- **Grantha management** — CRUD for sacred texts with type, Bhashyam/commentary metadata,
  intro (blocks + video), cover image, translations of the name, nested Sections and Teekas.
- **Hierarchical structure** — Grantha → Section (adhyay/khanda/valli/… nestable) → Manthra (verse).
- **Verse (Manthra) editor** — Sanskrit + IAST + English + up to **43 other-language translations**,
  Bhashyam commentary, per-Teeka commentary entries, word meanings.
- **Draft → Publish workflow** — everything is a local draft first; publish pushes to Strapi
  with **merge protection** (never silently wipes existing Strapi translations/teekas).
- **Strapi live sync** — every list auto-refetches (30 s + on window focus); `StrapiSyncBar`
  shows last-sync time + manual refresh. Content added directly in Strapi appears within 30 s.
- **AI translation (Hermex/Gemini)** — translate one mantra or a full grantha into all 43
  languages via browser automation; resumable checkpoints. See `docs/HERMEX.md`.
- **CSV import** — bulk-import grantha structure/verses (`grantha-csv-import-dialog.tsx`).
- **Articles** — blog with enforced **SEO** (metaTitle/metaDescription/shareImage + JSON-LD),
  authors, categories, dynamic-zone content blocks.
- **Acharya profiles** — profiles of teachers/authors (scraped + seeded).
- **Backup & restore** — snapshot Strapi grantha data to `grantha_backups` (gzip+base64 JSONB);
  browse/restore in the Backups UI; optional durable S3 backups on save.
- **Grantha locking** — admins can lock a published grantha → read-only for all users.
- **Multi-user** — Postgres-backed sessions; concurrent editors; per-user draft scoping.
- **Roles** — `admin` (full access + user management) and `editor` (data entry only); self-registration → editor.

---

## 4. Feedback implemented (why key features exist)

These were driven by real editorial/production incidents — keep them intact:

- **OtherTranslations merge protection (CRITICAL).** Strapi treats repeatable component
  arrays as *full replacement* on PUT. A partial publish once wiped 43 languages down to 1
  (Mandukya, 2026-05-07). Both publish paths now fetch existing Strapi translations and merge
  (Strapi is base, local overrides by language, new langs appended). Helper:
  `mergeOtherTranslations()` in `server/routes.ts`. Field names must be exactly
  `LanguageOfTranslation` + `TranslationText`.
- **Teeka merge protection.** Same replacement risk for `Teekas`; publish keeps all existing
  Strapi teekas, overrides only edited ones, omits `Teekas` entirely when nothing was edited.
- **Backup + restore infrastructure.** Added after data-loss incidents; snapshot before risky
  ops, restore scripts under `scripts/` (e.g. `force_restore_katho.mjs`, `restore_mandukya_ot.mjs`).
- **Grantha locking/blocker.** Admins lock published granthas so edits can't clobber finalized content.
- **Reconnect banner + auth session cache.** Connection drops during Save & Publish / server
  restarts kept users signed in and preserved in-tab work (`AuthReconnectBanner`, `auth-session-cache.ts`).
- **App-version refresh prompt.** Prompts users to reload after a new deploy (`use-app-version.tsx`).
- **Article SEO enforcement.** Portal forces SEO fields + JSON-LD before publish (`shared/article-seo.ts`).
- **Self-registration → editor role.** Lowered onboarding friction for data-entry staff.
- **Batched restore / 413 & 403 handling.** Large OtherTranslations sent in batches; WAF/rate-limit backoff.

---

## 5. Code structure

```
Data-Feeder-CMS/
├── client/src/
│   ├── App.tsx                 # wouter routes, auth gate, reconnect banner, PostHog
│   ├── pages/                  # one file per screen (see below)
│   ├── components/             # data-table, dashboard-layout, text-translation-fields,
│   │   │                       #   bhashya-entry-fields, strapi-sync-bar, rich-text-editor,
│   │   │                       #   grantha-csv-import-dialog, article-seo-panel, ...
│   │   └── ui/                 # shadcn/ui primitives
│   ├── hooks/                  # use-auth, use-drafts, use-strapi-sync, use-draft-backups,
│   │   │                       #   use-portal-vocabulary, use-app-version, ...
│   └── lib/                    # queryClient, strapi-blocks, posthog, publish-lock,
│                               #   grantha-*-sync, mantra-cms-cache, resolve-strapi-mantra-detail
├── server/
│   ├── index.ts                # Express bootstrap, session, vite/static wiring
│   ├── auth.ts                 # passport-local, session, trust proxy
│   ├── routes.ts               # MAIN file (~280KB): draft CRUD, publish, merge logic, admin, hermex
│   ├── strapi.ts               # Strapi API proxy (curl subprocess), all CRUD, strapiRequest()
│   ├── storage.ts              # DB access layer
│   ├── db.ts / env.ts          # Postgres connection / env loading
│   ├── acharyas.ts             # acharya endpoints
│   ├── s3-backup.ts            # durable S3 draft backups
│   ├── grantha-*.ts            # publish integrity, hierarchy repair, mantra slot sync, republish
│   └── hermex-translate.ts     # Hermex bridge (server side)
├── shared/
│   ├── schema.ts               # Drizzle DB schema + Strapi TS interfaces + enums (langs, types)
│   ├── article-seo.ts / article-editorial.ts
│   ├── grantha-publish-integrity.ts / grantha-publish-progress.ts
│   └── mantra-sort-key.ts, portal-draft-meta.ts, mantra-cms-guard.ts
├── script/                     # tsx maintenance scripts + migrations/ (SQL) + lib/
├── scripts/                    # .mjs restore/repair scripts + scrape_acharya_profiles.py
├── python/hermex_translate/    # Gemini browser automation (translate_cli.py, setup_gemini.py)
├── docs/                       # HERMEX.md, this file, investigations
├── replit.md                   # deep architecture/data-safety reference (read alongside this)
└── package.json                # scripts: dev/build/start + many test:/migrate:/repair:/hermex:
```

### Key page components (`client/src/pages/`)
`login`, `dashboard`, `granthas` (largest, ~390KB), `sections`, `chapters`, `manthras`,
`teekas`, `articles`, `authors`, `acharyas`, `categories`, `prasthana-thraya`, `backups`,
`backup-detail`, `admin-users`, `admin-vocabulary`, `single-type-editor` (About/Global).

---

## 6. Data model (Strapi content types)

- **Grantha** → GranthaName, slug, GranthaType, Bhashyam metadata, intro (blocks + video),
  coverImage, name translations, `sections[]`, `teekas[]`.
- **Section** → title, order, type (adhyay|khanda|valli|pada|…), `grantha`, `parent`,
  `sub_sections[]`, `manthras[]`. Nestable.
- **Manthra** (verse) → ShlokaManthraNumber, order, `Section`, `ShlokaManthraEntry`,
  `BhashyamEntry`, `Teekas[]`, `wordMeanings[]`.
- **Teeka** → TeekaName, TeekaAuthor, `grantha`.
- **Article** → title, description, slug, cover, author, category, blocks (dynamiczone), **seo**.
- **Author**, **Category**, **User**. Single types: **About**, **Global**.
- **Shared components:** `shared.text-and-translation` (Sanskrit/IAST/English + OtherTranslations),
  `shared.translations` (TranslationText + LanguageOfTranslation + isAiTranslated),
  `shared.word-meaning`, `shared.seo`, `default.bhashya-entries`.

### Postgres tables
`users`, `session`, `content_drafts` (JSONB `data`), `grantha_backups`, `grantha_locks`,
plus publish-jobs / vocabulary / acharya tables (see `script/migrations/`).

---

## 7. Getting started (local dev)

```bash
# 1. Install
npm install

# 2. Configure env (copy .env.example → .env, fill values — see §8)
cp .env.example .env

# 3. Ensure Postgres is running and DB exists (default: ekatmadham on localhost:5432)
npm run db:push          # apply Drizzle schema

# 4. Run
npm run dev              # NODE_ENV=development, serves API + Vite on PORT (default 5001)
```

- **Build:** `npm run build` → **Start (prod):** `npm run start` (serves `dist/index.cjs`)
- **Type-check:** `npm run check`
- **Migrations:** SQL files in `script/migrations/` applied via `npm run migrate:*`
- **Maintenance/repair:** many `npm run repair:*`, `audit:*`, `restore:*`, `test:*` scripts.
- **AI translation setup:** `npm run hermex:install` then `npm run hermex:setup` (see `docs/HERMEX.md`).

---

## 8. Credentials & environment

**Local `.env`** (values currently in the repo's `.env`):

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Postgres conn string (local: `postgresql://postgres:root@localhost:5432/ekatmadham`) |
| `SESSION_SECRET` | Express session secret (required, no fallback) |
| `STRAPI_URL` | Strapi base (`http://13.53.121.15:1337`) |
| `STRAPI_API_TOKEN` | Strapi API token (long secret in `.env`) |
| `PORT` | App port (local `5001`) |
| `S3_BACKUP_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Optional S3 draft backups (empty = disabled) |
| `HERMEX_ENABLED` + `HERMEX_*` | Gemini automation toggles/tuning (see `docs/HERMEX.md`) |

> ⚠️ **Secrets live in `.env` (gitignored) and on the EC2 box** — never commit real tokens.
> Rotate `STRAPI_API_TOKEN` / `SESSION_SECRET` if they leak. Treat the values above as
> "where to look," not "safe to share."

### Production topology (AWS)
- **EC2 host** `13.53.121.15` = `admincms.xoidlabs.com` (also runs Strapi). SSH:
  `ssh -i ~/.ssh/id_ed25519 ubuntu@13.53.121.15`.
- Three checkouts under `~/library/`: `library` (separate reading app, pm2 `sacred-script-hub`),
  `library-cms` (**this repo**, pm2 `cms-library`), `strapi-backend` (pm2 `strapi`).
- **Production DB = AWS RDS** `strapi-db.cfo2iqckovuw.eu-north-1.rds.amazonaws.com:5432`,
  database **`ekatmadham`**, user `strapi_user`, `sslmode=require`. **Private** — only reachable
  from the EC2 (run psql/seed scripts on the box or SSH-tunnel). Real creds in
  `~/library/library-cms/.env` on the box.
- psql gotcha: strip non-libpq params from `DATABASE_URL` and append `?sslmode=require` for raw psql.

---

## 9. Gotchas / must-knows

- **Never send partial repeatable arrays to Strapi** — it replaces the whole array. Always go
  through the merge helpers (`mergeOtherTranslations`, teeka merge) in `server/routes.ts`.
- **Strapi is reached via a `curl` subprocess** (`server/strapi.ts`, `execFile` with `-g`), not
  native fetch — needed to handle special chars in query strings from the workflow process.
- **`server/routes.ts` is huge (~280KB)** — it's the heart of publish logic; grep, don't scroll.
- **Hermex Chrome can wedge** on long runs (orphan profile Chrome + stale Singleton locks / two
  racing runs). Recovery: `pkill -f translate_cli.py` → `pkill -f "hermex/chrome_profile"` →
  `rm -f "$HOME/Library/Application Support/hermex/chrome_profile"/Singleton*`. See `docs/HERMEX.md`.
- **`replit.md`** contains the authoritative deep-dive on data-safety/merge behavior — read it
  before touching publish code.
- Draft ops are **user-scoped**; session cookies are httpOnly/secure-in-prod/sameSite-lax; trust
  proxy is on for the reverse-proxy deployment.

---

## 10. Where to go next

- **Deep architecture + data-safety rules:** `replit.md`
- **AI translation:** `docs/HERMEX.md`
- **Investigations:** `docs/orphan-manthras-investigation.md`
- **DB schema + types:** `shared/schema.ts`
- **Publish logic:** `server/routes.ts` + `server/strapi.ts` + `shared/grantha-publish-integrity.ts`
```
