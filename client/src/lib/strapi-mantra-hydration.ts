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

export type ManthraHydrationOptions = {
  /**
   * Portal draft / saved hierarchy: keep non-empty local verse bodies; still fill empty/stub
   * rows from CMS so labels like 1.18–1.26 show the same content as the Mantras tab.
   */
  preferPortalContent?: boolean;
};

/** Apply pre-fetched SK/EN from grantha open so each verse dialog does not re-download shloka text. */
export function hydrateManthraShlokaFromIndex<T extends { strapiDocumentId?: string; ShlokaManthraEntry?: unknown }>(
  node: T,
  index: StrapiMantraShlokaIndex,
  docId?: string,
  options?: ManthraHydrationOptions,
): T {
  const id = docId ?? node.strapiDocumentId;
  if (!id) return node;
  const remote = index.get(id);
  if (!remote) return node;
  const localRich = shlokaRichness(node.ShlokaManthraEntry);
  if (localRich >= MANTRA_LINK_MIN_CONTENT_SCORE) return node;
  return { ...node, ShlokaManthraEntry: remote };
}

/**
 * After enrich relinks a portal row to a different CMS documentId, drop stale draft bodies
 * so View/Edit show the linked Strapi verse (not text from a previous wrong match).
 */
export function prepareManthraAfterStrapiResolve<
  T extends {
    strapiDocumentId?: string;
    ShlokaManthraEntry?: unknown;
    BhashyamForShlokaManthra?: unknown;
    title?: string;
  },
>(
  node: T,
  resolvedDocId: string | undefined,
  index: StrapiMantraShlokaIndex,
  normalizedTitle?: string,
  options?: ManthraHydrationOptions,
): T {
  const id = resolvedDocId ?? node.strapiDocumentId;
  const prevId = node.strapiDocumentId;
  const relinked = !!id && !!prevId && prevId !== id;
  const titled = normalizedTitle !== undefined ? { ...node, title: normalizedTitle } : node;
  // Insert renumber: portal bodies stay on the stored documentId even if CMS label lags.
  if (
    relinked &&
    options?.preferPortalContent &&
    shlokaRichness(node.ShlokaManthraEntry) >= MANTRA_LINK_MIN_CONTENT_SCORE
  ) {
    return hydrateManthraShlokaFromIndex(
      { ...titled, strapiDocumentId: prevId },
      index,
      prevId,
      options,
    );
  }
  let base: T;
  if (relinked) {
    // Wrong CMS link (common after Viveka renumber/migration): always drop stale bodies.
    base = {
      ...titled,
      strapiDocumentId: id,
      ShlokaManthraEntry: undefined,
      BhashyamForShlokaManthra: undefined,
    };
  } else {
    base = { ...titled, strapiDocumentId: id };
  }
  if (!id) return base;
  return hydrateManthraShlokaFromIndex(base, index, id, options);
}

export function mantraNodeHasHydratedShloka(node: {
  ShlokaManthraEntry?: unknown;
}): boolean {
  return shlokaRichness(node.ShlokaManthraEntry) >= MANTRA_LINK_MIN_CONTENT_SCORE;
}
