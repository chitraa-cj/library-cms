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
    const g = conn
      .prepare("select id from granthas where document_id = ?")
      .get(granthaDocId) as { id: number } | undefined;
    if (!g) return []; // grantha not in Strapi (yet) — an empty skeleton is correct, not a failure.
    const rows = conn
      .prepare(
        `select m.id as id, m.document_id as documentId, m.shloka_manthra_number as num,
                m."order" as ord, sec.document_id as sectionDocId,
                tt.sanskrit_text_entry as skt, tt.english_translation_text as eng
         from manthras m
         join manthras_section_lnk ml on ml.manthra_id = m.id
         join sections sec on sec.id = ml.section_id
         join sections_grantha_lnk sg on sg.section_id = ml.section_id
         left join manthras_cmps mc on mc.entity_id = m.id and mc.field = 'ShlokaManthraEntry'
         left join components_shared_text_and_translations tt on tt.id = mc.cmp_id
         where sg.grantha_id = ? and m.published_at is not null
         order by m."order" asc`,
      )
      .all(g.id) as any[];
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
