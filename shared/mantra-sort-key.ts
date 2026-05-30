/**
 * Strapi `order` is a fractional sort key (like row rank in Excel), not contiguous 1..n.
 * Portal editor uses contiguous `order` 1..n for display titles only.
 */

// Wider gap means more sequential inserts at the same anchor before recompaction.
// Strapi `order` is int32 (max ~2.1B). With GAP=100_000 a section can hold ~20k rows
// before the max key approaches int32 cap, and we get ~16 binary-halving inserts at the
// same anchor before recompaction triggers (vs ~9 with GAP=1000).
export const STRAPI_SORT_GAP = 100_000;
export const MIN_STRAPI_SORT_GAP = 2;

export type SortKeyBetweenResult = {
  sortKey: number;
  needsRecompact: boolean;
};

/** Spaced key for portal display index (1-based). */
export function portalIndexToStrapiSortKey(portalIndex1Based: number): number {
  return portalIndex1Based * STRAPI_SORT_GAP;
}

/**
 * Pick a Strapi sort key strictly between two existing keys (O(1), no sibling updates).
 * When the gap is exhausted, caller must recompact the whole section.
 */
export function sortKeyBetween(
  prevSortKey: number | undefined,
  nextSortKey: number | undefined,
): SortKeyBetweenResult {
  if (prevSortKey == null && nextSortKey == null) {
    return { sortKey: STRAPI_SORT_GAP, needsRecompact: false };
  }
  if (prevSortKey == null) {
    const next = nextSortKey ?? STRAPI_SORT_GAP * 2;
    return {
      sortKey: Math.max(1, next - STRAPI_SORT_GAP),
      needsRecompact: false,
    };
  }
  if (nextSortKey == null) {
    return { sortKey: prevSortKey + STRAPI_SORT_GAP, needsRecompact: false };
  }
  const gap = nextSortKey - prevSortKey;
  if (gap > MIN_STRAPI_SORT_GAP) {
    return { sortKey: Math.floor(prevSortKey + gap / 2), needsRecompact: false };
  }
  return { sortKey: prevSortKey + 1, needsRecompact: true };
}

/** Assign sort keys from portal list order: 1000, 2000, 3000, … */
export function assignSpacedSortKeysFromPortalOrder<T extends { id: string }>(
  rowsInDisplayOrder: T[],
): Map<string, number> {
  const out = new Map<string, number>();
  rowsInDisplayOrder.forEach((row, idx) => {
    out.set(row.id, portalIndexToStrapiSortKey(idx + 1));
  });
  return out;
}

export function strapiOrdersByDocumentId(
  rows: Array<{ docId: string; order: number }>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.docId) m.set(r.docId, r.order);
  }
  return m;
}
