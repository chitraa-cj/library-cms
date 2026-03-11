import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp } from "drizzle-orm/pg-core";
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
] as const;

export interface StrapiBlock {
  type: string;
  children: { type: string; text: string }[];
}

export interface TextAndTranslation {
  SanskritTextEntry?: StrapiBlock[] | string;
  EnglishTranslationText?: StrapiBlock[] | string;
  OtherLanguagesTranslation?: StrapiBlock[] | string;
  LanguageOfTranslation?: (typeof translationLanguages)[number] | string;
}

export interface BhashyaEntry {
  TeekaName?: string;
  TeekaAuthor?: (typeof teekaAuthors)[number] | string;
  TeekaEntry?: TextAndTranslation;
}

export interface StrapiGrantha {
  id: number;
  documentId: string;
  GranthaName: string;
  GranthaType: (typeof granthaTypes)[number];
  BhashyamName?: string;
  BhashyamAuthor?: (typeof bhashyamAuthors)[number];
  IntroductionToTextEnglish?: StrapiBlock[];
  BhashyakaraIntroduction?: TextAndTranslation;
  chapters?: StrapiChapter[];
  createdAt?: string;
  updatedAt?: string;
}

export interface StrapiChapter {
  id: number;
  documentId: string;
  ChapterTitle: string;
  order: number;
  grantha?: StrapiGrantha;
  parent?: StrapiChapter;
  children?: StrapiChapter[];
  ShlokaManthraEntry?: TextAndTranslation;
  BhashyamForShlokaManthra?: TextAndTranslation;
  Teekas?: BhashyaEntry[];
  createdAt?: string;
  updatedAt?: string;
}

export interface StrapiArticle {
  id: number;
  documentId: string;
  title: string;
  description?: string;
  slug?: string;
  cover?: any;
  author?: StrapiAuthor;
  category?: StrapiCategory;
  blocks?: any[];
  createdAt?: string;
  updatedAt?: string;
}

export interface StrapiAuthor {
  id: number;
  documentId: string;
  name: string;
  avatar?: any;
  email?: string;
  articles?: StrapiArticle[];
  createdAt?: string;
  updatedAt?: string;
}

export interface StrapiCategory {
  id: number;
  documentId: string;
  name: string;
  slug?: string;
  description?: string;
  articles?: StrapiArticle[];
  createdAt?: string;
  updatedAt?: string;
}

export interface StrapiPrasthanaScreen {
  id: number;
  documentId: string;
  GranthaName?: string;
  GranthaType?: (typeof prasthanaGranthaTypes)[number];
  BhashyamName?: string;
  BhashyamAuthor?: (typeof prasthanaBhashyamAuthors)[number];
  EnglishIntroductionToText?: string;
  BhashyakaraIntroduction?: TextAndTranslation;
  BhashyaEntryCollection?: BhashyaEntry[];
  createdAt?: string;
  updatedAt?: string;
}

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
  meta: {};
}
