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
- **Article** (`api::article.article`): Blog articles — title, description, slug, cover (media), author (manyToOne), category (manyToOne), blocks (dynamiczone)
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

## File Structure
- `shared/schema.ts` - Database schema (users + content_drafts) + Strapi TypeScript interfaces + enums
- `server/auth.ts` - Passport.js authentication with session management, trust proxy for production
- `server/strapi.ts` - Strapi API proxy routes (all CRUD operations), exported strapiRequest function
- `server/routes.ts` - Draft API routes with user-scoped access control and input validation
- `server/db.ts` - PostgreSQL database connection
- `client/src/hooks/use-drafts.ts` - Shared draft management hook
- `client/src/pages/` - All page components (login, dashboard, granthas, chapters, articles, authors, categories, prasthana-thraya)
- `client/src/components/` - Reusable components (dashboard-layout, data-table, text-translation-fields, bhashya-entry-fields)

## Security
- All draft operations are user-scoped (users can only see/edit/delete their own drafts)
- Content type validation on draft creation
- Draft ID validation (NaN protection)
- Session cookies: httpOnly, secure in production, sameSite lax
- Trust proxy enabled for production deployment behind reverse proxy

## Environment Variables
- `DATABASE_URL` - PostgreSQL connection string
- `SESSION_SECRET` - Express session secret (required, no fallback)
- `STRAPI_URL` - Strapi CMS URL (http://13.53.121.15:1337)
- **Note**: Strapi connection uses curl subprocess (execFile) with `-g` flag to handle special characters in query strings. Node.js native fetch/https cannot reach this server from the workflow process.
- `STRAPI_API_TOKEN` - Strapi API authentication token
