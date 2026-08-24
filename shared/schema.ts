import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, serial, jsonb, integer, boolean, primaryKey } from "drizzle-orm/pg-core";
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

export const publishJobs = pgTable("cms_publish_jobs", {
  id: varchar("id").primaryKey(),
  draftId: integer("draft_id").notNull().references(() => contentDrafts.id, { onDelete: "cascade" }),
  userId: varchar("user_id").references(() => users.id),
  // Strapi documentId of the grantha being published. Set when the job starts; used
  // to reject concurrent publishes from other drafts targeting the same grantha
  // (forked drafts) without relying on in-process state that disappears on restart.
  granthaDocId: text("grantha_doc_id"),
  status: text("status").notNull().default("queued"), // queued|running|done|failed|cancelled|failed_recoverable
  progressDone: integer("progress_done").notNull().default(0),
  progressTotal: integer("progress_total").notNull().default(0),
  progressCurrent: text("progress_current").notNull().default("Starting…"),
  result: jsonb("result"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const idempotencyKeys = pgTable("cms_idempotency_keys", {
  key: text("key").primaryKey(),
  route: text("route").notNull(),
  requestHash: text("request_hash").notNull(),
  responseStatus: integer("response_status").notNull(),
  responseBody: jsonb("response_body"),
  userId: varchar("user_id").references(() => users.id),
  draftId: integer("draft_id").references(() => contentDrafts.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});

export const publishJobTasks = pgTable("cms_publish_job_tasks", {
  id: serial("id").primaryKey(),
  jobId: varchar("job_id").notNull().references(() => publishJobs.id, { onDelete: "cascade" }),
  draftId: integer("draft_id").notNull().references(() => contentDrafts.id, { onDelete: "cascade" }),
  taskType: text("task_type").notNull().default("publish_manthra"),
  status: text("status").notNull().default("queued"), // queued|running|done|failed
  attemptCount: integer("attempt_count").notNull().default(0),
  payload: jsonb("payload").notNull(),
  result: jsonb("result"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Per-job checkpoint of portal-manthra-id → Strapi-documentId so that a retry
// after process crash can reuse the docIds already created in Strapi instead of
// re-running expensive label-based dedup (and risking duplicate rows).
export const publishManthraResolutions = pgTable(
  "cms_publish_manthra_resolutions",
  {
    jobId: varchar("job_id").notNull().references(() => publishJobs.id, { onDelete: "cascade" }),
    portalManthraId: text("portal_manthra_id").notNull(),
    strapiDocumentId: text("strapi_document_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.jobId, t.portalManthraId] }),
  }),
);

export type PublishJobRecord = typeof publishJobs.$inferSelect;
export type InsertPublishJobRecord = typeof publishJobs.$inferInsert;
export type IdempotencyKeyRecord = typeof idempotencyKeys.$inferSelect;
export type PublishJobTaskRecord = typeof publishJobTasks.$inferSelect;
export type PublishManthraResolutionRecord = typeof publishManthraResolutions.$inferSelect;

export const granthaBackups = pgTable("grantha_backups", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  granthaCount: integer("grantha_count").notNull().default(0),
  sectionCount: integer("section_count").notNull().default(0),
  manthraCount: integer("manthra_count").notNull().default(0),
  data: jsonb("data").notNull(),
});

export type GranthaBackup = typeof granthaBackups.$inferSelect;
export type GranthaBackupMeta = Omit<GranthaBackup, "data">;

export const granthaLocks = pgTable("grantha_locks", {
  id: serial("id").primaryKey(),
  granthaDocId: text("grantha_doc_id").notNull().unique(),
  granthaName: text("grantha_name"),
  lockedByUserId: varchar("locked_by_user_id").references(() => users.id),
  lockedByUsername: text("locked_by_username"),
  lockedAt: timestamp("locked_at").defaultNow().notNull(),
  reason: text("reason"),
});

export type GranthaLock = typeof granthaLocks.$inferSelect;

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
  "Mādhavācārya",
  "Sringeri Madhavacharya",
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
  "brahmana",
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
  brahmana: "Brahmana",
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

/** Languages stored in `OtherTranslations` (excludes Sanskrit + English — separate fields). */
export const otherTranslationLanguages = translationLanguages.filter(
  (lang) => lang !== "Sanskrit" && lang !== "English",
) as readonly Exclude<
  (typeof translationLanguages)[number],
  "Sanskrit" | "English"
>[];

export const teekaAuthors = [
  "Anandagiri",
  "Ananda Gana",
  "Bharathi Theertha",
  "Raagavendra",
  "Sadanandha",
  "Srimad Devagnya Pandiya",
  "Shreedharaswami",
  "Upanishad Brahmendra",
  "Keshava Bhattacharya",
  "Vachaspati Mishra",
  "Padmapada",
  "Sureshvaracharya",
  "Prakasatman",
  "Govindananda",
  "Ramananda Saraswati",
  "Madhusudana Saraswati",
  "Dhanapati Suri",
  "Amalananda",
  "Appayya Dikshita",
  "Shankarananda",
  "Shriharsha",
  "Chitsukha",
  "Vidyaranya",
  "Hanuman",
  "Venkatanatha",
] as const;

/** Default top-level division labels (grantha structure wizard). */
export const defaultStructureLevelOneNames = [
  "Kanda",
  "Skandha",
  "Adhyaya",
  "Valli",
  "Prapathaka",
  "Mundaka",
  "Prashna",
] as const;

/** Default sub-section labels (grantha structure wizard). */
export const defaultStructureLevelTwoNames = [
  "Valli",
  "Anuvaka",
  "Khanda",
  "Brahmana",
  "Adhyaya",
  "Adhikarana",
  "Varnaka",
  "Pada",
] as const;

/** Default sub-sub-section labels (grantha structure wizard). */
export const defaultStructureLevelThreeNames = [
  "Pada",
  "Varga",
  "Anuvaka",
  "Khanda",
  "Section",
  "Part",
  "Sukta",
  "Adhikaranam",
] as const;

/** Default leaf entry labels (Mantra, Shloka, etc.). */
export const defaultStructureLeafNames = [
  "Mantra",
  "Manthra",
  "Shloka",
  "Sutra",
  "Anuvaka",
  "Pada",
  "Tirtha",
  "Utsava",
  "Vivarana",
] as const;

export const portalVocabularyKeys = [
  "teekaAuthors",
  "bhashyamAuthors",
  "structureLevelOneNames",
  "structureLevelTwoNames",
  "structureLevelThreeNames",
  "structureLeafNames",
] as const;

export type PortalVocabularyKey = (typeof portalVocabularyKeys)[number];

export type PortalVocabulary = Record<PortalVocabularyKey, string[]>;

export type PortalVocabularyCustom = Partial<Record<PortalVocabularyKey, string[]>>;

export const cmsPortalVocabulary = pgTable("cms_portal_vocabulary", {
  id: integer("id").primaryKey().default(1),
  custom: jsonb("custom").$type<PortalVocabularyCustom>().notNull().default({}),
  updatedAt: timestamp("updated_at").defaultNow(),
  updatedBy: varchar("updated_by").references(() => users.id),
});

export type CmsPortalVocabularyRow = typeof cmsPortalVocabulary.$inferSelect;

// ---------- Acharyas (guru-parampara) ----------
// Portal-only entity, stored entirely in local Postgres (no Strapi change).
// Biographies + works are seeded from advaitadhara.sanatana.in and can be
// edited in the portal. "Texts under an acharya" are NOT stored here — they are
// derived at read time by matching `aliases` against a Grantha's BhashyamAuthor
// and a Teeka's TeekaAuthor in Strapi.

/** One heading + its paragraphs within a biography (Sanskrit prose). */
export type AcharyaBioSection = {
  heading: string | null;
  paragraphs: string[];
};

/** A single work (कृतिः) attributed to the acharya. */
export type AcharyaWork = {
  title: string;
  type?: string | null;
  source?: string | null;
  remarks?: string | null;
};

/** How a biography was populated: from the source, hand-written, or absent. */
export const acharyaBioStatuses = ["sourced", "custom", "empty"] as const;
export type AcharyaBioStatus = (typeof acharyaBioStatuses)[number];

export const acharyaProfiles = pgTable("acharya_profiles", {
  id: serial("id").primaryKey(),
  /** Stable URL key, e.g. "acharya-0026" or "n-govindabhagavatpadah". */
  slug: varchar("slug").notNull().unique(),
  /** Source profile ref, e.g. "profile/acharya/0026" (null if none). */
  sourceRef: varchar("source_ref"),
  sourceUrl: text("source_url"),
  nameDevanagari: text("name_devanagari").notNull(),
  nameIast: text("name_iast"),
  /** Editable display name (defaults to IAST). */
  nameDisplay: text("name_display"),
  /** Name variants used to link Granthas/Teekas (BhashyamAuthor/TeekaAuthor). */
  aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
  /** Life dates as shown on the source, e.g. "788-820 A. D." */
  dates: text("dates"),
  /** Position in the guru-parampara ordering. */
  lineageOrder: integer("lineage_order").notNull().default(0),
  /** Devanagari name of the guru (parent in the lineage tree), if known. */
  guruDevanagari: text("guru_devanagari"),
  /** "acharya" | "granthakara" | null (from the source classification). */
  category: text("category"),
  biography: jsonb("biography").$type<AcharyaBioSection[]>().notNull().default([]),
  worksList: jsonb("works_list").$type<AcharyaWork[]>().notNull().default([]),
  avatarUrl: text("avatar_url"),
  bioStatus: text("bio_status").$type<AcharyaBioStatus>().notNull().default("empty"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  updatedBy: varchar("updated_by").references(() => users.id),
});

export type AcharyaProfile = typeof acharyaProfiles.$inferSelect;
export type InsertAcharyaProfile = typeof acharyaProfiles.$inferInsert;

/** Fields a portal editor may update on an acharya. */
export const updateAcharyaSchema = z.object({
  nameDisplay: z.string().trim().min(1).optional(),
  dates: z.string().trim().nullable().optional(),
  avatarUrl: z.string().trim().nullable().optional(),
  aliases: z.array(z.string().trim().min(1)).optional(),
  biography: z
    .array(
      z.object({
        heading: z.string().nullable(),
        paragraphs: z.array(z.string()),
      }),
    )
    .optional(),
});
export type UpdateAcharya = z.infer<typeof updateAcharyaSchema>;

/** An acharya plus the texts derived as "under" them from Strapi. */
export type AcharyaLinkedText = {
  documentId: string;
  name: string;
  kind: "grantha" | "teeka";
  granthaType?: string | null;
  slug?: string | null;
  coverImageUrl?: string | null;
};

export type AcharyaWithTexts = AcharyaProfile & {
  granthas: AcharyaLinkedText[];
  teekas: AcharyaLinkedText[];
};

// ---------- Strapi block / rich-text primitives ----------

/**
 * A leaf text node inside a Strapi block. Marks use Strapi's names
 * (`strikethrough`, not `strike`).
 */
export interface StrapiTextNode {
  type: "text";
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
}

/**
 * A single node in Strapi's block (rich-text) editor format.
 *
 * Most blocks (`paragraph`, `heading`, `quote`, `code`, `list-item`) hold text
 * nodes directly. A `list` block instead holds `list-item` blocks as children,
 * so `children` is a union of text nodes and nested blocks. `level` applies to
 * headings; `format` ("ordered" | "unordered") applies to lists.
 */
export interface StrapiBlock {
  type: string;
  level?: number;
  format?: "ordered" | "unordered";
  children: (StrapiTextNode | StrapiBlock)[];
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
 * Fields: TeekaName (string), TeekaAuthor (string — was an enum; now free-form, guarded by the shared vocabulary allowlist), grantha (manyToOne → Grantha).
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
 *   BhashyamAuthor (string — was an enum; now free-form, guarded by the shared vocabulary allowlist)
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
 *   blocks (dynamiczone — dateline + lead + body assembled on publish from portal draft)
 *
 * Portal draft also stores (not sent as top-level Strapi fields):
 *   eventDate, eventTime, place, lead, body
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
  /** Strapi `shared.seo` component when enabled on Article content-type */
  seo?: SeoComponent | null;
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
