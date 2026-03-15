import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, serial, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  displayName: text("display_name"),
  role: text("role").default("editor"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
  displayName: true,
});

export const loginSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type LoginData = z.infer<typeof loginSchema>;

export const contentDrafts = pgTable("content_drafts", {
  id: serial("id").primaryKey(),
  contentType: text("content_type").notNull(),
  strapiDocumentId: text("strapi_document_id"),
  title: text("title").notNull(),
  data: jsonb("data").notNull(),
  status: text("status").notNull().default("draft"),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertDraftSchema = createInsertSchema(contentDrafts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDraft = z.infer<typeof insertDraftSchema>;
export type Draft = typeof contentDrafts.$inferSelect;

// ---------- Controlled vocabularies ----------
// Values match the Strapi schema enumerations exactly.

export const granthaTypes = [
  "Upanishad",
  "Bhagavad Gita",
  "Brahma Sutra",
  "Prakarana Grantha",
  "Bhakthi Grantha",
] as const;

export const bhashyamAuthors = [
  "Sri Shankarayacharya",
  "Upanishad Brahmendra",
] as const;

export const prasthanaGranthaTypes = [
  "Upanishad",
  "Bhagavad Gita",
  "Brahma Sutra",
  "Prakarana Grantha",
  "Other Text",
] as const;

export const prasthanaBhashyamAuthors = [
  "Sri Shankaracharya",
  "Sri Upanishad Brahmendra",
] as const;

/**
 * Section type enum — matches Strapi's api::section.section `type` field.
 * Each value is the exact Strapi enumeration key.
 */
export const sectionTypes = [
  "adhyay",
  "khanda",
  "valli",
  "pada",
  "kanda",
  "sukta",
  "varga",
  "anuvaka",
  "prakarana",
  "chapter",
  "part",
  "section",
  "book",
] as const;

/** Human-readable display labels for each sectionType value. */
export const sectionTypeLabels: Record<(typeof sectionTypes)[number], string> = {
  adhyay: "Adhyaya",
  khanda: "Khanda",
  valli: "Valli",
  pada: "Pada",
  kanda: "Kanda",
  sukta: "Sukta",
  varga: "Varga",
  anuvaka: "Anuvaka",
  prakarana: "Prakarana",
  chapter: "Chapter",
  part: "Part",
  section: "Section",
  book: "Book",
};

/**
 * Language list matching the Strapi `shared.translations` component enum exactly.
 * Used for LanguageOfTranslation dropdowns throughout the app.
 */
export const translationLanguages = [
  "Sanskrit",
  "Hindi",
  "English",
  "Kannada",
  "Telugu",
  "Tamil",
  "Malayalam",
  "Gujarati",
  "Bengali",
  "Marathi",
  "Odia",
  "Punjabi",
  "Assamese",
  "Konkani",
  "Sinhala",
  "German",
  "French",
  "Spanish",
  "Portuguese",
  "Italian",
  "Dutch",
  "Russian",
  "Ukrainian",
  "Greek",
  "Polish",
  "Czech",
  "Romanian",
  "Hungarian",
  "Turkish",
  "Persian",
  "Arabic",
  "Hebrew",
  "Japanese",
  "Korean",
  "Thai",
  "Vietnamese",
  "Indonesian",
  "Malay",
  "Burmese",
  "Tibetan",
  "Mongolian",
  "Amharic",
  "Swahili",
  "Mandarin",
  "Egyptian_Arabic",
] as const;

export const teekaAuthors = [
  "Anandagiri",
  "Ramaraya Kavi",
  "Gopalananda",
  "Narayanasrami",
  "Madhusudana Saraswati",
] as const;

// ---------- Strapi block / rich-text primitives ----------

/** A single node in Strapi's block (rich-text) editor format. */
export interface StrapiBlock {
  type: string;
  children: { type: string; text: string }[];
}

// ---------- Shared component interfaces ----------

/**
 * `shared.translations` component — repeatable.
 * Used for GranthaNameTranslations, titleTranslations, OtherTranslations, etc.
 * `TranslationText` is Strapi blocks (rich text).
 */
export interface StrapiTranslation {
  id?: number;
  TranslationText?: StrapiBlock[] | null;
  LanguageOfTranslation?: (typeof translationLanguages)[number] | string | null;
  isAiTranslated?: boolean | null;
}

/**
 * `shared.text-and-translation` component — non-repeatable.
 * Used for BhashyakaraIntroduction, ShlokaManthraEntry, BhashyamEntry, TeekaEntry.
 * `IASTTransliteration` is Strapi blocks (rich text).
 * `OtherTranslations` is a repeatable `shared.translations` component.
 */
export interface TextAndTranslation {
  id?: number;
  SanskritTextEntry?: StrapiBlock[] | string | null;
  IASTTransliteration?: StrapiBlock[] | string | null;
  EnglishTranslationText?: StrapiBlock[] | string | null;
  OtherTranslations?: StrapiTranslation[];
  /** @deprecated Use OtherTranslations[] instead. Kept for legacy form state compatibility. */
  OtherLanguagesTranslation?: StrapiBlock[] | string | null;
}

/**
 * `default.bhashya-entries` component — repeatable.
 * Used for Teekas[] on Manthra records.
 * `teeka` is a relation to a Teeka record (provides TeekaName/TeekaAuthor lookup).
 * `TeekaEntry` is the actual commentary text.
 */
export interface BhashyaEntry {
  id?: number;
  teeka?: Pick<StrapiTeeka, "id" | "documentId" | "TeekaName" | "TeekaAuthor"> | null;
  TeekaEntry?: TextAndTranslation;
  /** @deprecated Direct TeekaName/TeekaAuthor fields — use teeka relation instead. */
  TeekaName?: string;
  /** @deprecated Direct TeekaAuthor fields — use teeka relation instead. */
  TeekaAuthor?: (typeof teekaAuthors)[number] | string;
}

/**
 * `shared.word-meaning` component — repeatable.
 * Used for wordMeanings[] on Manthra records.
 */
export interface WordMeaning {
  id?: number;
  word?: string | null;
  meaning?: string | null;
  position?: number | null;
}

/**
 * `shared.seo` component — non-repeatable.
 * Used on the Global single type.
 */
export interface SeoComponent {
  id?: number;
  metaTitle: string;
  metaDescription: string;
  shareImage?: {
    id?: number;
    documentId?: string;
    url?: string;
    alternativeText?: string | null;
  } | null;
}

// ---------- Strapi entity types ----------

/**
 * Teeka — an independent commentary work (api::teeka.teeka).
 * Fields: TeekaName (string), TeekaAuthor (enum), grantha (manyToOne → Grantha).
 */
export interface StrapiTeeka {
  id: number;
  documentId: string;
  TeekaName: string;
  TeekaAuthor?: (typeof teekaAuthors)[number] | string | null;
  grantha?: Pick<StrapiGrantha, "id" | "documentId" | "GranthaName"> | null;
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Section title translation — `shared.translations` component used on Section.
 * `TranslationText` is Strapi blocks (rich text).
 */
export interface SectionTitleTranslation {
  id?: number;
  TranslationText?: StrapiBlock[] | null;
  LanguageOfTranslation?: (typeof translationLanguages)[number] | string | null;
  isAiTranslated?: boolean | null;
}

/**
 * Section — a structural division of a Grantha (api::section.section).
 * Fields:
 *   title (string, required)
 *   order (integer)
 *   type (enum: adhyay | khanda | valli | pada | kanda | sukta | varga | anuvaka | prakarana | chapter | part | section | book)
 *   titleTranslations (shared.translations[], repeatable)
 *   grantha (manyToOne → Grantha)
 *   parent (manyToOne → Section — self-reference for nested sections)
 *   sub_sections (oneToMany → Section)
 *   manthras (oneToMany → Manthra)
 */
export interface StrapiSection {
  id: number;
  documentId: string;
  title: string;
  type?: (typeof sectionTypes)[number] | string | null;
  order?: number | null;
  titleTranslations?: SectionTitleTranslation[];
  grantha?: Pick<StrapiGrantha, "id" | "documentId" | "GranthaName"> | null;
  parent?: Pick<StrapiSection, "id" | "documentId" | "title" | "type"> | null;
  sub_sections?: Pick<StrapiSection, "id" | "documentId" | "title" | "type">[];
  manthras?: Pick<StrapiManthra, "id" | "documentId" | "ShlokaManthraNumber" | "order">[];
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Manthra — an individual verse/mantra entry (api::manthra.manthra).
 * Fields:
 *   order (integer)
 *   ShlokaManthraNumber (string) — verse number label
 *   Section (manyToOne → Section, capital S in Strapi)
 *   ShlokaManthraEntry (shared.text-and-translation)
 *   BhashyamEntry (shared.text-and-translation) — commentary on the verse
 *   Teekas (default.bhashya-entries[], repeatable) — per-teeka commentaries
 *   wordMeanings (shared.word-meaning[], repeatable)
 *
 * Note: `BhashyamForShlokaManthra` is a legacy alias for `BhashyamEntry` used in some
 * frontend form states. The actual Strapi field name is `BhashyamEntry`.
 */
export interface StrapiManthra {
  id: number;
  documentId: string;
  ShlokaManthraNumber?: string | null;
  order?: number | null;
  Section?: Pick<StrapiSection, "id" | "documentId" | "title"> | null;
  /** @deprecated Legacy alias — Strapi field is BhashyamEntry */
  section?: Pick<StrapiSection, "id" | "documentId" | "title"> | null;
  ShlokaManthraEntry?: TextAndTranslation | null;
  BhashyamEntry?: TextAndTranslation | null;
  /** @deprecated Legacy alias used in form state — Strapi field is BhashyamEntry */
  BhashyamForShlokaManthra?: TextAndTranslation | null;
  Teekas?: BhashyaEntry[];
  wordMeanings?: WordMeaning[];
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

// ---------- Main Strapi content-type interfaces ----------

/**
 * Grantha — the top-level sacred text record (api::grantha.grantha).
 * Fields:
 *   GranthaName (string, required)
 *   slug (uid, auto-generated from GranthaName)
 *   GranthaNameTranslations (shared.translations[], repeatable)
 *   coverImage (media — images only)
 *   order (integer)
 *   GranthaType (enum: Upanishad | Bhagavad Gita | Brahma Sutra | Prakarana Grantha | Bhakthi Grantha)
 *   BhashyamName (string)
 *   BhashyamAuthor (enum: Sri Shankarayacharya | Upanishad Brahmendra)
 *   IntroductionToTextEnglish (blocks — rich text)
 *   BhashyakaraIntroduction (shared.text-and-translation)
 *   introVideoId (string)
 *   introVideoTitle (string)
 *   NumberOfTeekas (integer, required)
 *   sections (oneToMany → Section)
 *   teekas (oneToMany → Teeka)
 */
export interface StrapiGrantha {
  id: number;
  documentId: string;
  GranthaName: string;
  GranthaType: (typeof granthaTypes)[number] | string;
  BhashyamName?: string | null;
  BhashyamAuthor?: (typeof bhashyamAuthors)[number] | string | null;
  IntroductionToTextEnglish?: StrapiBlock[] | null;
  BhashyakaraIntroduction?: TextAndTranslation | null;
  NumberOfTeekas?: number | null;
  slug?: string | null;
  order?: number | null;
  introVideoId?: string | null;
  introVideoTitle?: string | null;
  GranthaNameTranslations?: StrapiTranslation[];
  coverImage?: {
    id?: number;
    documentId?: string;
    url?: string;
    alternativeText?: string | null;
    width?: number;
    height?: number;
  } | null;
  sections?: StrapiSection[];
  teekas?: StrapiTeeka[];
  chapters?: StrapiChapter[];
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Chapter — a node in a hierarchical chapter tree (used via /api/chapters).
 * Maps to an alternate content type for nested chapter navigation.
 * Depth inferred from presence/absence of `parent`:
 *   depth 0 = Adhyaya, depth 1 = Khanda, depth 2 = Shloka / Manthra.
 */
export interface StrapiChapter {
  id: number;
  documentId: string;
  ChapterTitle: string;
  order: number;
  grantha?: Pick<StrapiGrantha, "id" | "documentId" | "GranthaName">;
  parent?: Pick<StrapiChapter, "id" | "documentId" | "ChapterTitle">;
  children?: StrapiChapter[];
  ShlokaManthraEntry?: TextAndTranslation;
  BhashyamForShlokaManthra?: TextAndTranslation;
  Teekas?: BhashyaEntry[];
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Article — blog / library article (api::article.article).
 * Fields:
 *   title (string)
 *   description (text)
 *   slug (uid, auto-generated from title)
 *   cover (media — images)
 *   author (manyToOne → Author)
 *   category (manyToOne → Category)
 *   blocks (dynamiczone)
 */
export interface StrapiArticle {
  id: number;
  documentId: string;
  title: string;
  description?: string | null;
  slug?: string | null;
  cover?: {
    id?: number;
    documentId?: string;
    url?: string;
    alternativeText?: string | null;
    width?: number;
    height?: number;
  } | null;
  author?: StrapiAuthor | null;
  category?: StrapiCategory | null;
  blocks?: any[];
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Author — writer of articles (api::author.author).
 * Fields:
 *   name (string)
 *   avatar (media)
 *   email (string)
 *   articles (oneToMany → Article)
 */
export interface StrapiAuthor {
  id: number;
  documentId: string;
  name: string;
  avatar?: {
    id?: number;
    documentId?: string;
    url?: string;
    alternativeText?: string | null;
  } | null;
  email?: string | null;
  articles?: StrapiArticle[];
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Category — taxonomy for articles (api::category.category).
 * Fields:
 *   name (string)
 *   slug (uid, auto-generated from name)
 *   description (text)
 *   articles (oneToMany → Article)
 */
export interface StrapiCategory {
  id: number;
  documentId: string;
  name: string;
  slug?: string | null;
  description?: string | null;
  articles?: StrapiArticle[];
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * About — single type (api::about.about).
 * Fields:
 *   title (string)
 *   blocks (dynamiczone)
 */
export interface StrapiAbout {
  id: number;
  documentId: string;
  title?: string | null;
  blocks?: any[];
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Global — single type for site-wide settings (api::global.global).
 * Fields:
 *   siteName (string)
 *   favicon (media)
 *   siteDescription (text)
 *   defaultSeo (shared.seo component)
 */
export interface StrapiGlobal {
  id: number;
  documentId: string;
  siteName?: string | null;
  siteDescription?: string | null;
  favicon?: {
    id?: number;
    documentId?: string;
    url?: string;
    alternativeText?: string | null;
  } | null;
  defaultSeo?: SeoComponent | null;
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Prasthana Thraya Screen — display screen for one of the three Prasthana Traya texts.
 * (Local concept — not a routed Strapi content type.)
 */
export interface StrapiPrasthanaScreen {
  id: number;
  documentId: string;
  GranthaName?: string | null;
  GranthaType?: (typeof prasthanaGranthaTypes)[number] | string | null;
  BhashyamName?: string | null;
  BhashyamAuthor?: (typeof prasthanaBhashyamAuthors)[number] | string | null;
  EnglishIntroductionToText?: string | null;
  BhashyakaraIntroduction?: TextAndTranslation | null;
  BhashyaEntryCollection?: BhashyaEntry[];
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

// ---------- API response wrappers ----------

export interface StrapiResponse<T> {
  data: T[];
  meta: {
    pagination: {
      page: number;
      pageSize: number;
      pageCount: number;
      total: number;
    };
  };
}

export interface StrapiSingleResponse<T> {
  data: T;
  meta: Record<string, unknown>;
}
