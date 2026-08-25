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
