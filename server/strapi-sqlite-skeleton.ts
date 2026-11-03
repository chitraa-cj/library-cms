/**
 * Fast per-grantha manthra "skeleton" read, straight from Strapi's SQLite file.
 *
 * WHY: Opening a large grantha (e.g. Suta Samhita, 6k+ verses) through Strapi's REST API is
 * inherently slow — ~6s for labels alone and ~19s once the ShlokaManthraEntry component is
 * populated — because Strapi hydrates/serializes every row and its components. The same data read
 * directly from the SQLite file (co-located on this box) takes ~50ms. This module does that read
 * and returns rows in the exact shape `sections/by-grantha` already groups, so the editor tree +
 * per-verse "has content" indicator render from it with no client change.
 *
 * SAFETY: read-only connection; returns `null` on ANY problem (file missing, schema drift, error)
 * so the caller transparently falls back to the REST pagination path. This keeps the coupling to
 * Strapi's internal table names optional — if Strapi ever moves off SQLite the fallback takes over.
 */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

function resolveDbPath(): string | null {
  const candidates = [
    process.env.STRAPI_SQLITE_PATH,
    path.join(os.homedir(), "library/strapi-backend/.tmp/data.db"),
    path.resolve(process.cwd(), "../strapi-backend/.tmp/data.db"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// undefined = not yet attempted; null = unavailable (stop retrying).
let cachedDb: Database.Database | null | undefined;

function getDb(): Database.Database | null {
  if (cachedDb !== undefined) return cachedDb;
  try {
    const p = resolveDbPath();
    if (!p) {
      cachedDb = null;
      return null;
    }
    cachedDb = new Database(p, { readonly: true, fileMustExist: true });
    return cachedDb;
  } catch {
    cachedDb = null;
    return null;
  }
}

function parseBlocks(s: unknown): any {
  if (typeof s !== "string" || !s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** A manthra row shaped like the REST `sections/by-grantha` manthra items (Section.documentId +
 *  a Sanskrit/English ShlokaManthraEntry preview). */
export interface SkeletonManthraRow {
  id: number;
  documentId: string;
  ShlokaManthraNumber: string | null;
  order: number | null;
  Section: { documentId: string };
  ShlokaManthraEntry: { SanskritTextEntry: any; EnglishTranslationText: any } | null;
}

/**
 * Return every PUBLISHED manthra of a grantha (labels + section link + Sanskrit/English preview),
 * or `null` if the SQLite DB isn't reachable / the query fails — caller must fall back to REST.
 */
export function readGranthaManthraSkeleton(granthaDocId: string): SkeletonManthraRow[] | null {
  const conn = getDb();
  if (!conn) return null;
  try {
    const exists = conn
      .prepare("select 1 as ok from granthas where document_id = ? limit 1")
      .get(granthaDocId) as { ok: number } | undefined;
    if (!exists) return []; // grantha not in Strapi (yet) — an empty skeleton is correct, not a failure.
    // Join the grantha by document_id (NOT by a single row id). A Strapi v5 document has TWO
    // grantha rows — draft (published_at null) and published — and the section→grantha links may
    // live on EITHER row. Resolving the grantha to one arbitrary row id (as this used to) breaks
    // whenever the links sit on the row we didn't pick: for Prabodha Sudhakara every section→grantha
    // link was on the published row while `select id ... where document_id` returned the draft row,
    // so the join found 0 verses and the editor showed 19 empty chapters. Matching on document_id
    // finds the links wherever they are; `group by m.id` collapses the duplicate rows that appear
    // when a published verse is reachable via both the draft- and published-grantha link paths
    // (draft & published share document_id, so sectionDocId is identical across the duplicates).
    const rows = conn
      .prepare(
        `select m.id as id, m.document_id as documentId, m.shloka_manthra_number as num,
                m."order" as ord, sec.document_id as sectionDocId,
                tt.sanskrit_text_entry as skt, tt.english_translation_text as eng
         from manthras m
         join manthras_section_lnk ml on ml.manthra_id = m.id
         join sections sec on sec.id = ml.section_id
         join sections_grantha_lnk sg on sg.section_id = ml.section_id
         join granthas g on g.id = sg.grantha_id
         left join manthras_cmps mc on mc.entity_id = m.id and mc.field = 'ShlokaManthraEntry'
         left join components_shared_text_and_translations tt on tt.id = mc.cmp_id
         where g.document_id = ? and m.published_at is not null
         group by m.id
         order by m."order" asc`,
      )
      .all(granthaDocId) as any[];
    return rows.map((r) => ({
      id: r.id,
      documentId: r.documentId,
      ShlokaManthraNumber: r.num ?? null,
      order: r.ord ?? null,
      Section: { documentId: r.sectionDocId },
      ShlokaManthraEntry:
        r.skt || r.eng
          ? { SanskritTextEntry: parseBlocks(r.skt), EnglishTranslationText: parseBlocks(r.eng) }
          : null,
    }));
  } catch {
    return null; // schema drift / locked / any error → REST fallback
  }
}

/** A manthra row for the whole-collection Mantras tab: same preview shape as the
 *  per-grantha skeleton, but with the Section title/type and the owning grantha
 *  attached so the tab can group/label rows without a second lookup. */
export interface AllManthraRow {
  id: number;
  documentId: string;
  ShlokaManthraNumber: string | null;
  order: number | null;
  Section: { documentId: string; title: string | null; type: string | null };
  // Lowercase `section` + `grantha` mirror the REST endpoint's normaliseManthra output,
  // which is what the Mantras-tab normaliser reads (m.section?.documentId, m.grantha).
  section: { documentId: string; title: string | null; type: string | null };
  grantha: { documentId: string; GranthaName: string | null } | null;
  ShlokaManthraEntry: { SanskritTextEntry: any; EnglishTranslationText: any } | null;
}

/**
 * Return EVERY published manthra across all granthas (label + section + grantha +
 * Sanskrit/English preview) for the Mantras tab, or `null` if the SQLite DB isn't
 * reachable / the query fails — caller must fall back to the REST pagination path.
 *
 * WHY: the Mantras tab's `/api/strapi/manthras` fetches the entire collection over
 * Strapi REST with populate, page by page (6–19s per grantha-worth) — minutes for a
 * large corpus. The same rows read straight from the co-located SQLite file take tens
 * of milliseconds. Shape mirrors the REST list (Section + grantha) so the tab's
 * normaliser renders from it with no client change; published-only matches the REST
 * default (drafts load via a separate query).
 */
export function readAllManthrasSkeleton(): AllManthraRow[] | null {
  const conn = getDb();
  if (!conn) return null;
  try {
    // Same document_id-based join as readGranthaManthraSkeleton (links may sit on the
    // draft OR published grantha row); `group by m.id` collapses the duplicate paths.
    const rows = conn
      .prepare(
        `select m.id as id, m.document_id as documentId, m.shloka_manthra_number as num,
                m."order" as ord,
                sec.document_id as sectionDocId, sec.title as sectionTitle, sec.type as sectionType,
                g.document_id as granthaDocId, g.grantha_name as granthaName,
                tt.sanskrit_text_entry as skt, tt.english_translation_text as eng
         from manthras m
         join manthras_section_lnk ml on ml.manthra_id = m.id
         join sections sec on sec.id = ml.section_id
         join sections_grantha_lnk sg on sg.section_id = ml.section_id
         join granthas g on g.id = sg.grantha_id
         left join manthras_cmps mc on mc.entity_id = m.id and mc.field = 'ShlokaManthraEntry'
         left join components_shared_text_and_translations tt on tt.id = mc.cmp_id
         where m.published_at is not null
         group by m.id
         order by g.grantha_name asc, m."order" asc`,
      )
      .all() as any[];
    return rows.map((r) => {
      const section = {
        documentId: r.sectionDocId,
        title: r.sectionTitle ?? null,
        type: r.sectionType ?? null,
      };
      return {
        id: r.id,
        documentId: r.documentId,
        ShlokaManthraNumber: r.num ?? null,
        order: r.ord ?? null,
        Section: section,
        section,
        grantha: r.granthaDocId
          ? { documentId: r.granthaDocId, GranthaName: r.granthaName ?? null }
          : null,
        ShlokaManthraEntry:
          r.skt || r.eng
            ? { SanskritTextEntry: parseBlocks(r.skt), EnglishTranslationText: parseBlocks(r.eng) }
            : null,
      };
    });
  } catch {
    return null; // schema drift / locked / any error → REST fallback
  }
}

/** A lightweight grantha "card" row for the names-first Granthas list: scalar fields
 *  the grid needs, plus lightweight section + teeka metadata (no intro/translations/
 *  cover/full mantras — the editor re-fetches those on open). Mirrors the fields the
 *  REST `/api/strapi/granthas` list item exposes that the card + merge actually read. */
export interface GranthaLiteRow {
  documentId: string;
  GranthaName: string | null;
  GranthaType: string | null;
  BhashyamName: string | null;
  BhashyamAuthor: string | null;
  slug: string | null;
  order: number | null;
  sections: Array<{
    documentId: string;
    title: string | null;
    type: string | null;
    order: number | null;
    parent: { documentId: string } | null;
  }>;
  teekas: Array<{ documentId: string; TeekaName: string | null }>;
}

/**
 * Return every PUBLISHED grantha with just the fields the Granthas grid needs — name,
 * type, bhashya labels, and lightweight section + teeka metadata — read straight from
 * Strapi's co-located SQLite file (~milliseconds). Returns `null` if the DB isn't
 * reachable / the query fails so the caller falls back to REST.
 *
 * WHY: the Granthas tab's `/api/strapi/granthas` deep-populates intro + translations +
 * cover + teekas and returns every heavy scalar field (introduction_to_text_english)
 * for all 130+ granthas — ~2.5MB, seconds — none of which the CARDS use (the editor
 * re-fetches deep data on open). This lean read powers a names-first list instantly.
 *
 * Section→grantha and teeka→grantha links are joined by grantha document_id (not a
 * single row id) because a Strapi v5 document has draft + published rows and the link
 * may sit on either — same reasoning as readGranthaManthraSkeleton.
 */
export function readAllGranthasLite(): GranthaLiteRow[] | null {
  const conn = getDb();
  if (!conn) return null;
  try {
    const granthas = conn
      .prepare(
        `select g.document_id as documentId, g.grantha_name as GranthaName,
                g.grantha_type as GranthaType, g.bhashyam_name as BhashyamName,
                g.bhashyam_author as BhashyamAuthor, g.slug as slug, g."order" as ord
         from granthas g
         where g.published_at is not null
         group by g.document_id
         order by g.grantha_name asc`,
      )
      .all() as any[];

    const sectionRows = conn
      .prepare(
        `select g.document_id as granthaDocId, sec.document_id as documentId,
                sec.title as title, sec.type as type, sec."order" as ord,
                psec.document_id as parentDocId
         from sections sec
         join sections_grantha_lnk sg on sg.section_id = sec.id
         join granthas g on g.id = sg.grantha_id
         left join sections_parent_lnk sp on sp.section_id = sec.id
         left join sections psec on psec.id = sp.inv_section_id
         where sec.published_at is not null
         group by sec.id`,
      )
      .all() as any[];

    const teekaRows = conn
      .prepare(
        `select g.document_id as granthaDocId, t.document_id as documentId,
                t.teeka_name as TeekaName
         from teekas t
         join teekas_grantha_lnk tg on tg.teeka_id = t.id
         join granthas g on g.id = tg.grantha_id
         where t.published_at is not null
         group by t.id`,
      )
      .all() as any[];

    const sectionsByGrantha = new Map<string, GranthaLiteRow["sections"]>();
    for (const s of sectionRows) {
      if (!s.granthaDocId) continue;
      let arr = sectionsByGrantha.get(s.granthaDocId);
      if (!arr) sectionsByGrantha.set(s.granthaDocId, (arr = []));
      arr.push({
        documentId: s.documentId,
        title: s.title ?? null,
        type: s.type ?? null,
        order: s.ord ?? null,
        parent: s.parentDocId ? { documentId: s.parentDocId } : null,
      });
    }

    const teekasByGrantha = new Map<string, GranthaLiteRow["teekas"]>();
    for (const t of teekaRows) {
      if (!t.granthaDocId) continue;
      let arr = teekasByGrantha.get(t.granthaDocId);
      if (!arr) teekasByGrantha.set(t.granthaDocId, (arr = []));
      arr.push({ documentId: t.documentId, TeekaName: t.TeekaName ?? null });
    }

    return granthas.map((g) => ({
      documentId: g.documentId,
      GranthaName: g.GranthaName ?? null,
      GranthaType: g.GranthaType ?? null,
      BhashyamName: g.BhashyamName ?? null,
      BhashyamAuthor: g.BhashyamAuthor ?? null,
      slug: g.slug ?? null,
      order: g.ord ?? null,
      sections: sectionsByGrantha.get(g.documentId) ?? [],
      teekas: teekasByGrantha.get(g.documentId) ?? [],
    }));
  } catch {
    return null; // schema drift / locked / any error → REST fallback
  }
}
