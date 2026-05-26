import {
  MANTRA_LINK_MIN_CONTENT_SCORE,
  scoreStrapiManthraRowContent,
} from "@/lib/grantha-structure-sync";

/** Shloka bodies from sections/by-grantha (already loaded when grantha opens). */
export type StrapiMantraShlokaIndex = Map<string, Record<string, unknown>>;

/**
 * Map documentId → ShlokaManthraEntry from sections/by-grantha.
 * When the same CMS row appears under multiple sections, keep the richest body (not last writer).
 */
export function buildMantraShlokaIndexFromSections(sections: unknown[]): StrapiMantraShlokaIndex {
  const index: StrapiMantraShlokaIndex = new Map();
  for (const sec of sections) {
    if (!sec || typeof sec !== "object") continue;
    const manthras = (sec as { manthras?: unknown[] }).manthras;
    if (!Array.isArray(manthras)) continue;
    for (const m of manthras) {
      if (!m || typeof m !== "object") continue;
      const row = m as { documentId?: string; ShlokaManthraEntry?: unknown };
      if (!row.documentId || !row.ShlokaManthraEntry) continue;
      const entry = row.ShlokaManthraEntry as Record<string, unknown>;
      const score = scoreStrapiManthraRowContent(entry);
      const prev = index.get(row.documentId);
      if (prev === undefined || score > scoreStrapiManthraRowContent(prev)) {
        index.set(row.documentId, entry);
      }
    }
  }
  return index;
}

function shlokaRichness(entry: unknown): number {
  return scoreStrapiManthraRowContent(entry);
}

/** Apply pre-fetched SK/EN from grantha open so each verse dialog does not re-download shloka text. */
export function hydrateManthraShlokaFromIndex<T extends { strapiDocumentId?: string; ShlokaManthraEntry?: unknown }>(
  node: T,
  index: StrapiMantraShlokaIndex,
  docId?: string,
): T {
  const id = docId ?? node.strapiDocumentId;
  if (!id) return node;
  const remote = index.get(id);
  if (!remote) return node;
  const localRich = shlokaRichness(node.ShlokaManthraEntry);
  if (localRich >= MANTRA_LINK_MIN_CONTENT_SCORE) return node;
  return { ...node, ShlokaManthraEntry: remote };
}

export function mantraNodeHasHydratedShloka(node: {
  ShlokaManthraEntry?: unknown;
}): boolean {
  return shlokaRichness(node.ShlokaManthraEntry) >= MANTRA_LINK_MIN_CONTENT_SCORE;
}
