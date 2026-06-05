import type { Express } from "express";
import { type Server } from "http";
import { setupAuth, requireAuth, requireAdmin, hashPassword } from "./auth";
import { createStrapiRouter, strapiRequest, strapiRequestLarge, withSectionLock } from "./strapi";
import { createMigrateRouter } from "./migrate-vivekachudamani";
import { activityLogger } from "./activity-log";
import { readLatestDraftSnapshot, writeDraftSnapshot } from "./data-safety";
import { storage } from "./storage";
import {
  addPortalVocabularyEntry,
  getPortalVocabulary,
  getPortalVocabularyDefaults,
  getTeekaAuthorsAllowlist,
  removePortalVocabularyEntry,
  resolveAllowedTeekaAuthor,
  resolveAllowedBhashyamAuthor,
} from "./cms-vocabulary";
import { portalVocabularyKeys, type PortalVocabularyKey } from "@shared/schema";
import Database from "better-sqlite3";
import type { User } from "@shared/schema";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  hermexEnabled,
  hermexPythonBin,
  hermexTranslateScriptPath,
  runHermexTranslate,
} from "./hermex-translate";
import { otherTranslationLanguages } from "@shared/schema";
import {
  portalIndexToStrapiSortKey,
  sortKeyBetween,
  STRAPI_SORT_GAP,
} from "@shared/mantra-sort-key";
import {
  formatIntegrityFailures,
  isPublishIntegrityEnabled,
  normalizeHierarchyMantraLeafTitles,
  plainTextFromManthraEntry,
  portalMantraTitleForConfiguredLeaf,
  canonicalMantraTitle,
  isBareLeafCounterLabel,
  scanGranthaHierarchyMantras,
  hierarchyHasDuplicateMantraSuffixes,
  scanMantraForPublish,
  sectionSuffixCollision,
  mantraNumberSuffix,
  findDocIdByExactLabelInRows,
  pickDocIdForSuffixInSectionRows,
} from "@shared/grantha-publish-integrity";
import { readClientBuildId } from "./build-info";
import { applyHierarchyRepairInPlace } from "./grantha-hierarchy-repair";
import { syncPendingMantraSlotsFromDraft } from "./grantha-mantra-slot-sync";
import {
  deleteGranthaTreeFromStrapi,
  stripHierarchyStrapiLinksForFreshPublish,
} from "./grantha-fresh-republish";
import { buildArticleStrapiPayload, validateArticleDraft } from "@shared/article-editorial";
import {
  deleteOrphanMantrasForGrantha,
  listOrphanMantrasForGrantha,
} from "./grantha-orphan-manthras";
import { validateMantraLabelForCmsCreate } from "@shared/mantra-cms-guard";
import { buildGranthaPublishProgressPlan } from "@shared/grantha-publish-progress";
import { collectUnlinkedMantrasFromGranthaDraft } from "../client/src/lib/grantha-strapi-mantra-sync";

/** Compress a snapshot payload for DB storage (gzip + base64 wrapper). */
function compressBackupData(data: any): any {
  const jsonStr = JSON.stringify(data);
  const compressed = gzipSync(Buffer.from(jsonStr, "utf8"), { level: 6 });
  return { _compressed: true, data: compressed.toString("base64") };
}

/** Decompress a snapshot payload returned from DB — handles both old (raw) and new (compressed) formats. */
function decompressBackupData(raw: any): any {
  if (raw && raw._compressed === true && typeof raw.data === "string") {
    const buf = Buffer.from(raw.data, "base64");
    const decompressed = gunzipSync(buf);
    return JSON.parse(decompressed.toString("utf8"));
  }
  return raw; // legacy uncompressed backups
}

function normalizeSnapshotPayload(input: any): any {
  if (!input || typeof input !== "object") return null;

  // Compressed wrapper format: { _compressed: true, data: "<base64-gzip>" }
  if (input._compressed === true && typeof input.data === "string") {
    return decompressBackupData(input);
  }

  // Common export wrapper formats: { data: {...} } or nested wrappers.
  if (input.data && typeof input.data === "object") {
    const nested = normalizeSnapshotPayload(input.data);
    if (nested) return nested;
  }

  // Canonical snapshot payload shape.
  const hasCollections =
    Array.isArray(input.granthas) ||
    Array.isArray(input.sections) ||
    Array.isArray(input.manthras);
  if (hasCollections) {
    return {
      ...input,
      granthas: Array.isArray(input.granthas) ? input.granthas : [],
      sections: Array.isArray(input.sections) ? input.sections : [],
      manthras: Array.isArray(input.manthras) ? input.manthras : [],
    };
  }

  return null;
}

import {
  isPortalDraftDataKey,
  scrubLeakedPortalKeysFromStrapiPayload,
  stripPortalMetaFromGranthaPayload,
} from "@shared/portal-draft-meta";

const STRAPI_INTERNAL_KEYS = new Set(["id", "_id", "__component", "createdAt", "updatedAt", "publishedAt", "documentId", "locale"]);

// ─── Background publish job store ────────────────────────────────────────────
interface PublishJob {
  status: "running" | "done" | "failed" | "failed_recoverable";
  progress: {
    done: number;
    total: number;
    current: string;
    breakdown?: import("@shared/grantha-publish-progress").GranthaPublishProgressBreakdown;
    summary?: string;
  };
  result?: any;
  error?: string;
  startedAt: Date;
}
const publishJobs = new Map<string, PublishJob>();
const draftOperationQueues = new Map<number, Promise<void>>();

async function withDraftLock<T>(draftId: number, op: () => Promise<T>): Promise<T> {
  const previous = draftOperationQueues.get(draftId) ?? Promise.resolve();
  const running = previous.then(op, op);
  const settled = running.then(() => undefined, () => undefined);
  draftOperationQueues.set(draftId, settled);
  try {
    return await running;
  } finally {
    if (draftOperationQueues.get(draftId) === settled) {
      draftOperationQueues.delete(draftId);
    }
  }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isRetryablePublishError(error: any): boolean {
  const code = error?.code;
  const status = error?.status;
  if (code === "upstream_timeout" || code === "upstream_server") return true;
  if (typeof status === "number" && (status === 408 || status === 429 || status >= 500)) return true;
  return false;
}

async function withPublishRetries<T>(op: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await op();
    } catch (error) {
      lastError = error;
      if (!isRetryablePublishError(error) || attempt === maxAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
    }
  }
  throw lastError;
}

function requestHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input ?? null)).digest("hex");
}

async function loadOrReplayIdempotency(req: any, route: string) {
  const key = req.get?.("Idempotency-Key") || req.get?.("idempotency-key");
  if (!key || typeof key !== "string") return null;
  const hash = requestHash(req.body ?? {});
  const existing = await storage.getIdempotencyRecord(key);
  if (existing) {
    if (existing.route !== route || existing.requestHash !== hash) {
      const err: any = new Error("Idempotency key reused with different request payload");
      err.status = 409;
      throw err;
    }
    return { replay: true as const, status: existing.responseStatus, body: existing.responseBody };
  }
  return { replay: false as const, key, hash };
}

async function persistIdempotency(
  key: string,
  route: string,
  hash: string,
  userId: string | null,
  draftId: number | null,
  responseStatus: number,
  responseBody: unknown,
) {
  await storage.upsertIdempotencyRecord({
    key,
    route,
    requestHash: hash,
    responseStatus,
    responseBody: responseBody as any,
    userId: userId ?? null,
    draftId: draftId ?? null,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
}
function cleanOldPublishJobs() {
  const now = Date.now();
  // Completed/failed jobs: clean after 15 min (user has had time to read the result).
  // Still-running jobs: keep up to 60 min so a very large grantha can finish without
  // the job being deleted while the backend is still working. After 60 min a running
  // job is almost certainly a zombie (process crash with no .catch) and should be reaped.
  const doneCutoff    = now - 15 * 60 * 1000;
  const runningCutoff = now - 60 * 60 * 1000;
  for (const [id, job] of publishJobs) {
    const isComplete = job.status === "done" || job.status === "failed";
    const cutoff = isComplete ? doneCutoff : runningCutoff;
    if (job.startedAt.getTime() < cutoff) publishJobs.delete(id);
  }
}

// ─── SQLite export helpers ────────────────────────────────────────────────────

/** Extract plain text from a Strapi blocks (rich-text) field */
// Recurse into nested block children (a `list` holds `list-item` blocks, which
// hold the text) so structured rich text isn't read as empty. List items join
// with newlines; everything else concatenates inline text. Paragraph-only input
// matches the previous one-level behaviour.
function blockNodeText(node: any): string {
  if (typeof node?.text === "string") return node.text;
  if (!Array.isArray(node?.children)) return "";
  const sep = node?.type === "list" ? "\n" : "";
  return node.children.map(blockNodeText).join(sep);
}

function blocksToText(blocks: any): string {
  if (!blocks || !Array.isArray(blocks)) return "";
  return blocks.map(blockNodeText).join("\n").trim();
}

/** Build an in-memory SQLite database from a backup snapshot and return its buffer.
 *  Tables:
 *   granthas          — one row per grantha
 *   teekas            — one row per commentary
 *   sections          — one row per section (L1/L2/L3)
 *   manthras          — one row per verse (main Sanskrit + Bhashyam plain text)
 *   manthra_teekas    — verse × teeka junction (Sanskrit teeka text per verse)
 *   word_meanings     — word-by-word meanings
 *   translations      — ALL language translations (grantha names, manthra Sanskrit,
 *                       Bhashyam, teeka entries) — one row per language per field
 */
function buildSqliteFromBackup(data: any): Buffer {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = OFF");

  // ── Schema ──────────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE granthas (
      id INTEGER PRIMARY KEY,
      document_id TEXT UNIQUE,
      grantha_name TEXT,
      grantha_type TEXT,
      slug TEXT,
      order_num INTEGER,
      number_of_teekas INTEGER,
      bhashyam_name TEXT,
      bhashyam_author TEXT,
      bhashyakara_name TEXT,
      bhashyakara_intro_sanskrit TEXT,
      bhashyakara_intro_iast TEXT,
      bhashyakara_intro_english TEXT,
      intro_to_text_english TEXT,
      intro_video_id TEXT,
      intro_video_title TEXT,
      created_at TEXT,
      updated_at TEXT,
      published_at TEXT
    );

    CREATE TABLE teekas (
      id INTEGER PRIMARY KEY,
      document_id TEXT UNIQUE,
      grantha_document_id TEXT,
      teeka_name TEXT,
      teeka_author TEXT,
      created_at TEXT,
      updated_at TEXT,
      published_at TEXT
    );

    CREATE TABLE sections (
      id INTEGER PRIMARY KEY,
      document_id TEXT UNIQUE,
      grantha_document_id TEXT,
      parent_document_id TEXT,
      title TEXT,
      type TEXT,
      order_num INTEGER,
      created_at TEXT,
      updated_at TEXT,
      published_at TEXT
    );

    CREATE TABLE manthras (
      id INTEGER PRIMARY KEY,
      document_id TEXT UNIQUE,
      section_document_id TEXT,
      grantha_document_id TEXT,
      shloka_manthra_number TEXT,
      order_num INTEGER,
      sanskrit_text TEXT,
      sanskrit_iast TEXT,
      english_translation TEXT,
      bhashyam_text TEXT,
      bhashyam_iast TEXT,
      bhashyam_english_translation TEXT,
      created_at TEXT,
      updated_at TEXT,
      published_at TEXT
    );

    -- Verse × teeka junction: one row per (manthra, teeka) pair.
    -- Sanskrit + English teeka text stored here; other languages in translations table.
    CREATE TABLE manthra_teekas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manthra_document_id TEXT,
      teeka_document_id TEXT,
      teeka_name TEXT,
      teeka_entry_sanskrit TEXT,
      teeka_entry_iast TEXT,
      teeka_entry_english TEXT
    );

    CREATE TABLE word_meanings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manthra_document_id TEXT,
      word TEXT,
      meaning TEXT,
      meaning_language TEXT
    );

    -- Unified translations table — captures every language-specific text.
    -- entity_type values:
    --   'grantha_name'       entity_document_id = granthas.document_id
    --   'manthra_sanskrit'   entity_document_id = manthras.document_id
    --   'manthra_bhashyam'   entity_document_id = manthras.document_id
    --   'teeka_entry'        entity_document_id = manthra_teekas.id (as text)
    CREATE TABLE translations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT,
      entity_document_id TEXT,
      language TEXT,
      text TEXT
    );

    CREATE INDEX idx_sections_grantha ON sections(grantha_document_id);
    CREATE INDEX idx_manthras_section ON manthras(section_document_id);
    CREATE INDEX idx_manthras_grantha ON manthras(grantha_document_id);
    CREATE INDEX idx_teekas_grantha ON teekas(grantha_document_id);
    CREATE INDEX idx_mt_manthra ON manthra_teekas(manthra_document_id);
    CREATE INDEX idx_tr_entity ON translations(entity_type, entity_document_id);
    CREATE INDEX idx_tr_language ON translations(language);
  `);

  // ── Prepared statements ────────────────────────────────────────────────────
  const insGrantha = db.prepare(`
    INSERT OR REPLACE INTO granthas
      (id, document_id, grantha_name, grantha_type, slug, order_num, number_of_teekas,
       bhashyam_name, bhashyam_author, bhashyakara_name,
       bhashyakara_intro_sanskrit, bhashyakara_intro_iast, bhashyakara_intro_english,
       intro_to_text_english, intro_video_id, intro_video_title,
       created_at, updated_at, published_at)
    VALUES (@id, @document_id, @grantha_name, @grantha_type, @slug, @order_num, @number_of_teekas,
            @bhashyam_name, @bhashyam_author, @bhashyakara_name,
            @bhashyakara_intro_sanskrit, @bhashyakara_intro_iast, @bhashyakara_intro_english,
            @intro_to_text_english, @intro_video_id, @intro_video_title,
            @created_at, @updated_at, @published_at)
  `);

  const insTeeka = db.prepare(`
    INSERT OR REPLACE INTO teekas
      (id, document_id, grantha_document_id, teeka_name, teeka_author, created_at, updated_at, published_at)
    VALUES (@id, @document_id, @grantha_document_id, @teeka_name, @teeka_author,
            @created_at, @updated_at, @published_at)
  `);

  const insSection = db.prepare(`
    INSERT OR REPLACE INTO sections
      (id, document_id, grantha_document_id, parent_document_id, title, type, order_num, created_at, updated_at, published_at)
    VALUES (@id, @document_id, @grantha_document_id, @parent_document_id, @title, @type,
            @order_num, @created_at, @updated_at, @published_at)
  `);

  const insManthra = db.prepare(`
    INSERT OR REPLACE INTO manthras
      (id, document_id, section_document_id, grantha_document_id, shloka_manthra_number, order_num,
       sanskrit_text, sanskrit_iast, english_translation,
       bhashyam_text, bhashyam_iast, bhashyam_english_translation,
       created_at, updated_at, published_at)
    VALUES (@id, @document_id, @section_document_id, @grantha_document_id, @shloka_manthra_number, @order_num,
            @sanskrit_text, @sanskrit_iast, @english_translation,
            @bhashyam_text, @bhashyam_iast, @bhashyam_english_translation,
            @created_at, @updated_at, @published_at)
  `);

  const insTeekaManthra = db.prepare(`
    INSERT INTO manthra_teekas (manthra_document_id, teeka_document_id, teeka_name, teeka_entry_sanskrit, teeka_entry_iast, teeka_entry_english)
    VALUES (@manthra_document_id, @teeka_document_id, @teeka_name, @teeka_entry_sanskrit, @teeka_entry_iast, @teeka_entry_english)
  `);

  const insWord = db.prepare(`
    INSERT INTO word_meanings (manthra_document_id, word, meaning, meaning_language)
    VALUES (@manthra_document_id, @word, @meaning, @meaning_language)
  `);

  const insTr = db.prepare(`
    INSERT INTO translations (entity_type, entity_document_id, language, text)
    VALUES (@entity_type, @entity_document_id, @language, @text)
  `);

  // Helper: insert all OtherTranslations for a given entity
  function insertTranslations(entityType: string, entityDocId: string, otherTranslations: any[]) {
    for (const t of (otherTranslations ?? [])) {
      const lang = t.LanguageOfTranslation ?? t.language ?? "";
      const text = blocksToText(t.TranslationText) || "";
      if (lang && text) {
        insTr.run({ entity_type: entityType, entity_document_id: entityDocId, language: lang, text });
      }
    }
  }

  // ── Deduplicate source data by documentId before inserting ─────────────────
  // Backup data can contain the same manthra/section/grantha more than once if the
  // Strapi API returned overlapping pages during the snapshot (e.g. due to data
  // mutations mid-pagination).  Keep only the last occurrence per documentId so the
  // plain INSERT INTO translations / manthra_teekas statements can't produce
  // duplicate rows even if the manthras array has repeated documentIds.
  /** Snapshot rows are loosely typed Strapi shapes; avoid generic inference to `{ id, documentId }` only. */
  function dedupeByDocId(arr: any[]): any[] {
    const seen = new Map<string, any>();
    for (const item of arr ?? []) {
      const key = item.documentId ?? String(item.id ?? Math.random());
      seen.set(key, item);
    }
    return Array.from(seen.values());
  }
  const dedupedManthras = dedupeByDocId(data.manthras ?? []);
  const dedupedSections = dedupeByDocId(data.sections ?? []);
  const dedupedGranthas = dedupeByDocId(data.granthas ?? []);

  // ── Insert all data in a single transaction ────────────────────────────────
  const insertAll = db.transaction(() => {

    // 1. Granthas + their embedded teekas + grantha name translations
    for (const g of dedupedGranthas) {
      const gDocId = g.documentId ?? null;
      const bhIntr = g.BhashyakaraIntroduction;
      insGrantha.run({
        id: g.id ?? null,
        document_id: gDocId,
        grantha_name: g.GranthaName ?? null,
        grantha_type: g.GranthaType ?? null,
        slug: g.slug ?? null,
        order_num: g.order ?? null,
        number_of_teekas: g.NumberOfTeekas ?? null,
        bhashyam_name: g.BhashyamName ?? null,
        bhashyam_author: g.BhashyamAuthor ?? null,
        bhashyakara_name: g.BhashyakaraName ?? null,
        bhashyakara_intro_sanskrit: blocksToText(bhIntr?.SanskritTextEntry) || null,
        bhashyakara_intro_iast: blocksToText(bhIntr?.IASTTransliteration) || null,
        bhashyakara_intro_english: blocksToText(bhIntr?.EnglishTranslationText) || null,
        intro_to_text_english: blocksToText(g.IntroductionToTextEnglish) || null,
        intro_video_id: g.introVideoId ?? null,
        intro_video_title: g.introVideoTitle ?? null,
        created_at: g.createdAt ?? null,
        updated_at: g.updatedAt ?? null,
        published_at: g.publishedAt ?? null,
      });

      if (gDocId) {
        // Grantha name translations (Tamil, Kannada, etc.)
        for (const nt of (g.GranthaNameTranslations ?? [])) {
          const lang = nt.LanguageOfTranslation ?? nt.language ?? "";
          const text = blocksToText(nt.TranslationText) || (typeof nt.TranslationText === "string" ? nt.TranslationText : "") || "";
          if (lang && text) insTr.run({ entity_type: "grantha_name", entity_document_id: gDocId, language: lang, text });
        }
        // BhashyakaraIntroduction other language translations
        insertTranslations("bhashyakara_intro", gDocId, bhIntr?.OtherTranslations);
      }

      // Embedded teekas
      for (const t of (g.teekas ?? [])) {
        insTeeka.run({
          id: t.id ?? null,
          document_id: t.documentId ?? null,
          grantha_document_id: gDocId,
          teeka_name: t.TeekaName ?? null,
          teeka_author: t.TeekaAuthor ?? null,
          created_at: t.createdAt ?? null,
          updated_at: t.updatedAt ?? null,
          published_at: t.publishedAt ?? null,
        });
      }
    }

    // 2. Sections + title translations
    for (const s of dedupedSections) {
      const sDocId = s.documentId ?? null;
      insSection.run({
        id: s.id ?? null,
        document_id: sDocId,
        grantha_document_id: s.grantha?.documentId ?? null,
        parent_document_id: s.parent?.documentId ?? null,
        title: s.title ?? null,
        type: s.type ?? null,
        order_num: s.order ?? null,
        created_at: s.createdAt ?? null,
        updated_at: s.updatedAt ?? null,
        published_at: s.publishedAt ?? null,
      });
      // Section title translations
      if (sDocId) {
        for (const tr of (s.titleTranslations ?? [])) {
          const lang = tr.LanguageOfTranslation ?? tr.language ?? "";
          const text = blocksToText(tr.TranslationText) || (typeof tr.TranslationText === "string" ? tr.TranslationText : "") || "";
          if (lang && text) insTr.run({ entity_type: "section_title", entity_document_id: sDocId, language: lang, text });
        }
      }
    }

    // 3. Manthras + translations + teekas + word meanings
    for (const m of dedupedManthras) {
      const mDocId = m.documentId ?? null;
      const shloka = m.ShlokaManthraEntry;
      const bhashyam = m.BhashyamEntry;

      const engTr = blocksToText(shloka?.EnglishTranslationText) || null;
      const bhashyamEngTr = blocksToText(bhashyam?.EnglishTranslationText) || null;

      insManthra.run({
        id: m.id ?? null,
        document_id: mDocId,
        section_document_id: m.Section?.documentId ?? null,
        grantha_document_id: m.Section?.grantha?.documentId ?? null,
        shloka_manthra_number: m.ShlokaManthraNumber ?? null,
        order_num: m.order ?? null,
        sanskrit_text: blocksToText(shloka?.SanskritTextEntry) || null,
        sanskrit_iast: blocksToText(shloka?.IASTTransliteration) || null,
        english_translation: engTr,
        bhashyam_text: blocksToText(bhashyam?.SanskritTextEntry) || null,
        bhashyam_iast: blocksToText(bhashyam?.IASTTransliteration) || null,
        bhashyam_english_translation: bhashyamEngTr,
        created_at: m.createdAt ?? null,
        updated_at: m.updatedAt ?? null,
        published_at: m.publishedAt ?? null,
      });

      if (mDocId) {
        // English translations go into translations table too (for unified querying)
        if (engTr) insTr.run({ entity_type: "manthra_sanskrit", entity_document_id: mDocId, language: "English", text: engTr });
        if (bhashyamEngTr) insTr.run({ entity_type: "manthra_bhashyam", entity_document_id: mDocId, language: "English", text: bhashyamEngTr });
        // Other language translations
        insertTranslations("manthra_sanskrit", mDocId, shloka?.OtherTranslations);
        insertTranslations("manthra_bhashyam", mDocId, bhashyam?.OtherTranslations);
      }

      // Manthra-Teeka junction
      for (const mt of (m.Teekas ?? [])) {
        const teekaDocId = mt.teeka?.documentId ?? mt.documentId ?? null;
        const teekaName = mt.teeka?.TeekaName ?? mt.TeekaName ?? null;
        const entry = mt.TeekaEntry;
        const entryText = blocksToText(entry?.SanskritTextEntry) || null;
        const entryIast = blocksToText(entry?.IASTTransliteration) || null;
        const entryEng = blocksToText(entry?.EnglishTranslationText) || null;

        const result = insTeekaManthra.run({
          manthra_document_id: mDocId,
          teeka_document_id: teekaDocId,
          teeka_name: teekaName,
          teeka_entry_sanskrit: entryText,
          teeka_entry_iast: entryIast,
          teeka_entry_english: entryEng,
        });

        // Teeka entry translations: English + other languages all go in translations table
        const mtId = String(result.lastInsertRowid);
        if (entryEng) insTr.run({ entity_type: "teeka_entry", entity_document_id: mtId, language: "English", text: entryEng });
        insertTranslations("teeka_entry", mtId, entry?.OtherTranslations);
      }

      // Word meanings
      for (const wm of (m.wordMeanings ?? [])) {
        insWord.run({
          manthra_document_id: mDocId,
          word: wm.word ?? wm.Word ?? null,
          meaning: wm.meaning ?? wm.Meaning ?? null,
          meaning_language: wm.language ?? wm.Language ?? null,
        });
      }
    }
  });

  insertAll();
  const buf = db.serialize();
  db.close();
  return buf;
}

// Strapi section.type enum — exact values the API accepts
const STRAPI_SECTION_TYPES = new Set([
  "adhyay", "khanda", "valli", "pada", "kanda", "sukta",
  "varga", "anuvaka", "prakarana", "brahmana", "chapter", "part", "section", "book",
]);

// Map portal level names → Strapi section.type enum values (case-insensitive)
const SECTION_TYPE_MAP: Record<string, string> = {
  adhyaya: "adhyay",
  adhyay: "adhyay",
  khanda: "khanda",
  valli: "valli",
  valla: "valli",
  pada: "pada",
  kanda: "kanda",
  sukta: "sukta",
  varga: "varga",
  anuvaka: "anuvaka",
  prakarana: "prakarana",
  brahmana: "brahmana",
  chapter: "chapter",
  part: "part",
  section: "section",
  book: "book",
  parichcheda: "section",
  pariccheda: "section",
  prasthanam: "book",
};

function mapSectionType(name: string): string | undefined {
  if (!name) return undefined;
  const key = name.toLowerCase().trim();
  return SECTION_TYPE_MAP[key];
}

function cleanPayloadForStrapi(data: Record<string, any>): Record<string, any> {
  const cleaned: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    // Preserve `text` field on Strapi blocks text nodes — even when empty or null.
    // If text is null/undefined, convert it to "" so Strapi never sees a missing text field.
    if (key === "text" && (value === "" || value === null || value === undefined)) {
      cleaned[key] = "";
      continue;
    }
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "number" && Number.isNaN(value)) continue;
    // Strip string "NaN" — happens when a number input was left blank and serialized
    if (value === "NaN") continue;
    if (STRAPI_INTERNAL_KEYS.has(key)) continue;
    if (isPortalDraftDataKey(key)) continue;
    // Strip local-only portal fields (prefixed with _)
    if (key.startsWith("_")) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      const sub = cleanPayloadForStrapi(value as Record<string, any>);
      if (Object.keys(sub).length > 0) {
        cleaned[key] = sub;
      }
    } else if (Array.isArray(value)) {
      let cleanedArr = value
        .map((item) =>
          typeof item === "object" && item !== null
            ? cleanPayloadForStrapi(item)
            : item
        )
        .filter((item) =>
          typeof item === "object" && item !== null
            ? Object.keys(item).length > 0
            : item !== "" && item !== null && item !== undefined
        );
      // If this looks like a Strapi blocks array, run a final sanitization pass
      // to guarantee every text node has a `text` field and every paragraph
      // has a valid children array — regardless of how the data arrived.
      if (cleanedArr.some((item: any) => item?.type === "paragraph" || item?.type === "heading")) {
        cleanedArr = sanitizeBlocksField(cleanedArr);
      }
      if (cleanedArr.length > 0) {
        cleaned[key] = cleanedArr;
      }
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

/** Ensure every node in a Strapi blocks array has valid structure.
 *  - Every {type:"text"} child must have a `text` field (defaults to "")
 *  - Every paragraph/heading must have a non-empty `children` array
 *  Applied automatically by cleanPayloadForStrapi to any array that looks
 *  like a blocks field (contains paragraph/heading nodes).
 */
function sanitizeBlocksField(blocks: any[]): any[] {
  return blocks.map((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return block;
    if (block.type !== "paragraph" && block.type !== "heading") return block;

    const rawChildren = Array.isArray(block.children) ? block.children : [];
    const children =
      rawChildren.length === 0
        ? [{ type: "text", text: "" }]
        : rawChildren.map((child: any) => {
            if (!child || typeof child !== "object") {
              return { type: "text", text: "" };
            }
            if (child.type === "text") {
              // text field must always be a string
              const t = child.text;
              return { ...child, text: typeof t === "string" ? t : "" };
            }
            return child;
          });

    return { ...block, children };
  });
}

const CONTENT_TYPE_MAP: Record<string, string> = {
  granthas: "granthas",
  sections: "sections",
  teekas: "teekas",
  articles: "articles",
  authors: "authors",
  categories: "categories",
  manthras: "manthras",
  chapters: "chapters",
};

// These content types exist in the portal but have no REST API route in Strapi.
// Drafts can be saved locally but cannot be published to Strapi directly.
const STRAPI_UNROUTED_TYPES = new Set(["prasthana-thraya-screens"]);

async function buildManthraData(
  manthra: Record<string, any>,
  sectionDocId: string | undefined,
  granthaDocId?: string,
  teekaNameToDocId?: Map<string, string>,
  options?: { fastSinglePublish?: boolean },
): Promise<Record<string, any>> {
  // Portal `title` is what the user sees in the hierarchy; it must win over any stale CMS field.
  const mData: Record<string, any> = {
    ShlokaManthraNumber: (manthra.title || manthra.ShlokaManthraNumber || "").trim(),
  };
  if (manthra.order != null) {
    const n = Number(manthra.order);
    if (!isNaN(n)) mData.order = n;
  }
  if (sectionDocId) mData.Section = sectionDocId;
  if (manthra.ShlokaManthraEntry && textEntryHasPublishableContent(manthra.ShlokaManthraEntry)) {
    mData.ShlokaManthraEntry = manthra.ShlokaManthraEntry;
  }
  // BhashyamForShlokaManthra is the hierarchy-builder field name; Strapi's actual field is BhashyamEntry
  if (manthra.BhashyamForShlokaManthra && textEntryHasPublishableContent(manthra.BhashyamForShlokaManthra)) {
    mData.BhashyamEntry = manthra.BhashyamForShlokaManthra;
  } else if (manthra.BhashyamEntry && textEntryHasPublishableContent(manthra.BhashyamEntry)) {
    mData.BhashyamEntry = manthra.BhashyamEntry;
  }

  const cleaned = cleanPayloadForStrapi(mData);

  // Normalize TextAndTranslation fields so OtherTranslations is always in Strapi's
  // repeatable-component format regardless of which format the draft stored them in.
  for (const key of ["ShlokaManthraEntry", "BhashyamEntry"] as const) {
    if (cleaned[key] && typeof cleaned[key] === "object" && !Array.isArray(cleaned[key])) {
      cleaned[key] = normalizeTextAndTranslation(cleaned[key]);
    }
  }

  // Resolve Teekas — grantha-wizard manthras store { TeekaName, TeekaAuthor, TeekaEntry }.
  // resolveManthraTeekas looks up each Teeka record in Strapi and converts to the
  // { teeka: documentId, TeekaEntry: {...} } format Strapi's bhashya-entries component expects.
  //
  // SAFETY RULE — always merge with existing Strapi teeka content:
  // Strapi treats a PUT with a Teekas array as a COMPLETE REPLACEMENT of all teekas on
  // that mantra. If the user only edited one teeka (e.g. "Upanishad Brahmendra") and we
  // send only that one, Strapi silently deletes every other teeka that was there (e.g.
  // "Kathopanishad"). To prevent this, for existing Strapi manthras we:
  //   1. Fetch the current mantra once (teekas + Shloka + Bhashyam populated).
  //   2. Build a merged array: keep every existing Strapi entry UNLESS the local draft
  //      has updated content for that same teeka; add any brand-new local entries.
  //   3. Send the merged array — so no existing teeka is ever silently wiped.
  //
  // When the local draft has NO teeka entries at all and the manthra already exists in
  // Strapi we OMIT Teekas from the PUT payload so Strapi is untouched.
  // Only for brand-new manthras (no strapiDocumentId) do we send Teekas: [].
  const rawTeekas = manthra.Teekas;
  const isExistingStrapi =
    typeof manthra.strapiDocumentId === "string" && manthra.strapiDocumentId.length >= 10;
  const strapiDocId = manthra.strapiDocumentId as string;

  // Fresh republish strips the live Strapi link but keeps `_priorStrapiDocId` so we can read
  // the existing CMS content for verses whose bhashyam/teeka were never hydrated into the draft.
  const priorContentDocId =
    !isExistingStrapi &&
    typeof manthra._priorStrapiDocId === "string" &&
    (manthra._priorStrapiDocId as string).length >= 10
      ? (manthra._priorStrapiDocId as string)
      : undefined;

  // Strapi keys the user explicitly edited this session (set by the editor). For these the draft
  // is authoritative: a shorter edit still lands (no placeholder protection) and an empty draft
  // means "remove", so deliberate edits/removals actually reflect in the CMS.
  const editedTextKeys = new Set<string>();
  if (manthra._shlokaEdited === true) editedTextKeys.add("ShlokaManthraEntry");
  if (manthra._bhashyamEdited === true) editedTextKeys.add("BhashyamEntry");

  let resolvedTeekas: any[] = [];
  if (Array.isArray(rawTeekas) && rawTeekas.length > 0) {
    resolvedTeekas = await resolveManthraTeekas(rawTeekas, granthaDocId, teekaNameToDocId);
  }

  const localTeekasNeedMerge =
    Array.isArray(rawTeekas) && rawTeekas.length > 0 && resolvedTeekas.length > 0;
  // Always fetch teeka snapshot for existing mantras so partial edits never wipe sibling teekas.
  const needsTeekaMergeSnapshot = isExistingStrapi && localTeekasNeedMerge;
  // Doc id to read existing CMS content from: the row itself for a normal update, or the
  // row this verse was published from for a fresh republish (so un-hydrated content survives).
  const snapshotDocId = isExistingStrapi ? strapiDocId : priorContentDocId;
  const fetchSnapshot =
    !!snapshotDocId &&
    (needsTeekaMergeSnapshot ||
      !!priorContentDocId ||
      (isExistingStrapi && editedTextKeys.size > 0));

  let strapiMantraSnapshot: any = null;
  if (fetchSnapshot) {
    try {
      strapiMantraSnapshot =
        (await strapiRequest(`/api/manthras/${snapshotDocId}${MANTRA_EXISTING_MERGE_QUERY}`))?.data ?? null;
      const n = strapiMantraSnapshot?.Teekas?.length ?? 0;
      console.log(
        `[buildManthraData] Fetched Strapi mantra snapshot (${n} teeka row(s))${
          priorContentDocId ? " for fresh-republish carry-over" : " for merge"
        }`,
      );
    } catch (e: any) {
      console.warn(`[buildManthraData] Could not fetch existing Strapi mantra for merge — ${e.message}`);
    }
  }

  if (Array.isArray(rawTeekas)) {
    if (rawTeekas.length > 0) {
      if (resolvedTeekas.length > 0 && isExistingStrapi) {
        // ── MERGE with existing Strapi teekas (snapshot from single GET above) ─────
        const existingTeekas: any[] = strapiMantraSnapshot?.Teekas ?? [];

        // Map local resolved entries by their teeka documentId.
        const localByTeekaDocId = new Map<string, any>();
        for (const lt of resolvedTeekas) {
          if (lt.teeka) localByTeekaDocId.set(lt.teeka as string, lt);
        }

        const mergedTeekas: any[] = [];

        // Pass 1 — walk existing Strapi entries:
        //   • If local has new content for this teeka → use local content but
        //     carry over the Strapi component `id` so Strapi updates in-place
        //     instead of deleting + re-creating.
        //   • If local has no update → keep as-is (re-send with id + teeka docId
        //     + full TeekaEntry so Strapi doesn't clear it).
        for (const et of existingTeekas) {
          const tDocId = et.teeka?.documentId;
          if (!tDocId) continue;
          const local = localByTeekaDocId.get(tDocId);
          if (local) {
            // Use local edits merged into Strapi so partial draft never wipes OtherTranslations.
            mergedTeekas.push({
              id: et.id,
              teeka: tDocId,
              TeekaEntry: mergeTeekaEntryForPut(et.TeekaEntry, local.TeekaEntry),
            });
            localByTeekaDocId.delete(tDocId); // mark as handled
          } else {
            // No local edit — keep existing content unchanged.
            mergedTeekas.push({ id: et.id, teeka: tDocId, TeekaEntry: et.TeekaEntry ?? null });
          }
        }

        // Pass 2 — add brand-new teekas that had no existing entry in Strapi.
        for (const [, lt] of localByTeekaDocId) {
          mergedTeekas.push(lt);
        }

        console.log(
          `[buildManthraData] Merged teekas: ${existingTeekas.length} existing + ${resolvedTeekas.length} local → ${mergedTeekas.length} total`
        );
        cleaned.Teekas = mergedTeekas;
      } else {
        // New mantra or nothing resolved — send as-is.
        cleaned.Teekas = resolvedTeekas;
      }
    } else if (!isExistingStrapi) {
      // New manthra: explicitly send [] so Strapi initialises the teekas field cleanly.
      cleaned.Teekas = [];
    }
    // else: existing Strapi manthra, empty local teekas → omit Teekas from payload
    // so Strapi preserves whatever content it already holds for this manthra.
  }

  // ── SAFETY: Merge ShlokaManthraEntry + BhashyamEntry (skip on fast single publish — local body is authoritative) ──
  // Also runs when the user explicitly edited/cleared a field (editedTextKeys), even if the
  // draft is now empty — so a deliberate removal is sent rather than silently kept.
  if (!options?.fastSinglePublish && isExistingStrapi) {
    if (strapiMantraSnapshot) {
      applyMantraTextMergeFromStrapiData(cleaned, strapiMantraSnapshot, editedTextKeys);
    } else if (mantraTextMergeNeeded(cleaned) || editedTextKeys.size > 0) {
      await mergeMantraTextComponentsFromStrapi(cleaned, strapiDocId, editedTextKeys);
    }
  }

  // Fresh republish: backfill bhashyam / teeka / shloka that the draft never hydrated so a
  // structural renumber (which recreates every row) can't blank out un-opened verses. A field
  // the user deliberately cleared this session must NOT be refilled from the old CMS row.
  if (priorContentDocId && strapiMantraSnapshot) {
    carryOverFreshRepublishContent(cleaned, strapiMantraSnapshot, editedTextKeys);
  }

  pruneNonPublishableManthraTextFields(cleaned, editedTextKeys);
  sanitizeStrapiTextComponentsOnManthraLikePayload(cleaned);
  return cleaned;
}

/** Drop Strapi row identity from draft rows so merges never overwrite a valid instance id
 *  with undefined or a stale id from another entity. */
function omitTranslationComponentIdentity(row: Record<string, any>): Record<string, any> {
  const { id, documentId, ...rest } = row;
  return rest;
}

/** Merge OtherTranslations arrays: Strapi is the base, local overrides by language.
 * Any language in Strapi that isn't touched by local is preserved.
 * Any language that local explicitly has is used (overrides Strapi for that language).
 * Any language that is only in local (not yet in Strapi) is appended.
 *
 * When updating an existing language row, **merge onto the Strapi object** — do not replace
 * the whole row with the draft-only object. Strapi v5 rejects PUTs where repeatable component
 * entries lose their instance id ("not related to the entity").
 */
function mergeOtherTranslations(localOT: any[], strapiOT: any[]): any[] {
  const result = [...strapiOT];
  for (const localEntry of localOT) {
    const lang = localEntry.LanguageOfTranslation;
    if (!lang) continue;
    const idx = result.findIndex((e) => e.LanguageOfTranslation === lang);
    const localFields = omitTranslationComponentIdentity(localEntry);
    if (idx >= 0) {
      result[idx] = { ...result[idx], ...localFields };
    } else {
      result.push({ ...localFields });
    }
  }
  return result;
}

/** When updating an existing Strapi grantha, merge repeatable translations so PUT never replaces
 *  Strapi-only languages with a partial draft list (same pattern as mantra OtherTranslations). */
function mergeGranthaPayloadWithExistingStrapiTranslations(
  granthaPayload: Record<string, any>,
  existing: any | null | undefined
): void {
  if (!existing || typeof existing !== "object") return;

  const strapiGT = existing.GranthaNameTranslations;
  const localGT = granthaPayload.GranthaNameTranslations;
  if (Array.isArray(strapiGT) && strapiGT.length > 0 && Array.isArray(localGT) && localGT.length > 0) {
    granthaPayload.GranthaNameTranslations = mergeOtherTranslations(localGT, strapiGT);
  }

  const localBH = granthaPayload.BhashyakaraIntroduction;
  const strapiBH = existing.BhashyakaraIntroduction;
  if (localBH && typeof localBH === "object" && strapiBH && typeof strapiBH === "object") {
    granthaPayload.BhashyakaraIntroduction = mergeTeekaEntryForPut(strapiBH, localBH);
  }
}

/** Remove Strapi admin / relation noise from rich text trees while preserving block shape.
 *  Does **not** strip `__component` — Strapi blocks/components may require it on write. */
function deepSanitizeStrapiRichValue(v: any): any {
  if (v == null) return v;
  if (Array.isArray(v)) return v.map(deepSanitizeStrapiRichValue);
  if (typeof v !== "object") return v;
  const STRIP = new Set([
    "id",
    "documentId",
    "createdAt",
    "updatedAt",
    "publishedAt",
    "locale",
    "localizations",
    "createdBy",
    "updatedBy",
  ]);
  const o: Record<string, any> = {};
  for (const [k, val] of Object.entries(v)) {
    if (STRIP.has(k)) continue;
    if (k.startsWith("_") && k !== "__component") continue;
    o[k] = deepSanitizeStrapiRichValue(val);
  }
  return o;
}

/** Rebuild `shared.text-and-translation` for Strapi PUT: only accepted fields, no `populate=*` cruft. */
function rebuildTextAndTranslationForStrapiPut(src: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!src || typeof src !== "object") return null;
  const out: Record<string, any> = {};
  for (const field of ["SanskritTextEntry", "EnglishTranslationText", "IASTTransliteration"] as const) {
    const v = src[field];
    if (Array.isArray(v) && v.length > 0) {
      const san = deepSanitizeStrapiRichValue(v);
      if (Array.isArray(san) && san.length > 0) {
        out[field] = sanitizeBlocksField(san);
      }
    }
  }
  const ot = src.OtherTranslations;
  if (Array.isArray(ot) && ot.length > 0) {
    const rows = ot
      .map((row: any) => {
        const lang = typeof row?.LanguageOfTranslation === "string" ? row.LanguageOfTranslation.trim() : "";
        if (!lang) return null;
        const tt = row.TranslationText;
        if (!Array.isArray(tt) || tt.length === 0) {
          return {
            LanguageOfTranslation: lang,
            TranslationText: [{ type: "paragraph", children: [{ type: "text", text: "" }] }],
          };
        }
        const san = deepSanitizeStrapiRichValue(tt);
        const blocks = Array.isArray(san) && san.length > 0 ? sanitizeBlocksField(san) : [{ type: "paragraph", children: [{ type: "text", text: "" }] }];
        return { LanguageOfTranslation: lang, TranslationText: blocks };
      })
      .filter(Boolean) as any[];
    if (rows.length > 0) out.OtherTranslations = rows;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Strapi v5 rejects merged GET snapshots that still send nested component `id` / `documentId`
 *  ("Some of the provided components … are not related to the entity"). The merge step
 *  intentionally preserves those keys for in-memory merge logic — strip them again before PUT. */
function scrubMergedGranthaRepeatableComponents(granthaPayload: Record<string, any>): void {
  const bh = granthaPayload.BhashyakaraIntroduction;
  if (bh && typeof bh === "object") {
    const built = rebuildTextAndTranslationForStrapiPut(bh as Record<string, any>);
    if (built && Object.keys(built).length > 0) {
      granthaPayload.BhashyakaraIntroduction = built;
    } else {
      delete granthaPayload.BhashyakaraIntroduction;
    }
  }
  const gnt = granthaPayload.GranthaNameTranslations;
  if (Array.isArray(gnt) && gnt.length > 0) {
    granthaPayload.GranthaNameTranslations = gnt
      .map((row: any) => {
        const lang = typeof row?.LanguageOfTranslation === "string" ? row.LanguageOfTranslation.trim() : "";
        if (!lang) return null;
        const tt = row.TranslationText;
        if (!Array.isArray(tt) || tt.length === 0) {
          return {
            LanguageOfTranslation: lang,
            TranslationText: [{ type: "paragraph", children: [{ type: "text", text: "" }] }],
          };
        }
        const san = deepSanitizeStrapiRichValue(tt);
        const blocks =
          Array.isArray(san) && san.length > 0
            ? sanitizeBlocksField(san)
            : [{ type: "paragraph", children: [{ type: "text", text: "" }] }];
        return { LanguageOfTranslation: lang, TranslationText: blocks };
      })
      .filter(Boolean) as any[];
  }
}

/** Rebuild every `shared.text-and-translation` on a Manthra/Chapter payload after Strapi merges.
 *  Covers unchanged `TeekaEntry` rows that never went through mergeTeekaEntryForPut. */
const MANTHRA_TEXT_COMPONENT_KEYS = ["ShlokaManthraEntry", "BhashyamEntry", "BhashyamForShlokaManthra"] as const;

function sanitizeStrapiTextComponentsOnManthraLikePayload(m: Record<string, any>): void {
  for (const key of MANTHRA_TEXT_COMPONENT_KEYS) {
    const v = m[key];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const rebuilt = rebuildTextAndTranslationForStrapiPut(v as Record<string, any>);
      if (rebuilt && Object.keys(rebuilt).length > 0) m[key] = rebuilt;
      else delete m[key];
    }
  }
  if (!Array.isArray(m.Teekas)) return;
  m.Teekas = m.Teekas.map((row: any) => {
    if (!row || typeof row !== "object") return row;
    const te = row.TeekaEntry;
    if (!te || typeof te !== "object") return row;
    const rebuilt = rebuildTextAndTranslationForStrapiPut(te as Record<string, any>);
    if (rebuilt && Object.keys(rebuilt).length > 0) {
      return { ...row, TeekaEntry: rebuilt };
    }
    const { TeekaEntry: _omit, ...rest } = row;
    return rest;
  });
}

async function fetchGranthaTranslationsForMerge(documentId: string): Promise<any | null> {
  try {
    const qs = [
      "populate[BhashyakaraIntroduction][populate]=*",
      "populate[GranthaNameTranslations]=*",
    ].join("&");
    const res = await strapiRequest(`/api/granthas/${documentId}?${qs}`);
    return res?.data ?? null;
  } catch (e: any) {
    console.warn(`[publish] Could not fetch existing grantha translations for merge: ${e.message}`);
    return null;
  }
}

function blocksPlainText(v: any): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  return v
    .map((block: any) =>
      (block?.children ?? [])
        .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
        .join(""),
    )
    .join("\n")
    .trim();
}

function isStubOrderOrPlaceholderPlainText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^\d{1,4}(\.\.*)?$/.test(t)) return true;
  return false;
}

/** Draft stubs (e.g. order digit "4" or "4..") must not replace full CMS verse text on publish. */
function isPlaceholderVersusCmsText(draft: any, cms: any): boolean {
  const d = blocksPlainText(draft);
  const s = blocksPlainText(cms);
  if (!d) return false;
  if (isStubOrderOrPlaceholderPlainText(d)) return true;
  if (!s || d === s) return false;
  if (/^\d{1,3}$/.test(d)) return true;
  if (d.length <= 8 && s.length > 40) return true;
  if (s.length >= 40 && d.length < s.length * 0.2) return true;
  return false;
}

function hasPublishableBlocks(v: any): boolean {
  if (!v) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (!Array.isArray(v)) return false;
  return v.some(
    (block: any) =>
      Array.isArray(block?.children) &&
      block.children.some((c: any) => typeof c?.text === "string" && c.text.trim().length > 0),
  );
}

function otherTranslationsHavePublishableContent(ot: any): boolean {
  if (!Array.isArray(ot)) return false;
  return ot.some((row) => {
    if (!row || typeof row !== "object") return false;
    return (
      hasPublishableBlocks(row.TranslationText) ||
      hasPublishableBlocks(row.OtherLanguagesTranslation)
    );
  });
}

function textEntryHasPublishableContent(entry: any): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (
    hasPublishableBlocks(entry.SanskritTextEntry) ||
    hasPublishableBlocks(entry.EnglishTranslationText) ||
    hasPublishableBlocks(entry.IASTTransliteration)
  ) {
    return true;
  }
  return otherTranslationsHavePublishableContent(entry.OtherTranslations);
}

/** Drop empty TextAndTranslation shells so Strapi PUT omits them and keeps CMS content.
 *  Keys in `preserveKeys` are kept even when empty — the user deliberately cleared them and
 *  the empty value must be sent so Strapi actually removes the content. */
function pruneNonPublishableManthraTextFields(m: Record<string, any>, preserveKeys?: Set<string>): void {
  for (const key of MANTHRA_TEXT_COMPONENT_KEYS) {
    if (preserveKeys?.has(key)) continue;
    const v = m[key];
    if (v && typeof v === "object" && !Array.isArray(v) && !textEntryHasPublishableContent(v)) {
      delete m[key];
    }
  }
}

/** Draft order stubs (e.g. Sanskrit/English = "4") must not trigger a full content PUT. */
function manthraTextEntryIsOrderStubOnly(entry: any): boolean {
  if (!entry || typeof entry !== "object") return false;
  const sans = blocksPlainText(entry.SanskritTextEntry);
  const eng = blocksPlainText(entry.EnglishTranslationText);
  if (sans && eng && sans !== eng) return false;
  const t = sans || eng;
  return isStubOrderOrPlaceholderPlainText(t);
}

/** True when the portal draft has verse/teeka content worth a full Strapi merge PUT. */
function manthraHasLocalPublishableContent(manthra: Record<string, any>): boolean {
  // An explicit edit/clear must take the full merge path, not the label-only fast path —
  // otherwise a deliberately emptied Shloka/Bhashyam would never be cleared in the CMS.
  if (manthra._shlokaEdited === true || manthra._bhashyamEdited === true) return true;
  if (textEntryHasPublishableContent(manthra.ShlokaManthraEntry)) {
    if (manthraTextEntryIsOrderStubOnly(manthra.ShlokaManthraEntry)) return false;
    return true;
  }
  if (textEntryHasPublishableContent(manthra.BhashyamForShlokaManthra)) return true;
  if (textEntryHasPublishableContent(manthra.BhashyamEntry)) return true;
  const teekas = manthra.Teekas;
  if (Array.isArray(teekas) && teekas.some((t) => textEntryHasPublishableContent(t?.TeekaEntry))) {
    return true;
  }
  return Array.isArray(manthra.wordMeanings) && manthra.wordMeanings.length > 0;
}

async function updateManthraIdentityOnly(
  strapiDocumentId: string,
  label: string,
  order: number | undefined,
  warnings?: Array<{ manthra: string; error: string }>,
): Promise<string> {
  const data: Record<string, any> = { ShlokaManthraNumber: label };
  if (order != null && !Number.isNaN(order)) data.order = order;
  await strapiManthraRequest(`/api/manthras/${strapiDocumentId}`, "PUT", data, label, warnings);
  return strapiDocumentId;
}

/** Merge draft TextAndTranslation onto Strapi (same shape for TeekaEntry, ShlokaManthraEntry, BhashyamEntry).
 *  Strapi is the base; each blocks field is replaced only when the draft has publishable content there.
 *  OtherTranslations are merged by language so Strapi-only rows are never dropped.
 *  Return value is always rebuilt for Strapi REST (strips nested ids / relations from populate=*). */
function mergeTeekaEntryForPut(
  strapiEntry: any | null | undefined,
  localEntry: any | null | undefined,
  // When the user explicitly edited this field, the draft is authoritative: take its blocks
  // whenever they're non-empty, bypassing the placeholder/length heuristic that otherwise
  // protects rich CMS text from being clobbered by a stub draft.
  trustDraft = false,
): any {
  if (!localEntry || typeof localEntry !== "object") {
    if (strapiEntry && typeof strapiEntry === "object") {
      const norm = normalizeTextAndTranslation({ ...strapiEntry });
      return rebuildTextAndTranslationForStrapiPut(norm as Record<string, any>) ?? norm;
    }
    return strapiEntry ?? null;
  }
  if (!strapiEntry || typeof strapiEntry !== "object") {
    const norm = normalizeTextAndTranslation({ ...localEntry });
    return rebuildTextAndTranslationForStrapiPut(norm as Record<string, any>) ?? norm;
  }
  const s = normalizeTextAndTranslation({ ...strapiEntry });
  const d = normalizeTextAndTranslation({ ...localEntry });
  const strapiOT: any[] = Array.isArray(s.OtherTranslations) ? s.OtherTranslations : [];
  const draftOT: any[] = Array.isArray(d.OtherTranslations) ? d.OtherTranslations : [];
  const mergedOT =
    strapiOT.length === 0 && draftOT.length === 0
      ? undefined
      : mergeOtherTranslations(draftOT, strapiOT);

  const keepDraft = (draftField: any, strapiField: any) =>
    hasPublishableBlocks(draftField) &&
    (trustDraft || !isPlaceholderVersusCmsText(draftField, strapiField));

  const out: Record<string, any> = { ...s };
  if (keepDraft(d.SanskritTextEntry, s.SanskritTextEntry)) {
    out.SanskritTextEntry = d.SanskritTextEntry;
  }
  if (keepDraft(d.EnglishTranslationText, s.EnglishTranslationText)) {
    out.EnglishTranslationText = d.EnglishTranslationText;
  }
  if (keepDraft(d.IASTTransliteration, s.IASTTransliteration)) {
    out.IASTTransliteration = d.IASTTransliteration;
  }
  if (mergedOT !== undefined) out.OtherTranslations = mergedOT;
  return rebuildTextAndTranslationForStrapiPut(out) ?? out;
}

/** Empty TextAndTranslation used to actively clear a CMS field the user deliberately removed. */
function clearedTextEntry(): Record<string, any> {
  const emptyBlocks = [{ type: "paragraph", children: [{ type: "text", text: "" }] }];
  return {
    SanskritTextEntry: emptyBlocks,
    EnglishTranslationText: emptyBlocks.map((b) => ({ ...b })),
    IASTTransliteration: emptyBlocks.map((b) => ({ ...b })),
    OtherTranslations: [],
  };
}

function rebuildTeekaOrTextEntryFromSnapshot(entry: any): any {
  if (!entry || typeof entry !== "object") return entry ?? null;
  const norm = normalizeTextAndTranslation({ ...entry });
  return rebuildTextAndTranslationForStrapiPut(norm as Record<string, any>) ?? norm;
}

/**
 * Fresh republish only — fill anything the local draft is missing from a snapshot of the row
 * this verse was previously published from. Large granthas never hydrate per-verse bhashyam/teeka
 * into the draft, and a fresh republish recreates every row, so without this carry-over an
 * un-opened verse would be recreated blank (and its original deleted), losing its commentary.
 */
function carryOverFreshRepublishContent(
  target: Record<string, any>,
  snapshot: any,
  editedKeys?: Set<string>,
): void {
  if (!snapshot || typeof snapshot !== "object") return;

  // Shloka + Bhashyam bodies: take the CMS body whenever the draft didn't supply one.
  for (const key of ["ShlokaManthraEntry", "BhashyamEntry"] as const) {
    // A field the user deliberately edited/cleared this session is authoritative — never refill it.
    if (editedKeys?.has(key)) continue;
    if (textEntryHasPublishableContent(target[key])) continue;
    const snap = snapshot[key];
    if (snap && typeof snap === "object" && textEntryHasPublishableContent(snap)) {
      target[key] = rebuildTeekaOrTextEntryFromSnapshot(snap);
    }
  }

  // Teekas: keep every draft entry, fill empty TeekaEntry bodies from CMS, and add any CMS
  // teekas the draft never carried (an un-opened verse holds no per-teeka content locally).
  const snapTeekas: any[] = Array.isArray(snapshot.Teekas) ? snapshot.Teekas : [];
  if (snapTeekas.length === 0) return;
  const snapByDocId = new Map<string, any>();
  for (const et of snapTeekas) {
    if (et?.teeka?.documentId) snapByDocId.set(et.teeka.documentId, et);
  }
  const localTeekas: any[] = Array.isArray(target.Teekas) ? target.Teekas : [];
  const merged: any[] = [];
  const used = new Set<string>();
  for (const lt of localTeekas) {
    const tDocId = typeof lt?.teeka === "string" ? lt.teeka : undefined;
    if (tDocId) used.add(tDocId);
    if (tDocId && !textEntryHasPublishableContent(lt?.TeekaEntry) && snapByDocId.has(tDocId)) {
      merged.push({ ...lt, TeekaEntry: rebuildTeekaOrTextEntryFromSnapshot(snapByDocId.get(tDocId).TeekaEntry) });
    } else {
      merged.push(lt);
    }
  }
  for (const et of snapTeekas) {
    const tDocId = et?.teeka?.documentId;
    if (!tDocId || used.has(tDocId)) continue;
    merged.push({ teeka: tDocId, TeekaEntry: rebuildTeekaOrTextEntryFromSnapshot(et.TeekaEntry) });
  }
  if (merged.length > 0) target.Teekas = merged;
}

/** One Strapi GET for existing-mantra publish: teekas + Shloka + Bhashyam (avoids duplicate round-trips). */
const MANTRA_EXISTING_MERGE_QUERY =
  "?populate[Teekas][populate][TeekaEntry][populate]=*" +
  "&populate[Teekas][populate][teeka][fields][0]=TeekaName" +
  "&populate[Teekas][populate][teeka][fields][1]=documentId" +
  "&populate[ShlokaManthraEntry][populate]=*" +
  "&populate[BhashyamEntry][populate]=*";

const MANTRA_TEEKAS_ONLY_QUERY =
  "?populate[Teekas][populate][TeekaEntry][populate]=*" +
  "&populate[Teekas][populate][teeka][fields][0]=TeekaName" +
  "&populate[Teekas][populate][teeka][fields][1]=documentId";

const MANTRA_TEXT_ONLY_QUERY =
  "?populate[ShlokaManthraEntry][populate]=*" +
  "&populate[BhashyamEntry][populate]=*";

/** Picks the smallest populate query that covers the merges we actually need. */
function pickMantraMergeQuery(needsTeekas: boolean, needsText: boolean): string | null {
  if (!needsTeekas && !needsText) return null;
  if (needsTeekas && needsText) return MANTRA_EXISTING_MERGE_QUERY;
  if (needsTeekas) return MANTRA_TEEKAS_ONLY_QUERY;
  return MANTRA_TEXT_ONLY_QUERY;
}

function mantraTextMergeNeeded(target: Record<string, any>): boolean {
  const keys = ["ShlokaManthraEntry", "BhashyamEntry"] as const;
  return keys.some((k) => target[k] && typeof target[k] === "object" && !Array.isArray(target[k]));
}

/** Apply Strapi-backed merge for Shloka/Bhashyam using a mantra `data` object already fetched from Strapi. */
function applyMantraTextMergeFromStrapiData(
  target: Record<string, any>,
  strapiData: any,
  // Strapi keys the user explicitly edited this session (authoritative: trust draft, and an
  // empty draft means "remove" rather than "leave CMS alone").
  editedKeys?: Set<string>,
): void {
  const keys = ["ShlokaManthraEntry", "BhashyamEntry"] as const;
  for (const key of keys) {
    const edited = !!editedKeys?.has(key);
    const localEntry = target[key];
    const hasLocal =
      localEntry && typeof localEntry === "object" && textEntryHasPublishableContent(localEntry);
    if (!hasLocal) {
      if (edited) {
        // User deliberately cleared this field — overwrite CMS with empty so it's removed.
        target[key] = clearedTextEntry();
      } else {
        // Omit from PUT — Strapi keeps existing CMS text when the field is not sent.
        delete target[key];
      }
      continue;
    }
    const strapiEntry = strapiData && typeof strapiData === "object" ? strapiData[key] : undefined;
    if (strapiEntry && typeof strapiEntry === "object") {
      target[key] = mergeTeekaEntryForPut(strapiEntry, localEntry, edited);
    }
    // No CMS counterpart: target[key] stays = the draft entry (already correct).
  }
}

/** Fallback when no snapshot: fetch Strapi Shloka/Bhashyam only (used after failed combined fetch). */
async function mergeMantraTextComponentsFromStrapi(
  target: Record<string, any>,
  strapiDocumentId: string,
  editedKeys?: Set<string>,
): Promise<void> {
  if (!mantraTextMergeNeeded(target) && !(editedKeys && editedKeys.size > 0)) return;
  try {
    const fetched = await strapiRequest(`/api/manthras/${strapiDocumentId}${MANTRA_EXISTING_MERGE_QUERY}`);
    applyMantraTextMergeFromStrapiData(target, fetched?.data, editedKeys);
  } catch (e: any) {
    console.warn(`[mergeMantraTextComponentsFromStrapi] Fetch/merge failed — sending local fields only: ${e.message}`);
  }
}

// Strapi's sections collection only accepts these values for the `type` field.
// Any portal-side type label that isn't in this set must be mapped to "section"
// (a safe generic fallback) before being sent to the API — otherwise Strapi
// returns a 400 ValidationError and the section (and all its manthras) fails silently.
const VALID_STRAPI_SECTION_TYPES = new Set([
  "adhyay", "khanda", "valli", "pada", "kanda", "sukta", "varga",
  "anuvaka", "prakarana", "chapter", "part", "section", "book",
]);

// Helper: find an existing Strapi section by title+grantha+parent, or create it if missing.
// This prevents duplicate sections on repeated publishes of the same grantha draft.
async function findOrCreateSection(
  title: string,
  type: string | undefined,
  order: number | undefined,
  granthaDocId: string,
  parentDocId: string | undefined
): Promise<string | undefined> {
  // Guard: never create or look up a section with a blank title.
  // Blank-titled sections corrupt the hierarchy and are impossible to reliably dedup.
  if (!title || !title.trim()) {
    console.warn(`[publish] Skipping section with blank title (type=${type}, order=${order}) — not publishing to Strapi`);
    return undefined;
  }

  // Normalise the section type: if the portal label isn't in Strapi's allowed enum
  // (e.g. "brahmana", "adhikarana", etc.) use "section" as a safe generic fallback.
  // This prevents 400 ValidationErrors when creating new sections and also avoids
  // futile type-correction PUTs that would just fail with the same 400.
  const effectiveType = type
    ? (VALID_STRAPI_SECTION_TYPES.has(type) ? type : "section")
    : undefined;
  if (type && effectiveType !== type) {
    console.warn(`[publish] Section type "${type}" is not a valid Strapi type — using "section" instead`);
  }

  // Search for an existing section that matches title + grantha + parent.
  // Use $eqi (case-insensitive) so "Prathama Adhyaya" and "prathama adhyaya" are treated as the same section.
  try {
    const t = encodeURIComponent(title.trim());
    const g = encodeURIComponent(granthaDocId);
    let url = `/api/sections?filters[title][$eqi]=${t}&filters[grantha][documentId][$eq]=${g}&fields[0]=documentId&fields[1]=type`;
    if (parentDocId) {
      url += `&filters[parent][documentId][$eq]=${encodeURIComponent(parentDocId)}`;
    } else {
      url += `&filters[parent][$null]=true`;
    }
    const existing = await strapiRequest(url);
    const existingRecord = existing?.data?.[0];
    const existingDocId: string | undefined = existingRecord?.documentId;
    if (existingDocId) {
      // Correct the type whenever it doesn't match — not just when it's missing.
      // This repairs sections that were created with the wrong type in an earlier publish.
      // Only attempt correction when effectiveType is a valid Strapi value.
      if (effectiveType && existingRecord?.type !== effectiveType) {
        try {
          await strapiRequest(`/api/sections/${existingDocId}`, {
            method: "PUT",
            body: JSON.stringify({ data: { type: effectiveType } }),
          });
          console.log(`[publish] Section "${title}" (${existingDocId}) type corrected: ${existingRecord?.type || "(none)"} → ${effectiveType}`);
        } catch (e: any) {
          console.warn(`[publish] Section "${title}" type correction failed: ${e.message}`);
        }
      } else {
        console.log(`[publish] Section "${title}" already exists: ${existingDocId} — reusing`);
      }
      return existingDocId;
    }
  } catch (lookupErr: any) {
    // Log the lookup failure but still fall through to create — resilience over perfection.
    // Downside: may create a duplicate section if Strapi has one already. Warn so this is visible.
    console.warn(
      `[publish] Section "${title}" dedup lookup failed (${lookupErr?.message || lookupErr}) — ` +
      `falling through to create; may produce a duplicate if the section already exists in Strapi`
    );
  }

  // Not found (or lookup failed) — create a new section
  const payload: Record<string, any> = { title: title.trim(), grantha: granthaDocId };
  if (effectiveType) payload.type = effectiveType;
  if (order != null) payload.order = order;
  if (parentDocId) payload.parent = parentDocId;
  const r = await strapiRequest("/api/sections", {
    method: "POST",
    body: JSON.stringify({ data: payload }),
  });
  const newDocId: string | undefined = r?.data?.documentId;
  if (!newDocId) {
    // Strapi returned a 2xx but with no documentId — this is a data-consistency failure.
    // Throw so the caller's catch block can add a visible entry to publishFailures and
    // skip this section's manthras (rather than silently proceeding with an undefined docId).
    throw new Error(
      `Section "${title}" was accepted by Strapi but no documentId was returned — ` +
      `cannot link manthras to it. Check Strapi logs for this section and re-publish.`
    );
  }
  console.log(`[publish] Section "${title}" created: ${newDocId}`);
  return newDocId;
}

// Helper: resolve a section to its Strapi documentId.
// If the node already has a known Strapi docId (from a previous publish),
// use it directly (PUT to update order/type) — skipping the expensive dedup
// API lookup. Falls back to findOrCreateSection when no prior docId is known.
async function resolveSection(
  knownDocId: string | undefined,
  title: string,
  type: string | undefined,
  order: number | undefined,
  granthaDocId: string,
  parentDocId: string | undefined,
  skipMetadataUpdate = false,
): Promise<string | undefined> {
  // Normalise type to a valid Strapi enum value (same logic as findOrCreateSection).
  const effectiveType = type
    ? (VALID_STRAPI_SECTION_TYPES.has(type) ? type : "section")
    : undefined;

  if (knownDocId) {
    if (skipMetadataUpdate) {
      return knownDocId;
    }
    // Fast path: we already know this section's Strapi ID — update it in place
    try {
      const payload: Record<string, any> = {};
      if (effectiveType) payload.type = effectiveType;
      if (order != null) payload.order = order;
      if (Object.keys(payload).length > 0) {
        await strapiRequest(`/api/sections/${knownDocId}`, {
          method: "PUT",
          body: JSON.stringify({ data: payload }),
        });
      }
      console.log(`[publish] Section "${title}" fast-path (known docId ${knownDocId})`);
      return knownDocId;
    } catch (e: any) {
      // 404 means the section was deleted from Strapi since last publish — fall through to recreate
      if (e?.status === 404) {
        console.warn(`[publish] Section "${title}" docId ${knownDocId} is 404 in Strapi — recreating`);
      } else {
        console.warn(`[publish] Section "${title}" fast-path PUT failed (${e.message}), falling back to dedup`);
      }
    }
  }
  // Slow path: dedup lookup + create
  return findOrCreateSection(title, type, order, granthaDocId, parentDocId);
}

function countManthraOtherTranslations(mData: Record<string, any>): number {
  let n = 0;
  for (const key of ["ShlokaManthraEntry", "BhashyamEntry"] as const) {
    const ot = mData[key]?.OtherTranslations;
    if (Array.isArray(ot)) n += ot.length;
  }
  for (const t of mData.Teekas ?? []) {
    const ot = t?.TeekaEntry?.OtherTranslations;
    if (Array.isArray(ot)) n += ot.length;
  }
  return n;
}

function manthraPayloadLooksLarge(mData: Record<string, any>): boolean {
  if (countManthraOtherTranslations(mData) > 12) return true;
  try {
    return JSON.stringify(mData).length > 350_000;
  } catch {
    return false;
  }
}

const MANTRA_OT_BATCH_SIZE = 12;
const MANTRA_OT_SINGLE_PUT_MAX = 12;

/** Sync a TextAndTranslation field when OtherTranslations is large — batch merges to avoid 413/timeouts. */
async function putTextEntryWithOptionalOtBatching(
  putEndpoint: string,
  fieldKey: "ShlokaManthraEntry" | "BhashyamEntry",
  entry: Record<string, any>,
  label: string,
  warnings?: Array<{ manthra: string; error: string }>,
): Promise<void> {
  if (!entry || typeof entry !== "object") return;
  const { OtherTranslations, ...core } = entry;
  const ot = Array.isArray(OtherTranslations) ? OtherTranslations : [];
  if (ot.length <= MANTRA_OT_SINGLE_PUT_MAX) {
    await strapiRequest(putEndpoint, {
      method: "PUT",
      body: JSON.stringify({ data: { [fieldKey]: entry } }),
    });
    return;
  }

  console.log(
    `[publish] Manthra "${label}" — syncing ${ot.length} ${fieldKey} OtherTranslations in batches`,
  );
  await strapiRequest(putEndpoint, {
    method: "PUT",
    body: JSON.stringify({ data: { [fieldKey]: { ...core, OtherTranslations: [] } } }),
  });

  const BATCH = MANTRA_OT_BATCH_SIZE;
  let merged: any[] = [];
  for (let i = 0; i < ot.length; i += BATCH) {
    merged = mergeOtherTranslations(ot.slice(i, i + BATCH), merged);
    try {
      await strapiRequest(putEndpoint, {
        method: "PUT",
        body: JSON.stringify({ data: { [fieldKey]: { ...core, OtherTranslations: merged } } }),
      });
    } catch (e: any) {
      if (e?.status !== 413) throw e;
      warnings?.push({
        manthra: label,
        error: `[WARNING] Some ${fieldKey} OtherTranslations could not be synced (batch ${Math.floor(i / BATCH) + 1}).`,
      });
      break;
    }
  }
}

// Send a single Strapi request, splitting payload into chunks when 413 or when very large.
// Strapi v5 PUT merges fields — omitted fields are preserved on the record.
// This lets us split large manthras into: core + BhashyamEntry + Teekas
// so ALL content is synced even when the combined payload exceeds the body limit.
async function strapiManthraRequest(
  endpoint: string,
  method: "PUT" | "POST",
  mData: Record<string, any>,
  label: string,
  warnings?: Array<{ manthra: string; error: string }>
): Promise<any> {
  const forceChunk = manthraPayloadLooksLarge(mData);

  // --- Fast path: single request (skip when payload is predictably huge) ---
  if (!forceChunk) {
    try {
      const res = await strapiRequest(endpoint, { method, body: JSON.stringify({ data: mData }) });
      console.log(`[publish] Manthra "${label}" ${method === "PUT" ? "updated" : "created"} (single request)`);
      return res;
    } catch (e: any) {
      if (e?.status !== 413) throw e;
    }
  } else {
    console.log(
      `[publish] Manthra "${label}" — large payload (${countManthraOtherTranslations(mData)} OT rows) — chunked sync`,
    );
  }

  // --- Split path: payload too large, split into smaller requests ---
  console.warn(`[publish] Manthra "${label}" — splitting into chunked requests to sync all content`);

  // Separate the three large sections — each will be PUT independently.
  const { BhashyamEntry, Teekas, ShlokaManthraEntry, ...coreData } = mData;

  let putEndpoint = endpoint;
  let mainRes: any;

  // Chunk 1: identity + ShlokaManthraEntry only (no BhashyamEntry, no Teekas)
  if (method === "POST") {
    // POST creates the record; subsequent chunks use PUT on the returned docId
    mainRes = await strapiRequest(endpoint, { method: "POST", body: JSON.stringify({ data: coreData }) });
    const newDocId: string | undefined = mainRes?.data?.documentId;
    if (!newDocId) throw new Error(`[publish] Manthra "${label}" POST succeeded but returned no documentId`);
    putEndpoint = `/api/manthras/${newDocId}`;
  } else {
    await strapiRequest(endpoint, { method: "PUT", body: JSON.stringify({ data: coreData }) });
    // Extract the docId from the PUT endpoint robustly: filter empty segments to handle
    // any trailing slashes, and strip potential query params from the last segment.
    const lastSegment = endpoint.split("/").filter(Boolean).pop() ?? "";
    const putDocId = lastSegment.split("?")[0];
    mainRes = { data: { documentId: putDocId } };
  }

  // Chunk 1b: ShlokaManthraEntry (Sanskrit/English + batched OtherTranslations)
  if (ShlokaManthraEntry && typeof ShlokaManthraEntry === "object") {
    try {
      await putTextEntryWithOptionalOtBatching(
        putEndpoint,
        "ShlokaManthraEntry",
        ShlokaManthraEntry,
        label,
        warnings,
      );
    } catch (e: any) {
      if (e?.status !== 413) throw e;
      warnings?.push({
        manthra: label,
        error: "[WARNING] ShlokaManthraEntry could not be fully synced — payload too large.",
      });
    }
  }

  // Chunk 2: BhashyamEntry (separate PUT — Strapi preserves other fields when omitted)
  if (BhashyamEntry && Object.keys(BhashyamEntry).some((k) => BhashyamEntry[k])) {
    try {
      await putTextEntryWithOptionalOtBatching(
        putEndpoint,
        "BhashyamEntry",
        BhashyamEntry,
        label,
        warnings,
      );
    } catch (e2: any) {
      if (e2?.status !== 413) throw e2;
      warnings?.push({
        manthra: label,
        error: "[WARNING] BhashyamEntry could not be fully synced — payload too large.",
      });
    }
  }

  // Chunk 3: Full Teekas array sent once — includes all TeekaEntry content
  if (Array.isArray(Teekas) && Teekas.length > 0) {
    try {
      await strapiRequest(putEndpoint, { method: "PUT", body: JSON.stringify({ data: { Teekas } }) });
    } catch (e3: any) {
      if (e3?.status !== 413) throw e3;
      // Teekas combined are too large — send each teeka individually
      // Fetch the current teekas so we can merge (avoids losing existing teeka IDs)
      let currentTeekas: any[] = [];
      try {
        const existing = await strapiRequest(`${putEndpoint}?populate[Teekas][populate]=*`, { method: "GET" });
        const raw = existing?.data?.Teekas ?? [];
        currentTeekas = raw.map((t: any) => {
          if (!t?.TeekaEntry || typeof t.TeekaEntry !== "object") return t;
          const rb = rebuildTextAndTranslationForStrapiPut(t.TeekaEntry as Record<string, any>);
          if (rb && Object.keys(rb).length > 0) return { ...t, TeekaEntry: rb };
          const { TeekaEntry: _omit, ...rest } = t;
          return rest;
        });
      } catch (fetchErr: any) {
        console.warn(
          `[publish] Teekas chunk: could not GET existing teekas for merge (${label}) — continuing with empty baseline:`,
          fetchErr?.message || fetchErr
        );
      }

      let warnedTeekaOtherTr = false;
      for (let i = 0; i < (Teekas as any[]).length; i++) {
        const teeka = (Teekas as any[])[i];
        // Build a Teekas array: existing teekas up to this point + this teeka + remaining without TeekaEntry
        const updatedTeekas = [
          ...currentTeekas.slice(0, i),
          teeka,
          ...(Teekas as any[]).slice(i + 1).map((t: any) => { const { TeekaEntry: _te, ...ref } = t; return ref; }),
        ];
        try {
          await strapiRequest(putEndpoint, { method: "PUT", body: JSON.stringify({ data: { Teekas: updatedTeekas } }) });
          currentTeekas = updatedTeekas;
        } catch (e3b: any) {
          if (e3b?.status !== 413) throw e3b;
          // This individual teeka is too large — strip its OtherTranslations
          const { TeekaEntry, ...teekaRef } = teeka;
          const { OtherTranslations: _to, ...teEntryCore } = TeekaEntry ?? {};
          const slimTeeka = TeekaEntry ? { ...teekaRef, TeekaEntry: teEntryCore } : teekaRef;
          const updatedSlim = [
            ...currentTeekas.slice(0, i),
            slimTeeka,
            ...(Teekas as any[]).slice(i + 1).map((t: any) => { const { TeekaEntry: _te, ...ref } = t; return ref; }),
          ];
          await strapiRequest(putEndpoint, { method: "PUT", body: JSON.stringify({ data: { Teekas: updatedSlim } }) });
          currentTeekas = updatedSlim;
          if (!warnedTeekaOtherTr) {
            warnings?.push({ manthra: label, error: `[WARNING] One or more TeekaEntry OtherTranslations could not be synced — too large even as individual requests. All other Teeka content was synced.` });
            warnedTeekaOtherTr = true;
          }
        }
      }
    }
  }

  console.log(`[publish] Manthra "${label}" fully synced via chunked requests`);
  return mainRes;
}

// Helper: update an existing Strapi manthra (PUT).
// On 413, automatically splits the payload into multiple requests so all
// content is synced without any data loss.
async function updateExistingManthra(
  strapiDocumentId: string,
  mData: Record<string, any>,
  label: string,
  warnings?: Array<{ manthra: string; error: string }>
): Promise<string> {
  await strapiManthraRequest(`/api/manthras/${strapiDocumentId}`, "PUT", mData, label, warnings);
  return strapiDocumentId;
}

// Extract a human-readable description from a Strapi error object or raw error message.
// Strapi wraps its real message inside JSON: { error: { message, details } }.
// This function unwraps it so users see "title must not be empty" instead of
// the full raw "Strapi error 400: {\"data\":null,\"error\":{...huge JSON...}}" blob.
function strapiErrorMessage(e: any): string {
  const raw: string = e?.message || String(e);
  // Try to parse the JSON body that strapiRequest embeds after "Strapi error NNN: "
  const match = raw.match(/Strapi error \d+: (\{.+)/s);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      const msg: string = parsed?.error?.message || "";
      const details = parsed?.error?.details;
      // ValidationError details often contain per-field error info
      let extra = "";
      if (details?.errors && Array.isArray(details.errors)) {
        extra = ": " + details.errors.map((d: any) => `${d.path?.join(".") || "field"} — ${d.message}`).join("; ");
      }
      if (msg) return msg + extra;
    } catch { /* fall through to raw */ }
  }
  // Simplify network/curl errors into something actionable
  if (raw.includes("curl large failed") || raw.includes("curl failed") || raw.includes("max-time")) {
    return "Strapi took too long to respond (large content fetch). Retry the snapshot in a minute.";
  }
  return raw;
}

// Returns true if the Strapi error looks like an orphaned-locale "document not found".
// Strapi v5 returns 400 ValidationError (not 404) when a document exists in the DB
// but its locale entry is null — e.g. "Document with id X, locale null not found".
function isOrphanedDocError(e: any): boolean {
  if (e?.status === 404) return true;
  if (e?.status === 400 && typeof e?.message === "string") {
    const lower = e.message.toLowerCase();
    // Strapi v5 uses several forms: "not found", "document not found", "invalid document id", "invalid id"
    return lower.includes("not found") || lower.includes("invalid") && lower.includes("id");
  }
  return false;
}

// Attempt to DELETE an orphaned manthra from Strapi so we can POST a clean replacement.
// The document exists in Strapi's DB but its locale entry is null, making PUT/publish
// fail. A DELETE is typically still accepted even for locale-null documents.
// Errors are swallowed — the subsequent POST will either succeed or produce its own error.
async function deleteOrphanedManthra(docId: string, label: string): Promise<void> {
  try {
    await strapiRequest(`/api/manthras/${docId}`, { method: "DELETE" });
    console.log(`[publish] Orphaned manthra "${label}" (${docId}) deleted from Strapi — will recreate`);
  } catch (delErr: any) {
    console.warn(`[publish] Could not delete orphaned manthra "${label}" (${docId}): ${delErr?.message?.slice(0, 120)} — proceeding to POST anyway`);
  }
}

function portalMantraLabel(manthra: Record<string, any>, mData?: Record<string, any>): string {
  return String(mData?.ShlokaManthraNumber ?? manthra.title ?? manthra.ShlokaManthraNumber ?? "").trim();
}

function mantraNumericSuffix(label: string): string | null {
  const m = label.match(/(\d+(?:\.\d+)+)\s*$/);
  return m ? m[1] : null;
}

function mantraLabelsShareNumber(a: string, b: string): boolean {
  const sa = mantraNumericSuffix(a);
  const sb = mantraNumericSuffix(b);
  if (!sa || !sb) return a.trim().toLowerCase() === b.trim().toLowerCase();
  return sa === sb;
}

function pickBestManthraDocIdFromStrapiRows(
  rows: Array<{ documentId?: string; order?: number }>,
  preferredDocId?: string,
): string | undefined {
  const valid = rows.filter((r) => typeof r.documentId === "string" && r.documentId.length >= 10);
  if (valid.length === 0) return undefined;
  if (preferredDocId) {
    const pref = valid.find((r) => r.documentId === preferredDocId);
    if (pref?.documentId) return pref.documentId;
  }
  const sorted = [...valid].sort((a, b) => {
    const oa = a.order ?? Number.MAX_SAFE_INTEGER;
    const ob = b.order ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return String(a.documentId).localeCompare(String(b.documentId));
  });
  return sorted[0]?.documentId;
}

/** Ensure a stored portal docId targets the grantha/section being published (prevents cross-text PUTs). */
async function manthraDocIdMatchesPublishContext(
  documentId: string,
  granthaDocId: string | undefined,
  sectionDocId: string | undefined,
): Promise<boolean> {
  const r = await strapiRequest(
    `/api/manthras/${documentId}?fields[0]=documentId&populate[Section][fields][0]=documentId&populate[Section][populate][grantha][fields][0]=documentId`,
  );
  const m = r?.data;
  if (!m) return false;
  const secId: string | undefined = m.Section?.documentId;
  const gId: string | undefined = m.Section?.grantha?.documentId;
  if (granthaDocId && gId && gId !== granthaDocId) return false;
  if (sectionDocId && secId && secId !== sectionDocId) return false;
  return true;
}

/** Find the Strapi manthra in a section whose ShlokaManthraNumber matches the portal label. */
// ── Per-section read cache ──────────────────────────────────────────────────
// During a grantha publish, listSectionMantraLabels / listSectionMantraSortKeys
// are called once per mantra by the dedup + integrity paths. For a 100-mantra
// section that was N round-trips → N pages of Strapi data refetched ~N times.
// Cache the result for a short TTL; intra-section writes call invalidateSectionReadCache
// to drop stale entries before the next read.
const SECTION_READ_TTL_MS = 30 * 1000;
const sectionReadCache = new Map<string, { at: number; data: unknown }>();
function sectionCacheGet<T>(key: string): T | undefined {
  const hit = sectionReadCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > SECTION_READ_TTL_MS) {
    sectionReadCache.delete(key);
    return undefined;
  }
  return hit.data as T;
}
function sectionCacheSet<T>(key: string, data: T): T {
  sectionReadCache.set(key, { at: Date.now(), data });
  if (sectionReadCache.size > 256) {
    // Prevent unbounded growth on long-running servers — drop oldest 64.
    const keys = [...sectionReadCache.keys()].slice(0, 64);
    for (const k of keys) sectionReadCache.delete(k);
  }
  return data;
}
export function invalidateSectionReadCache(sectionDocId: string): void {
  if (!sectionDocId) return;
  for (const k of sectionReadCache.keys()) {
    if (k.startsWith(`section:${sectionDocId}:`)) sectionReadCache.delete(k);
  }
}

async function listSectionMantraLabels(
  sectionDocId: string,
): Promise<Array<{ documentId: string; label: string }>> {
  const cacheKey = `section:${sectionDocId}:labels`;
  const cached = sectionCacheGet<Array<{ documentId: string; label: string }>>(cacheKey);
  if (cached) return cached;
  const s = encodeURIComponent(sectionDocId);
  const all: Array<{ documentId: string; label: string }> = [];
  let page = 1;
  while (true) {
    const r = await strapiRequest(
      `/api/manthras?filters[Section][documentId][$eq]=${s}&fields[0]=documentId&fields[1]=ShlokaManthraNumber&pagination[pageSize]=100&pagination[page]=${page}`,
    );
    for (const row of r.data ?? []) {
      if (typeof row.documentId === "string") {
        all.push({
          documentId: row.documentId,
          label: String(row.ShlokaManthraNumber ?? "").trim(),
        });
      }
    }
    if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  return sectionCacheSet(cacheKey, all);
}

async function fetchManthraStrapiLabel(documentId: string): Promise<string | undefined> {
  try {
    const r = await strapiRequest(
      `/api/manthras/${documentId}?fields[0]=ShlokaManthraNumber`,
    );
    return String(r?.data?.ShlokaManthraNumber ?? "").trim() || undefined;
  } catch {
    return undefined;
  }
}

async function fetchMantraOrderByDocId(documentId: string): Promise<number | undefined> {
  try {
    const r = await strapiRequest(`/api/manthras/${documentId}?fields[0]=order`);
    const o = r?.data?.order;
    return typeof o === "number" && !Number.isNaN(o) ? o : undefined;
  } catch {
    return undefined;
  }
}

async function fetchMantraOrdersByDocIds(docIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(docIds.filter((id) => typeof id === "string" && id.length >= 10))];
  await Promise.all(
    unique.map(async (id) => {
      const o = await fetchMantraOrderByDocId(id);
      if (o != null) out.set(id, o);
    }),
  );
  return out;
}

/** One Strapi list call instead of N teeka lookups during single-mantra publish. */
async function loadGranthaTeekaNameToDocId(granthaDocId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const g = encodeURIComponent(granthaDocId);
  let page = 1;
  while (true) {
    const r = await strapiRequest(
      `/api/teekas?filters[grantha][documentId][$eq]=${g}&fields[0]=documentId&fields[1]=TeekaName&pagination[pageSize]=100&pagination[page]=${page}`,
    );
    for (const row of r.data ?? []) {
      const name = String(row.TeekaName ?? "").trim().toLowerCase();
      if (name && typeof row.documentId === "string") map.set(name, row.documentId);
    }
    if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  return map;
}

async function findManthraDocIdByLabelInSection(
  sectionDocId: string,
  label: string,
  preferredDocId?: string,
): Promise<string | undefined> {
  const trimmed = label.trim();
  if (!trimmed || !sectionDocId) return undefined;
  const n = encodeURIComponent(trimmed);
  const s = encodeURIComponent(sectionDocId);
  const existing = await strapiRequest(
    `/api/manthras?filters[ShlokaManthraNumber][$eqi]=${n}&filters[Section][documentId][$eq]=${s}&fields[0]=documentId&fields[1]=order&pagination[pageSize]=25`,
  );
  const rows: any[] = existing?.data ?? [];
  return pickBestManthraDocIdFromStrapiRows(rows, preferredDocId);
}

/**
 * Resolve which Strapi document should receive a publish PUT.
 * The portal hierarchy `title` (e.g. "Shloka 1.1.5") is authoritative — never write content
 * to a stored docId whose ShlokaManthraNumber points at a different verse.
 */
async function resolveManthraDocIdForPublish(
  manthra: Record<string, any>,
  sectionDocId: string | undefined,
  mData: Record<string, any>,
  granthaDocId?: string,
  options?: { fastSinglePublish?: boolean; republishFresh?: boolean },
  // documentIds owned (via strapiDocumentId) by OTHER portal verses in this same publish.
  // A verse must never resolve — by label — onto a row that is another verse's identity,
  // or an inserted verse would steal the renumbered verse's row (and its bhashyam/teeka).
  reservedDocIds: Set<string> = new Set(),
): Promise<string | undefined> {
  if (options?.republishFresh) return undefined;

  const portalLabel = portalMantraLabel(manthra, mData);
  const stored =
    typeof manthra.strapiDocumentId === "string" && manthra.strapiDocumentId.length >= 10
      ? manthra.strapiDocumentId
      : undefined;

  if (!sectionDocId) return stored;

  // Single-mantra publish: hierarchy docId is authoritative (avoids 2–3 Strapi round-trips).
  if (options?.fastSinglePublish && stored) {
    return stored;
  }

  const preferred = stored;

  const resolveFromSectionRows = async (): Promise<string | undefined> => {
    if (!portalLabel) return undefined;
    const allRows = await listSectionMantraLabels(sectionDocId);
    // Never adopt a row that is another verse's immutable identity.
    const rows =
      reservedDocIds.size > 0 ? allRows.filter((r) => !reservedDocIds.has(r.documentId)) : allRows;
    const byExact = findDocIdByExactLabelInRows(rows, portalLabel, preferred);
    if (byExact) return byExact;
    const bySuffix = pickDocIdForSuffixInSectionRows(rows, portalLabel, preferred);
    if (bySuffix) return bySuffix;
    const byFetch = await findManthraDocIdByLabelInSection(sectionDocId, portalLabel, preferred);
    return byFetch && !reservedDocIds.has(byFetch) ? byFetch : undefined;
  };

  // documentId is the verse's immutable identity. When the portal link points at a row that
  // belongs to this grantha/section and isn't claimed by any OTHER sibling, TRUST it — even if
  // the CMS label still lags a renumber (portal "1.1.3" vs CMS "1.1.2"). This publish relabels
  // the row. Re-resolving by label here is what let an inserted "1.1.2" hijack the old verse's
  // row, and pushed the renumbered verse onto a fresh blank row without its commentary.
  if (stored) {
    try {
      const ok = await manthraDocIdMatchesPublishContext(stored, granthaDocId, sectionDocId);
      if (ok) {
        if (!reservedDocIds.has(stored)) return stored;
        // Conflict: another sibling claims the same docId too — fall back to label resolution
        // for this verse so the two don't both write to the same row.
        if (!portalLabel) return stored;
        const adopted = await resolveFromSectionRows();
        if (adopted) {
          console.warn(
            `[publish] strapiDocumentId ${stored} is claimed by multiple portal verses — publishing "${portalLabel}" to ${adopted} instead`,
          );
          return adopted;
        }
        return stored;
      }
      console.warn(
        `[publish] Ignoring strapiDocumentId ${stored} — mantra belongs to a different grantha/section than this publish`,
      );
    } catch (e: any) {
      if (!isOrphanedDocError(e)) {
        console.warn(`[publish] Stored doc ${stored} lookup failed:`, e?.message || e);
      }
    }
  }

  return resolveFromSectionRows();
}

type PortalManthraSibling = { id?: string; strapiDocumentId?: string; order?: number };

async function listSectionMantraSortKeys(
  sectionDocId: string,
): Promise<Array<{ documentId: string; order: number }>> {
  const cacheKey = `section:${sectionDocId}:sortKeys`;
  const cached = sectionCacheGet<Array<{ documentId: string; order: number }>>(cacheKey);
  if (cached) return cached;
  const sectionFilter = encodeURIComponent(sectionDocId);
  const listQuery = [
    `filters[Section][documentId][$eq]=${sectionFilter}`,
    "fields[0]=documentId",
    "fields[1]=order",
    "pagination[pageSize]=100",
    "sort=order:asc",
  ].join("&");

  const all: Array<{ documentId: string; order: number }> = [];
  let page = 1;
  while (true) {
    const r = await strapiRequest(`/api/manthras?${listQuery}&pagination[page]=${page}`);
    for (const row of r.data ?? []) {
      if (typeof row.documentId === "string") {
        all.push({
          documentId: row.documentId,
          order: typeof row.order === "number" ? row.order : 0,
        });
      }
    }
    if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  all.sort((a, b) => a.order - b.order);
  return sectionCacheSet(cacheKey, all);
}

/**
 * Strapi `order` is a fractional sort key. Portal `order` 1..n is display-only.
 * - Existing rows: keep CMS sort key on fast single publish; full publish uses spaced keys from portal index.
 * - New rows: key between Strapi neighbors of portal prev/next siblings.
 */
async function resolvePublishSortKey(
  manthra: Record<string, any>,
  sectionDocId: string | undefined,
  options?: { fastSinglePublish?: boolean; portalSiblings?: PortalManthraSibling[] },
): Promise<number | undefined> {
  if (!sectionDocId) return undefined;

  const stored =
    typeof manthra.strapiDocumentId === "string" && manthra.strapiDocumentId.length >= 10
      ? manthra.strapiDocumentId
      : undefined;

  // Fast single-mantra publish: one GET — not a full section walk (often 100+ mantras).
  if (options?.fastSinglePublish && stored) {
    const existing = await fetchMantraOrderByDocId(stored);
    if (existing != null) return existing;
  }

  const siblings = options?.portalSiblings;
  if (options?.fastSinglePublish && siblings && siblings.length > 0) {
    const sorted = [...siblings].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const idx = sorted.findIndex((s) => s.id === manthra.id);
    if (idx >= 0) {
      const prevDoc = idx > 0 ? sorted[idx - 1]?.strapiDocumentId : undefined;
      const nextDoc = idx < sorted.length - 1 ? sorted[idx + 1]?.strapiDocumentId : undefined;
      const neighborIds = [prevDoc, nextDoc, stored].filter(
        (id): id is string => typeof id === "string" && id.length >= 10,
      );
      const orderByDocId = await fetchMantraOrdersByDocIds(neighborIds);
      if (stored && orderByDocId.has(stored)) {
        return orderByDocId.get(stored);
      }
      const prevSort = prevDoc ? orderByDocId.get(prevDoc) : undefined;
      const nextSort = nextDoc ? orderByDocId.get(nextDoc) : undefined;
      return sortKeyBetween(prevSort, nextSort).sortKey;
    }
  }

  if (options?.fastSinglePublish) {
    const portalOrder = Number(manthra.order);
    if (!Number.isNaN(portalOrder) && portalOrder > 0) {
      if (portalOrder >= STRAPI_SORT_GAP) return portalOrder;
      return portalIndexToStrapiSortKey(portalOrder);
    }
    return undefined;
  }

  // Grantha-publish hot path: when portal siblings are provided and this manthra is
  // in the list, the sort key is just the portal index spaced by GAP. No Strapi state
  // is needed — skipping listSectionMantraSortKeys here removes a paged GET per mantra
  // (cached at TTL, but still wasted CPU on the cached deserialize for large sections).
  if (siblings && siblings.length > 0) {
    const sorted = [...siblings].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const idx = sorted.findIndex((s) => s.id === manthra.id);
    if (idx >= 0) {
      return portalIndexToStrapiSortKey(idx + 1);
    }
  }

  // Fall back to the live Strapi state only when portal siblings can't anchor us.
  const strapiRows = await listSectionMantraSortKeys(sectionDocId);
  const orderByDocId = new Map(strapiRows.map((r) => [r.documentId, r.order]));

  if (stored && orderByDocId.has(stored)) {
    return orderByDocId.get(stored);
  }

  const portalOrder = Number(manthra.order);
  if (!Number.isNaN(portalOrder) && portalOrder > 0) {
    if (portalOrder >= STRAPI_SORT_GAP) return portalOrder;
    return portalIndexToStrapiSortKey(portalOrder);
  }
  return undefined;
}

/** Publish one mantra: content + ShlokaManthraNumber; sort key from fractional CMS ordering. */
async function publishManthraToStrapi(
  manthra: Record<string, any>,
  sectionDocId: string | undefined,
  granthaDocId: string | undefined,
  teekaNameToDocId: Map<string, string> | undefined,
  publishFailures: Array<{ manthra: string; error: string }>,
  options?: {
    fastSinglePublish?: boolean;
    portalSiblings?: PortalManthraSibling[];
    configuredLeaf?: string;
    granthaName?: string;
    /** Editor explicitly approved a verse renumber — relaxes the suffix-stability guard only. */
    allowRenumber?: boolean;
    /** Publish every mantra as a new CMS row under a fresh grantha tree. */
    republishFresh?: boolean;
  },
): Promise<string | undefined> {
  try {
    return await publishManthraToStrapiInner(
      manthra,
      sectionDocId,
      granthaDocId,
      teekaNameToDocId,
      publishFailures,
      options,
    );
  } finally {
    // Drop cached section reads after this mantra's writes so the NEXT publish in
    // the same section observes our changes (label, sort key, new docId).
    if (sectionDocId) invalidateSectionReadCache(sectionDocId);
  }
}

async function publishManthraToStrapiInner(
  manthra: Record<string, any>,
  sectionDocId: string | undefined,
  granthaDocId: string | undefined,
  teekaNameToDocId: Map<string, string> | undefined,
  publishFailures: Array<{ manthra: string; error: string }>,
  options?: {
    fastSinglePublish?: boolean;
    portalSiblings?: PortalManthraSibling[];
    configuredLeaf?: string;
    granthaName?: string;
    /** Editor explicitly approved a verse renumber — relaxes the suffix-stability guard only. */
    allowRenumber?: boolean;
    republishFresh?: boolean;
  },
): Promise<string | undefined> {
  const configuredLeaf = (options?.configuredLeaf || "Mantra").trim() || "Mantra";
  let normalizedTitle = portalMantraTitleForConfiguredLeaf(
    manthra.title || manthra.ShlokaManthraNumber,
    configuredLeaf,
    manthra.ShlokaManthraNumber,
  );
  if (!normalizedTitle.trim() && options?.portalSiblings?.length) {
    const sorted = [...options.portalSiblings].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const idx = sorted.findIndex((s) => s.id === manthra.id);
    if (idx >= 0) {
      normalizedTitle = canonicalMantraTitle(configuredLeaf, `1.${idx + 1}`);
    }
  }
  if (
    !normalizedTitle.trim() &&
    isBareLeafCounterLabel(manthra.title || manthra.ShlokaManthraNumber, configuredLeaf)
  ) {
    normalizedTitle = "";
  }
  if (normalizedTitle !== (manthra.title ?? "").trim()) {
    manthra = { ...manthra, title: normalizedTitle };
  }
  const portalLabel = (manthra.title || manthra.ShlokaManthraNumber || "").trim();
  const prelimData = { ShlokaManthraNumber: portalLabel };
  // documentIds owned by OTHER verses in this section's publish. Their rows are those verses'
  // identities and must never be adopted (by label) for this verse — that is the insert/renumber
  // "bhashyam tags along with the new verse" corruption.
  const reservedDocIds = new Set<string>();
  for (const sib of options?.portalSiblings ?? []) {
    if (
      sib.id !== manthra.id &&
      typeof sib.strapiDocumentId === "string" &&
      sib.strapiDocumentId.length >= 10
    ) {
      reservedDocIds.add(sib.strapiDocumentId);
    }
  }
  let targetDocId = await resolveManthraDocIdForPublish(
    manthra,
    sectionDocId,
    prelimData,
    granthaDocId,
    options,
    reservedDocIds,
  );
  const label = portalLabel || manthra.title || "(unknown)";
  const publishOrder = await resolvePublishSortKey(manthra, sectionDocId, options);
  const portalLinkedDocumentId =
    typeof manthra.strapiDocumentId === "string" && manthra.strapiDocumentId.length >= 10
      ? manthra.strapiDocumentId
      : undefined;

  if (
    isPublishIntegrityEnabled() &&
    !options?.fastSinglePublish &&
    sectionDocId &&
    portalLabel
  ) {
    const allRows = await listSectionMantraLabels(sectionDocId);
    // A row owned by another sibling is that verse's identity — exclude it so a label
    // collision can't make this verse adopt (and overwrite) another verse's row.
    const rows =
      reservedDocIds.size > 0
        ? allRows.filter((r) => !reservedDocIds.has(r.documentId))
        : allRows;
    const labelMap = new Map(rows.map((r) => [r.label, r.documentId]));
    const collision = sectionSuffixCollision(
      rows.map((r) => r.label),
      portalLabel,
      targetDocId,
      labelMap,
    );
    if (collision) {
      const adopt = pickDocIdForSuffixInSectionRows(
        rows,
        portalLabel,
        targetDocId ?? portalLinkedDocumentId,
      );
      if (adopt) {
        if (adopt !== targetDocId) {
          console.warn(
            `[publish] Suffix collision for "${portalLabel}" — updating existing row ${adopt} instead of creating`,
          );
        }
        targetDocId = adopt;
      } else {
        publishFailures.push({ manthra: portalLabel, error: collision.message });
        return undefined;
      }
    }
  }

  if (targetDocId && !manthraHasLocalPublishableContent(manthra)) {
    const order = publishOrder;
    try {
      return await updateManthraIdentityOnly(targetDocId, label, order, publishFailures);
    } catch (putErr: any) {
      if (isOrphanedDocError(putErr)) {
        console.warn(
          `[publish] Manthra "${label}" identity PUT orphaned (${targetDocId}), recreating`,
        );
        await deleteOrphanedManthra(targetDocId, label);
        const byLabel = sectionDocId
          ? await findManthraDocIdByLabelInSection(sectionDocId, label, manthra.strapiDocumentId)
          : undefined;
        if (byLabel) {
          return updateManthraIdentityOnly(byLabel, label, order, publishFailures);
        }
        return createOrUpdateManthra(
          { ShlokaManthraNumber: label, order, Section: sectionDocId },
          label,
          publishFailures,
          false,
        );
      }
      throw putErr;
    }
  }

  const manthraForBuild =
    targetDocId && targetDocId !== manthra.strapiDocumentId
      ? { ...manthra, strapiDocumentId: targetDocId }
      : manthra;
  const mData = await buildManthraData(
    manthraForBuild,
    sectionDocId,
    granthaDocId,
    teekaNameToDocId,
    options,
  );
  if (portalLabel) {
    mData.ShlokaManthraNumber = portalLabel;
  }
  if (publishOrder != null && !Number.isNaN(publishOrder)) {
    mData.order = publishOrder;
  }

  const fullLabel = portalMantraLabel(manthra, mData) || manthra.title || "(unknown)";

  if (isPublishIntegrityEnabled()) {
    const existingStrapiLabel =
      targetDocId && !options?.fastSinglePublish
        ? await fetchManthraStrapiLabel(targetDocId)
        : undefined;
    const entry = mData.ShlokaManthraEntry ?? manthra.ShlokaManthraEntry;
    const { sk, en } = plainTextFromManthraEntry(entry);
    const violations = scanMantraForPublish({
      portalLabel: fullLabel,
      configuredLeaf,
      granthaName: options?.granthaName,
      targetDocumentId: targetDocId,
      existingStrapiLabel,
      sanskritPlain: sk,
      englishPlain: en,
      allowRenumber: options?.allowRenumber,
      portalLinkedDocumentId,
    });
    const hard = violations.filter((v) => v.severity === "error");
    if (hard.length > 0) {
      const msg = formatIntegrityFailures(hard);
      console.warn(`[publish] Integrity block "${fullLabel}": ${msg}`);
      publishFailures.push({ manthra: fullLabel, error: msg });
      return undefined;
    }
  }

  if (targetDocId && Object.keys(mData).length === 0) {
    return targetDocId;
  }

  if (targetDocId) {
    try {
      return await updateExistingManthra(targetDocId, mData, fullLabel, publishFailures);
    } catch (putErr: any) {
      if (isOrphanedDocError(putErr)) {
        console.warn(
          `[publish] Manthra "${fullLabel}" — PUT ${putErr?.status} orphaned (docId ${targetDocId}), deleting then recreating`,
        );
        await deleteOrphanedManthra(targetDocId, fullLabel);
        return createOrUpdateManthra(mData, fullLabel, publishFailures, true);
      }
      throw putErr;
    }
  }

  return createOrUpdateManthra(mData, fullLabel, publishFailures);
}

// Helper: create a manthra in Strapi if one with the same ShlokaManthraNumber+Section doesn't exist.
// If one IS found, UPDATE it so that content changes (teeka entries, shloka text, etc.)
// are never silently discarded.  A manthra can end up here without a stored strapiDocumentId
// when the draft was created before Strapi IDs were synced back, but the manthra already
// exists in Strapi — skipping it would throw away the user's edits.
// Returns the Strapi documentId of the manthra that was created or updated,
// so callers can sync it back into the portal draft hierarchy.
// skipLookup=true skips the dedup search and goes straight to POST — use this when
// the caller already knows the stored docId is orphaned (the search would only return
// the same dead docId, causing a second identical failure).
async function createOrUpdateManthra(
  mData: Record<string, any>,
  label: string,
  warnings?: Array<{ manthra: string; error: string }>,
  skipLookup = false
): Promise<string | undefined> {
  const sectionDocId: string | undefined = mData.Section;
  const number: string | undefined = mData.ShlokaManthraNumber;
  const labelErr = validateMantraLabelForCmsCreate(number ?? label);
  if (labelErr) {
    console.warn(`[publish] Refusing to create manthra without label: ${labelErr}`);
    warnings?.push({ manthra: label || "(no label)", error: labelErr });
    return undefined;
  }

  // skipLookup=true is used when the caller already tried a direct PUT that failed
  // with an orphaned-document error.  In that case the Strapi search might return
  // the same dead docId (the document exists in the DB but its locale entry is
  // null), so we skip the dedup lookups and go straight to POST.
  if (!skipLookup && sectionDocId) {
    const s = encodeURIComponent(sectionDocId);

    if (number?.trim()) {
      const rows = await listSectionMantraLabels(sectionDocId);
      const labelMap = new Map(rows.map((r) => [r.label, r.documentId]));
      const reuseDocId =
        findDocIdByExactLabelInRows(rows, number.trim()) ??
        pickDocIdForSuffixInSectionRows(rows, number.trim());
      if (reuseDocId) {
        console.log(
          `[publish] Manthra "${label}" already exists in section (by label or suffix) — updating`,
        );
        try {
          return await updateExistingManthra(reuseDocId, mData, label, warnings);
        } catch (updateErr: any) {
          if (isOrphanedDocError(updateErr)) {
            console.warn(
              `[publish] Manthra "${label}" — found by label/suffix but docId ${reuseDocId} is orphaned, deleting then recreating`,
            );
            await deleteOrphanedManthra(reuseDocId, label);
          } else {
            throw updateErr;
          }
        }
      }
      if (isPublishIntegrityEnabled()) {
        const collision = sectionSuffixCollision(
          rows.map((r) => r.label),
          number.trim(),
          undefined,
          labelMap,
        );
        if (collision) {
          const reuseOnCollision =
            pickDocIdForSuffixInSectionRows(rows, number.trim()) ??
            findDocIdByExactLabelInRows(rows, number.trim());
          if (reuseOnCollision) {
            console.log(
              `[publish] Manthra "${label}" — suffix already in section, updating ${reuseOnCollision}`,
            );
            try {
              return await updateExistingManthra(reuseOnCollision, mData, label, warnings);
            } catch (updateErr: any) {
              if (!isOrphanedDocError(updateErr)) throw updateErr;
              await deleteOrphanedManthra(reuseOnCollision, label);
            }
          } else {
            const msg = collision.message;
            console.warn(`[publish] Manthra "${label}" blocked: ${msg}`);
            warnings?.push({ manthra: label, error: msg });
            return undefined;
          }
        }
      }
    }

    // 1) ShlokaManthraNumber match within the same section — case-insensitive + trimmed
    //    so "Mantra 1.1.2" and "mantra 1.1.2 " are treated as the same manthra.
    if (number) {
      try {
        const n = encodeURIComponent(number.trim());
        const existing = await strapiRequest(
          `/api/manthras?filters[ShlokaManthraNumber][$eqi]=${n}&filters[Section][documentId][$eq]=${s}&fields[0]=documentId&fields[1]=order&pagination[pageSize]=25`,
        );
        const existingDocId = pickBestManthraDocIdFromStrapiRows(existing?.data ?? [], undefined);
        if (existingDocId) {
          console.log(`[publish] Manthra "${label}" already exists (by name) — updating instead of skipping`);
          try {
            return await updateExistingManthra(existingDocId, mData, label + " [auto-update]", warnings);
          } catch (updateErr: any) {
            if (isOrphanedDocError(updateErr)) {
              // The docId returned by the lookup is itself orphaned (locale null).
              // Delete it from Strapi first so the subsequent POST can succeed cleanly.
              console.warn(`[publish] Manthra "${label}" — found by name but docId ${existingDocId} is orphaned, deleting then recreating`);
              await deleteOrphanedManthra(existingDocId, label);
            } else {
              throw updateErr;
            }
          }
        }
      } catch (e: any) {
        if (!isOrphanedDocError(e)) throw e;
        // orphaned update error already logged above; fall through to create
      }
    }

    // 2) Order match — only when the portal did not supply a verse label (avoid writing to the wrong row).
    // Portal display order is 1..n; Strapi uses fractional sort keys (1000+). Never match raw portal index to CMS order.
    const portalOrderNum = mData.order != null ? Number(mData.order) : NaN;
    if (!number?.trim() && !Number.isNaN(portalOrderNum) && portalOrderNum >= STRAPI_SORT_GAP) {
      try {
        const o = encodeURIComponent(String(portalOrderNum));
        const existingByOrder = await strapiRequest(
          `/api/manthras?filters[order][$eq]=${o}&filters[Section][documentId][$eq]=${s}&fields[0]=documentId`
        );
        const existingDocId: string | undefined = existingByOrder?.data?.[0]?.documentId;
        if (existingDocId) {
          console.log(`[publish] Manthra "${label}" already exists (by order=${portalOrderNum}) — updating instead of skipping`);
          try {
            return await updateExistingManthra(existingDocId, mData, label + " [auto-update by order]", warnings);
          } catch (updateErr: any) {
            if (isOrphanedDocError(updateErr)) {
              console.warn(`[publish] Manthra "${label}" — found by order but docId ${existingDocId} is orphaned, deleting then recreating`);
              await deleteOrphanedManthra(existingDocId, label);
            } else {
              throw updateErr;
            }
          }
        }
      } catch (e: any) {
        if (!isOrphanedDocError(e)) throw e;
      }
    }
  }

  const mr = await strapiManthraRequest("/api/manthras", "POST", mData, label, warnings);
  const createdDocId: string | undefined = mr?.data?.documentId;
  console.log(`[publish] Manthra "${label}" created: ${createdDocId}`);
  return createdDocId;
}

/** Admin grantha lock: block Strapi publish while locked (matches portal view-only behaviour). */
async function assertGranthaPublishNotLocked(strapiGranthaDocId: string | null | undefined): Promise<void> {
  if (!strapiGranthaDocId || strapiGranthaDocId.length < 10) return;
  const lock = await storage.getGranthaLock(strapiGranthaDocId);
  if (!lock) return;
  const err: any = new Error(
    "This grantha is locked for editing by an administrator. Publishing is disabled until the lock is removed."
  );
  err.status = 403;
  err.code = "grantha_locked";
  throw err;
}

async function publishGranthaWithHierarchy(
  draft: any,
  jobId?: string,
  onProgress?: (
    done: number,
    total: number,
    current: string,
    meta?: {
      breakdown?: import("@shared/grantha-publish-progress").GranthaPublishProgressBreakdown;
      summary?: string;
    },
  ) => void,
  publishOptions?: { allowRenumber?: boolean; republishFresh?: boolean },
): Promise<any> {
  const allowRenumber = !!publishOptions?.allowRenumber;
  let republishFresh =
    !!publishOptions?.republishFresh || (allowRenumber && !!draft.strapiDocumentId);
  let oldGranthaDocIdForCleanup: string | undefined;

  await assertGranthaPublishNotLocked(draft.strapiDocumentId);
  const rawData = draft.data as Record<string, any>;
  // Strip wizard-only / local-format fields from the Grantha payload
  const {
    teekas: teekaDefinitions,
    hierarchy: hierarchyRaw,
    structureConfig,
    // Always compute NumberOfTeekas from the actual teekas array, never from stored form data
    NumberOfTeekas: _NumberOfTeekas,
    otherTranslations: _otherLocal,
    granthaNameTranslations: granthaNameTranslationsLocal,
    deletedStrapiSectionDocIds,
    deletedStrapiManthraDocIds,
    deletedStrapiTeekaDocIds,
    publishScope: _publishScope,
    ...granthaDataRaw
  } = rawData;

  let hierarchy = hierarchyRaw;
  if (republishFresh && draft.strapiDocumentId) {
    oldGranthaDocIdForCleanup = draft.strapiDocumentId;
    console.log(
      `[publish] Fresh republish: portal draft replaces CMS grantha ${oldGranthaDocIdForCleanup}`,
    );
    if (Array.isArray(hierarchy)) {
      hierarchy = stripHierarchyStrapiLinksForFreshPublish(hierarchy);
    }
    draft = { ...draft, strapiDocumentId: undefined };
  }

  const granthaPayload = cleanPayloadForStrapi(stripPortalMetaFromGranthaPayload(granthaDataRaw));

  // BhashyamAuthor is a Strapi enum. Drafts can carry prasthana spellings or
  // admin-added custom values that aren't in the grantha enum, which makes Strapi
  // reject the publish with a 400 ValidationError. Normalize to an allowed value,
  // or drop the field entirely so publish succeeds for granthas without a bhashyam.
  const resolvedBhashyamAuthor = resolveAllowedBhashyamAuthor(granthaPayload.BhashyamAuthor);
  if (resolvedBhashyamAuthor) {
    granthaPayload.BhashyamAuthor = resolvedBhashyamAuthor;
  } else if ("BhashyamAuthor" in granthaPayload) {
    delete granthaPayload.BhashyamAuthor;
  }

  // ── Progress tracking ─────────────────────────────────────────────────────
  // All three bindings use const/let (not function declarations) so they are
  // NOT hoisted. Any call site that appears above these lines will get a
  // ReferenceError on the function name itself — making the dependency chain
  // self-enforcing rather than relying on code placement conventions.
  let _progressDone = 0;
  const _publishProgressPlan = buildGranthaPublishProgressPlan({
    hierarchy,
    teekaDefinitions,
    levelThreeEnabled: !!structureConfig?.levelThreeEnabled,
    levelTwoEnabled: structureConfig?.levelTwoEnabled !== false,
  });
  const _progressTotal = _publishProgressPlan.total;
  console.log("[publish] progress plan", {
    granthaId: draft.strapiDocumentId ?? draft.id,
    draftTitle: draft.title,
    totalItems: _progressTotal,
    breakdown: {
      grantha: _publishProgressPlan.grantha,
      teekas: _publishProgressPlan.teekas,
      adhyayas: _publishProgressPlan.adhyayas,
      khandas: _publishProgressPlan.khandas,
      padas: _publishProgressPlan.padas,
      mantras: _publishProgressPlan.mantras,
    },
    summary: _publishProgressPlan.summary,
  });
  const reportProgress = (current: string, entityType?: string): void => {
    _progressDone++;
    if (entityType) {
      console.log(
        `[publish][progress] ${_progressDone}/${_progressTotal} ${entityType}: ${current}`,
      );
    }
    onProgress?.(_progressDone, _progressTotal, current);
  };
  onProgress?.(0, _progressTotal, _publishProgressPlan.summary, {
    breakdown: _publishProgressPlan,
    summary: _publishProgressPlan.summary,
  });

  // Strapi requires BhashyakaraIntroduction.SanskritTextEntry to always be present
  // when BhashyakaraIntroduction is included. cleanPayloadForStrapi may have stripped
  // it out if it was empty (empty array → dropped). Ensure it exists with a default.
  if (
    granthaPayload.BhashyakaraIntroduction &&
    !granthaPayload.BhashyakaraIntroduction.SanskritTextEntry
  ) {
    granthaPayload.BhashyakaraIntroduction.SanskritTextEntry = [
      { type: "paragraph", children: [{ type: "text", text: "" }] },
    ];
  }

  // Set NumberOfTeekas from the wizard's teeka count (Strapi expects a number, 0 is valid)
  granthaPayload.NumberOfTeekas = Array.isArray(teekaDefinitions) ? teekaDefinitions.length : 0;

  // Convert local granthaNameTranslations → Strapi GranthaNameTranslations format.
  // The shared.translations component uses TranslationText (blocks) not GranthaNameTranslation.
  // Skip entries that don't have a language selected — Strapi's enum rejects empty/missing values.
  if (Array.isArray(granthaNameTranslationsLocal) && granthaNameTranslationsLocal.length > 0) {
    const validNameTranslations = granthaNameTranslationsLocal.filter((t: any) => t.language?.trim());
    if (validNameTranslations.length > 0) {
      granthaPayload.GranthaNameTranslations = validNameTranslations.map((t: any) => ({
        LanguageOfTranslation: t.language,
        TranslationText: t.name
          ? [{ type: "paragraph", children: [{ type: "text", text: t.name }] }]
          : [{ type: "paragraph", children: [{ type: "text", text: "" }] }],
      }));
    }
  }

  // 1. Create or update the Grantha record
  let strapiResult: any;
  if (republishFresh) {
    scrubLeakedPortalKeysFromStrapiPayload(
      granthaPayload,
      "POST /api/granthas (fresh structural republish)",
    );
    console.log(
      `[publish] Fresh republish — POST /api/granthas keys:`,
      Object.keys(granthaPayload).sort().join(", "),
    );
    strapiResult = await strapiRequest("/api/granthas", {
      method: "POST",
      body: JSON.stringify({ data: granthaPayload }),
    });
  } else if (draft.strapiDocumentId) {
    const existingG = await fetchGranthaTranslationsForMerge(draft.strapiDocumentId);
    mergeGranthaPayloadWithExistingStrapiTranslations(granthaPayload, existingG);
    scrubMergedGranthaRepeatableComponents(granthaPayload);
    if (
      granthaPayload.BhashyakaraIntroduction &&
      !granthaPayload.BhashyakaraIntroduction.SanskritTextEntry
    ) {
      granthaPayload.BhashyakaraIntroduction.SanskritTextEntry = [
        { type: "paragraph", children: [{ type: "text", text: "" }] },
      ];
    }
    // We already know the Strapi record — update it
    scrubLeakedPortalKeysFromStrapiPayload(
      granthaPayload,
      `PUT /api/granthas/${draft.strapiDocumentId}`,
    );
    console.log(
      `[publish] Strapi PUT /api/granthas/${draft.strapiDocumentId} keys:`,
      Object.keys(granthaPayload).sort().join(", "),
    );
    strapiResult = await strapiRequest(`/api/granthas/${draft.strapiDocumentId}`, {
      method: "PUT",
      body: JSON.stringify({ data: granthaPayload }),
    });
  } else {
    // Check whether a Grantha with the same name already exists in Strapi
    // to avoid creating duplicates when the same text is published more than once.
    // Uses case-insensitive ($eqi) matching and normalizes trailing whitespace.
    let existingDocId: string | undefined;
    if (granthaPayload.GranthaName) {
      try {
        const trimmedName = (granthaPayload.GranthaName as string).trim();
        const searchName = encodeURIComponent(trimmedName);
        // First try case-insensitive exact match ($eqi supported in Strapi v5)
        const existing = await strapiRequest(
          `/api/granthas?filters[GranthaName][$eqi]=${searchName}&fields[0]=documentId&fields[1]=GranthaName`
        );
        existingDocId = existing?.data?.[0]?.documentId;
      } catch {
        // ignore — fall back to creating
      }
    }

    if (existingDocId) {
      const existingG = await fetchGranthaTranslationsForMerge(existingDocId);
      mergeGranthaPayloadWithExistingStrapiTranslations(granthaPayload, existingG);
      scrubMergedGranthaRepeatableComponents(granthaPayload);
      if (
        granthaPayload.BhashyakaraIntroduction &&
        !granthaPayload.BhashyakaraIntroduction.SanskritTextEntry
      ) {
        granthaPayload.BhashyakaraIntroduction.SanskritTextEntry = [
          { type: "paragraph", children: [{ type: "text", text: "" }] },
        ];
      }
      scrubLeakedPortalKeysFromStrapiPayload(granthaPayload, `PUT /api/granthas/${existingDocId}`);
      strapiResult = await strapiRequest(`/api/granthas/${existingDocId}`, {
        method: "PUT",
        body: JSON.stringify({ data: granthaPayload }),
      });
    } else {
      scrubLeakedPortalKeysFromStrapiPayload(granthaPayload, "POST /api/granthas");
      strapiResult = await strapiRequest("/api/granthas", {
        method: "POST",
        body: JSON.stringify({ data: granthaPayload }),
      });
    }
  }

  const granthaDocId: string | undefined = strapiResult?.data?.documentId;
  reportProgress("Grantha record", "grantha");

  // 2. Publish teekas (best-effort) — create each teeka and link to this grantha.
  // Also build a TeekaName→Strapi-documentId map so step 3 can resolve teekas instantly
  // without extra API lookups, even for teekas created for the first time right now.
  const teekaNameToDocId: Map<string, string> = new Map();
  if (Array.isArray(teekaDefinitions) && granthaDocId) {
    const teekaAuthorAllow = await getTeekaAuthorsAllowlist();
    // Normalize wizard entries first (skip duplicates / blanks).
    type TeekaCandidate = { effectiveName: string; validAuthor?: string };
    const candidates: TeekaCandidate[] = [];
    const seen = new Set<string>();
    for (const teeka of teekaDefinitions) {
      const validAuthor = resolveAllowedTeekaAuthor(teeka.TeekaAuthor, teekaAuthorAllow);
      const effectiveName = (teeka.TeekaName || "").trim() || (validAuthor ? `${validAuthor} Teeka` : "");
      if (!effectiveName) continue;
      const key = effectiveName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ effectiveName, validAuthor });
    }

    if (candidates.length > 0) {
      // Single bulk lookup: pull every existing teeka for this grantha in one GET, then
      // resolve each candidate in memory. Replaces the per-teeka filtered GET that used
      // to be O(N) round-trips serial — for a 10-teeka grantha that's 10 fewer RTTs.
      let existingByName: Map<string, string>;
      try {
        existingByName = await loadGranthaTeekaNameToDocId(granthaDocId);
      } catch (e: any) {
        console.warn(`[publish] Bulk teeka lookup failed; falling back per-teeka. ${e?.message || e}`);
        existingByName = new Map();
      }

      const toCreate: TeekaCandidate[] = [];
      const toSyncAuthor: Array<{ docId: string; author: string; name: string }> = [];
      for (const c of candidates) {
        const docId = existingByName.get(c.effectiveName.toLowerCase());
        if (docId) {
          console.log(`[publish] Teeka "${c.effectiveName}" already exists (${docId}) — reusing`);
          teekaNameToDocId.set(c.effectiveName.toLowerCase(), docId);
          if (c.validAuthor) toSyncAuthor.push({ docId, author: c.validAuthor, name: c.effectiveName });
          reportProgress(`Teeka: ${c.effectiveName}`, "teeka");
        } else {
          toCreate.push(c);
        }
      }

      for (const { docId, author, name } of toSyncAuthor) {
        try {
          await strapiRequest(`/api/teekas/${docId}`, {
            method: "PUT",
            body: JSON.stringify({ data: { TeekaAuthor: author } }),
          });
        } catch (e: any) {
          console.warn(`[publish] Teeka "${name}" author sync failed: ${e?.message || e}`);
        }
      }

      // Parallelize creates. Strapi handles them as independent POSTs; if two land at
      // exactly the same instant we accept the rare dup risk — `loadGranthaTeekaNameToDocId`
      // would resolve either copy on the next publish.
      const TEEKA_CREATE_CONCURRENCY = 6;
      for (let i = 0; i < toCreate.length; i += TEEKA_CREATE_CONCURRENCY) {
        const batch = toCreate.slice(i, i + TEEKA_CREATE_CONCURRENCY);
        await Promise.all(
          batch.map(async (c) => {
            try {
              const created = await strapiRequest("/api/teekas", {
                method: "POST",
                body: JSON.stringify({
                  data: {
                    TeekaName: c.effectiveName,
                    ...(c.validAuthor ? { TeekaAuthor: c.validAuthor } : {}),
                    grantha: granthaDocId,
                  },
                }),
              });
              const createdDocId: string | undefined = created?.data?.documentId;
              if (createdDocId) {
                teekaNameToDocId.set(c.effectiveName.toLowerCase(), createdDocId);
                console.log(`[publish] Teeka "${c.effectiveName}" created (${createdDocId})`);
              } else {
                console.warn(`[publish] Teeka "${c.effectiveName}" created but no documentId returned`);
              }
            } catch (e: any) {
              console.error(`[publish] Teeka "${c.effectiveName}" failed:`, e.message);
            } finally {
              reportProgress(`Teeka: ${c.effectiveName}`, "teeka");
            }
          }),
        );
      }
    }
  }
  console.log(`[publish] teekaNameToDocId map: ${[...teekaNameToDocId.entries()].map(([k, v]) => `"${k}"→${v}`).join(", ") || "(empty)"}`);

  // 2b/2c. Delete explicitly removed sections + manthras from Strapi.
  // Failed deletes (non-404) are collected and bubbled out so the publish
  // handler can re-pin them onto draft.data.deletedStrapiManthraDocIds for
  // the next publish to retry. Without this, transient Strapi 5xx errors
  // silently orphan rows because the cleanup step always strips the array.
  const failedDeletedSectionDocIds: string[] = [];
  const failedDeletedManthraDocIds: string[] = [];

  const DELETE_CONCURRENCY = 8;
  const runBoundedDeletes = async (
    docIds: string[],
    label: "section" | "manthra",
    failedSink: string[],
  ): Promise<void> => {
    if (docIds.length === 0) return;
    const apiPath = label === "section" ? "sections" : "manthras";
    console.log(`[publish] Deleting ${docIds.length} removed ${label}s from Strapi: ${docIds.join(", ")}`);
    for (let i = 0; i < docIds.length; i += DELETE_CONCURRENCY) {
      const batch = docIds.slice(i, i + DELETE_CONCURRENCY);
      await Promise.all(
        batch.map(async (docId) => {
          try {
            await strapiRequest(`/api/${apiPath}/${docId}`, { method: "DELETE" });
            console.log(`[publish] Deleted ${label} ${docId}`);
            if (label === "section") invalidateSectionReadCache(docId);
          } catch (e: any) {
            if (e?.status === 404) {
              if (label === "section") invalidateSectionReadCache(docId);
              return; // already gone — fine
            }
            console.error(`[publish] Failed to delete ${label} ${docId}:`, e?.message || e);
            failedSink.push(docId);
          }
        }),
      );
    }
  };

  if (!republishFresh && Array.isArray(deletedStrapiSectionDocIds)) {
    await runBoundedDeletes(deletedStrapiSectionDocIds, "section", failedDeletedSectionDocIds);
  }
  if (!republishFresh && Array.isArray(deletedStrapiManthraDocIds)) {
    await runBoundedDeletes(deletedStrapiManthraDocIds, "manthra", failedDeletedManthraDocIds);
  }

  // 3. Publish hierarchy as Sections + Manthras (best-effort)
  // Sections → /api/sections (title, type, grantha, parent)
  // Manthras → /api/manthras (ShlokaManthraNumber, Section, content fields)
  const L1name: string = structureConfig?.levelOneName || "Adhyaya";
  const L2name: string = structureConfig?.levelTwoName || "Khanda";
  const L3name: string = structureConfig?.levelThreeName || "Pada";
  const levelTwoEnabled: boolean = structureConfig?.levelTwoEnabled !== false;
  const levelThreeEnabled: boolean = !!structureConfig?.levelThreeEnabled;

  // Map display names → Strapi enum values (undefined = omit type field)
  const L1type = mapSectionType(L1name);
  const L2type = mapSectionType(L2name);
  const L3type = mapSectionType(L3name);

  console.log(`[publish] Hierarchy: L1=${L1name}→${L1type}, L2=${L2name}→${L2type}, L3=${L3name}→${L3type}, levelTwo=${levelTwoEnabled}, levelThree=${levelThreeEnabled}`);
  console.log(`[publish] Adhyayas count: ${Array.isArray(hierarchy) ? hierarchy.length : 0}`);

  const configuredLeaf = String(structureConfig?.leafName || "Mantra").trim() || "Mantra";
  const granthaNameForIntegrity = String(granthaPayload.GranthaName || draft.title || "").trim();

  if (Array.isArray(hierarchy)) {
    const duplicateSuffixes = hierarchyHasDuplicateMantraSuffixes(hierarchy, configuredLeaf, {
      levelThreeEnabled: !!structureConfig?.levelThreeEnabled,
    });
    applyHierarchyRepairInPlace(hierarchy, structureConfig, configuredLeaf, {
      renumberVerseLabels: !!allowRenumber || duplicateSuffixes,
    });
  }

  if (isPublishIntegrityEnabled() && Array.isArray(hierarchy)) {
    const preflight = scanGranthaHierarchyMantras(
      hierarchy,
      configuredLeaf,
      granthaNameForIntegrity,
      {
        maxErrors: 30,
        levelThreeEnabled: !!structureConfig?.levelThreeEnabled,
      },
    );
    const hard = preflight.filter((v) => v.severity === "error");
    if (hard.length > 0) {
      const err: any = new Error(
        `Publish blocked: ${hard.length} integrity issue(s). ${formatIntegrityFailures(hard)}`,
      );
      err.code = "publish_preflight_failed";
      err.violations = hard;
      throw err;
    }
  }

  // manthraIdToDocId: local portal manthra id → Strapi documentId
  // Built during the traversal below; used to sync Strapi docIds back into the
  // draft hierarchy after publish so that the NEXT publish can do a direct PUT
  // (no dedup API calls) for every manthra whose docId is now known.
  //
  // On retry after a crash, hydrate from cms_publish_manthra_resolutions so we
  // skip re-resolving manthras already published. A buffered flusher batches
  // upserts (50 at a time / every 2s) so the worker hot path doesn't pay a DB
  // round-trip per mantra. The trade-off is finer-grained crash recovery
  // (you may re-publish up to ~50 mantras after a crash) for big throughput
  // wins on large single-section granthas (Vivekachudamani et al).
  const manthraIdToDocId: Map<string, string> =
    jobId && !republishFresh ? await storage.loadManthraResolutions(jobId) : new Map();
  if (manthraIdToDocId.size > 0) {
    console.log(`[publish] Hydrated ${manthraIdToDocId.size} manthra resolution(s) from checkpoint`);
  }

  const resolutionBuffer: Array<{ portalManthraId: string; strapiDocumentId: string }> = [];
  const RESOLUTION_FLUSH_SIZE = 50;
  const RESOLUTION_FLUSH_MS = 2000;
  let resolutionFlushInFlight: Promise<void> = Promise.resolve();
  const flushResolutions = async (): Promise<void> => {
    if (!jobId || resolutionBuffer.length === 0) return;
    const batch = resolutionBuffer.splice(0, resolutionBuffer.length);
    resolutionFlushInFlight = resolutionFlushInFlight.then(() =>
      storage.recordManthraResolutionsBulk(jobId, batch).catch((e) => {
        console.warn(`[publish] resolution flush of ${batch.length} entries failed: ${e?.message || e}`);
      }),
    );
    await resolutionFlushInFlight;
  };
  const resolutionTimer = jobId
    ? setInterval(() => {
        void flushResolutions();
      }, RESOLUTION_FLUSH_MS)
    : null;
  if (resolutionTimer) resolutionTimer.unref?.();

  // Collect manthra publish failures so they can be surfaced to the user.
  // Each entry: { manthra: string (number/title), error: string }
  const publishFailures: Array<{ manthra: string; error: string }> = [];

  // const (not function declaration) so it is NOT hoisted — any accidental call
  // before this line would TDZ on `publishManthra` itself, not on a closed-over variable.
  const publishManthra = async (
    manthra: any,
    sectionDocId: string | undefined,
    portalSiblings?: PortalManthraSibling[],
  ): Promise<boolean> => {
    try {
      if (manthra.strapiDocumentId && manthra.strapiDocumentId.length < 10) {
        console.warn(
          `[publish] Manthra "${manthra.title}" — strapiDocumentId "${manthra.strapiDocumentId}" looks like a local portal UID (too short), ignoring it`,
        );
      }

      // If a previous attempt of this job already resolved this manthra, the in-memory
      // map (hydrated from cms_publish_manthra_resolutions on entry) carries the docId.
      // Stamp it onto the manthra so publishManthraToStrapi takes the fast PUT path
      // instead of re-running the dedup search.
      if (manthra.id && manthraIdToDocId.has(manthra.id)) {
        const checkpointDocId = manthraIdToDocId.get(manthra.id)!;
        if (!manthra.strapiDocumentId || manthra.strapiDocumentId.length < 10) {
          manthra = { ...manthra, strapiDocumentId: checkpointDocId };
        }
      }

      const returnedDocId = await publishManthraToStrapi(
        manthra,
        sectionDocId,
        granthaDocId,
        teekaNameToDocId,
        publishFailures,
        { portalSiblings, configuredLeaf, granthaName: granthaNameForIntegrity, allowRenumber, republishFresh },
      );
      if (returnedDocId && manthra.id) {
        manthraIdToDocId.set(manthra.id, returnedDocId);
        if (jobId) {
          // Buffered, fire-and-forget: keep the worker hot path free of DB latency.
          // The flusher above writes batches in the background; on crash we lose at
          // most ~50 checkpoints — a retry just re-publishes those mantras.
          resolutionBuffer.push({ portalManthraId: manthra.id, strapiDocumentId: returnedDocId });
          if (resolutionBuffer.length >= RESOLUTION_FLUSH_SIZE) {
            void flushResolutions();
          }
        }
      }
      return true;
    } catch (e: any) {
      const label = manthra.ShlokaManthraNumber || manthra.title || "(unknown)";
      const msg = strapiErrorMessage(e);
      console.error(`[publish] Manthra "${label}" failed:`, e?.message || e);
      publishFailures.push({ manthra: label, error: msg });
      return false;
    }
  };

  // Queue-based worker publish for manthras:
  // - tasks are durable in Postgres (publish_job_tasks)
  // - workers claim queued tasks and publish with bounded concurrency
  // - keeps fan-out explicit and resumable
  const MANTHRA_CONCURRENCY = Math.min(
    16,
    Math.max(4, Number(process.env.PUBLISH_MANTHRA_CONCURRENCY) || 10),
  );
  const publishManthrasBatch = async (manthras: any[], sectionDocId: string | undefined): Promise<void> => {
    const portalSiblings = [...manthras]
      .map((m) => ({ id: m.id, strapiDocumentId: m.strapiDocumentId, order: m.order }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (!jobId) {
      // Synchronous path: sort keys are derived from the portal index (no read-modify-
      // write on Strapi state) and labels are unique per section by preflight, so we
      // can publish intra-section mantras in parallel without the section lock.
      for (let i = 0; i < manthras.length; i += MANTHRA_CONCURRENCY) {
        const batch = manthras.slice(i, i + MANTHRA_CONCURRENCY);
        await Promise.all(
          batch.map(async (m) => {
            await publishManthra(m, sectionDocId, portalSiblings);
            reportProgress(m.title || m.id, "mantra");
          }),
        );
      }
      return;
    }

    for (const manthra of manthras) {
      await storage.enqueuePublishJobTask({
        jobId,
        draftId: draft.id,
        taskType: "publish_manthra",
        status: "queued",
        attemptCount: 0,
        payload: {
          sectionDocId,
          manthra,
          portalSiblings,
        },
        result: null,
        error: null,
      } as any);
    }

    const workers = Array.from({ length: MANTHRA_CONCURRENCY }).map(async () => {
      while (true) {
        const claimed = await storage.claimNextPublishJobTask(jobId);
        if (!claimed) {
          const remainingQueued = await storage.listPublishJobTasks(jobId, ["queued"]);
          if (remainingQueued.length === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
        const payload = (claimed.payload as any) ?? {};
        const qManthra = payload.manthra;
        const qSectionDocId = payload.sectionDocId;
        const qPortalSiblings = payload.portalSiblings as PortalManthraSibling[] | undefined;
        let terminal = false;
        try {
          // No section lock here: sort keys are derived from the portal index (no
          // shared Strapi state) and label uniqueness is enforced by preflight.
          // Workers in the same section can publish in parallel safely.
          const ok = await publishManthra(qManthra, qSectionDocId, qPortalSiblings);
          if (ok) {
            await storage.completePublishJobTask(claimed.id, { ok: true });
            terminal = true;
          } else if ((claimed.attemptCount ?? 0) < 3) {
            await storage.updatePublishJobTask(claimed.id, {
              status: "queued",
              error: "retrying after failed publish attempt",
            } as any);
          } else {
            await storage.failPublishJobTask(claimed.id, "manthra publish failed after retries");
            terminal = true;
          }
        } catch (e: any) {
          if ((claimed.attemptCount ?? 0) < 3) {
            await storage.updatePublishJobTask(claimed.id, {
              status: "queued",
              error: e?.message || "retrying task",
            } as any);
          } else {
            await storage.failPublishJobTask(claimed.id, e?.message || "Task failed");
            terminal = true;
          }
        } finally {
          if (terminal) {
            reportProgress(qManthra?.title || qManthra?.id || "manthra", "mantra");
          }
        }
      }
    });

    await Promise.all(workers);
    const failedTasks = await storage.listPublishJobTasks(jobId, ["failed"]);
    if (failedTasks.length > 0) {
      for (const ft of failedTasks) {
        const p = (ft.payload as any) ?? {};
        const label = p?.manthra?.ShlokaManthraNumber || p?.manthra?.title || `task-${ft.id}`;
        publishFailures.push({ manthra: label, error: ft.error || "manthra publish task failed" });
      }
    }
  };

  // Maps: local node .id → Strapi documentId, collected during traversal.
  // All three section levels + manthras are tracked so the next publish can
  // use the fast-path (direct PUT) without any dedup API lookups.
  const adhyayaIdToDocId: Map<string, string> = new Map();
  const khandaIdToDocId: Map<string, string> = new Map();
  const padaIdToDocId: Map<string, string> = new Map();

  // Count how many manthras live under a given hierarchy node so we can report
  // "N manthras skipped" when their parent section fails to publish.
  const countManthrasUnder = (node: any): number => {
    if (levelThreeEnabled && Array.isArray(node.padas) && node.padas.length > 0) {
      return node.padas.reduce((s: number, p: any) => s + (p.manthras?.length ?? 0), 0);
    }
    return (node.manthras?.length ?? 0) +
      (node.khandas ?? []).reduce((s: number, k: any) => {
        if (levelThreeEnabled && Array.isArray(k.padas) && k.padas.length > 0) {
          return s + k.padas.reduce((ks: number, p: any) => ks + (p.manthras?.length ?? 0), 0);
        }
        return s + (k.manthras?.length ?? 0);
      }, 0);
  };

  if (!granthaDocId) {
    console.error("[publish] Grantha documentId missing from Strapi response — cannot publish sections or manthras");
    publishFailures.push({
      manthra: "[Grantha]",
      error: "Strapi did not return a documentId for the grantha record. Sections and manthras were not published. Please try publishing again.",
    });
  } else if (Array.isArray(hierarchy) && hierarchy.length > 0) {
    // Process L1 sections (adhyayas) with bounded concurrency. Distinct sections
    // are safe to publish in parallel — intra-section mutations are still serialized
    // by withSectionLock further down. The Maps (adhyayaIdToDocId, …) are mutated
    // from multiple async branches but only with `.set` so there is no read-then-write
    // race; Promise.all on the JS event loop keeps each increment atomic.
    const ADHYAYA_CONCURRENCY = Math.min(
      6,
      Math.max(1, Number(process.env.PUBLISH_ADHYAYA_CONCURRENCY) || 4),
    );

    const processAdhyaya = async (adhyaya: any): Promise<void> => {
      // Guard: skip L1 sections with blank titles — they cannot be deduped and corrupt Strapi
      if (!adhyaya.title?.trim()) {
        const skipped = countManthrasUnder(adhyaya);
        console.warn(`[publish] Skipping L1 section with blank title (order=${adhyaya.order}) — fix the title in the portal before publishing`);
        if (skipped > 0) {
          publishFailures.push({
            manthra: `[Section order=${adhyaya.order}]`,
            error: `Section has no title — ${skipped} mantra${skipped === 1 ? "" : "s"} not published. Add a title in the portal and re-publish.`,
          });
        }
        return;
      }

      let adhyayaDocId: string | undefined;
      try {
        adhyayaDocId = await resolveSection(
          adhyaya.documentId, adhyaya.title, L1type, adhyaya.order ?? undefined, granthaDocId, undefined
        );
      } catch (e: any) {
        const msg = strapiErrorMessage(e);
        console.error(`[publish] Section L1 "${adhyaya.title}" failed:`, e?.message || e);
        const skipped = countManthrasUnder(adhyaya);
        const skipNote = skipped > 0 ? ` (${skipped} mantra${skipped === 1 ? "" : "s"} not published)` : "";
        publishFailures.push({ manthra: `[Section] ${adhyaya.title}`, error: msg + skipNote });
        return;
      }
      if (!adhyayaDocId) return;
      if (adhyaya.id) adhyayaIdToDocId.set(adhyaya.id, adhyayaDocId);
      reportProgress(adhyaya.title, "adhyaya");

      for (const khanda of (adhyaya.khandas ?? [])) {
        const isDefaultKhanda = khanda.title === "_default" || !levelTwoEnabled;
        let khandaDocId: string | undefined;

        if (isDefaultKhanda && levelTwoEnabled && khanda.title === "_default" && adhyayaDocId) {
          const childCheck = await strapiRequest(
            `/api/sections?filters[parent][documentId][$eq]=${encodeURIComponent(adhyayaDocId)}&filters[grantha][documentId][$eq]=${encodeURIComponent(granthaDocId)}&fields[0]=documentId&fields[1]=title&pagination[pageSize]=5`,
          );
          const childSecs: any[] = childCheck?.data ?? [];
          if (childSecs.length > 0) {
            const realKhanda = (adhyaya.khandas ?? []).find(
              (k: any) => k.title && k.title !== "_default" && k.documentId,
            );
            const match =
              realKhanda?.documentId
                ? childSecs.find((c: any) => c.documentId === realKhanda.documentId)
                : childSecs[0];
            if (match?.documentId) {
              khandaDocId = match.documentId;
              console.warn(
                `[publish] Adhyaya "${adhyaya.title}" has khanda sections in Strapi — publishing mantras to "${match.title}" (${match.documentId}) instead of the adhyaya row`,
              );
            }
          }
        }

        if (!isDefaultKhanda) {
          // Guard: skip L2 sections with blank titles
          if (!khanda.title?.trim()) {
            const skipped = countManthrasUnder(khanda);
            console.warn(`[publish] Skipping L2 section with blank title under "${adhyaya.title}" (order=${khanda.order}) — fix the title in the portal before publishing`);
            if (skipped > 0) {
              publishFailures.push({
                manthra: `[Section under ${adhyaya.title}, order=${khanda.order}]`,
                error: `Section has no title — ${skipped} mantra${skipped === 1 ? "" : "s"} not published. Add a title in the portal and re-publish.`,
              });
            }
            continue;
          }
          try {
            khandaDocId = await resolveSection(
              khanda.documentId, khanda.title, L2type, khanda.order ?? undefined, granthaDocId, adhyayaDocId
            );
          } catch (e: any) {
            const msg = strapiErrorMessage(e);
            console.error(`[publish] Section L2 "${khanda.title}" failed:`, e?.message || e);
            const skipped = countManthrasUnder(khanda);
            const skipNote = skipped > 0 ? ` (${skipped} mantra${skipped === 1 ? "" : "s"} not published)` : "";
            publishFailures.push({ manthra: `[Section] ${khanda.title}`, error: msg + skipNote });
            continue;
          }
          if (!khandaDocId) continue;
          if (khanda.id) khandaIdToDocId.set(khanda.id, khandaDocId);
          reportProgress(khanda.title, "khanda");
        } else if (!khandaDocId) {
          khandaDocId = adhyayaDocId;
        }

        if (levelThreeEnabled && Array.isArray(khanda.padas) && khanda.padas.length > 0) {
          for (const pada of khanda.padas) {
            // Guard: skip L3 sections with blank titles
            if (!pada.title?.trim()) {
              const skipped = pada.manthras?.length ?? 0;
              console.warn(`[publish] Skipping L3 section with blank title under "${khanda.title}" (order=${pada.order}) — fix the title in the portal before publishing`);
              if (skipped > 0) {
                publishFailures.push({
                  manthra: `[Section under ${khanda.title}, order=${pada.order}]`,
                  error: `Section has no title — ${skipped} mantra${skipped === 1 ? "" : "s"} not published. Add a title in the portal and re-publish.`,
                });
              }
              continue;
            }
            let padaDocId: string | undefined;
            try {
              padaDocId = await resolveSection(
                pada.documentId, pada.title, L3type, pada.order ?? undefined, granthaDocId, khandaDocId
              );
            } catch (e: any) {
              const msg = strapiErrorMessage(e);
              const skipped = pada.manthras?.length ?? 0;
              const skipNote = skipped > 0 ? ` (${skipped} mantra${skipped === 1 ? "" : "s"} not published)` : "";
              console.warn(`[publish] Pada "${pada.title}" failed:`, e?.message || e);
              publishFailures.push({ manthra: `[Section] ${pada.title}`, error: msg + skipNote });
              continue;
            }
            if (!padaDocId) continue;
            if (pada.id) padaIdToDocId.set(pada.id, padaDocId);
            reportProgress(pada.title, "pada");
            await publishManthrasBatch(pada.manthras ?? [], padaDocId);
          }
        } else {
          await publishManthrasBatch(khanda.manthras ?? [], khandaDocId);
        }
      }
    };

    // Worker pool: each worker pulls the next adhyaya index from a shared cursor.
    let cursor = 0;
    const adhyayas = hierarchy;
    const workers = Array.from({ length: ADHYAYA_CONCURRENCY }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= adhyayas.length) return;
        try {
          await processAdhyaya(adhyayas[idx]);
        } catch (e: any) {
          // Defensive — processAdhyaya catches its own errors per section, but a thrown
          // exception here would otherwise abort the whole grantha publish.
          console.error(`[publish] Unexpected error processing adhyaya ${adhyayas[idx]?.title}:`, e);
          publishFailures.push({
            manthra: `[Section] ${adhyayas[idx]?.title || `idx=${idx}`}`,
            error: e?.message || "Unexpected publish error",
          });
        }
      }
    });
    await Promise.all(workers);
  }

  // 2d. Delete Teeka collection entries removed in Teeka Management (best-effort).
  // Runs after mantra publish so merged mantra payloads are written first. Strapi may
  // reject DELETE if relations still point at the teeka — log non-404 errors only.
  if (Array.isArray(deletedStrapiTeekaDocIds) && deletedStrapiTeekaDocIds.length > 0) {
    console.log(
      `[publish] Deleting ${deletedStrapiTeekaDocIds.length} removed teeka(s) from Strapi: ${deletedStrapiTeekaDocIds.join(", ")}`
    );
    for (const teekaDocId of deletedStrapiTeekaDocIds) {
      try {
        await strapiRequest(`/api/teekas/${teekaDocId}`, { method: "DELETE" });
        console.log(`[publish] Deleted teeka ${teekaDocId}`);
      } catch (e: any) {
        if (e?.status !== 404) {
          console.error(`[publish] Failed to delete teeka ${teekaDocId}:`, e.message);
        }
      }
    }
  }

  // Sync ALL Strapi documentIds (sections at every level + manthras) back into the
  // hierarchy so the next publish uses the fast-path for every known record.
  // Always generate updatedHierarchy (even when no new IDs were obtained) so the
  // draft is always a complete, authoritative snapshot of what's in Strapi.
  const hasSectionIds = adhyayaIdToDocId.size > 0 || khandaIdToDocId.size > 0 || padaIdToDocId.size > 0;
  const updatedHierarchy: any[] | undefined = Array.isArray(hierarchy)
    ? hierarchy.map((adhyaya: any) => ({
        ...adhyaya,
        ...(adhyayaIdToDocId.has(adhyaya.id) ? { documentId: adhyayaIdToDocId.get(adhyaya.id) } : {}),
        khandas: (adhyaya.khandas ?? []).map((khanda: any) => ({
          ...khanda,
          ...(khandaIdToDocId.has(khanda.id) ? { documentId: khandaIdToDocId.get(khanda.id) } : {}),
          padas: (khanda.padas ?? []).map((pada: any) => ({
            ...pada,
            ...(padaIdToDocId.has(pada.id) ? { documentId: padaIdToDocId.get(pada.id) } : {}),
            manthras: (pada.manthras ?? []).map((m: any) =>
              manthraIdToDocId.has(m.id) ? { ...m, strapiDocumentId: manthraIdToDocId.get(m.id) } : m
            ),
          })),
          manthras: (khanda.manthras ?? []).map((m: any) =>
            manthraIdToDocId.has(m.id) ? { ...m, strapiDocumentId: manthraIdToDocId.get(m.id) } : m
          ),
        })),
      }))
    : undefined;

  console.log(
    `[publish] Syncing back: ${adhyayaIdToDocId.size} adhyaya, ${khandaIdToDocId.size} khanda, ` +
    `${padaIdToDocId.size} pada, ${manthraIdToDocId.size} manthra docId(s) into draft hierarchy`
  );
  if (publishFailures.length > 0) {
    console.warn(`[publish] ${publishFailures.length} manthra(s) failed to publish:`,
      publishFailures.map(f => `"${f.manthra}": ${f.error}`).join("; ")
    );
  }
  const hardFailures = publishFailures.filter((f) => !String(f.error || "").startsWith("[WARNING]"));
  if (hardFailures.length > 0) {
    // Partial success: grantha/sections/manthras were processed; return warnings instead of
    // throwing. Throwing caused failed_recoverable + client auto-republish loops (progress
    // hits 100% then the entire publish restarts from zero).
    if (!granthaDocId) {
      const err: any = new Error(
        `Integrity guard: grantha was not created in Strapi (${hardFailures.length} failure(s)).`,
      );
      err.code = "publish_integrity_guard";
      err.failures = hardFailures;
      throw err;
    }
    console.warn(
      `[publish] Completed with ${hardFailures.length} non-warning failure(s) — returning as warnings (no full republish)`,
    );
  }

  // Final flush + timer teardown before returning. setInterval keeps the Node process
  // alive otherwise; the .unref() above mitigates that but we still want a deterministic
  // shutdown when the publish completes.
  if (resolutionTimer) clearInterval(resolutionTimer);
  if (jobId) {
    try {
      await flushResolutions();
      await resolutionFlushInFlight;
    } catch (e: any) {
      console.warn(`[publish] final resolution flush failed: ${e?.message || e}`);
    }
  }

  if (
    republishFresh &&
    oldGranthaDocIdForCleanup &&
    granthaDocId &&
    oldGranthaDocIdForCleanup !== granthaDocId
  ) {
    reportProgress("Removing superseded CMS grantha", "grantha");
    try {
      const cleanup = await deleteGranthaTreeFromStrapi(oldGranthaDocIdForCleanup);
      console.log(
        `[publish] Superseded grantha ${oldGranthaDocIdForCleanup} cleanup: ` +
          `granthaDeleted=${cleanup.granthaDeleted}, ` +
          `failedManthras=${cleanup.failedManthras.length}, failedSections=${cleanup.failedSections.length}`,
      );
      if (cleanup.failedManthras.length > 0 || cleanup.failedSections.length > 0) {
        publishFailures.push({
          manthra: "[Grantha cleanup]",
          error:
            `[WARNING] Old CMS grantha was replaced but ${cleanup.failedManthras.length} mantra(s) ` +
            `and ${cleanup.failedSections.length} section(s) could not be deleted — remove them manually in Strapi if needed.`,
        });
      }
    } catch (e: any) {
      console.error(
        `[publish] Failed to delete superseded grantha ${oldGranthaDocIdForCleanup}:`,
        e?.message || e,
      );
      publishFailures.push({
        manthra: "[Grantha cleanup]",
        error: `[WARNING] New grantha published but old CMS tree (${oldGranthaDocIdForCleanup}) could not be removed: ${e?.message || e}`,
      });
    }
  }

  return {
    strapiResult,
    updatedHierarchy,
    publishFailures,
    failedDeletedSectionDocIds,
    failedDeletedManthraDocIds,
  };
}

/**
 * Normalize a TextAndTranslation object so Strapi always receives OtherTranslations
 * as a repeatable component array — even when the portal stored it in the legacy
 * flat-field format (LanguageOfTranslation + OtherLanguagesTranslation).
 *
 * Legacy (TextTranslationFields / Manthras page):
 *   { LanguageOfTranslation: "Kannada", OtherLanguagesTranslation: [...blocks] }
 *
 * Strapi expected format (shared.translations component):
 *   { OtherTranslations: [{ LanguageOfTranslation: "Kannada", TranslationText: [...blocks] }] }
 */
function normalizeTextAndTranslation(field: Record<string, any>): Record<string, any> {
  const {
    LanguageOfTranslation,
    OtherLanguagesTranslation,
    OtherTranslations,
    ...rest
  } = field;

  // Start with any already-correct OtherTranslations entries — drop any that have no language selected
  const existing: Array<Record<string, any>> = Array.isArray(OtherTranslations)
    ? OtherTranslations.filter((t) => typeof t?.LanguageOfTranslation === "string" && t.LanguageOfTranslation.trim())
    : [];

  // Promote legacy flat fields into the array if both language and text are present
  const legacyText = Array.isArray(OtherLanguagesTranslation) && OtherLanguagesTranslation.length > 0
    ? OtherLanguagesTranslation : null;
  if (LanguageOfTranslation && legacyText) {
    const alreadyCovered = existing.some(
      (t) => t.LanguageOfTranslation === LanguageOfTranslation
    );
    if (!alreadyCovered) {
      existing.push({ LanguageOfTranslation, TranslationText: legacyText });
    }
  }

  return {
    ...rest,
    ...(existing.length > 0 ? { OtherTranslations: existing } : {}),
  };
}

// Resolve raw Teeka entries (stored as { TeekaName, TeekaAuthor, TeekaEntry })
// into the format Strapi's default.bhashya-entries component expects:
//   { teeka: teekaDocumentId, TeekaEntry: {...} }
// The `teeka` field is a relation to the Teeka collection type — we look up the
// record by TeekaName. Entries whose Teeka record cannot be found are skipped.
//
// Resolution priority:
//   1. teekaNameToDocId map (built during this publish run — most reliable for newly-created teekas)
//   2. Stored teekaDocId / teeka.documentId — BUT only if it's a real Strapi documentId
//      (not a local portal UUID which contains hyphens and has never been saved to Strapi)
//   3. Strapi API name lookup (fallback)
async function resolveManthraTeekas(
  rawTeekas: any[],
  granthaDocId?: string,
  teekaNameToDocId?: Map<string, string>
): Promise<any[]> {
  if (rawTeekas.length === 0) return [];

  // Phase 1: resolve each teeka's Strapi docId WITHOUT sequential blocking.
  // The previous serial loop did one Strapi GET per teeka missing a docId; a mantra with
  // 8 unbound teekas was 8 sequential round-trips (~4-8s with old curl transport).
  // Parallelize the name lookups via Promise.all so the wall time is one Strapi call.
  const teekaSlots = rawTeekas.map((t) => {
    const TeekaName = (t.TeekaName || "").trim();
    let teekaDocId: string | undefined;

    if (teekaNameToDocId && TeekaName) {
      teekaDocId = teekaNameToDocId.get(TeekaName.toLowerCase());
    }
    if (!teekaDocId) {
      const stored = t.teekaDocId || t.teeka?.documentId || undefined;
      if (stored && stored.length >= 20) teekaDocId = stored;
    }
    return { raw: t, TeekaName, teekaDocId, needsLookup: !teekaDocId && !!TeekaName };
  });

  const lookupTargets = teekaSlots.filter((s) => s.needsLookup);
  if (lookupTargets.length > 0) {
    const uniqueNames = [...new Set(lookupTargets.map((s) => s.TeekaName))];
    const nameToDocId = new Map<string, string>();
    await Promise.all(
      uniqueNames.map(async (name) => {
        try {
          let url = `/api/teekas?filters[TeekaName][$eqi]=${encodeURIComponent(name)}&fields[0]=documentId&pagination[pageSize]=5`;
          if (granthaDocId) url += `&filters[grantha][documentId][$eq]=${encodeURIComponent(granthaDocId)}`;
          const found = await strapiRequest(url);
          const docId = found?.data?.[0]?.documentId;
          if (docId) nameToDocId.set(name, docId);
        } catch (e: any) {
          console.error(`[resolveManthraTeekas] Lookup error for "${name}": ${e.message}`);
        }
      }),
    );
    for (const slot of lookupTargets) {
      slot.teekaDocId = nameToDocId.get(slot.TeekaName);
    }
  }

  // Phase 2: build the output entries. Pure CPU work — no awaits.
  const resolved: any[] = [];
  for (const slot of teekaSlots) {
    if (!slot.teekaDocId) {
      if (!slot.TeekaName) {
        console.warn(`[resolveManthraTeekas] Entry has no teeka documentId and no TeekaName — skipping`);
      } else {
        console.warn(`[resolveManthraTeekas] Teeka record not found in Strapi: "${slot.TeekaName}" — skipping this teeka entry`);
      }
      continue;
    }
    const t = slot.raw;
    if (!t.TeekaEntry || typeof t.TeekaEntry !== "object") continue;
    const norm = normalizeTextAndTranslation(t.TeekaEntry);
    const hasRealContent =
      (norm.SanskritTextEntry?.length ?? 0) > 0 ||
      (norm.EnglishTranslationText?.length ?? 0) > 0 ||
      (norm.OtherTranslations?.length ?? 0) > 0;
    if (!hasRealContent) continue;
    resolved.push({ teeka: slot.teekaDocId, TeekaEntry: norm });
  }
  console.log(`[resolveManthraTeekas] Resolved ${resolved.length}/${rawTeekas.length} teeka(s)`);
  return resolved;
}

async function buildManthraPayloadAsync(
  data: Record<string, any>,
  strapiDocumentId?: string
): Promise<Record<string, any>> {
  const {
    section,       // lowercase local field → maps to Strapi's capital-S Section relation
    grantha,       // local tracking only — not a direct field in Strapi Manthra schema
    Teekas: rawTeekas,
    _section,      // also local tracking
    ...rest
  } = data;

  const payload = cleanPayloadForStrapi(rest);

  // Normalize ShlokaManthraEntry and BhashyamEntry so OtherTranslations is always
  // in the repeatable-component format Strapi expects, not the legacy flat fields.
  for (const key of ["ShlokaManthraEntry", "BhashyamEntry"] as const) {
    if (payload[key] && typeof payload[key] === "object" && !Array.isArray(payload[key])) {
      payload[key] = normalizeTextAndTranslation(payload[key]);
    }
  }

  // Map section documentId → Section relation (Strapi v5 accepts raw documentId string)
  const sectionDocId = section || _section;
  if (sectionDocId && typeof sectionDocId === "string") {
    payload.Section = sectionDocId;
  }

  // order must be a number (not string)
  if (payload.order !== undefined && payload.order !== null) {
    const n = Number(payload.order);
    if (!Number.isNaN(n)) payload.order = n;
    else delete payload.order;
  }

  // Resolve and merge teekas — mirrors buildManthraData (single Strapi GET when possible).
  //
  // SAFETY RULE — always merge with existing Strapi teeka content:
  // Strapi treats a PUT with a Teekas array as a COMPLETE REPLACEMENT of all teekas on
  // that mantra. If the user only edited one teeka (e.g. "Upanishad Brahmendra") and we
  // send only that one, Strapi silently deletes every other teeka that was there (e.g.
  // "Kathopanishad"). To prevent this, for existing Strapi manthras we:
  //   1. Fetch the current mantra once (teekas + Shloka + Bhashyam populated).
  //   2. Build a merged array: keep every existing Strapi entry UNLESS the local draft
  //      has updated content for that same teeka; add any brand-new local entries.
  //   3. Send the merged array — so no existing teeka is ever silently wiped.
  //
  // When the local draft has NO teeka entries and the manthra already exists in Strapi
  // we OMIT Teekas from the payload so Strapi preserves whatever content it holds.
  const isExistingStrapi = typeof strapiDocumentId === "string" && strapiDocumentId.length >= 10;

  // Run teeka resolution in parallel with the existing-mantra snapshot fetch: both are
  // independent network calls. With keep-alive HTTP they share a connection.
  const localHasTeekas = Array.isArray(rawTeekas) && rawTeekas.length > 0;
  const needsTextMerge = isExistingStrapi && mantraTextMergeNeeded(payload);
  // Pull the snapshot only if we actually need to merge something; skip otherwise
  // so a publish that's only updating, say, ShlokaManthraNumber doesn't pay for
  // a multi-MB populate=* GET.
  const mergeQuery = pickMantraMergeQuery(localHasTeekas && isExistingStrapi, needsTextMerge);
  const snapshotPromise =
    mergeQuery && strapiDocumentId
      ? strapiRequest(`/api/manthras/${strapiDocumentId}${mergeQuery}`)
          .then((r) => r?.data ?? null)
          .catch((e: any) => {
            console.warn(`[buildManthraPayloadAsync] Could not fetch existing Strapi mantra for merge — ${e.message}`);
            return null;
          })
      : Promise.resolve(null);

  const [resolvedTeekas, strapiMantraSnapshot] = await Promise.all([
    localHasTeekas ? resolveManthraTeekas(rawTeekas) : Promise.resolve([] as any[]),
    snapshotPromise,
  ]);
  if (strapiMantraSnapshot && resolvedTeekas.length > 0) {
    const n = (strapiMantraSnapshot as any)?.Teekas?.length ?? 0;
    console.log(`[buildManthraPayloadAsync] Fetched Strapi mantra snapshot (${n} teeka row(s)) for merge`);
  }

  if (Array.isArray(rawTeekas)) {
    if (rawTeekas.length > 0) {
      if (resolvedTeekas.length > 0 && isExistingStrapi) {
        // ── MERGE with existing Strapi teekas (single GET above) ─────────────────
        const existingTeekas: any[] = strapiMantraSnapshot?.Teekas ?? [];

        const localByTeekaDocId = new Map<string, any>();
        for (const lt of resolvedTeekas) {
          if (lt.teeka) localByTeekaDocId.set(lt.teeka as string, lt);
        }

        const mergedTeekas: any[] = [];

        // Pass 1 — walk existing Strapi entries; prefer local edits, keep rest unchanged
        for (const et of existingTeekas) {
          const tDocId = et.teeka?.documentId;
          if (!tDocId) continue;
          const local = localByTeekaDocId.get(tDocId);
          if (local) {
            mergedTeekas.push({
              id: et.id,
              teeka: tDocId,
              TeekaEntry: mergeTeekaEntryForPut(et.TeekaEntry, local.TeekaEntry),
            });
            localByTeekaDocId.delete(tDocId);
          } else {
            mergedTeekas.push({ id: et.id, teeka: tDocId, TeekaEntry: et.TeekaEntry ?? null });
          }
        }

        // Pass 2 — add brand-new teekas that had no existing entry in Strapi
        for (const [, lt] of localByTeekaDocId) {
          mergedTeekas.push(lt);
        }

        console.log(
          `[buildManthraPayloadAsync] Merged teekas: ${existingTeekas.length} existing + ${resolvedTeekas.length} local → ${mergedTeekas.length} total`
        );
        payload.Teekas = mergedTeekas;
      } else {
        // New mantra or nothing resolved — send as-is
        payload.Teekas = resolvedTeekas;
      }
    } else if (!isExistingStrapi) {
      // New mantra with no teekas — explicitly initialise the field
      payload.Teekas = [];
    }
    // else: existing Strapi mantra, empty local teekas → omit Teekas from payload
    // so Strapi preserves whatever content it already holds for this mantra.
  }

  if (isExistingStrapi && strapiDocumentId && strapiMantraSnapshot) {
    applyMantraTextMergeFromStrapiData(payload, strapiMantraSnapshot);
  } else if (isExistingStrapi && strapiDocumentId && mantraTextMergeNeeded(payload) && !strapiMantraSnapshot) {
    await mergeMantraTextComponentsFromStrapi(payload, strapiDocumentId);
  }

  pruneNonPublishableManthraTextFields(payload);
  sanitizeStrapiTextComponentsOnManthraLikePayload(payload);
  return payload;
}

function buildSectionPayload(data: Record<string, any>): Record<string, any> {
  const {
    _grantha,          // local-prefix copy of grantha documentId
    _parent,           // local-prefix copy of parent section documentId
    grantha,           // documentId string for the parent Grantha
    parent,            // documentId string for the parent Section
    order,
    ...rest
  } = data;

  const payload = cleanPayloadForStrapi(rest);

  // Map grantha → Strapi relation (Strapi v5 accepts raw documentId string)
  const granthaId = grantha || _grantha;
  if (granthaId && typeof granthaId === "string") {
    payload.grantha = granthaId;
  }

  // Map parent → Strapi relation
  const parentId = parent || _parent;
  if (parentId && typeof parentId === "string") {
    payload.parent = parentId;
  }

  // order must be a number
  if (order !== undefined && order !== null && order !== "") {
    const n = Number(order);
    if (!Number.isNaN(n)) payload.order = n;
  }

  return payload;
}

async function buildChapterPayload(data: Record<string, any>): Promise<Record<string, any>> {
  const {
    _grantha,                // local-only prefix copy
    _parentDocId,            // local-only prefix copy
    grantha,                 // documentId string for the Grantha relation
    parent,                  // documentId string for the parent Chapter relation
    Teekas: rawTeekas,
    order,
    ...rest
  } = data;

  const payload = cleanPayloadForStrapi(rest);

  // Normalize TextAndTranslation fields so OtherTranslations is always
  // in the repeatable-component format Strapi expects.
  for (const key of ["ShlokaManthraEntry", "BhashyamForShlokaManthra"] as const) {
    if (payload[key] && typeof payload[key] === "object" && !Array.isArray(payload[key])) {
      payload[key] = normalizeTextAndTranslation(payload[key]);
    }
  }

  // Map grantha → Strapi relation
  const granthaId = grantha || _grantha;
  if (granthaId && typeof granthaId === "string") {
    payload.grantha = granthaId;
  }

  // Map parent → Strapi relation
  const parentId = parent || _parentDocId;
  if (parentId && typeof parentId === "string") {
    payload.parent = parentId;
  }

  // order must be a number
  if (order !== undefined && order !== null && order !== "") {
    const n = Number(order);
    if (!Number.isNaN(n)) payload.order = n;
  }

  // Resolve Teekas (same format as manthras)
  if (Array.isArray(rawTeekas) && rawTeekas.length > 0) {
    const resolvedTeekas = await resolveManthraTeekas(rawTeekas, granthaId || _grantha);
    if (resolvedTeekas.length > 0) {
      payload.Teekas = resolvedTeekas;
    }
  }

  sanitizeStrapiTextComponentsOnManthraLikePayload(payload);
  return payload;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  setupAuth(app);
  app.use(activityLogger);

  app.get("/api/app-version", (_req, res) => {
    res.json({ buildId: readClientBuildId() });
  });

  const strapiRouter = createStrapiRouter();
  app.use("/api/strapi", strapiRouter);

  const migrateRouter = createMigrateRouter();
  app.use("/api/strapi/migrate", migrateRouter);

  const hermexTranslateBodySchema = z.object({
    sourceText: z.string().min(1).max(120_000),
    sourceLanguage: z.enum(["English", "Sanskrit"]),
    targetLanguages: z.array(z.string()).min(1).max(50),
    context: z.string().max(500).optional(),
    chunkSize: z.number().int().min(1).max(10).optional(),
    headless: z.boolean().optional(),
    queryTimeoutSec: z.number().int().min(60).max(900).optional(),
  });

  app.get("/api/hermex/status", requireAuth, (_req, res) => {
    res.json({
      enabled: hermexEnabled(),
      python: hermexPythonBin(),
      script: hermexTranslateScriptPath(),
      otherTranslationLanguageCount: otherTranslationLanguages.length,
      otherTranslationLanguages: [...otherTranslationLanguages],
      sourceLanguages: ["English", "Sanskrit"],
    });
  });

  app.post("/api/hermex/translate", requireAuth, async (req, res) => {
    if (!hermexEnabled()) {
      return res.status(503).json({
        message:
          "Hermex translation is disabled. Set HERMEX_ENABLED=true and install Python deps (see docs/HERMEX.md).",
      });
    }
    try {
      const parsed = hermexTranslateBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors.map((e) => e.message).join("; ") });
      }
      const allowed = new Set<string>(otherTranslationLanguages as readonly string[]);
      const invalid = parsed.data.targetLanguages.filter((l) => !allowed.has(l));
      if (invalid.length) {
        return res.status(400).json({
          message: `Invalid target language(s): ${invalid.join(", ")}. Must be one of the ${allowed.size} OtherTranslations languages.`,
        });
      }
      const result = await runHermexTranslate(parsed.data);
      res.json({
        translations: (result.translations ?? []).map((row) => ({
          LanguageOfTranslation: row.language,
          TranslationText: row.text,
          isAiTranslated: true,
        })),
      });
    } catch (error: any) {
      console.error("[hermex] translate failed:", error?.message || error);
      res.status(500).json({
        message: error?.message || "Hermex translation failed",
      });
    }
  });

  const VALID_CONTENT_TYPES = [...Object.keys(CONTENT_TYPE_MAP), ...Array.from(STRAPI_UNROUTED_TYPES)];

  app.get("/api/drafts", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const { contentType } = req.query;
      if (contentType && !VALID_CONTENT_TYPES.includes(contentType as string)) {
        return res.status(400).json({ message: "Invalid content type" });
      }
      const drafts = contentType
        ? await storage.getDraftsByType(contentType as string, user.id)
        : await storage.getDrafts(user.id);
      res.json(drafts);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch drafts" });
    }
  });

  app.get("/api/drafts/:id", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid draft ID" });
      const draft = await storage.getDraft(id, user.id);
      if (!draft) return res.status(404).json({ message: "Draft not found" });
      res.json(draft);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch draft" });
    }
  });

  app.post("/api/drafts", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const { contentType, title, data, strapiDocumentId } = req.body;
      if (!contentType || !title || !data) {
        return res.status(400).json({ message: "contentType, title, and data are required" });
      }
      if (!VALID_CONTENT_TYPES.includes(contentType)) {
        return res.status(400).json({ message: "Invalid content type" });
      }
      const draft = await storage.createDraft({
        contentType,
        title,
        data,
        strapiDocumentId: strapiDocumentId || null,
        status: "draft",
        createdBy: user.id,
      });
      void writeDraftSnapshot({
        event: "draft.create",
        draftId: draft.id,
        userId: user.id,
        title: draft.title,
        status: draft.status,
        strapiDocumentId: draft.strapiDocumentId,
        data: draft.data,
      });
      res.status(201).json(draft);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to create draft" });
    }
  });

  app.put("/api/drafts/:id", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid draft ID" });
      const idem = await loadOrReplayIdempotency(req, `/api/drafts/${id}`);
      if (idem?.replay) return res.status(idem.status).json(idem.body);
      await withDraftLock(id, async () => {
        const { title, data, expectedUpdatedAt } = req.body;
        const before = await storage.getDraft(id, user.id);
        if (!before) {
          res.status(404).json({ message: "Draft not found" });
          return;
        }

        const nextTitle = title ?? before.title;
        const nextData = data ?? before.data;
        if (nextTitle === before.title && jsonEqual(nextData, before.data) && before.status === "draft") {
          res.json(before);
          return;
        }

        void writeDraftSnapshot({
          event: "draft.update.before",
          draftId: before.id,
          userId: user.id,
          title: before.title,
          status: before.status,
          strapiDocumentId: before.strapiDocumentId,
          data: before.data,
        });
        const draft = expectedUpdatedAt
          ? await storage.updateDraftIfVersion(
              id,
              user.id,
              new Date(expectedUpdatedAt),
              {
                ...(title && { title }),
                ...(data && { data }),
                status: "draft",
              }
            )
          : await storage.updateDraft(id, user.id, {
              ...(title && { title }),
              ...(data && { data }),
              status: "draft",
            });
        if (!draft) {
          const latest = await storage.getDraft(id, user.id);
          if (latest) {
            res.status(409).json({ message: "Draft was updated elsewhere. Please refresh and retry.", latest });
          } else {
            res.status(404).json({ message: "Draft not found" });
          }
          return;
        }
        void writeDraftSnapshot({
          event: "draft.update.after",
          draftId: draft.id,
          userId: user.id,
          title: draft.title,
          status: draft.status,
          strapiDocumentId: draft.strapiDocumentId,
          data: draft.data,
        });
        if (idem && !idem.replay) {
          await persistIdempotency(idem.key, `/api/drafts/${id}`, idem.hash, user.id, id, 200, draft);
        }
        res.json(draft);
      });
    } catch (error: any) {
      if (error?.status) return res.status(error.status).json({ message: error.message });
      res.status(500).json({ message: error.message || "Failed to update draft" });
    }
  });

  /** Merge one mantra node into draft hierarchy; optionally append if missing (new local insert). */
  function patchManthraInHierarchy(
    hierarchy: any[],
    loc: { adhyayaId: string; khandaId: string; padaId?: string; manthraId: string },
    manthraData: Record<string, any>,
    upsert = false,
  ): { hierarchy: any[]; updated: boolean } {
    const { adhyayaId, khandaId, padaId, manthraId } = loc;
    let updated = false;

    const patchList = (manthras: any[]) => {
      const list = manthras ?? [];
      const idx = list.findIndex((m: any) => m?.id === manthraId);
      if (idx >= 0) {
        updated = true;
        const next = [...list];
        next[idx] = { ...next[idx], ...manthraData, id: manthraId };
        return next;
      }
      if (upsert) {
        updated = true;
        return [...list, { ...manthraData, id: manthraId }];
      }
      return list;
    };

    const nextHierarchy = hierarchy.map((a: any) => {
      if (a?.id !== adhyayaId) return a;
      return {
        ...a,
        khandas: (a.khandas || []).map((k: any) => {
          if (k?.id !== khandaId) return k;
          if (padaId) {
            return {
              ...k,
              padas: (k.padas || []).map((p: any) => {
                if (p?.id !== padaId) return p;
                return { ...p, manthras: patchList(p.manthras) };
              }),
            };
          }
          return { ...k, manthras: patchList(k.manthras) };
        }),
      };
    });

    return { hierarchy: nextHierarchy, updated };
  }

  // Fast-path draft save for mantra modal edits.
  // Updates only one mantra node inside hierarchy to avoid sending full draft payload
  // from the browser on every modal save/close.
  app.patch("/api/drafts/:id/manthra", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid draft ID" });
      const idem = await loadOrReplayIdempotency(req, `/api/drafts/${id}/manthra`);
      if (idem?.replay) return res.status(idem.status).json(idem.body);
      await withDraftLock(id, async () => {
        const { title, adhyayaId, khandaId, padaId, manthraId, manthraData, expectedUpdatedAt } = req.body ?? {};
        if (!adhyayaId || !khandaId || !manthraId || !manthraData || typeof manthraData !== "object") {
          res.status(400).json({ message: "adhyayaId, khandaId, manthraId and manthraData are required" });
          return;
        }

        const draft = await storage.getDraft(id, user.id);
        if (!draft) {
          res.status(404).json({ message: "Draft not found" });
          return;
        }
        void writeDraftSnapshot({
          event: "draft.manthra-patch.before",
          draftId: draft.id,
          userId: user.id,
          title: draft.title,
          status: draft.status,
          strapiDocumentId: draft.strapiDocumentId,
          data: draft.data,
        });

        const draftData = (draft.data && typeof draft.data === "object") ? draft.data as any : {};
        const hierarchy = Array.isArray(draftData.hierarchy) ? draftData.hierarchy : [];

        let { hierarchy: updatedHierarchy, updated: updatedNode } = patchManthraInHierarchy(
          hierarchy,
          { adhyayaId, khandaId, padaId, manthraId },
          manthraData,
          false,
        );
        if (!updatedNode) {
          ({ hierarchy: updatedHierarchy, updated: updatedNode } = patchManthraInHierarchy(
            hierarchy,
            { adhyayaId, khandaId, padaId, manthraId },
            manthraData,
            true,
          ));
        }

        if (!updatedNode) {
          res.status(404).json({ message: "Manthra not found in draft hierarchy" });
          return;
        }

        if (jsonEqual(updatedHierarchy, hierarchy) && (!title || title === draft.title) && draft.status === "draft") {
          res.json(draft);
          return;
        }

        const updated = expectedUpdatedAt
          ? await storage.updateDraftIfVersion(
              id,
              user.id,
              new Date(expectedUpdatedAt),
              {
                ...(title ? { title } : {}),
                data: { ...draftData, hierarchy: updatedHierarchy },
                status: "draft",
              }
            )
          : await storage.updateDraft(id, user.id, {
              ...(title ? { title } : {}),
              data: { ...draftData, hierarchy: updatedHierarchy },
              status: "draft",
            });
        if (!updated) {
          const latest = await storage.getDraft(id, user.id);
          if (latest) {
            res.status(409).json({ message: "Draft was updated elsewhere. Please refresh and retry.", latest });
          } else {
            res.status(404).json({ message: "Draft not found" });
          }
          return;
        }
        void writeDraftSnapshot({
          event: "draft.manthra-patch.after",
          draftId: updated.id,
          userId: user.id,
          title: updated.title,
          status: updated.status,
          strapiDocumentId: updated.strapiDocumentId,
          data: updated.data,
        });
        if (idem && !idem.replay) {
          await persistIdempotency(idem.key, `/api/drafts/${id}/manthra`, idem.hash, user.id, id, 200, updated);
        }
        res.json(updated);
      });
    } catch (error: any) {
      if ((error as any)?.status) return res.status((error as any).status).json({ message: (error as any).message });
      res.status(500).json({ message: error.message || "Failed to patch mantra draft" });
    }
  });

  app.delete("/api/drafts/:id", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid draft ID" });
      const before = await storage.getDraft(id, user.id);
      if (before) {
        void writeDraftSnapshot({
          event: "draft.delete.before",
          draftId: before.id,
          userId: user.id,
          title: before.title,
          status: before.status,
          strapiDocumentId: before.strapiDocumentId,
          data: before.data,
        });
      }
      const plan = await storage.getDraftDiscardPlan(id, user.id);
      if (!plan.draft) return res.status(404).json({ message: "Draft not found" });
      const { deleted, plan: resultPlan } = await storage.discardDraftWithDependencies(id, {
        userId: user.id,
      });
      if (!deleted) return res.status(404).json({ message: "Draft not found" });
      res.json({
        message: "Draft deleted",
        removed: {
          idempotencyKeys: resultPlan.idempotencyKeys,
          publishJobs: resultPlan.publishJobs,
          publishJobTasks: resultPlan.publishJobTasks,
        },
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to delete draft" });
    }
  });

  // Recover draft payload from the latest server-side snapshot (admin-only — overwrites current draft).
  app.post("/api/drafts/:id/recover-latest", requireAuth, requireAdmin, async (req, res) => {
    try {
      const user = req.user as User;
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid draft ID" });
      const draft = await storage.getDraft(id, user.id);
      if (!draft) return res.status(404).json({ message: "Draft not found" });

      const snapshot = await readLatestDraftSnapshot(id, user.id);
      if (!snapshot?.data) {
        return res.status(404).json({ message: "No snapshot found for this draft" });
      }

      const recovered = await storage.updateDraft(id, user.id, {
        title: snapshot.title || draft.title,
        data: snapshot.data,
        status: "draft",
      });
      if (!recovered) return res.status(404).json({ message: "Draft not found" });
      res.json({ draft: recovered, recoveredFrom: snapshot.ts || null });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to recover draft" });
    }
  });

  /** Publish one mantra row from a grantha draft (shared by single + batch endpoints). */
  async function publishOneManthraFromGranthaDraft(
    draftId: number,
    userId: string,
    loc: { adhyayaId: string; khandaId: string; padaId?: string; manthraId: string },
    manthraData?: Record<string, any>,
  ): Promise<{
    returnedDocId?: string;
    publishFailures: Array<{ manthra: string; error: string }>;
    hierarchy: any[];
    data: any;
  }> {
    const draft = await storage.getDraft(draftId, userId);
    if (!draft) {
      const err: any = new Error("Draft not found");
      err.status = 404;
      throw err;
    }

    const granthaDocId: string | undefined = draft.strapiDocumentId ?? undefined;
    if (!granthaDocId) {
      const err: any = new Error(
        "The grantha must be published to Strapi first before publishing individual mantras. Use 'Save & Publish' on the grantha to publish it, then try again.",
      );
      err.status = 400;
      throw err;
    }

    let data = draft.data as any;
    let hierarchy: any[] = data?.hierarchy || [];
    const structureConfig = data?.structureConfig || {};
    const teekaDefinitions: any[] = data?.teekas || [];
    const { adhyayaId, khandaId, padaId, manthraId } = loc;

    if (manthraData && typeof manthraData === "object") {
      const merged = patchManthraInHierarchy(hierarchy, loc, manthraData, true);
      if (merged.updated) {
        hierarchy = merged.hierarchy;
        data = { ...data, hierarchy };
      }
    }

    const adhyaya = hierarchy.find((a: any) => a.id === adhyayaId);
    if (!adhyaya) {
      const err: any = new Error("Adhyaya not found in draft");
      err.status = 404;
      throw err;
    }
    const khanda = (adhyaya.khandas || []).find((k: any) => k.id === khandaId);
    if (!khanda) {
      const err: any = new Error("Khanda not found in draft");
      err.status = 404;
      throw err;
    }

    let manthraNode: any;
    let padaNode: any;
    if (padaId) {
      padaNode = (khanda.padas || []).find((p: any) => p.id === padaId);
      if (!padaNode) {
        const err: any = new Error("Pada not found in draft");
        err.status = 404;
        throw err;
      }
      manthraNode = (padaNode.manthras || []).find((m: any) => m.id === manthraId);
    } else {
      manthraNode = (khanda.manthras || []).find((m: any) => m.id === manthraId);
    }
    if (!manthraNode) {
      const err: any = new Error("Manthra not found in draft");
      err.status = 404;
      throw err;
    }

    const neededTeekaNames = new Set<string>();
    for (const t of manthraNode.Teekas ?? []) {
      const n = String(t?.TeekaName ?? "").trim().toLowerCase();
      if (n) neededTeekaNames.add(n);
    }

    const teekaNameToDocId: Map<string, string> = await loadGranthaTeekaNameToDocId(granthaDocId);
    const teekaAuthorAllow = await getTeekaAuthorsAllowlist();
    for (const teeka of teekaDefinitions) {
      const validAuthor = resolveAllowedTeekaAuthor(teeka.TeekaAuthor, teekaAuthorAllow);
      const effectiveName = (teeka.TeekaName || "").trim() || (validAuthor ? `${validAuthor} Teeka` : "");
      if (!effectiveName) continue;
      const key = effectiveName.toLowerCase();
      if (neededTeekaNames.size > 0 && !neededTeekaNames.has(key)) continue;
      if (teeka.documentId && teeka.documentId.length >= 10) {
        teekaNameToDocId.set(key, teeka.documentId);
      }
    }

    const L1name: string = structureConfig?.levelOneName || "Adhyaya";
    const L2name: string = structureConfig?.levelTwoName || "Khanda";
    const L3name: string = structureConfig?.levelThreeName || "Pada";
    const levelTwoEnabled: boolean = structureConfig?.levelTwoEnabled !== false;
    const levelThreeEnabled: boolean = !!structureConfig?.levelThreeEnabled;
    const L1type = mapSectionType(L1name);
    const L2type = mapSectionType(L2name);
    const L3type = mapSectionType(L3name);

    const knownSectionId = (id: unknown): string | undefined =>
      typeof id === "string" && id.length >= 10 ? id : undefined;

    const skipSectionTouch = true;

    let adhyayaDocId = knownSectionId(adhyaya.documentId);
    if (!adhyayaDocId) {
      adhyayaDocId = await resolveSection(
        adhyaya.documentId,
        adhyaya.title,
        L1type,
        adhyaya.order ?? undefined,
        granthaDocId,
        undefined,
        skipSectionTouch,
      );
    }
    if (!adhyayaDocId) {
      const err: any = new Error(`Could not resolve section "${adhyaya.title}" in Strapi`);
      err.status = 500;
      throw err;
    }

    const isDefaultKhanda = khanda.title === "_default" || !levelTwoEnabled;
    let khandaDocId: string | undefined = isDefaultKhanda ? adhyayaDocId : knownSectionId(khanda.documentId);
    if (!khandaDocId && !isDefaultKhanda) {
      khandaDocId = await resolveSection(
        khanda.documentId,
        khanda.title,
        L2type,
        khanda.order ?? undefined,
        granthaDocId,
        adhyayaDocId,
        skipSectionTouch,
      );
    }
    if (!khandaDocId) {
      const err: any = new Error(`Could not resolve section "${khanda.title}" in Strapi`);
      err.status = 500;
      throw err;
    }

    let sectionDocId: string | undefined = khandaDocId;
    if (levelThreeEnabled && padaId && padaNode) {
      sectionDocId = knownSectionId(padaNode.documentId);
      if (!sectionDocId) {
        sectionDocId = await resolveSection(
          padaNode.documentId,
          padaNode.title,
          L3type,
          padaNode.order ?? undefined,
          granthaDocId,
          khandaDocId,
          skipSectionTouch,
        );
      }
      if (!sectionDocId) {
        const err: any = new Error(`Could not resolve section "${padaNode.title}" in Strapi`);
        err.status = 500;
        throw err;
      }
    }
    if (!sectionDocId) {
      const err: any = new Error("Could not resolve target section in Strapi");
      err.status = 500;
      throw err;
    }

    const portalSiblings = (padaId && padaNode ? padaNode.manthras : khanda.manthras ?? [])
      .map((m: any) => ({ id: m.id, strapiDocumentId: m.strapiDocumentId, order: m.order }))
      .sort((a: PortalManthraSibling, b: PortalManthraSibling) => (a.order ?? 0) - (b.order ?? 0));

    const configuredLeaf = String(structureConfig?.leafName || "Mantra").trim() || "Mantra";
    const granthaName = String(data?.GranthaName || draft.title || "").trim();

    const publishFailures: Array<{ manthra: string; error: string }> = [];
    const returnedDocId = await publishManthraToStrapi(
      manthraNode,
      sectionDocId,
      granthaDocId,
      teekaNameToDocId,
      publishFailures,
      {
        fastSinglePublish: true,
        portalSiblings,
        configuredLeaf,
        granthaName,
      },
    );

    if (returnedDocId && manthraNode.id) {
      hierarchy = hierarchy.map((a: any) => {
        if (a.id !== adhyayaId) return a;
        return {
          ...a,
          khandas: (a.khandas || []).map((k: any) => {
            if (k.id !== khandaId) return k;
            if (padaId) {
              return {
                ...k,
                padas: (k.padas || []).map((p: any) => {
                  if (p.id !== padaId) return p;
                  return {
                    ...p,
                    manthras: (p.manthras || []).map((m: any) =>
                      m.id === manthraId ? { ...m, strapiDocumentId: returnedDocId } : m,
                    ),
                  };
                }),
              };
            }
            return {
              ...k,
              manthras: (k.manthras || []).map((m: any) =>
                m.id === manthraId ? { ...m, strapiDocumentId: returnedDocId } : m,
              ),
            };
          }),
        };
      });
      data = { ...data, hierarchy };
    }

    return { returnedDocId, publishFailures, hierarchy, data };
  }

  // ── Sync portal-only mantra slots to Strapi (server-authoritative section resolution) ──
  app.post("/api/drafts/:id/sync-mantra-slots", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid draft ID" });

      const draft = await storage.getDraft(id, user.id);
      if (!draft) return res.status(404).json({ message: "Draft not found" });

      const granthaDocId = draft.strapiDocumentId ?? undefined;
      if (!granthaDocId || granthaDocId.length < 10) {
        return res.status(400).json({
          message: "Grantha must be published to Strapi before mantra slots can sync to CMS.",
        });
      }

      const body = req.body as {
        adhyayaId?: string;
        khandaId?: string;
        padaId?: string;
        hierarchy?: unknown[];
        onlyManthraIds?: string[];
      };

      const data = draft.data as Record<string, any>;
      const result = await syncPendingMantraSlotsFromDraft({
        draftData: data,
        granthaDocId,
        resolveSection,
        mapSectionType,
        scope: {
          adhyayaId: body.adhyayaId,
          khandaId: body.khandaId,
          padaId: body.padaId,
        },
        hierarchyOverride: Array.isArray(body.hierarchy) ? body.hierarchy : undefined,
        onlyManthraIds: Array.isArray(body.onlyManthraIds) ? body.onlyManthraIds : undefined,
      });

      if (result.patches.length > 0 || result.hierarchy !== data.hierarchy) {
        await storage.updateDraft(id, user.id, {
          data: { ...data, hierarchy: result.hierarchy },
          status: "draft",
        });
      }

      const hardErrors = result.errors.filter(
        (e) => !e.includes("still pending CMS slot sync"),
      );

      res.json({
        ok: hardErrors.length === 0,
        patches: result.patches,
        hierarchy: result.hierarchy,
        errors: result.errors,
        remainingPending: result.remainingPending ?? 0,
        message:
          result.patches.length > 0
            ? `Created ${result.patches.length} CMS row(s). They appear in the Mantras tab (labels may show as empty until verse sync).`
            : result.errors.length > 0
              ? result.errors.join("; ")
              : "No pending portal-only verses to sync.",
      });
    } catch (error: any) {
      console.error("[sync-mantra-slots]", error);
      res.status(500).json({ message: error.message || "Mantra slot sync failed" });
    }
  });

  // ── Orphan mantras: blank ShlokaManthraNumber rows from failed slot sync ─────────────
  app.get("/api/granthas/:docId/orphan-manthras", requireAuth, async (req, res) => {
    try {
      const docId = req.params.docId?.trim();
      if (!docId || docId.length < 10) {
        return res.status(400).json({ message: "Valid grantha documentId required" });
      }
      const orphans = await listOrphanMantrasForGrantha(docId);
      res.json({ count: orphans.length, orphans });
    } catch (error: any) {
      console.error("[orphan-manthras]", error);
      res.status(500).json({ message: error.message || "Failed to list orphan mantras" });
    }
  });

  app.post("/api/granthas/:docId/cleanup-orphan-manthras", requireAuth, async (req, res) => {
    try {
      const docId = req.params.docId?.trim();
      if (!docId || docId.length < 10) {
        return res.status(400).json({ message: "Valid grantha documentId required" });
      }
      const dryRun = req.body?.dryRun === true;
      const result = await deleteOrphanMantrasForGrantha(docId, { dryRun });
      res.json({
        dryRun,
        orphanCount: result.orphans.length,
        deletedCount: result.deleted.length,
        failedCount: result.failed.length,
        deleted: result.deleted,
        failed: result.failed,
        message: dryRun
          ? `Found ${result.orphans.length} orphan row(s) — set dryRun:false to delete`
          : `Deleted ${result.deleted.length} orphan row(s)`,
      });
    } catch (error: any) {
      console.error("[cleanup-orphan-manthras]", error);
      res.status(500).json({ message: error.message || "Cleanup failed" });
    }
  });

  // ── Unified mantras view: Strapi rows + portal-only grantha draft verses ─────────────
  app.get("/api/cms/manthras-unified", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const granthaDrafts = await storage.getDraftsByType("granthas", user.id);
      const pending = granthaDrafts.flatMap((d) =>
        collectUnlinkedMantrasFromGranthaDraft({
          id: d.id,
          strapiDocumentId: d.strapiDocumentId,
          data: d.data as Record<string, unknown> | undefined,
        }),
      );
      res.json({ pendingGranthaMantras: pending });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to load unified mantras view" });
    }
  });

  // ── Publish preflight (integrity scan, no Strapi writes) ───────────────────
  app.post("/api/drafts/:id/publish-preflight", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid draft ID" });

      const draft = await storage.getDraft(id, user.id);
      if (!draft) return res.status(404).json({ message: "Draft not found" });

      const data = draft.data as Record<string, any>;
      const hierarchy: unknown[] = data?.hierarchy ?? [];
      const structureConfig = data?.structureConfig ?? {};
      const configuredLeaf = String(structureConfig?.leafName || "Mantra").trim() || "Mantra";
      const granthaName = String(data?.GranthaName || draft.title || "").trim();

      if (Array.isArray(hierarchy)) {
        const needsRenumber = hierarchyHasDuplicateMantraSuffixes(hierarchy, configuredLeaf, {
          levelThreeEnabled: !!structureConfig?.levelThreeEnabled,
        });
        const repaired = applyHierarchyRepairInPlace(hierarchy, structureConfig, configuredLeaf, {
          renumberVerseLabels: needsRenumber,
        });
        if (repaired) {
          await storage.updateDraft(id, user.id, { data: { ...data, hierarchy } });
        }
      }

      const violations = isPublishIntegrityEnabled()
        ? scanGranthaHierarchyMantras(hierarchy, configuredLeaf, granthaName, {
            maxErrors: 40,
            levelThreeEnabled: !!structureConfig?.levelThreeEnabled,
          })
        : [];

      const errors = violations.filter((v) => v.severity === "error");
      res.json({
        ok: errors.length === 0,
        violationCount: violations.length,
        errorCount: errors.length,
        violations: violations.slice(0, 40),
        message:
          errors.length > 0
            ? formatIntegrityFailures(errors)
            : "No blocking integrity issues found.",
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Preflight failed" });
    }
  });

  // ── Per-manthra publish ─────────────────────────────────────────────────────
  // Publishes (or updates) a single manthra from a grantha draft to Strapi.
  // Requires the grantha itself to already have a strapiDocumentId.
  // Body: { adhyayaId, khandaId, padaId?, manthraId }
  app.post("/api/drafts/:id/publish-manthra", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid draft ID" });

      const { adhyayaId, khandaId, padaId, manthraId, manthraData } = req.body;
      if (!adhyayaId || !khandaId || !manthraId) {
        return res.status(400).json({ message: "adhyayaId, khandaId, and manthraId are required" });
      }

      const jobId = Math.random().toString(36).substring(2, 14);
      const job: PublishJob = {
        status: "running",
        progress: { done: 0, total: 1, current: "Publishing mantra to Strapi…" },
        startedAt: new Date(),
      };
      publishJobs.set(jobId, job);
      void storage
        .createPublishJob({
          id: jobId,
          draftId: id,
          userId: user.id,
          granthaDocId: null,
          status: "running",
          progressDone: 0,
          progressTotal: 1,
          progressCurrent: job.progress.current,
          result: null,
          error: null,
        })
        .catch((e) => console.warn("[publish-manthra] Could not persist job row:", e?.message));

      res.json({
        async: true,
        jobId,
        message: "Mantra publish started. Verse with many teekas may take a minute or two.",
      });

      void (async () => {
        try {
          job.progress.current = "Syncing verse, teekas, and translations to Strapi…";
          const result = await publishOneManthraFromGranthaDraft(
            id,
            user.id,
            { adhyayaId, khandaId, padaId, manthraId },
            manthraData,
          );

          try {
            await storage.updateDraft(id, user.id, { data: result.data, status: "draft" });
          } catch (saveErr: any) {
            console.warn(`[publish-manthra] Could not save updated docId back to draft:`, saveErr.message);
          }

          const errors = result.publishFailures.filter((f) => !f.error.startsWith("[WARNING]"));
          if (errors.length > 0) {
            job.status = "failed";
            job.error = errors[0].error;
            await storage.updatePublishJob(jobId, {
              status: "failed",
              progressDone: 0,
              progressTotal: 1,
              progressCurrent: "Failed",
              error: job.error,
              result: { publishFailures: result.publishFailures },
            });
            return;
          }

          const responseBody = {
            strapiDocumentId: result.returnedDocId,
            warnings: result.publishFailures.filter((f) => f.error.startsWith("[WARNING]")),
          };
          job.status = "done";
          job.progress = { done: 1, total: 1, current: "Done" };
          job.result = responseBody;
          await storage.updatePublishJob(jobId, {
            status: "done",
            progressDone: 1,
            progressTotal: 1,
            progressCurrent: "Done",
            result: responseBody,
            error: null,
          });
        } catch (error: any) {
          console.error("[publish-manthra]", error);
          job.status = "failed";
          job.error = error.message || "Failed to publish mantra";
          void storage.updatePublishJob(jobId, {
            status: "failed",
            progressDone: 0,
            progressTotal: 1,
            progressCurrent: "Failed",
            error: job.error,
          });
        }
      })();
    } catch (error: any) {
      console.error("[publish-manthra]", error);
      const status = error?.status ?? 500;
      res.status(status).json({ message: error.message || "Failed to publish mantra" });
    }
  });

  // Batch publish: only the listed mantra nodes (used when grantha metadata/structure unchanged).
  app.post("/api/drafts/:id/publish-manthras-batch", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid draft ID" });

      const targets: Array<{ adhyayaId: string; khandaId: string; padaId?: string; manthraId: string }> =
        Array.isArray(req.body?.mantras) ? req.body.mantras : [];
      if (targets.length === 0) {
        return res.status(400).json({ message: "mantras array is required (at least one target)" });
      }

      const published: Array<{ manthraId: string; strapiDocumentId?: string }> = [];
      const failures: Array<{ manthraId: string; error: string }> = [];
      const warnings: Array<{ manthra: string; error: string }> = [];
      let lastData: any;

      for (const t of targets) {
        if (!t.adhyayaId || !t.khandaId || !t.manthraId) {
          failures.push({ manthraId: t.manthraId || "(unknown)", error: "Invalid target (missing ids)" });
          continue;
        }
        try {
          const result = await publishOneManthraFromGranthaDraft(id, user.id, t);
          lastData = result.data;
          const hard = result.publishFailures.filter((f) => !f.error.startsWith("[WARNING]"));
          warnings.push(...result.publishFailures.filter((f) => f.error.startsWith("[WARNING]")));
          if (hard.length > 0) {
            failures.push({ manthraId: t.manthraId, error: hard[0].error });
          } else {
            published.push({ manthraId: t.manthraId, strapiDocumentId: result.returnedDocId });
          }
        } catch (e: any) {
          failures.push({ manthraId: t.manthraId, error: e?.message || "Publish failed" });
        }
      }

      if (lastData) {
        try {
          const clearedScope = {
            ...lastData,
            publishScope: {
              changedManthraIds: [],
              requiresFullPublish: false,
              granthaMetaDirty: false,
            },
          };
          await storage.updateDraft(id, user.id, { data: clearedScope, status: "draft" });
        } catch (saveErr: any) {
          console.warn(`[publish-manthras-batch] Could not save draft:`, saveErr.message);
        }
      }

      if (published.length === 0 && failures.length > 0) {
        return res.status(500).json({
          message: failures[0].error,
          published,
          failures,
          warnings,
        });
      }

      res.json({
        publishedCount: published.length,
        failureCount: failures.length,
        published,
        failures,
        warnings,
      });
    } catch (error: any) {
      console.error("[publish-manthras-batch]", error);
      res.status(500).json({ message: error.message || "Failed to publish mantras" });
    }
  });

  app.post("/api/drafts/:id/publish", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid draft ID" });
      // Editor opt-in: after an intentional verse deletion the following verses shift
      // number, which the suffix-stability guard would otherwise block. The client sets
      // this only after the user confirms the renumber.
      const { allowRenumber } = (req.body ?? {}) as { allowRenumber?: boolean };
      let idem = await loadOrReplayIdempotency(req, `/api/drafts/${id}/publish`);
      if (idem?.replay) {
        // If the cached response references a publish job that is now failed/missing,
        // invalidate the cache and let a fresh publish start. Otherwise the client would
        // poll a dead jobId forever and never recover via retry.
        const cachedJobId = (idem.body as any)?.jobId;
        const key = (req.get?.("Idempotency-Key") || req.get?.("idempotency-key")) as string | undefined;
        if (cachedJobId && key) {
          const cachedJob = await storage.getPublishJob(cachedJobId);
          const stale =
            !cachedJob ||
            cachedJob.status === "failed" ||
            cachedJob.status === "failed_recoverable";
          if (stale) {
            await storage.deleteIdempotencyRecord(key);
            console.log(
              `[publish] idempotency replay invalidated for key=${key} (job ${cachedJobId} status=${cachedJob?.status ?? "missing"})`,
            );
            idem = await loadOrReplayIdempotency(req, `/api/drafts/${id}/publish`);
          }
        }
        if (idem?.replay) return res.status(idem.status).json(idem.body);
      }
      await withDraftLock(id, async () => {
        const existingJob = await storage.getRunningPublishJobForDraft(id);
        if (existingJob) {
          const runningResponse = { jobId: existingJob.id, async: true, message: "Publish already running" };
          if (idem && !idem.replay) {
            await persistIdempotency(idem.key, `/api/drafts/${id}/publish`, idem.hash, user.id, id, 200, runningResponse);
          }
          res.json(runningResponse);
          return;
        }

        let draft = await storage.getDraft(id, user.id);
        if (!draft) {
          res.status(404).json({ message: "Draft not found" });
          return;
        }
        void writeDraftSnapshot({
          event: "draft.publish.before",
          draftId: draft.id,
          userId: user.id,
          title: draft.title,
          status: draft.status,
          strapiDocumentId: draft.strapiDocumentId,
          data: draft.data,
          metadata: { contentType: draft.contentType },
        });
        if (draft.status === "published") {
          // Allow re-publishing: reset to "draft" so the publish route proceeds.
          // This handles the race window where the UI still shows the Publish button
          // after a successful publish (stale cache) and the user clicks again.
          const reset = await storage.updateDraft(id, user.id, { status: "draft" });
          if (reset) draft = reset;
        }

        if (STRAPI_UNROUTED_TYPES.has(draft.contentType)) {
          res.status(501).json({
            message: `Cannot publish ${draft.contentType} directly to Strapi — the REST API route for this collection type is not enabled on the Strapi server. Please create or edit this record in the Strapi Content Manager: http://13.53.121.15:1337/admin`,
          });
          return;
        }

        const strapiPlural = CONTENT_TYPE_MAP[draft.contentType];
        if (!strapiPlural) {
          res.status(400).json({ message: `Unknown content type: ${draft.contentType}` });
          return;
        }

      let strapiResult: any;
      let updatedHierarchy: any[] | undefined;
      let publishFailures: Array<{ manthra: string; error: string }> | undefined;

        if (draft.contentType === "granthas") {
        // Granthas publish can take several minutes (hundreds of Strapi API calls).
        // Run it in a background job so the HTTP request returns immediately and the
        // Replit proxy doesn't time it out. The client polls /publish-status for progress.

        // Per-grantha guard: two drafts can point at the same published Strapi grantha
        // (e.g. forked drafts). The lock lives on cms_publish_jobs.grantha_doc_id so it
        // survives process restart and works across multiple server instances.
        const targetGranthaDocId = draft.strapiDocumentId || undefined;
        if (targetGranthaDocId) {
          const inflight = await storage.getRunningPublishJobForGrantha(targetGranthaDocId);
          if (inflight && inflight.draftId !== id) {
            const runningResponse = {
              jobId: inflight.id,
              async: true,
              message: "Another publish is already running for this grantha",
            };
            if (idem && !idem.replay) {
              await persistIdempotency(idem.key, `/api/drafts/${id}/publish`, idem.hash, user.id, id, 200, runningResponse);
            }
            res.json(runningResponse);
            return;
          }
        }

        const jobId = Math.random().toString(36).substring(2, 14);
        const job: PublishJob = {
          status: "running",
          progress: { done: 0, total: 0, current: "Starting…" },
          startedAt: new Date(),
        };
        publishJobs.set(jobId, job);
        await storage.createPublishJob({
          id: jobId,
          draftId: id,
          userId: user.id,
          granthaDocId: targetGranthaDocId ?? null,
          status: "running",
          progressDone: 0,
          progressTotal: 0,
          progressCurrent: "Starting…",
          result: null,
          error: null,
        });
        cleanOldPublishJobs();

        // Respond immediately so the client connection is freed
        const startedResponse = { jobId, async: true, message: "Publish started in background" };
        if (idem && !idem.replay) {
          await persistIdempotency(idem.key, `/api/drafts/${id}/publish`, idem.hash, user.id, id, 200, startedResponse);
        }
        res.json(startedResponse);

        // Background: run the actual publish (don't await here)
        // Single attempt: retrying re-runs the entire grantha walk (progress resets to 0).
        withPublishRetries(
          () =>
            publishGranthaWithHierarchy(
              draft,
              jobId,
              (done, total, current, meta) => {
              job.progress = {
                done,
                total,
                current,
                breakdown: meta?.breakdown ?? job.progress.breakdown,
                summary: meta?.summary ?? job.progress.summary,
              };
              void storage.updatePublishJob(jobId, {
                status: "running",
                progressDone: done,
                progressTotal: total,
                progressCurrent: current,
              });
            },
              { allowRenumber: !!allowRenumber },
            ),
          1,
        )
          .then(async (result) => {
            // Sync Strapi documentIds back; clear pending deletions + publish scope so the
            // next publish does not re-run full delete/sync or auto-retry the same work.
            // Exception: deletes that failed (non-404 from Strapi) are preserved on the
            // draft so the next publish retries them — otherwise transient errors leave
            // orphan rows in Strapi forever.
            const existingData = (draft.data as Record<string, any>) ?? {};
            const {
              deletedStrapiSectionDocIds: _ds,
              deletedStrapiManthraDocIds: _dm,
              deletedStrapiTeekaDocIds: _dt,
              publishScope: _ps,
              ...restDraft
            } = existingData;
            const retrySections = Array.isArray(result.failedDeletedSectionDocIds)
              ? result.failedDeletedSectionDocIds
              : [];
            const retryManthras = Array.isArray(result.failedDeletedManthraDocIds)
              ? result.failedDeletedManthraDocIds
              : [];
            await storage.updateDraft(id, user.id, {
              data: {
                ...restDraft,
                ...(result.updatedHierarchy ? { hierarchy: result.updatedHierarchy } : {}),
                ...(retrySections.length > 0
                  ? { deletedStrapiSectionDocIds: retrySections }
                  : {}),
                ...(retryManthras.length > 0
                  ? { deletedStrapiManthraDocIds: retryManthras }
                  : {}),
                publishScope: {
                  changedManthraIds: [],
                  requiresFullPublish: false,
                  granthaMetaDirty: false,
                },
              },
            });
            const newDocumentId =
              result.strapiResult?.data?.documentId || draft.strapiDocumentId;
            const updated = await storage.markDraftPublished(id, user.id, newDocumentId);
            if (updated) {
              void writeDraftSnapshot({
                event: "draft.publish.after",
                draftId: updated.id,
                userId: user.id,
                title: updated.title,
                status: updated.status,
                strapiDocumentId: updated.strapiDocumentId,
                data: updated.data,
                metadata: { background: true, contentType: draft.contentType },
              });
            }
            const responseBody: Record<string, any> = { draft: updated, strapi: result.strapiResult };
            const warnings: Array<{ manthra: string; error: string }> = [];
            if (Array.isArray(result.publishFailures) && result.publishFailures.length > 0) {
              warnings.push(...result.publishFailures);
            }
            for (const sid of result.failedDeletedSectionDocIds ?? []) {
              warnings.push({
                manthra: `[Section ${sid}]`,
                error: "Strapi delete failed — will retry on next publish",
              });
            }
            for (const mid of result.failedDeletedManthraDocIds ?? []) {
              warnings.push({
                manthra: `[Manthra ${mid}]`,
                error: "Strapi delete failed — will retry on next publish",
              });
            }
            if (warnings.length > 0) responseBody.warnings = warnings;
            job.status = "done";
            job.result = responseBody;
            await storage.updatePublishJob(jobId, {
              status: "done",
              progressDone: job.progress.done,
              progressTotal: job.progress.total,
              progressCurrent: job.progress.current,
              result: responseBody,
              error: null,
            });
            // Drop the manthra checkpoint table now that this publish succeeded; the docIds
            // are persisted back into the draft's hierarchy JSON above so the table is no
            // longer load-bearing for the next attempt.
            void storage
              .deleteManthraResolutions(jobId)
              .catch((e) => console.warn(`[publish] resolution cleanup failed: ${e?.message || e}`));
          })
          .catch((err: any) => {
            console.error(`[publish-bg] Job ${jobId} failed:`, err.message);
            // Do not mark integrity/preflight failures as recoverable — the client used to
            // auto-POST /publish on failed_recoverable and restart the full grantha job.
            const recoverable = isRetryablePublishError(err);
            job.status = recoverable ? "failed_recoverable" : "failed";
            job.error = err.message || "Publish failed";
            void storage.updatePublishJob(jobId, {
              status: recoverable ? "failed_recoverable" : "failed",
              progressDone: job.progress.done,
              progressTotal: job.progress.total,
              progressCurrent: job.progress.current,
              error: job.error,
              result:
                err?.violations || err?.failures
                  ? { violations: err.violations, failures: err.failures }
                  : null,
            });
          });
        // No in-process Map to clear: the grantha-level lock lives on cms_publish_jobs
        // (status='running' → no longer running once updatePublishJob flips it to
        // done/failed in the then/catch handlers above).

        return; // Response already sent
        } else {
        const cleanedData =
          draft.contentType === "manthras"
            ? await buildManthraPayloadAsync(draft.data as Record<string, any>, draft.strapiDocumentId ?? undefined)
            : draft.contentType === "sections"
            ? buildSectionPayload(draft.data as Record<string, any>)
            : draft.contentType === "chapters"
            ? await buildChapterPayload(draft.data as Record<string, any>)
            : draft.contentType === "articles"
            ? (() => {
                const articleErr = validateArticleDraft(draft.data as Record<string, unknown>);
                if (articleErr) {
                  const err: any = new Error(articleErr);
                  err.status = 400;
                  throw err;
                }
                return cleanPayloadForStrapi(
                  buildArticleStrapiPayload(draft.data as Record<string, unknown>),
                );
              })()
            : cleanPayloadForStrapi(draft.data as Record<string, any>);

        // Log a size summary rather than the full JSON: stringify on a 500KB-2MB rich-text
        // payload is a synchronous main-loop hit that meaningfully delays the actual PUT.
        const cleanedKeys = cleanedData && typeof cleanedData === "object" ? Object.keys(cleanedData) : [];
        console.log(`[publish] ${draft.contentType} payload: keys=[${cleanedKeys.join(",")}] teekas=${Array.isArray((cleanedData as any)?.Teekas) ? (cleanedData as any).Teekas.length : 0}`);

        if (draft.strapiDocumentId) {
          strapiResult = await strapiRequest(
            `/api/${strapiPlural}/${draft.strapiDocumentId}`,
            {
              method: "PUT",
              body: JSON.stringify({ data: cleanedData }),
            }
          );
        } else {
          strapiResult = await strapiRequest(`/api/${strapiPlural}`, {
            method: "POST",
            body: JSON.stringify({ data: cleanedData }),
          });
        }
      }

      // Sync Strapi documentIds back into the draft hierarchy so subsequent
      // publishes skip dedup API lookups and do direct PUTs for known manthras.
        if (updatedHierarchy) {
        const existingData = (draft.data as Record<string, any>) ?? {};
        await storage.updateDraft(id, user.id, {
          data: { ...existingData, hierarchy: updatedHierarchy },
        });
      }

        const newDocumentId = strapiResult?.data?.documentId || draft.strapiDocumentId;
        const updated = await storage.markDraftPublished(id, user.id, newDocumentId);
      if (updated) {
        void writeDraftSnapshot({
          event: "draft.publish.after",
          draftId: updated.id,
          userId: user.id,
          title: updated.title,
          status: updated.status,
          strapiDocumentId: updated.strapiDocumentId,
          data: updated.data,
          metadata: { background: false, contentType: draft.contentType },
        });
      }

        const responseBody: Record<string, any> = { draft: updated, strapi: strapiResult };
        if (publishFailures && publishFailures.length > 0) {
          responseBody.warnings = publishFailures;
        }
        if (idem && !idem.replay) {
          await persistIdempotency(idem.key, `/api/drafts/${id}/publish`, idem.hash, user.id, id, 200, responseBody);
        }
        res.json(responseBody);
      });
    } catch (error: any) {
      if ((error as any)?.status) return res.status((error as any).status).json({ message: (error as any).message });
      res.status(500).json({ message: error.message || "Failed to publish draft" });
    }
  });

  // ── Background publish status polling ──────────────────────────────────────
  // Client polls this endpoint while a grantha publish job is running.
  // Returns { status, progress: { done, total, current }, result?, error? }
  app.get("/api/drafts/:id/publish-status", requireAuth, async (req, res) => {
    const { jobId } = req.query;
    if (!jobId || typeof jobId !== "string") {
      return res.status(400).json({ message: "jobId query param required" });
    }
    const memJob = publishJobs.get(jobId);
    if (memJob) {
      return res.json({
        status: memJob.status,
        progress: memJob.progress,
        ...(memJob.result ? { result: memJob.result } : {}),
        ...(memJob.error ? { error: memJob.error } : {}),
      });
    }
    const dbJob = await storage.getPublishJob(jobId);
    if (!dbJob) return res.status(404).json({ message: "Job not found (may have expired)" });
    res.json({
      status: dbJob.status,
      progress: {
        done: dbJob.progressDone ?? 0,
        total: dbJob.progressTotal ?? 0,
        current: dbJob.progressCurrent ?? "Starting…",
      },
      ...(dbJob.result ? { result: dbJob.result } : {}),
      ...(dbJob.error ? { error: dbJob.error } : {}),
    });
  });

  // ───────────────── Portal vocabulary (dropdowns) ─────────────────

  app.get("/api/cms/vocabulary", requireAuth, async (_req, res) => {
    try {
      res.json(await getPortalVocabulary());
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to load vocabulary" });
    }
  });

  app.post("/api/admin/cms/vocabulary", requireAuth, requireAdmin, async (req, res) => {
    try {
      const user = req.user as User;
      const key = req.body?.key as PortalVocabularyKey;
      const value = typeof req.body?.value === "string" ? req.body.value : "";
      if (!portalVocabularyKeys.includes(key)) {
        return res.status(400).json({ message: "Invalid vocabulary key" });
      }
      const vocabulary = await addPortalVocabularyEntry(key, value, user.id);
      res.json(vocabulary);
    } catch (error: any) {
      const status = error?.status ?? 500;
      res.status(status).json({ message: error.message || "Failed to add vocabulary entry" });
    }
  });

  app.delete("/api/admin/cms/vocabulary", requireAuth, requireAdmin, async (req, res) => {
    try {
      const user = req.user as User;
      const key = req.body?.key as PortalVocabularyKey;
      const value = typeof req.body?.value === "string" ? req.body.value : "";
      if (!portalVocabularyKeys.includes(key)) {
        return res.status(400).json({ message: "Invalid vocabulary key" });
      }
      const vocabulary = await removePortalVocabularyEntry(key, value, user.id);
      res.json(vocabulary);
    } catch (error: any) {
      const status = error?.status ?? 500;
      res.status(status).json({ message: error.message || "Failed to remove vocabulary entry" });
    }
  });

  // ───────────────── Admin: User Management ─────────────────

  // List all users (admin only)
  app.get("/api/admin/users", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      const safe = allUsers.map(({ password: _, ...u }) => u);
      res.json(safe);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch users" });
    }
  });

  // Create a new user (admin only)
  app.post("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { username, password, displayName, role } = req.body;
      if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required" });
      }
      if (password.length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters" });
      }
      const existing = await storage.getUserByUsername(username);
      if (existing) {
        return res.status(409).json({ message: "Username already exists" });
      }
      const hashed = await hashPassword(password);
      const user = await storage.createUser({
        username,
        password: hashed,
        displayName: displayName || username,
        role: role === "admin" ? "admin" : "editor",
      });
      const { password: _, ...safe } = user;
      res.status(201).json(safe);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to create user" });
    }
  });

  // Update user role (admin only)
  app.patch("/api/admin/users/:id/role", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { role } = req.body;
      if (!role || !["admin", "editor"].includes(role)) {
        return res.status(400).json({ message: "Role must be 'admin' or 'editor'" });
      }
      const updated = await storage.updateUserRole(id, role);
      if (!updated) return res.status(404).json({ message: "User not found" });
      const { password: _, ...safe } = updated;
      res.json(safe);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to update role" });
    }
  });

  // Reset user password (admin only)
  app.patch("/api/admin/users/:id/password", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { password } = req.body;
      if (!password || password.length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters" });
      }
      const hashed = await hashPassword(password);
      const updated = await storage.updateUserPassword(id, hashed);
      if (!updated) return res.status(404).json({ message: "User not found" });
      res.json({ message: "Password updated" });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to reset password" });
    }
  });

  // ── Backup routes (admin only — read-only snapshots of all Strapi content) ──
  // Backups are immutable: no update or delete routes exist.

  async function fetchAllStrapiPages(basePath: string): Promise<any[]> {
    const sep = basePath.includes("?") ? "&" : "?";
    const firstUrl = `${basePath}${sep}pagination[page]=1&pagination[pageSize]=100`;
    const first = await strapiRequest(firstUrl);
    if (!first?.data || !Array.isArray(first.data)) return [];
    const { pageCount } = first.meta?.pagination ?? {};
    if (!pageCount || pageCount <= 1) return first.data;
    const remaining = Array.from({ length: pageCount - 1 }, (_, i) => i + 2);
    const pages = await Promise.all(
      remaining.map((p) => strapiRequest(`${basePath}${sep}pagination[page]=${p}&pagination[pageSize]=100`))
    );
    return [first.data, ...pages.map((r) => (r?.data ?? []))].flat();
  }

  async function fetchAllStrapiPagesLarge(
    basePath: string,
    options?: { pageSize?: number; concurrency?: number },
  ): Promise<any[]> {
    const pageSize = options?.pageSize ?? 50;
    const concurrency = options?.concurrency ?? 2;
    const sep = basePath.includes("?") ? "&" : "?";
    const pageQuery = `pagination[pageSize]=${pageSize}`;
    const firstUrl = `${basePath}${sep}pagination[page]=1&${pageQuery}`;
    const first = await strapiRequestLarge(firstUrl);
    if (!first?.data || !Array.isArray(first.data)) return [];
    const { pageCount } = first.meta?.pagination ?? {};
    if (!pageCount || pageCount <= 1) return first.data;

    const results: any[][] = new Array(pageCount - 1);
    const remaining = Array.from({ length: pageCount - 1 }, (_, i) => i + 2);

    for (let i = 0; i < remaining.length; i += concurrency) {
      const batch = remaining.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map((p) =>
          strapiRequestLarge(`${basePath}${sep}pagination[page]=${p}&${pageQuery}`),
        ),
      );
      batchResults.forEach((r, j) => {
        results[i + j] = r?.data ?? [];
      });
      console.log(`[backup] Fetched manthra pages ${batch[0]}–${batch[batch.length - 1]} of ${pageCount}`);
    }

    return [first.data, ...results].flat();
  }

  app.get("/api/admin/backups", requireAuth, async (_req, res) => {
    try {
      const backups = await storage.listBackups();
      res.json(backups);
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to list backups" });
    }
  });

  // Full data dump (kept for download; not used by Browse UI).
  app.get("/api/admin/backups/:id/data", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid backup ID" });
      const backup = await storage.getBackup(id);
      if (!backup) return res.status(404).json({ message: "Backup not found" });
      res.json({
        id: backup.id,
        label: backup.label,
        createdAt: backup.createdAt,
        granthaCount: backup.granthaCount,
        sectionCount: backup.sectionCount,
        manthraCount: backup.manthraCount,
        data: decompressBackupData(backup.data),
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to load backup" });
    }
  });

  // Lightweight summary: metadata + granthas + sections (no manthra text).
  // Used by the Browse UI to populate the sidebar without fetching the full blob.
  app.get("/api/admin/backups/:id/summary", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid backup ID" });
      const backup = await storage.getBackup(id);
      if (!backup) return res.status(404).json({ message: "Backup not found" });
      const d = decompressBackupData(backup.data);

      // Build per-section manthra count from the manthras array.
      const manthraCountBySection: Record<number, number> = {};
      for (const m of (d.manthras ?? [])) {
        const sid = m?.Section?.id;
        if (sid != null) manthraCountBySection[sid] = (manthraCountBySection[sid] ?? 0) + 1;
      }

      res.json({
        id: backup.id,
        label: backup.label,
        createdAt: backup.createdAt,
        granthaCount: backup.granthaCount,
        sectionCount: backup.sectionCount,
        manthraCount: backup.manthraCount,
        granthas: d.granthas ?? [],
        sections: (d.sections ?? []).map((s: any) => ({
          id: s.id,
          documentId: s.documentId,
          title: s.title,
          type: s.type,
          order: s.order,
          grantha: s.grantha,
          parent: s.parent,
          manthraCount: manthraCountBySection[s.id] ?? 0,
        })),
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to load backup summary" });
    }
  });

  // Manthras for a specific section — fetched on demand by the Browse UI.
  app.get("/api/admin/backups/:id/sections/:sectionId/manthras", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const sectionId = parseInt(req.params.sectionId);
      if (isNaN(id) || isNaN(sectionId)) return res.status(400).json({ message: "Invalid ID" });
      const backup = await storage.getBackup(id);
      if (!backup) return res.status(404).json({ message: "Backup not found" });
      const d = decompressBackupData(backup.data);
      const manthras = (d.manthras ?? []).filter((m: any) => m?.Section?.id === sectionId);
      manthras.sort((a: any, b: any) => (a.order ?? 999) - (b.order ?? 999));
      res.json(manthras);
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to load manthras" });
    }
  });

  app.get("/api/admin/backups/:id/download", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid backup ID" });
      const backup = await storage.getBackup(id);
      if (!backup) return res.status(404).json({ message: "Backup not found" });
      const label = (backup.label as string).replace(/[^a-z0-9_\-]/gi, "_");
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="ekatmadham-backup-${label}-${backup.id}.json"`);
      res.json(decompressBackupData(backup.data));
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to download backup" });
    }
  });

  // Download backup as a SQLite database file — fully normalized tables, queryable in any DB browser.
  app.get("/api/admin/backups/:id/export-sqlite", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid backup ID" });
      const backup = await storage.getBackup(id);
      if (!backup) return res.status(404).json({ message: "Backup not found" });
      const label = (backup.label as string).replace(/[^a-z0-9_\-]/gi, "_");
      const sqliteBuf = buildSqliteFromBackup(decompressBackupData(backup.data));
      res.setHeader("Content-Type", "application/x-sqlite3");
      res.setHeader("Content-Disposition", `attachment; filename="ekatmadham-${label}-${backup.id}.sqlite"`);
      res.setHeader("Content-Length", sqliteBuf.length);
      res.end(sqliteBuf);
    } catch (e: any) {
      console.error("[sqlite-export] failed:", e.message);
      res.status(500).json({ message: e.message || "Failed to export SQLite" });
    }
  });

  // Import a backup snapshot from another environment (e.g. copy dev → prod).
  // Body: { label, granthaCount, sectionCount, manthraCount, data }
  app.post("/api/admin/backups/import", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { label, granthaCount, sectionCount, manthraCount, data } = req.body;
      if (!data || typeof data !== "object") return res.status(400).json({ message: "Missing data payload" });

      const normalized = normalizeSnapshotPayload(data);
      if (!normalized) {
        return res.status(400).json({
          message:
            "Invalid snapshot JSON format. Expected granthas/sections/manthras arrays (optionally wrapped in data or _compressed payload).",
        });
      }

      const effectiveGranthaCount = Number(granthaCount ?? normalized.granthas?.length ?? 0);
      const effectiveSectionCount = Number(sectionCount ?? normalized.sections?.length ?? 0);
      const effectiveManthraCount = Number(manthraCount ?? normalized.manthras?.length ?? 0);

      const backup = await storage.createBackup(
        label ?? new Date().toISOString(),
        compressBackupData(normalized),
        effectiveGranthaCount,
        effectiveSectionCount,
        effectiveManthraCount,
      );
      res.status(201).json({ id: backup.id, label: backup.label });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Import failed" });
    }
  });

  // ── Restore lost Strapi content from a snapshot ──────────────────────────────
  // Compares each manthra in the backup against live Strapi and re-pushes any
  // field (teekas | bhashyam | both | shloka_ot | all) that is present in the backup
  // but missing from the live record.  Only overwrites when the live field is genuinely empty
  // (Teekas=[] / BhashyamEntry null) so existing live content is never clobbered.
  //
  // Strategy: batch-fetch ALL manthras for the grantha from Strapi in one paginated
  // query (much faster than one API call per manthra), then for each manthra where
  // the backup has content that is absent in Strapi, push the content back.
  //
  // The endpoint responds immediately with "started" and a jobId.
  // The caller polls GET /api/admin/restore-jobs/:jobId for progress + results.
  const restoreJobs = new Map<string, {
    status: "running" | "done" | "error";
    progress: number; total: number;
    results: { manthra: string; docId: string; action: string }[];
    errors: { manthra: string; error: string }[];
    message?: string;
  }>();

  type RestoreFieldScope = "teekas" | "bhashyam" | "both" | "shloka_ot" | "all";

  function backupOtLangsSet(entry: any): Set<string> {
    const set = new Set<string>();
    for (const r of entry?.OtherTranslations ?? []) {
      const lang = (r?.LanguageOfTranslation ?? "").trim();
      if (lang && textEntryHasPublishableContent({ TranslationText: r.TranslationText })) {
        set.add(lang);
      }
    }
    return set;
  }

  /** Restore one mantra from snapshot into live Strapi; other mantras in the grantha are untouched. */
  async function restoreSingleMantraFromBackup(
    bm: any,
    granthaDocId: string,
    field: RestoreFieldScope,
  ): Promise<{ actions: string[]; skipped: string[]; errors: string[] }> {
    const label = bm.ShlokaManthraNumber ?? bm.documentId;
    const docId = bm.documentId as string;
    const actions: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    if (!docId || docId.length < 10) {
      errors.push("Invalid mantra documentId in snapshot");
      return { actions, skipped, errors };
    }

    let liveSummary: { hasTeekas: boolean; hasBhashyam: boolean; shlokaOtCount: number; bhashyamOtCount: number };
    try {
      const livePeek = await strapiRequest(
        `/api/manthras/${docId}?fields[0]=documentId` +
        `&populate[Teekas][fields][0]=id` +
        `&populate[BhashyamEntry][fields][0]=id` +
        `&populate[ShlokaManthraEntry][populate][OtherTranslations]=true` +
        `&populate[BhashyamEntry][populate][OtherTranslations]=true`,
      );
      const item = livePeek?.data;
      if (!item?.documentId) {
        errors.push(`Mantra "${label}" not found in live Strapi — cannot restore (no create)`);
        return { actions, skipped, errors };
      }
      const countOt = (entry: any) =>
        (entry?.OtherTranslations ?? []).filter(
          (r: any) =>
            (r?.LanguageOfTranslation ?? "").trim() &&
            textEntryHasPublishableContent({ TranslationText: r.TranslationText }),
        ).length;
      liveSummary = {
        hasTeekas: Array.isArray(item.Teekas) && item.Teekas.length > 0,
        hasBhashyam: !!(item.BhashyamEntry?.id),
        shlokaOtCount: countOt(item.ShlokaManthraEntry),
        bhashyamOtCount: countOt(item.BhashyamEntry),
      };
    } catch (e: any) {
      errors.push(e?.message ?? String(e));
      return { actions, skipped, errors };
    }

    if (field === "teekas" || field === "both" || field === "all") {
      const backupHasTeeka = (bm.Teekas ?? []).some(
        (t: any) =>
          t.TeekaEntry?.SanskritTextEntry?.length > 0 ||
          t.TeekaEntry?.EnglishTranslationText?.length > 0 ||
          t.TeekaEntry?.OtherTranslations?.length > 0,
      );
      if (!backupHasTeeka) {
        skipped.push("Teekas — none in snapshot");
      } else if (liveSummary.hasTeekas) {
        skipped.push("Teekas — already present in live Strapi");
      } else {
        try {
          const resolved = await resolveManthraTeekas(bm.Teekas, granthaDocId);
          if (resolved.length > 0) {
            await strapiRequest(`/api/manthras/${docId}`, {
              method: "PUT",
              body: JSON.stringify({ data: { Teekas: resolved } }),
            });
            actions.push(`restored ${resolved.length} teeka(s)`);
          } else {
            errors.push("Could not resolve teeka docIds from Strapi");
          }
        } catch (e: any) {
          errors.push(`Teekas: ${e?.message ?? String(e)}`);
        }
      }
    }

    if (field === "bhashyam" || field === "both" || field === "all") {
      const backupHasBhashyam =
        bm.BhashyamEntry &&
        (bm.BhashyamEntry.SanskritTextEntry?.length > 0 ||
          bm.BhashyamEntry.EnglishTranslationText?.length > 0);
      if (!backupHasBhashyam) {
        skipped.push("Bhashyam — none in snapshot");
      } else if (liveSummary.hasBhashyam) {
        skipped.push("Bhashyam — already present in live Strapi");
      } else {
        try {
          const normalizedBhashyam = normalizeTextAndTranslation(bm.BhashyamEntry);
          await strapiRequest(`/api/manthras/${docId}`, {
            method: "PUT",
            body: JSON.stringify({ data: { BhashyamEntry: normalizedBhashyam } }),
          });
          actions.push("restored BhashyamEntry");
        } catch (e: any) {
          errors.push(`Bhashyam: ${e?.message ?? String(e)}`);
        }
      }
    }

    if (field === "shloka_ot" || field === "all") {
      const backupCount = backupOtLangsSet(bm.ShlokaManthraEntry).size;
      if (backupCount < 1) {
        skipped.push("Shloka translations — none in snapshot");
      } else if (backupCount <= liveSummary.shlokaOtCount) {
        skipped.push(`Shloka translations — live already has ${liveSummary.shlokaOtCount} (snapshot ${backupCount})`);
      } else {
        try {
          const liveFull = (
            await strapiRequest(
              `/api/manthras/${docId}?populate[ShlokaManthraEntry][populate][OtherTranslations]=*`,
            )
          )?.data;
          const liveEntry = liveFull?.ShlokaManthraEntry ?? {};
          const liveOt: any[] = Array.isArray(liveEntry.OtherTranslations) ? liveEntry.OtherTranslations : [];
          const liveLangs = backupOtLangsSet(liveEntry);
          const backupOt = (bm.ShlokaManthraEntry?.OtherTranslations ?? []).filter((r: any) => {
            const lang = (r?.LanguageOfTranslation ?? "").trim();
            return lang && !liveLangs.has(lang) && textEntryHasPublishableContent({ TranslationText: r.TranslationText });
          });
          if (backupOt.length === 0) {
            skipped.push("Shloka translations — no missing languages to merge");
          } else {
            const mergedOt = mergeOtherTranslations(
              backupOt.map((r: any) => omitTranslationComponentIdentity(r)),
              liveOt,
            );
            const payload = {
              SanskritTextEntry: liveEntry.SanskritTextEntry,
              EnglishTranslationText: liveEntry.EnglishTranslationText,
              IASTTransliteration: liveEntry.IASTTransliteration,
              OtherTranslations: mergedOt,
            };
            const normalized = normalizeTextAndTranslation(payload);
            await strapiRequest(`/api/manthras/${docId}`, {
              method: "PUT",
              body: JSON.stringify({ data: { ShlokaManthraEntry: normalized } }),
            });
            actions.push(
              `merged ${backupOt.length} shloka translation(s): ${backupOt.map((r: any) => r.LanguageOfTranslation).join(", ")}`,
            );
          }
        } catch (e: any) {
          errors.push(`Shloka translations: ${e?.message ?? String(e)}`);
        }
      }
    }

    return { actions, skipped, errors };
  }

  app.post("/api/admin/backups/:id/restore-manthra", requireAuth, requireAdmin, async (req, res) => {
    try {
      const backupId = parseInt(req.params.id, 10);
      if (Number.isNaN(backupId)) return res.status(400).json({ message: "Invalid backup ID" });

      const { manthraDocumentId, granthaDocId, field = "all" } = req.body as {
        manthraDocumentId?: string;
        granthaDocId?: string;
        field?: RestoreFieldScope;
      };
      if (!manthraDocumentId || manthraDocumentId.length < 10) {
        return res.status(400).json({ message: "manthraDocumentId is required" });
      }
      if (!granthaDocId || granthaDocId.length < 10) {
        return res.status(400).json({ message: "granthaDocId is required" });
      }

      const allowed: RestoreFieldScope[] = ["teekas", "bhashyam", "both", "shloka_ot", "all"];
      const scope = allowed.includes(field as RestoreFieldScope) ? (field as RestoreFieldScope) : "all";

      const backup = await storage.getBackup(backupId);
      if (!backup) return res.status(404).json({ message: "Backup not found" });
      const bData = decompressBackupData(backup.data);

      const bm = (bData.manthras ?? []).find((m: any) => m.documentId === manthraDocumentId);
      if (!bm) {
        return res.status(404).json({ message: "Mantra not found in this snapshot" });
      }

      const { actions, skipped, errors } = await restoreSingleMantraFromBackup(bm, granthaDocId, scope);
      const label = bm.ShlokaManthraNumber ?? manthraDocumentId;

      if (errors.length > 0 && actions.length === 0) {
        return res.status(500).json({
          ok: false,
          manthra: label,
          documentId: manthraDocumentId,
          message: errors[0],
          actions,
          skipped,
          errors,
        });
      }

      res.json({
        ok: true,
        manthra: label,
        documentId: manthraDocumentId,
        restored: actions.length,
        actions,
        skipped,
        errors,
        message:
          actions.length > 0
            ? actions.join("; ")
            : skipped.length > 0
              ? skipped.join("; ")
              : "Nothing to restore for this mantra",
      });
    } catch (e: any) {
      console.error("[restore-manthra]", e);
      res.status(500).json({ message: e.message || "Failed to restore mantra" });
    }
  });

  app.post("/api/admin/backups/:id/restore-grantha", requireAuth, requireAdmin, async (req, res) => {
    const backupId = parseInt(req.params.id);
    const { granthaDocId, field = "both" } = req.body as {
      granthaDocId: string;
      field?: "teekas" | "bhashyam" | "both" | "shloka_ot" | "all";
    };
    if (!granthaDocId) return res.status(400).json({ message: "granthaDocId is required" });
    if (isNaN(backupId)) return res.status(400).json({ message: "Invalid backup ID" });

    const backup = await storage.getBackup(backupId);
    if (!backup) return res.status(404).json({ message: "Backup not found" });
    const bData = decompressBackupData(backup.data);

    const sectionDocIds = new Set<string>(
      (bData.sections ?? [])
        .filter((s: any) => s.grantha?.documentId === granthaDocId)
        .map((s: any) => s.documentId as string)
    );

    const backupManthras: any[] = (bData.manthras ?? []).filter((m: any) =>
      sectionDocIds.has(m.Section?.documentId ?? m.section?.documentId ?? "")
    );

    if (backupManthras.length === 0) {
      return res.json({ total: 0, restored: 0, skipped: 0, errored: 0, results: [], errors: [] });
    }

    // Generate a simple job ID
    const jobId = `restore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    restoreJobs.set(jobId, { status: "running", progress: 0, total: backupManthras.length, results: [], errors: [] });

    // Respond immediately so the HTTP connection doesn't time out
    res.status(202).json({ jobId, total: backupManthras.length });

    // Run the restore in the background
    (async () => {
      const job = restoreJobs.get(jobId)!;
      try {
        // Step 1: Batch-fetch all live manthras for this grantha from Strapi (paginated)
        // We ask for just enough fields to know whether teekas/bhashyam are present.
        const countFilledOtLangs = (entry: any): number => {
          const ot = entry?.OtherTranslations;
          if (!Array.isArray(ot)) return 0;
          return ot.filter(
            (r: any) =>
              (r?.LanguageOfTranslation ?? "").trim() &&
              textEntryHasPublishableContent({ TranslationText: r.TranslationText }),
          ).length;
        };

        const liveManthraMap = new Map<string, { hasTeekas: boolean; hasBhashyam: boolean }>();
        let page = 1;
        while (true) {
          const liveRes = await strapiRequest(
            `/api/manthras?filters[Section][grantha][documentId][$eq]=${encodeURIComponent(granthaDocId)}` +
            `&fields[0]=documentId` +
            `&populate[Teekas][fields][0]=id` +
            `&populate[BhashyamEntry][fields][0]=id` +
            `&populate[ShlokaManthraEntry][populate][OtherTranslations]=true` +
            `&populate[BhashyamEntry][populate][OtherTranslations]=true` +
            `&pagination[page]=${page}&pagination[pageSize]=50`
          );
          const items: any[] = liveRes?.data ?? [];
          for (const item of items) {
            liveManthraMap.set(item.documentId, {
              hasTeekas: Array.isArray(item.Teekas) && item.Teekas.length > 0,
              hasBhashyam: !!(item.BhashyamEntry?.id),
              shlokaOtCount: countFilledOtLangs(item.ShlokaManthraEntry),
              bhashyamOtCount: countFilledOtLangs(item.BhashyamEntry),
            } as any);
          }
          if (items.length < 50) break;
          page++;
        }

        console.log(`[restore-job ${jobId}] Fetched ${liveManthraMap.size} live manthras from Strapi`);

        // Step 2: Identify manthras that need restoration
        const toRestoreTeekas: any[] = [];
        const toRestoreBhashyam: any[] = [];
        const toRestoreShlokaOt: any[] = [];

        const backupOtLangs = (entry: any): Set<string> => {
          const set = new Set<string>();
          for (const r of entry?.OtherTranslations ?? []) {
            const lang = (r?.LanguageOfTranslation ?? "").trim();
            if (lang && textEntryHasPublishableContent({ TranslationText: r.TranslationText })) {
              set.add(lang);
            }
          }
          return set;
        };

        for (const bm of backupManthras) {
          const docId: string = bm.documentId;
          if (!docId) continue;
          const live = liveManthraMap.get(docId) as
            | { hasTeekas: boolean; hasBhashyam: boolean; shlokaOtCount?: number; bhashyamOtCount?: number }
            | undefined;
          if (!live) continue; // Not found in Strapi — skip (don't create)

          if (field === "teekas" || field === "both" || field === "all") {
            const backupHasTeeka = (bm.Teekas ?? []).some(
              (t: any) =>
                t.TeekaEntry?.SanskritTextEntry?.length > 0 ||
                t.TeekaEntry?.EnglishTranslationText?.length > 0 ||
                t.TeekaEntry?.OtherTranslations?.length > 0
            );
            if (backupHasTeeka && !live.hasTeekas) {
              toRestoreTeekas.push(bm);
            }
          }

          if (field === "bhashyam" || field === "both" || field === "all") {
            const backupHasBhashyam =
              bm.BhashyamEntry &&
              (bm.BhashyamEntry.SanskritTextEntry?.length > 0 ||
                bm.BhashyamEntry.EnglishTranslationText?.length > 0);
            if (backupHasBhashyam && !live.hasBhashyam) {
              toRestoreBhashyam.push(bm);
            }
          }

          if (field === "shloka_ot" || field === "all") {
            const backupCount = backupOtLangs(bm.ShlokaManthraEntry).size;
            const liveCount = live.shlokaOtCount ?? 0;
            if (backupCount >= 30 && backupCount > liveCount) {
              toRestoreShlokaOt.push(bm);
            }
          }
        }

        const needingRestore = new Set(
          [...toRestoreTeekas, ...toRestoreBhashyam, ...toRestoreShlokaOt].map((m: any) => m.documentId),
        );
        job.total = backupManthras.length;
        console.log(
          `[restore-job ${jobId}] Need teeka restore: ${toRestoreTeekas.length}, bhashyam: ${toRestoreBhashyam.length}, shloka OT: ${toRestoreShlokaOt.length}`,
        );

        // Mark manthras that don't need restoration as skipped
        for (const bm of backupManthras) {
          if (!needingRestore.has(bm.documentId)) {
            const label = bm.ShlokaManthraNumber ?? bm.documentId;
            const hasBackupContent =
              (bm.Teekas ?? []).some((t: any) => t.TeekaEntry?.SanskritTextEntry?.length > 0 || t.TeekaEntry?.EnglishTranslationText?.length > 0) ||
              (bm.BhashyamEntry?.SanskritTextEntry?.length > 0 || bm.BhashyamEntry?.EnglishTranslationText?.length > 0);
            if (hasBackupContent) {
              job.results.push({ manthra: label, docId: bm.documentId, action: "already present — skipped" });
            }
          }
        }

        // Step 3: Restore teekas for manthras that need it
        for (const bm of toRestoreTeekas) {
          const label = bm.ShlokaManthraNumber ?? bm.documentId;
          try {
            const resolved = await resolveManthraTeekas(bm.Teekas, granthaDocId);
            if (resolved.length > 0) {
              await strapiRequest(`/api/manthras/${bm.documentId}`, {
                method: "PUT",
                body: JSON.stringify({ data: { Teekas: resolved } }),
              });
              job.results.push({ manthra: label, docId: bm.documentId, action: `restored ${resolved.length} teeka(s)` });
            } else {
              job.errors.push({ manthra: label, error: "Could not resolve teeka docIds from Strapi" });
            }
          } catch (e: any) {
            job.errors.push({ manthra: label, error: e?.message ?? String(e) });
          }
          job.progress++;
        }

        // Step 4: Restore BhashyamEntry for manthras that need it
        for (const bm of toRestoreBhashyam) {
          const label = bm.ShlokaManthraNumber ?? bm.documentId;
          try {
            const normalizedBhashyam = normalizeTextAndTranslation(bm.BhashyamEntry);
            await strapiRequest(`/api/manthras/${bm.documentId}`, {
              method: "PUT",
              body: JSON.stringify({ data: { BhashyamEntry: normalizedBhashyam } }),
            });
            job.results.push({ manthra: label, docId: bm.documentId, action: "restored BhashyamEntry" });
          } catch (e: any) {
            job.errors.push({ manthra: label, error: e?.message ?? String(e) });
          }
          job.progress++;
        }

        // Step 5: Merge missing ShlokaManthraEntry OtherTranslations from backup (preserve live SK/EN)
        for (const bm of toRestoreShlokaOt) {
          const label = bm.ShlokaManthraNumber ?? bm.documentId;
          try {
            const liveFull = (
              await strapiRequest(
                `/api/manthras/${bm.documentId}?populate[ShlokaManthraEntry][populate][OtherTranslations]=*`,
              )
            )?.data;
            const liveEntry = liveFull?.ShlokaManthraEntry ?? {};
            const liveOt: any[] = Array.isArray(liveEntry.OtherTranslations) ? liveEntry.OtherTranslations : [];
            const liveLangs = backupOtLangs(liveEntry);
            const backupOt = (bm.ShlokaManthraEntry?.OtherTranslations ?? []).filter((r: any) => {
              const lang = (r?.LanguageOfTranslation ?? "").trim();
              return lang && !liveLangs.has(lang) && textEntryHasPublishableContent({ TranslationText: r.TranslationText });
            });
            if (backupOt.length === 0) {
              job.results.push({ manthra: label, docId: bm.documentId, action: "shloka OT — already complete — skipped" });
              job.progress++;
              continue;
            }
            const mergedOt = mergeOtherTranslations(
              backupOt.map((r: any) => omitTranslationComponentIdentity(r)),
              liveOt,
            );
            const payload = {
              SanskritTextEntry: liveEntry.SanskritTextEntry,
              EnglishTranslationText: liveEntry.EnglishTranslationText,
              IASTTransliteration: liveEntry.IASTTransliteration,
              OtherTranslations: mergedOt,
            };
            const normalized = normalizeTextAndTranslation(payload);
            await strapiRequest(`/api/manthras/${bm.documentId}`, {
              method: "PUT",
              body: JSON.stringify({ data: { ShlokaManthraEntry: normalized } }),
            });
            const added = backupOt.map((r: any) => r.LanguageOfTranslation).join(", ");
            job.results.push({
              manthra: label,
              docId: bm.documentId,
              action: `merged ${backupOt.length} shloka translation(s): ${added}`,
            });
          } catch (e: any) {
            job.errors.push({ manthra: label, error: e?.message ?? String(e) });
          }
          job.progress++;
        }

        job.status = "done";
        console.log(`[restore-job ${jobId}] Done. restored=${job.results.filter(r => !r.action.includes("skipped")).length} errors=${job.errors.length}`);
      } catch (e: any) {
        job.status = "error";
        job.message = e?.message ?? String(e);
        console.error(`[restore-job ${jobId}] Fatal error:`, e.message);
      }
    })();
  });

  app.get("/api/admin/restore-jobs/:jobId", requireAuth, (req, res) => {
    const job = restoreJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    const restoredCount = job.results.filter((r) => !r.action.includes("skipped")).length;
    const skippedCount = job.results.filter((r) => r.action.includes("skipped")).length;
    res.json({
      status: job.status,
      progress: job.progress,
      total: job.total,
      restored: restoredCount,
      skipped: skippedCount,
      errored: job.errors.length,
      results: job.results,
      errors: job.errors,
      message: job.message,
    });
  });

  // Track in-progress backup to prevent duplicate requests.
  let backupInProgress = false;
  let backupLastError: string | null = null;

  app.post("/api/admin/backup", requireAuth, requireAdmin, (_req, res) => {
    if (backupInProgress) {
      return res.status(409).json({ message: "A snapshot is already being created. Please wait." });
    }

    // Respond immediately so the HTTP connection never times out.
    backupInProgress = true;
    backupLastError = null;
    res.status(202).json({ status: "started" });

    // Run the heavy Strapi fetches in the background.
    (async () => {
      try {
        console.log("[backup] Starting full Strapi snapshot...");

        const granthaFields =
          "/api/granthas?" +
          "populate[BhashyakaraIntroduction][populate][OtherTranslations]=true" +
          "&populate[GranthaNameTranslations]=true" +
          "&populate[teekas]=true";

        const sectionFields =
          "/api/sections?" +
          "populate[grantha][fields][0]=documentId&populate[grantha][fields][1]=GranthaName" +
          "&populate[parent][fields][0]=documentId&populate[parent][fields][1]=title" +
          "&populate[titleTranslations]=true";

        const manthraFields =
          "/api/manthras?" +
          "populate[ShlokaManthraEntry][populate][OtherTranslations]=true" +
          "&populate[BhashyamEntry][populate][OtherTranslations]=true" +
          "&populate[Teekas][populate][teeka]=true" +
          "&populate[Teekas][populate][TeekaEntry][populate][OtherTranslations]=true" +
          "&populate[wordMeanings]=true" +
          "&populate[Section][populate][grantha][fields][0]=documentId" +
          "&populate[Section][populate][grantha][fields][1]=GranthaName";

        const [granthas, sections, manthras] = await Promise.all([
          fetchAllStrapiPages(granthaFields),
          fetchAllStrapiPages(sectionFields),
          fetchAllStrapiPagesLarge(manthraFields),
        ]);

        console.log(`[backup] Fetched: ${granthas.length} granthas, ${sections.length} sections, ${manthras.length} manthras`);

        const label = new Date().toISOString().slice(0, 19).replace("T", " ");
        const snapshotData = {
          timestamp: new Date().toISOString(),
          granthaCount: granthas.length,
          sectionCount: sections.length,
          manthraCount: manthras.length,
          granthas,
          sections,
          manthras,
        };

        console.log(`[backup] Compressing snapshot data...`);
        const compressedPayload = compressBackupData(snapshotData);
        console.log(`[backup] Saving to database...`);
        const backup = await storage.createBackup(
          label,
          compressedPayload,
          granthas.length,
          sections.length,
          manthras.length
        );

        console.log(`[backup] Saved as backup #${backup.id}`);
        backupLastError = null;
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        backupLastError = msg;
        console.error("[backup] Failed:", msg, e?.stack?.slice(0, 500));
      } finally {
        backupInProgress = false;
      }
    })();
  });

  app.get("/api/admin/backup/status", requireAuth, (_req, res) => {
    res.json({ inProgress: backupInProgress, lastError: backupLastError });
  });

  // Delete user (admin only — cannot delete yourself)
  app.delete("/api/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const me = req.user as User;
      if (id === me.id) {
        return res.status(400).json({ message: "You cannot delete your own account" });
      }
      const deleted = await storage.deleteUser(id);
      if (!deleted) return res.status(404).json({ message: "User not found" });
      res.json({ message: "User deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to delete user" });
    }
  });

  // ---------- Grantha lock / unlock ----------

  app.get("/api/granthas/locks", requireAuth, async (_req, res) => {
    try {
      const locks = await storage.getGranthaLocks();
      res.json(locks);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch locks" });
    }
  });

  app.post("/api/admin/granthas/:docId/lock", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { docId } = req.params;
      const { reason, granthaName } = req.body ?? {};
      const user = req.user as User;
      const lock = await storage.lockGrantha(
        docId,
        granthaName || undefined,
        user.id,
        user.username,
        reason || undefined,
      );
      res.status(201).json(lock);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to lock grantha" });
    }
  });

  app.delete("/api/admin/granthas/:docId/lock", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { docId } = req.params;
      const removed = await storage.unlockGrantha(docId);
      if (!removed) return res.status(404).json({ message: "No lock found for this grantha" });
      res.json({ message: "Grantha unlocked" });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to unlock grantha" });
    }
  });

  return httpServer;
}
