# Ekatmadham Library - Content Management Portal

## Overview
A data feeding website for the Ekatmadham Library that connects to a Strapi CMS backend. Users can log in, create, edit, and delete content that gets published to the Strapi CMS and displayed on the Ekatmadham Library website.

## Architecture
- **Frontend**: React + TypeScript with Vite, shadcn/ui components, TanStack Query, wouter routing
- **Backend**: Express.js server with session-based authentication (passport-local), Strapi API proxy
- **Database**: PostgreSQL (for user authentication only)
- **CMS**: Strapi CMS running on AWS EC2 (13.60.173.218:1337)

## Content Types (from Strapi)
- **Granthas**: Sacred texts (GranthaName, GranthaType, BhashyamName, BhashyamAuthor, BhashyakaraIntroduction)
- **Chapters**: Chapter management with hierarchical structure (ChapterTitle, order, parent/children, ShlokaManthraEntry, BhashyamForShlokaManthra, Teekas)
- **Articles**: Blog articles (title, description, slug, author, category)
- **Authors**: Author profiles (name, email, avatar)
- **Categories**: Content categories (name, slug, description)
- **Prasthana Thraya**: Special screen entries (GranthaName, GranthaType, BhashyamName, BhashyamAuthor, BhashyaEntryCollection)

## Key Components
- **TextAndTranslation**: Reusable component for Sanskrit text + English translation + other languages
- **BhashyaEntryFields**: Repeatable Teeka/commentary entries with nested TextAndTranslation
- **DataTable**: Generic data table with search, CRUD actions, loading/empty states

## File Structure
- `shared/schema.ts` - Database schema (users table) + Strapi TypeScript interfaces
- `server/auth.ts` - Passport.js authentication with session management
- `server/strapi.ts` - Strapi API proxy routes (all CRUD operations)
- `server/db.ts` - PostgreSQL database connection
- `client/src/pages/` - All page components (login, dashboard, granthas, chapters, articles, authors, categories, prasthana-thraya)
- `client/src/components/` - Reusable components (dashboard-layout, data-table, text-translation-fields, bhashya-entry-fields)

## Environment Variables
- `DATABASE_URL` - PostgreSQL connection string
- `SESSION_SECRET` - Express session secret
- `STRAPI_URL` - Strapi CMS URL (http://13.60.173.218:1337)
- `STRAPI_API_TOKEN` - Strapi API authentication token
