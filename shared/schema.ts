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

/** Section types used for the sections[] relation on a Grantha. */
export const sectionTypes = ["Adhyaya", "Khanda", "Valli", "Brahmana"] as const;

export const translationLanguages = [
  "Tamil",
  "Kannada",
  "Telugu",
  "Mandarin",
  "Arabic",
  "French",
  "Spanish",
  "Hindi",
  "German",
  "Vietnamese",
  "Assamese",
  "Kashmiri",
  "Marathi",
  "Konkani",
  "Malayalam",
  "Punjabi",
  "Bengali",
  "Manipuri",
  "Nepali",
  "Urdu",
  "Azerbaijani",
  "Odia",
  "Sindhi",
  "Polish",
  "Dutch",
  "Swahili",
  "Swedish",
  "Greek",
  "Amharic",
  "Hebrew",
  "Portuguese",
  "Russian",
  "Indonesian",
  "Japanese",
  "Nigerian Pidgin",
  "Egyptian Arabic",
  "Hausa",
  "Turkish",
  "Korean",
  "Thai",
  "Italian",
  "Sinhalese",
  "Ukrainian",
  "Persian",
  "Kurdish",
  "Mongolian",
  "Tibetan",
  "Burmese",
  "Malay",
  "Gujarati",
  "Bhojpuri",
] as const;

export const teekaAuthors = [
  "Anandagiri",
  "Ramaraya Kavi",
  "Gopalananda",
  "Narayanasrami",
  "Madhusudana Saraswati",
] as const;

// ---------- Strapi block / rich-text primitives ----------

export interface StrapiBlock {
  type: string;
  children: { type: string; text: string }[];
}

/**
 * Reusable bilingual text component.
 * `SanskritTextEntry` and the translation fields are Strapi rich-text (StrapiBlock[]) or plain
 * strings depending on context.
 * `IASTTransliteration` is a plain string for IAST romanisation.
 */
export interface TextAndTranslation {
  id?: number;
  SanskritTextEntry?: StrapiBlock[] | string;
  EnglishTranslationText?: StrapiBlock[] | string;
  OtherLanguagesTranslation?: StrapiBlock[] | string;
  LanguageOfTranslation?: (typeof translationLanguages)[number] | string;
  IASTTransliteration?: string | null;
}

/** Component: a single teeka (commentary) entry on a shloka. */
export interface BhashyaEntry {
  id?: number;
  TeekaName?: string;
  TeekaAuthor?: (typeof teekaAuthors)[number] | string;
  TeekaEntry?: TextAndTranslation;
}

// ---------- Strapi entity types ----------

/**
 * Teeka — an independent commentary work linked to a Grantha.
 * Returned as items in the `teekas[]` relation on StrapiGrantha.
 */
export interface StrapiTeeka {
  id: number;
  documentId: string;
  TeekaName: string;
  TeekaAuthor?: string;
  grantha?: Pick<StrapiGrantha, "id" | "documentId" | "GranthaName"> | null;
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Section — a chapter-level record linked to a Grantha via the `sections[]` relation.
 * Type can be "Adhyaya", "Khanda", "Valli", "Brahmana", or null for leaf/shloka sections.
 */
export interface SectionTitleTranslation {
  id?: number;
  TranslationText?: string;
  LanguageOfTranslation?: string;
  isAiTranslated?: boolean | null;
}

export interface StrapiSection {
  id: number;
  documentId: string;
  title: string;
  type?: (typeof sectionTypes)[number] | string | null;
  order?: number | null;
  grantha?: Pick<StrapiGrantha, "id" | "documentId" | "GranthaName"> | null;
  parent?: Pick<StrapiSection, "id" | "documentId" | "title"> | null;
  sub_sections?: Pick<StrapiSection, "id" | "documentId" | "title">[];
  manthras?: Pick<StrapiManthra, "id" | "documentId" | "title" | "order">[];
  titleTranslations?: SectionTitleTranslation[];
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Manthra — an individual verse/mantra entry linked to a Section (and optionally a Grantha).
 */
export interface StrapiManthra {
  id: number;
  documentId: string;
  title?: string | null;
  order?: number | null;
  section?: Pick<StrapiSection, "id" | "documentId" | "title"> | null;
  ShlokaManthraEntry?: TextAndTranslation | null;
  BhashyamForShlokaManthra?: TextAndTranslation | null;
  Teekas?: BhashyaEntry[];
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

// ---------- Main Strapi content-type interfaces ----------

/**
 * Grantha — the top-level sacred text record.
 * Reflects the Strapi "granthas" content type with `populate=*`.
 */
export interface StrapiGrantha {
  id: number;
  documentId: string;
  GranthaName: string;
  GranthaType: (typeof granthaTypes)[number] | string;
  BhashyamName?: string | null;
  BhashyamAuthor?: (typeof bhashyamAuthors)[number] | string | null;

  /** English introduction to the text (Strapi rich-text / blocks). */
  IntroductionToTextEnglish?: StrapiBlock[] | null;

  /** Bilingual introduction authored by the bhashyakara (commentator). */
  BhashyakaraIntroduction?: TextAndTranslation | null;

  /** Total number of teeka (commentary) works linked to this Grantha. */
  NumberOfTeekas?: number | null;

  /** URL-friendly slug. */
  slug?: string | null;

  /** Display order within a listing. */
  order?: number | null;

  /** YouTube / external video ID for the intro video. */
  introVideoId?: string | null;

  /** Title of the intro video. */
  introVideoTitle?: string | null;

  /** Multilingual translations of the Grantha name. */
  GranthaNameTranslations?: any[];

  /** Cover image media object. */
  coverImage?: {
    id?: number;
    documentId?: string;
    url?: string;
    alternativeText?: string | null;
    width?: number;
    height?: number;
  } | null;

  /**
   * Chapter sections linked to this Grantha.
   * Each section has a type (Adhyaya / Khanda) and optional ordering.
   */
  sections?: StrapiSection[];

  /**
   * Teeka (commentary) entities linked to this Grantha.
   * These are independent Strapi records with their own documentId.
   */
  teekas?: StrapiTeeka[];

  /** Populated chapter records (from the separate chapters content type). */
  chapters?: StrapiChapter[];

  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Chapter — a node in the Adhyaya → Khanda → Shloka/Manthra hierarchy.
 * Matches the Strapi "chapters" content type with `populate=*`.
 * Depth is inferred from the presence/absence of a `parent`:
 *   depth 0 = Adhyaya, depth 1 = Khanda, depth 2 = Shloka / Manthra.
 */
export interface StrapiChapter {
  id: number;
  documentId: string;
  ChapterTitle: string;
  order: number;

  /** Parent Grantha this chapter belongs to. */
  grantha?: Pick<StrapiGrantha, "id" | "documentId" | "GranthaName">;

  /** Parent chapter (null for Adhyaya; Adhyaya for Khanda; Khanda for Shloka). */
  parent?: Pick<StrapiChapter, "id" | "documentId" | "ChapterTitle">;

  /** Direct child chapters. */
  children?: StrapiChapter[];

  /** Shloka / Manthra text with translation (leaf level only). */
  ShlokaManthraEntry?: TextAndTranslation;

  /** Bhashyam commentary on the shloka (leaf level only). */
  BhashyamForShlokaManthra?: TextAndTranslation;

  /** Per-teeka commentary entries (leaf level only). */
  Teekas?: BhashyaEntry[];

  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Article — blog / library article.
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
  author?: StrapiAuthor;
  category?: StrapiCategory;
  /** Rich-text content blocks. */
  blocks?: any[];
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Author — writer of articles.
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
 * Category — taxonomy for articles.
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
 * Prasthana Thraya Screen — display screen for one of the three Prasthana Traya texts.
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
