# Ekatmadham Library - Content Management Portal

## Overview
A data feeding website for the Ekatmadham Library that connects to a Strapi CMS backend. Users can log in, create content as drafts in the local database, and explicitly publish to Strapi CMS when ready. Published content is displayed on the Ekatmadham Library website.

## Architecture
- **Frontend**: React + TypeScript with Vite, shadcn/ui components, TanStack Query, wouter routing
- **Backend**: Express.js server with session-based authentication (passport-local), Strapi API proxy, draft management
- **Database**: PostgreSQL (user authentication + content drafts)
- **CMS**: Strapi CMS running on AWS EC2 (13.60.173.218:1337)

## Content Flow
1. User creates/edits content → saved as **draft** in local PostgreSQL
2. User clicks **Publish** → content is sent to Strapi CMS
3. Published content appears on the Ekatmadham Library website (dev.ekatmdhamlibrary.xoidlabs.com)

## Content Types (from Strapi)
- **Granthas**: Sacred texts (GranthaName, GranthaType, BhashyamName, BhashyamAuthor, IntroductionToTextEnglish, BhashyakaraIntroduction)
- **Chapters**: Chapter management with hierarchical structure (ChapterTitle, order, parent/children, ShlokaManthraEntry, BhashyamForShlokaManthra, Teekas)
- **Articles**: Blog articles (title, description, slug, author, category)
- **Authors**: Author profiles (name, email, avatar)
- **Categories**: Content categories (name, slug, description)
- **Prasthana Thraya**: Special screen entries (GranthaName, GranthaType, BhashyamName, BhashyamAuthor, BhashyaEntryCollection)

## Key Components
- **TextAndTranslation**: Reusable component for Sanskrit text + English translation + other languages (51 language dropdown)
- **BhashyaEntryFields**: Repeatable Teeka/commentary entries with nested TextAndTranslation (4 Teeka authors)
- **DataTable**: Generic data table with search, CRUD actions, status badges (Draft/Published), Publish button
- **useDrafts hook**: Shared hook for draft CRUD + publish workflow across all content pages

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
- `STRAPI_URL` - Strapi CMS URL (http://13.60.173.218:1337)
- `STRAPI_API_TOKEN` - Strapi API authentication token
