/**
 * Pure helpers for Grantha hierarchy ↔ structure config alignment.
 * Kept out of the page component so async loaders (e.g. openEdit) can run
 * the same normalization as the wizard "Next" step without ordering bugs.
 */

import { entryContentCharCount } from "./strapi-blocks";
import { portalIndexToStrapiSortKey, STRAPI_SORT_GAP } from "@shared/mantra-sort-key";
import { isBareLeafCounterTitle } from "@shared/grantha-publish-integrity";

export const STRAPI_DOCUMENT_ID_MIN_LENGTH = 10;

export function isPublishedStrapiDocId(id: string | undefined): id is string {
  return typeof id === "string" && id.length >= STRAPI_DOCUMENT_ID_MIN_LENGTH;
}

export function sortNodesByOrder<T extends { order?: number; id?: string }>(nodes: T[]): T[] {
  return [...nodes].sort((a, b) => {
    const d = (a.order ?? 0) - (b.order ?? 0);
    if (d !== 0) return d;
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });
}

/** True when `order` is a Strapi fractional sort key (1000+), not portal display index 1..n. */
export function isStrapiFractionalSortKey(order: number | undefined): boolean {
  return typeof order === "number" && !Number.isNaN(order) && order >= STRAPI_SORT_GAP;
}

/**
 * Comparable sort key for mantra lists that may mix portal indices (1..n) and Strapi keys (1000+).
 * Portal rows sort just before their spaced Strapi slot (1 → 999, 2 → 1999) so inserts stay ordered.
 */
export function mantraDisplaySortKey(order: number | undefined): number {
  if (order == null || Number.isNaN(order)) return 0;
  if (isStrapiFractionalSortKey(order)) return order;
  const n = Math.max(1, Math.floor(order));
  return portalIndexToStrapiSortKey(n) - 1;
}

/** Sort mantras when portal `order` and Strapi `order` may appear in the same list (e.g. after enrich). */
export function sortMantrasByDisplayOrder<T extends { order?: number; id?: string }>(nodes: T[]): T[] {
  return [...nodes].sort((a, b) => {
    const d = mantraDisplaySortKey(a.order) - mantraDisplaySortKey(b.order);
    if (d !== 0) return d;
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });
}

/** 1-based rank of each Strapi row in CMS sort order (for supplement / merge before normalize). */
export function buildStrapiMantraRankMap(manthras: StrapiMantraRef[]): Map<string, number> {
  const sorted = [...manthras].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const ranks = new Map<string, number>();
  sorted.forEach((sm, idx) => {
    if (sm.docId) ranks.set(sm.docId, idx + 1);
  });
  return ranks;
}

/** 1-based index of `id` in `sortNodesByOrder(nodes)` — use for titles that must match sorted hierarchy. */
export function ordinalIndexInSortedOrder<T extends { id: string; order?: number }>(
  nodes: T[] | undefined,
  id: string,
): number {
  const sorted = sortNodesByOrder(nodes ?? []);
  const i = sorted.findIndex((n) => n.id === id);
  return i >= 0 ? i + 1 : 1;
}

/** Context for rebuilding mantra display titles and contiguous `order` after insert/delete. */
export interface MantraTitleCtx {
  leaf: string;
  aIdx: number;
  kIdx: number;
  pIdx?: number;
  isDefaultKhanda: boolean;
  padaPath: boolean;
  levelTwoEnabled: boolean;
}

/** Leaf labels offered in the grantha wizard — titles using these prefixes follow `structureConfig.leafName`. */
export const PORTAL_SELECTABLE_LEAF_NAMES = [
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

/** Strapi mantra row used when linking portal hierarchy nodes to CMS documentIds. */
export type StrapiMantraRef = {
  title: string;
  docId: string;
  order: number;
  /** Sanskrit + English char count from list/detail fetch; used to pick the CMS row with real content. */
  contentScore?: number;
};

/** Minimum richness to prefer content over lowest-order duplicate when linking. */
export const MANTRA_LINK_MIN_CONTENT_SCORE = 12;

export function strapiMantraRefRichness(ref: StrapiMantraRef): number {
  return ref.contentScore ?? 0;
}

/** Compare verse suffixes numerically: `"1.1.10"` > `"1.1.9"`. */
export function compareMantraNumberSuffix(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/** Last numeric segment of a suffix, e.g. `"1.1.4"` → `4`. */
export function mantraSuffixLeafOrder(suffix: string | null | undefined): number | null {
  if (!suffix) return null;
  const parts = suffix.split(".");
  const n = parseInt(parts[parts.length - 1] ?? "", 10);
  return Number.isNaN(n) ? null : n;
}

/** Trailing numeric segment, e.g. `"Mantra 1.1.5"` → `"1.1.5"`. */
export function mantraNumberSuffix(title: string | undefined): string | null {
  const t = (title ?? "").trim();
  if (!t) return null;
  const m = t.match(/(\d+(?:\.\d+)+)\s*$/);
  return m ? m[1] : null;
}

/** Prefix before the numeric segment, e.g. `"Shloka 1.1.5"` → `"Shloka"`. */
export function mantraTitleLeafPrefix(title: string | undefined): string | null {
  const t = (title ?? "").trim();
  if (!t) return null;
  const m = t.match(/^(.+?)\s+[\d.]+$/);
  return m ? m[1].trim() : null;
}

export function titleUsesConfiguredLeaf(title: string | undefined, configuredLeaf: string): boolean {
  const leaf = (configuredLeaf ?? "").trim();
  if (!leaf) return true;
  const prefix = mantraTitleLeafPrefix(title);
  if (!prefix) return !(title ?? "").trim();
  return prefix.toLowerCase() === leaf.toLowerCase();
}

export function canonicalMantraTitle(
  configuredLeaf: string,
  numericSuffix: string,
): string {
  return `${(configuredLeaf || "Mantra").trim()} ${numericSuffix}`.trim();
}

/** Portal display label for a verse: always uses the stored/configured leaf + numeric suffix. */
export function portalMantraTitleForLeaf(
  portalTitle: string | undefined,
  configuredLeaf: string,
  strapiTitle?: string,
): string {
  const leaf = (configuredLeaf || "Mantra").trim() || "Mantra";
  const suffix = mantraNumberSuffix(portalTitle) ?? mantraNumberSuffix(strapiTitle);
  if (suffix) return canonicalMantraTitle(leaf, suffix);
  const st = (strapiTitle ?? "").trim();
  if (st && titleUsesConfiguredLeaf(st, leaf)) return st;
  const pt = (portalTitle ?? "").trim();
  if (pt && titleUsesConfiguredLeaf(pt, leaf)) return pt;
  return pt || canonicalMantraTitle(leaf, "1");
}

/**
 * When CMS rows overwhelmingly use one leaf prefix (e.g. Shloka) but the saved draft
 * still says Mantra, align structure config on open so the editor matches Strapi.
 */
export function inferLeafNameFromStrapiMantras(
  mantras: Iterable<{ title?: string }>,
  draftLeaf: string,
): string {
  const draft = (draftLeaf || "Mantra").trim() || "Mantra";
  const counts = new Map<string, number>();
  let total = 0;
  for (const m of mantras) {
    const p = mantraTitleLeafPrefix(m.title);
    if (!p) continue;
    const canonical = PORTAL_SELECTABLE_LEAF_NAMES.find(
      (n) => n.toLowerCase() === p.toLowerCase(),
    );
    if (!canonical) continue;
    counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
    total++;
  }
  if (total < 5) return draft;
  const draftCount =
    [...counts.entries()].find(([k]) => k.toLowerCase() === draft.toLowerCase())?.[1] ?? 0;
  let bestLeaf = draft;
  let bestCount = draftCount;
  for (const [leaf, n] of counts) {
    if (n > bestCount) {
      bestLeaf = leaf;
      bestCount = n;
    }
  }
  if (bestLeaf.toLowerCase() === draft.toLowerCase()) return draft;
  if (draftCount > total * 0.25) return draft;
  if (bestCount < total * 0.5) return draft;
  return bestLeaf;
}

export function mantrasShareNumberSuffix(a: string | undefined, b: string | undefined): boolean {
  const sa = mantraNumberSuffix(a);
  const sb = mantraNumberSuffix(b);
  if (!sa || !sb) return (a ?? "").trim() === (b ?? "").trim();
  return sa === sb;
}

/** Same verse number and same leaf label (Mantra vs Shloka are never treated as the same row). */
export function mantrasShareLeafAndSuffix(
  a: string | undefined,
  b: string | undefined,
  configuredLeaf: string,
): boolean {
  if (!mantrasShareNumberSuffix(a, b)) return false;
  return titleUsesConfiguredLeaf(a, configuredLeaf) && titleUsesConfiguredLeaf(b, configuredLeaf);
}

export function collectKnownVerseSuffixesForLeaf(
  titles: Iterable<string | undefined>,
  configuredLeaf: string,
): Set<string> {
  const known = new Set<string>();
  for (const t of titles) {
    if (!titleUsesConfiguredLeaf(t, configuredLeaf)) continue;
    const suffix = mantraNumberSuffix(t);
    if (suffix) known.add(suffix);
  }
  return known;
}

/** True when Strapi already has this verse under the configured leaf in the portal tree. */
export function strapiVerseTakenForConfiguredLeaf(
  strapiTitle: string | undefined,
  knownSuffixesForLeaf: Set<string>,
  configuredLeaf: string,
): boolean {
  if (!titleUsesConfiguredLeaf(strapiTitle, configuredLeaf)) return false;
  const suffix = mantraNumberSuffix(strapiTitle);
  return suffix != null && knownSuffixesForLeaf.has(suffix);
}

/** True when any row in the section already uses this verse suffix (any leaf prefix). */
export function sectionHasVerseSuffixAnyLeaf(
  mantras: StrapiMantraRef[],
  suffix: string,
  excludeDocId?: string,
): boolean {
  return mantras.some(
    (m) => mantraNumberSuffix(m.title) === suffix && (!excludeDocId || m.docId !== excludeDocId),
  );
}

/** `order` keys with more than one Strapi row are excluded (unsafe for remapping). */
export function buildUniqueStrapiOrderMap(manthras: StrapiMantraRef[]): {
  byOrder: Map<number, StrapiMantraRef>;
  ambiguousOrders: Set<number>;
} {
  const byOrder = new Map<number, StrapiMantraRef>();
  const ambiguousOrders = new Set<number>();
  for (const sm of manthras) {
    if (sm.order == null || Number.isNaN(sm.order)) continue;
    if (byOrder.has(sm.order)) {
      ambiguousOrders.add(sm.order);
      byOrder.delete(sm.order);
    } else if (!ambiguousOrders.has(sm.order)) {
      byOrder.set(sm.order, sm);
    }
  }
  return { byOrder, ambiguousOrders };
}

/**
 * When Strapi has multiple rows for the same verse label, pick one row to link/update.
 * Prefer the portal's stored docId, then the lowest `order` (original row).
 */
export function pickPreferredStrapiMantraRef(
  refs: StrapiMantraRef[],
  preferredDocId?: string,
): StrapiMantraRef | undefined {
  if (refs.length === 0) return undefined;
  if (preferredDocId) {
    const pref = refs.find((r) => r.docId === preferredDocId);
    if (pref) return pref;
  }
  return [...refs].sort((a, b) => {
    const oa = a.order ?? Number.MAX_SAFE_INTEGER;
    const ob = b.order ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return a.docId.localeCompare(b.docId);
  })[0];
}

/**
 * When duplicates share the same verse suffix, prefer the row with substantive CMS text
 * so the Grantha editor and Mantras tab link to the same record.
 */
export function pickBestStrapiMantraRefForLink(
  refs: StrapiMantraRef[],
  preferredDocId?: string,
): StrapiMantraRef | undefined {
  if (refs.length === 0) return undefined;
  const maxScore = Math.max(...refs.map((r) => strapiMantraRefRichness(r)));
  if (maxScore >= MANTRA_LINK_MIN_CONTENT_SCORE) {
    const richest = refs.filter((r) => strapiMantraRefRichness(r) === maxScore);
    return pickPreferredStrapiMantraRef(richest, preferredDocId);
  }
  return pickPreferredStrapiMantraRef(refs, preferredDocId);
}

/** Exact ShlokaManthraNumber match within one section (never grantha-wide). */
export function findStrapiMantraByExactTitleInSection(
  sectionMantras: StrapiMantraRef[],
  portalTitle: string | undefined,
  preferredDocId?: string,
  claimedDocIds?: Set<string>,
): StrapiMantraRef | undefined {
  const label = (portalTitle ?? "").trim();
  if (!label || sectionMantras.length === 0) return undefined;
  const lower = label.toLowerCase();
  const hits = sectionMantras.filter((sm) => sm.title.trim().toLowerCase() === lower);
  if (hits.length === 0) return undefined;
  const pool = strapiRefsAvailableForLink(hits, preferredDocId, claimedDocIds);
  if (pool.length === 0) return undefined;
  return pickBestStrapiMantraRefForLink(pool, preferredDocId);
}

/**
 * Match CMS rows by verse suffix (1.1.2, etc.). Prefers the grantha's configured leaf;
 * when the portal title uses that leaf but CMS rows still use another prefix (Mantra → Shloka),
 * still links by suffix so fetch/view/edit show the correct row.
 */
function strapiRefsAvailableForLink(
  pool: StrapiMantraRef[],
  preferredDocId?: string,
  claimedDocIds?: Set<string>,
): StrapiMantraRef[] {
  if (!claimedDocIds?.size) return pool;
  return pool.filter((h) => h.docId === preferredDocId || !claimedDocIds.has(h.docId));
}

export function findStrapiMantraByVerseSuffix(
  mantras: StrapiMantraRef[],
  portalTitle: string | undefined,
  configuredLeaf: string,
  preferredDocId?: string,
  claimedDocIds?: Set<string>,
): StrapiMantraRef | undefined {
  const leaf = (configuredLeaf || "Mantra").trim();
  const label = (portalTitle ?? "").trim();
  const suffix = mantraNumberSuffix(label);
  if (!suffix) return undefined;
  const hits = mantras.filter((sm) => mantraNumberSuffix(sm.title) === suffix);
  if (hits.length === 0) return undefined;
  const leafHits = hits.filter((sm) => titleUsesConfiguredLeaf(sm.title, leaf));
  const portalUsesLeaf = titleUsesConfiguredLeaf(label, leaf);
  let pool =
    leafHits.length > 0
      ? leafHits
      : portalUsesLeaf
        ? hits
        : [];
  pool = strapiRefsAvailableForLink(pool, preferredDocId, claimedDocIds);
  if (pool.length === 0) return undefined;
  return pickBestStrapiMantraRefForLink(pool, preferredDocId);
}

/** @deprecated Use findStrapiMantraByVerseSuffix — kept for existing imports/tests. */
export function findStrapiMantraByLeafAndSuffix(
  mantras: StrapiMantraRef[],
  portalTitle: string | undefined,
  configuredLeaf: string,
  preferredDocId?: string,
): StrapiMantraRef | undefined {
  return findStrapiMantraByVerseSuffix(mantras, portalTitle, configuredLeaf, preferredDocId);
}

export interface ResolvePortalMantraStrapiOptions {
  configuredLeaf: string;
  /** Fallback only when `sectionMantras` is empty (legacy / no section context). */
  byExactTitle?: Map<string, string>;
  sectionMantras: StrapiMantraRef[];
  byOrder: Map<number, StrapiMantraRef>;
  ambiguousOrders: Set<number>;
  /** DocIds already linked to an earlier portal row in this section (insert-between safety). */
  claimedDocIds?: Set<string>;
}

/**
 * Map a portal mantra node to the correct Strapi documentId.
 * Published `strapiDocumentId` owns verse content; portal titles may run ahead of CMS labels
 * during insert-between renumber. Label/suffix matching is for portal-only rows only.
 */
export function resolvePortalMantraToStrapiDoc(
  portal: { title?: string; order?: number; strapiDocumentId?: string },
  opts: ResolvePortalMantraStrapiOptions,
): { docId: string | undefined } | undefined {
  const { configuredLeaf, byExactTitle, sectionMantras, claimedDocIds } = opts;
  const leaf = (configuredLeaf || "Mantra").trim();
  const portalTitle = (portal.title ?? "").trim();
  const preferred = (portal.strapiDocumentId ?? "").trim();

  if (isPublishedStrapiDocId(preferred) && !claimedDocIds?.has(preferred)) {
    return { docId: preferred };
  }

  if (!portalTitle) return undefined;

  const exactInSection = findStrapiMantraByExactTitleInSection(
    sectionMantras,
    portalTitle,
    preferred,
    claimedDocIds,
  );
  if (exactInSection) {
    return { docId: exactInSection.docId };
  }
  if (sectionMantras.length === 0 && byExactTitle?.has(portalTitle)) {
    const id = byExactTitle.get(portalTitle)!;
    if (!claimedDocIds?.has(id) || id === preferred) return { docId: id };
  }

  const bySuffix = findStrapiMantraByVerseSuffix(
    sectionMantras,
    portalTitle,
    leaf,
    preferred,
    claimedDocIds,
  );
  if (bySuffix) {
    return { docId: bySuffix.docId };
  }

  return undefined;
}

export function titlePrefixFromMantraTitle(title: string | undefined, leaf: string): string {
  const configuredLeaf = (leaf ?? "Mantra").trim() || "Mantra";
  const t = title ?? "";
  if (!t.trim()) return configuredLeaf;
  const m = t.match(/^(.+?)\s+[\d.]+$/);
  if (!m) return configuredLeaf;
  const prefix = m[1].trim();
  const isPortalAutoLeaf = PORTAL_SELECTABLE_LEAF_NAMES.some(
    (name) => name.toLowerCase() === prefix.toLowerCase(),
  );
  return isPortalAutoLeaf ? configuredLeaf : prefix;
}

export function buildMantraDisplayTitle(pfx: string, orderNum: number, ctx: MantraTitleCtx): string {
  if (ctx.padaPath && ctx.pIdx != null) {
    return ctx.isDefaultKhanda
      ? `${pfx} ${ctx.aIdx}.${ctx.pIdx}.${orderNum}`
      : `${pfx} ${ctx.aIdx}.${ctx.kIdx}.${ctx.pIdx}.${orderNum}`;
  }
  if (ctx.levelTwoEnabled && !ctx.isDefaultKhanda) {
    return `${pfx} ${ctx.aIdx}.${ctx.kIdx}.${orderNum}`;
  }
  return `${pfx} ${ctx.aIdx}.${orderNum}`;
}

export function buildMantraTitleCtx(
  adhyayaIndex: number,
  khanda: { title?: string },
  khandaIndex: number,
  cfg: GranthaStructureConfig,
  padaIndex?: number,
): MantraTitleCtx {
  const leaf = (cfg.leafName || "Mantra").trim() || "Mantra";
  const levelTwo = cfg.levelTwoEnabled !== false;
  const levelThree = !!cfg.levelThreeEnabled;
  const aIdx = adhyayaIndex + 1;
  const isDefaultKhanda = khanda.title === "_default";
  const kIdx = levelTwo && !isDefaultKhanda ? khandaIndex + 1 : aIdx;
  return {
    leaf,
    aIdx,
    kIdx,
    pIdx: padaIndex != null ? padaIndex + 1 : undefined,
    isDefaultKhanda,
    padaPath: levelThree && padaIndex != null,
    levelTwoEnabled: levelTwo,
  };
}

/**
 * CMS/portal label for identity sync. Uses the portal suffix when present; otherwise derives
 * Mantra 1.7-style title from list position — never defaults every blank row to "Mantra 1".
 */
export function mantraLabelForCmsSync(
  portalTitle: string | undefined,
  orderNum: number,
  ctx: MantraTitleCtx,
): string {
  if (mantraNumberSuffix(portalTitle)) {
    return portalMantraTitleForLeaf(portalTitle, ctx.leaf);
  }
  return buildMantraDisplayTitle(ctx.leaf, orderNum, ctx);
}

/**
 * Insert/delete renumber: derive Shloka 1.1.n from **list position** so each CMS row keeps its
 * documentId but receives the shifted label (old 1.1.7 → 1.1.8, new blank → 1.1.3).
 */
export function mantraLabelFromListPosition(
  portalTitle: string | undefined,
  orderNum1Based: number,
  ctx: MantraTitleCtx,
): string {
  const pfx = titlePrefixFromMantraTitle(portalTitle, ctx.leaf);
  return buildMantraDisplayTitle(pfx, orderNum1Based, ctx);
}

/** Drop duplicate portal `id` only — never drop rows that share a CMS documentId (insert renumber). */
export function dedupeMantrasInDisplayOrder<T extends { id: string; strapiDocumentId?: string }>(
  manthrasInDisplayOrder: T[],
): T[] {
  const seenIds = new Set<string>();
  const out: T[] = [];
  for (const m of manthrasInDisplayOrder) {
    if (m.id && seenIds.has(m.id)) continue;
    if (m.id) seenIds.add(m.id);
    out.push(m);
  }
  return out;
}

function assignContiguousOrderAndTitles<T extends { id: string; title: string; order: number }>(
  manthrasInDisplayOrder: T[],
  ctx: MantraTitleCtx,
): T[] {
  return dedupeMantrasInDisplayOrder(manthrasInDisplayOrder).map((m, idx) => {
    const orderNum = idx + 1;
    const pfx = titlePrefixFromMantraTitle(m.title, ctx.leaf);
    return {
      ...m,
      order: orderNum,
      title: buildMantraDisplayTitle(pfx, orderNum, ctx),
    };
  });
}

/**
 * Sort by `order`, then assign contiguous `order` 1…n and titles from hierarchy + position.
 * Preserves each row's `id` and all other fields — only `order` and `title` change.
 */
export function reindexMantrasContiguous<T extends { id: string; title: string; order: number }>(
  manthras: T[],
  ctx: MantraTitleCtx,
): T[] {
  return assignContiguousOrderAndTitles(sortMantrasByDisplayOrder(manthras), ctx);
}

/**
 * Same as `reindexMantrasContiguous` but uses the **array order** of `manthras` as display order
 * (no sort). Use after insert/append when items are already in the correct sequence.
 *
 * Spreadsheet insert: only `order` and `title` change — `id`, `strapiDocumentId`, and verse bodies move with the row.
 */
export function reindexMantrasInListOrder<T extends { id: string; title: string; order: number }>(
  manthrasInDisplayOrder: T[],
  ctx: MantraTitleCtx,
): T[] {
  return assignContiguousOrderAndTitles(manthrasInDisplayOrder, ctx);
}

function mantraListHasDuplicateSuffixes(
  manthras: { id?: string; title?: string }[],
  configuredLeaf: string,
): boolean {
  const seen = new Set<string>();
  for (const m of manthras) {
    const label = (m.title ?? "").trim();
    const suf = mantraNumberSuffix(label);
    if (!suf || !titleUsesConfiguredLeaf(label, configuredLeaf)) continue;
    if (seen.has(suf)) return true;
    seen.add(suf);
  }
  return false;
}

/**
 * After rapid + inserts or CMS drift: re-run list-order renumber on any section that has
 * duplicate verse suffixes (e.g. two "Shloka 1.1.7" rows).
 */
export function repairDuplicateSuffixesInHierarchy<T extends SyncAdhyayaNode>(
  list: T[],
  cfg: GranthaStructureConfig,
): T[] {
  const leaf = (cfg.leafName || "Mantra").trim() || "Mantra";
  const levelThree = !!cfg.levelThreeEnabled;
  let changed = false;

  const fixList = <M extends SyncManthraNode>(
    manthras: M[],
    ctx: MantraTitleCtx,
  ): M[] => {
    if (!mantraListHasDuplicateSuffixes(manthras, leaf)) return manthras;
    changed = true;
    return reindexMantrasInListOrder(
      dedupeMantrasInDisplayOrder(sortMantrasByDisplayOrder(manthras)),
      ctx,
    ) as M[];
  };

  const out = sortNodesByOrder(list).map((a, ai) => {
    const khandas = sortNodesByOrder(a.khandas ?? []).map((k, ki) => {
      const khandaCtx = buildMantraTitleCtx(ai, k, ki, cfg);
      if (levelThree && (k.padas ?? []).length > 0) {
        const padas = sortNodesByOrder(k.padas ?? []).map((p, pi) => {
          const padaCtx = buildMantraTitleCtx(ai, k, ki, cfg, pi);
          return { ...p, manthras: fixList(p.manthras ?? [], padaCtx) };
        });
        return { ...k, padas, manthras: [] as SyncManthraNode[] };
      }
      return { ...k, manthras: fixList(k.manthras ?? [], khandaCtx) };
    });
    return { ...a, khandas } as T;
  });

  return changed ? out : list;
}

/**
 * Sort by `order`, assign contiguous `order` 1…n, **without** changing `title`.
 * Use after delete when the user chose not to renumber verse labels but Strapi/UI still need a clean `order` sequence.
 */
export function reindexMantraOrdersPreservingTitles<T extends { id: string; title: string; order: number }>(
  manthras: T[] | undefined,
): T[] {
  return sortMantrasByDisplayOrder(manthras ?? []).map((m, idx) => ({
    ...m,
    order: idx + 1,
  }));
}

/** When a row has no proper verse suffix (e.g. blank or duplicate "Mantra 1"), derive Mantra 1.n from position. */
function manthrasWithPositionTitlesIfNeeded<T extends { title: string }>(
  manthras: T[],
  ctx: MantraTitleCtx,
): T[] {
  return manthras.map((m, idx) =>
    mantraNumberSuffix(m.title)
      ? m
      : { ...m, title: mantraLabelForCmsSync(m.title, idx + 1, ctx) },
  );
}

/**
 * Persist/save prep: sort sections, fix contiguous `order`, dedupe linked rows.
 * Fills missing/broken verse labels (no x.y suffix) from list position — does not renumber valid labels.
 */
export function prepareHierarchyForSave<T extends SyncAdhyayaNode>(
  list: T[],
  cfg: GranthaStructureConfig,
): T[] {
  const levelThree = !!cfg.levelThreeEnabled;

  return sortNodesByOrder(list).map((a, ai) => {
    const khandas = sortNodesByOrder(a.khandas ?? []).map((k, ki) => {
      const khandaCtx = buildMantraTitleCtx(ai, k, ki, cfg);
      if (levelThree && (k.padas ?? []).length > 0) {
        const padas = sortNodesByOrder(k.padas ?? []).map((p, pi) => {
          const padaCtx = buildMantraTitleCtx(ai, k, ki, cfg, pi);
          const ordered = reindexMantraOrdersPreservingTitles(
            dedupeMantrasInDisplayOrder(sortMantrasByDisplayOrder(p.manthras ?? [])),
          );
          return {
            ...p,
            order: pi + 1,
            manthras: manthrasWithPositionTitlesIfNeeded(ordered, padaCtx),
          };
        });
        return { ...k, order: ki + 1, padas, manthras: [] as SyncManthraNode[] };
      }
      const ordered = reindexMantraOrdersPreservingTitles(
        dedupeMantrasInDisplayOrder(sortMantrasByDisplayOrder(k.manthras ?? [])),
      );
      return {
        ...k,
        order: ki + 1,
        padas: [] as SyncPadaNode[],
        manthras: manthrasWithPositionTitlesIfNeeded(ordered, khandaCtx),
      };
    });
    return { ...a, order: ai + 1, khandas } as T;
  });
}

/** Assign `order` 1…n in the given list sequence (use after splice insert/delete before normalize). */
export function assignContiguousMantraOrders<T extends { order: number }>(manthrasInDisplayOrder: T[]): T[] {
  return manthrasInDisplayOrder.map((m, idx) => ({ ...m, order: idx + 1 }));
}

/** Subset of portal `structureConfig` used for sync logic */
export interface GranthaStructureConfig {
  levelOneEnabled?: boolean;
  levelOneName?: string;
  levelTwoEnabled?: boolean;
  levelTwoName?: string;
  levelThreeEnabled?: boolean;
  levelThreeName?: string;
  leafName?: string;
}

export interface SyncManthraNode {
  id: string;
  title: string;
  order: number;
  strapiDocumentId?: string;
}

export interface SyncPadaNode {
  id: string;
  title: string;
  order: number;
  manthras: SyncManthraNode[];
  expanded: boolean;
  documentId?: string;
}

export interface SyncKhandaNode {
  id: string;
  title: string;
  order: number;
  padas: SyncPadaNode[];
  manthras: SyncManthraNode[];
  expanded: boolean;
  documentId?: string;
}

export interface SyncAdhyayaNode {
  id: string;
  title: string;
  order: number;
  khandas: SyncKhandaNode[];
  expanded: boolean;
  documentId?: string;
}

/**
 * Sanskrit ordinals (masculine `-a` form, as used for adhyaya / khanda / section
 * numbering) used for default section labels in the portal editor.
 * Index `i` (0-based) is the ordinal for position `i + 1`.
 * Keep in sync with `ORDINALS` in `client/src/pages/granthas.tsx`.
 */
const PORTAL_SECTION_ORDINALS = [
  "Prathama",       // 1
  "Dvitiya",        // 2
  "Tritiya",        // 3
  "Chaturtha",      // 4
  "Panchama",       // 5
  "Shashtha",       // 6
  "Saptama",        // 7
  "Ashtama",        // 8
  "Navama",         // 9
  "Dashama",        // 10
  "Ekadasha",       // 11
  "Dvadasha",       // 12
  "Trayodasha",     // 13
  "Chaturdasha",    // 14
  "Panchadasha",    // 15
  "Shodasha",       // 16
  "Saptadasha",     // 17
  "Ashtadasha",     // 18
  "Navadasha",      // 19
  "Vimsha",         // 20
  "Ekavimsha",      // 21
  "Dvavimsha",      // 22
  "Trayovimsha",    // 23
  "Chaturvimsha",   // 24
  "Panchavimsha",   // 25
  "Shadvimsha",     // 26
  "Saptavimsha",    // 27
  "Ashtavimsha",    // 28
  "Navavimsha",     // 29
  "Trimsha",        // 30
  "Ekatrimsha",     // 31
  "Dvatrimsha",     // 32
  "Trayastrimsha",  // 33
  "Chatustrimsha",  // 34
  "Panchatrimsha",  // 35
  "Shattrimsha",    // 36
  "Saptatrimsha",   // 37
  "Ashtatrimsha",   // 38
  "Navatrimsha",    // 39
  "Chatvarimsha",   // 40
] as const;

/**
 * Alternate spellings of auto-generated ordinals that older data may already contain,
 * so syncing recognises them as auto titles (and rewrites them to the canonical form
 * above) rather than treating them as custom names. Canonical forms live in
 * `PORTAL_SECTION_ORDINALS`; these are only used for matching, never emitted.
 */
const PORTAL_SECTION_ORDINAL_ALIASES = [
  "Shashthi",        // legacy spelling of 6th (now "Shashtha")
  "Ekonavimsha",     // variant of 19th ("Navadasha")
  "Ekonatrimsha",    // variant of 29th ("Navavimsha")
  "Ekonachatvarimsha", // variant of 39th ("Navatrimsha")
] as const;

export function editorOrdinalLabel(n: number): string {
  return (PORTAL_SECTION_ORDINALS[n - 1] as string | undefined) ?? `${n}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * If `currentTitle` looks like the portal's auto pattern `{ordinal} {levelName}`, rewrite the
 * ordinal to match `position1Based`. Otherwise return `currentTitle` unchanged (custom names).
 */
export function syncPortalSectionTitle(
  currentTitle: string | undefined,
  levelName: string | undefined,
  position1Based: number,
): string {
  const t = (currentTitle ?? "").trim();
  if (t === "_default") return t;
  const name = (levelName ?? "").trim();
  if (!name) return t;
  const ordAlt = [...PORTAL_SECTION_ORDINALS, ...PORTAL_SECTION_ORDINAL_ALIASES].join("|");
  const re = new RegExp(`^(?:${ordAlt}|\\d+)\\s+${escapeRegExp(name)}\\s*$`, "i");
  if (!t) return `${editorOrdinalLabel(position1Based)} ${name}`;
  if (!re.test(t)) return t;
  return `${editorOrdinalLabel(position1Based)} ${name}`;
}

/** Assign default `{ordinal} {levelName}` titles where sections are blank (hidden L1 rows, insert-after, CMS load). */
export function fillMissingSectionTitles<T extends SyncAdhyayaNode>(
  list: T[],
  cfg: GranthaStructureConfig,
): T[] {
  const levelTwo = cfg.levelTwoEnabled !== false;
  const levelThree = !!cfg.levelThreeEnabled;
  const L1 = (cfg.levelOneName ?? "Adhyaya").trim() || "Adhyaya";
  const L2 = (cfg.levelTwoName ?? "Khanda").trim() || "Khanda";
  const L3 = (cfg.levelThreeName ?? "Pada").trim() || "Pada";

  return sortNodesByOrder(list).map((a, ai) => {
    const aTitle = a.title?.trim() || `${editorOrdinalLabel(ai + 1)} ${L1}`;
    const khandas = sortNodesByOrder(a.khandas ?? []).map((k, ki) => {
      if (k.title === "_default") return k;
      const kTitle = k.title?.trim() || `${editorOrdinalLabel(ki + 1)} ${L2}`;
      if (levelThree) {
        const padas = sortNodesByOrder(k.padas ?? []).map((p, pi) => {
          const pTitle = p.title?.trim() || `${editorOrdinalLabel(pi + 1)} ${L3}`;
          return p.title?.trim() ? p : { ...p, title: pTitle };
        });
        return k.title?.trim() ? { ...k, padas } : { ...k, title: kTitle, padas };
      }
      return k.title?.trim() ? k : { ...k, title: kTitle };
    });
    return a.title?.trim() ? { ...a, khandas } : { ...a, title: aTitle, khandas };
  });
}

/**
 * Single pass: sort adhyayas → khandas → padas by `order`, assign contiguous sibling `order`,
 * sync auto-style section titles, then reindex every mantra list (titles + contiguous `order`)
 * so editor state matches the UI immediately after structural edits.
 */
export function normalizeEditorHierarchy<T extends SyncAdhyayaNode>(list: T[], cfg: GranthaStructureConfig): T[] {
  const levelTwo = cfg.levelTwoEnabled !== false;
  const levelThree = !!cfg.levelThreeEnabled;
  const leaf = cfg.leafName ?? "Mantra";
  const L1 = (cfg.levelOneName ?? "Adhyaya").trim() || "Adhyaya";
  const L2 = (cfg.levelTwoName ?? "Khanda").trim() || "Khanda";
  const L3 = (cfg.levelThreeName ?? "Pada").trim() || "Pada";

  return sortNodesByOrder(list).map((a, ai) => {
    const aIdx = ai + 1;
    const adhyayaTitle = syncPortalSectionTitle(a.title, L1, aIdx);
    const sortedK = sortNodesByOrder(a.khandas ?? []);

    const khandas = sortedK.map((k, ki) => {
      const isDefaultKhanda = k.title === "_default";
      const kIdx = levelTwo && !isDefaultKhanda ? ki + 1 : aIdx;
      const khandaTitle = isDefaultKhanda ? k.title : syncPortalSectionTitle(k.title, L2, ki + 1);

      if (levelThree) {
        const sortedP = sortNodesByOrder(k.padas ?? []);
        const padas = sortedP.map((p, pi) => {
          const pIdx = pi + 1;
          const padaTitle = syncPortalSectionTitle(p.title, L3, pIdx);
          const ctx: MantraTitleCtx = {
            leaf,
            aIdx,
            kIdx,
            pIdx,
            isDefaultKhanda,
            padaPath: true,
            levelTwoEnabled: levelTwo,
          };
          const manthras = reindexMantrasInListOrder(sortMantrasByDisplayOrder(p.manthras ?? []), ctx);
          return { ...p, order: pIdx, title: padaTitle, manthras };
        });
        return { ...k, order: ki + 1, title: khandaTitle, padas, manthras: [] };
      }

      const ctx: MantraTitleCtx = {
        leaf,
        aIdx,
        kIdx,
        isDefaultKhanda,
        padaPath: false,
        levelTwoEnabled: levelTwo,
      };
      const manthras = reindexMantrasInListOrder(sortMantrasByDisplayOrder(k.manthras ?? []), ctx);
      return { ...k, order: ki + 1, title: khandaTitle, padas: [], manthras };
    });

    return { ...a, order: aIdx, title: adhyayaTitle, khandas } as T;
  });
}

/** Clear stale portal-only flags after load, save, or CMS link. */
export function sanitizeHierarchyPortalMeta<T extends SyncAdhyayaNode>(list: T[]): T[] {
  const fixManthra = <M extends SyncManthraNode & { _isNewLocal?: boolean }>(m: M): M => {
    if (m._isNewLocal && m.strapiDocumentId && isPublishedStrapiDocId(m.strapiDocumentId)) {
      const { _isNewLocal: _, ...rest } = m;
      return rest as M;
    }
    return m;
  };
  return list.map((a) => ({
    ...a,
    khandas: (a.khandas ?? []).map((k) => ({
      ...k,
      manthras: (k.manthras ?? []).map(fixManthra),
      padas: (k.padas ?? []).map((p) => ({
        ...p,
        manthras: (p.manthras ?? []).map(fixManthra),
      })),
    })),
  })) as T[];
}

function newLocalId(): string {
  return Math.random().toString(36).slice(2, 9);
}

export function collectPublishedManthraDocIdsFromKhanda(k: SyncKhandaNode): string[] {
  const ids: string[] = [];
  for (const m of k.manthras ?? []) {
    if (isPublishedStrapiDocId(m.strapiDocumentId)) ids.push(m.strapiDocumentId);
  }
  for (const p of k.padas ?? []) {
    for (const m of p.manthras ?? []) {
      if (isPublishedStrapiDocId(m.strapiDocumentId)) ids.push(m.strapiDocumentId);
    }
  }
  return ids;
}

export function collectPublishedManthraDocIdsFromAdhyaya(a: SyncAdhyayaNode): string[] {
  const ids: string[] = [];
  for (const k of a.khandas ?? []) {
    ids.push(...collectPublishedManthraDocIdsFromKhanda(k));
  }
  return ids;
}

/**
 * Leaf-entry count for one khanda — when L3 padas exist, counts mantras under padas only
 * (never khanda.manthras, which must stay empty in 3-level books).
 */
export function countLeafMantrasInKhanda(
  k: Pick<SyncKhandaNode, "manthras" | "padas">,
  cfg: Pick<GranthaStructureConfig, "levelThreeEnabled">,
): number {
  if (cfg.levelThreeEnabled && (k.padas ?? []).length > 0) {
    return (k.padas ?? []).reduce((s, p) => s + (p.manthras ?? []).length, 0);
  }
  return (k.manthras ?? []).length;
}

/** Leaf-entry count for an adhyaya (respects flat vs L2 vs L3 structure config). */
export function countLeafMantrasInAdhyaya(
  a: Pick<SyncAdhyayaNode, "khandas">,
  cfg: Pick<GranthaStructureConfig, "levelTwoEnabled" | "levelThreeEnabled">,
): number {
  const levelTwo = cfg.levelTwoEnabled !== false;
  if (!levelTwo) {
    const k = a.khandas?.[0];
    return k ? countLeafMantrasInKhanda(k, cfg) : 0;
  }
  return (a.khandas ?? []).reduce((s, k) => s + countLeafMantrasInKhanda(k, cfg), 0);
}

/**
 * Strapi section flat list: sum mantras on tree leaves only.
 * Parent sections (e.g. Khanda) often still carry legacy inline mantras while children
 * (Pada) hold the canonical rows — summing every section double-counts (549 vs 13).
 */
/**
 * Mantras for a portal khanda/pada after section resolution.
 * When the portal node has no linked Strapi section (common on flat books), fall back to the
 * grantha's only section that actually has mantras so enrich never leaves verses behind.
 */
export function strapiMantrasForResolvedSection(
  strapiMantrasBySecDocId: Map<string, StrapiMantraRef[]>,
  resolvedSecId: string | undefined,
  parentSecId: string | undefined,
): StrapiMantraRef[] {
  if (resolvedSecId) {
    const list = strapiMantrasBySecDocId.get(resolvedSecId);
    if (list && list.length > 0) return list;
  }
  if (parentSecId) {
    const list = strapiMantrasBySecDocId.get(parentSecId);
    if (list && list.length > 0) return list;
  }
  const nonEmpty = [...strapiMantrasBySecDocId.values()].filter((list) => list.length > 0);
  if (nonEmpty.length === 1) return nonEmpty[0]!;
  if (strapiMantrasBySecDocId.size === 1) {
    return [...strapiMantrasBySecDocId.values()][0] ?? [];
  }
  return [];
}

export type PortalMantraOwnerMergeContext = {
  resolvedSecId?: string;
  adhyayaDocId?: string;
  khandaTitle?: string;
  khandaDocId?: string;
  padaDocId?: string;
  cfg: Pick<GranthaStructureConfig, "levelTwoEnabled" | "levelThreeEnabled">;
  childrenByParentDocId?: Map<string, Array<{ documentId: string }>>;
};

function mergeStrapiMantraRefLists(
  primaryList: StrapiMantraRef[],
  sectionDocIds: Iterable<string>,
  strapiMantrasBySecDocId: Map<string, StrapiMantraRef[]>,
): StrapiMantraRef[] {
  const byDoc = new Map<string, StrapiMantraRef>();
  const ingest = (list: StrapiMantraRef[]) => {
    for (const sm of list) {
      if (!sm.docId) continue;
      const prev = byDoc.get(sm.docId);
      const score = sm.contentScore ?? 0;
      const prevScore = prev?.contentScore ?? 0;
      if (!prev || score >= prevScore) byDoc.set(sm.docId, sm);
    }
  };
  ingest(primaryList);
  for (const sid of sectionDocIds) {
    if (!sid) continue;
    ingest(strapiMantrasBySecDocId.get(sid) ?? []);
  }
  return [...byDoc.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Section documentIds whose mantras belong to one portal owner (khanda / pada / flat adhyaya). */
export function collectMantraSectionDocIdsForPortalOwner(
  ctx: PortalMantraOwnerMergeContext,
  strapiMantrasBySecDocId: Map<string, StrapiMantraRef[]>,
): string[] {
  const {
    resolvedSecId,
    adhyayaDocId,
    khandaTitle,
    khandaDocId,
    padaDocId,
    cfg,
    childrenByParentDocId,
  } = ctx;
  const ids = new Set<string>();
  const levelTwo = cfg.levelTwoEnabled !== false;
  const levelThree = !!cfg.levelThreeEnabled;
  const isDefaultKhanda = khandaTitle === "_default" || !levelTwo;

  if (resolvedSecId) ids.add(resolvedSecId);
  if (isPublishedStrapiDocId(padaDocId)) ids.add(padaDocId!);
  if (isPublishedStrapiDocId(khandaDocId)) ids.add(khandaDocId!);

  if (levelThree && padaDocId) {
    return [...ids];
  }

  if (!levelTwo && adhyayaDocId) {
    ids.add(adhyayaDocId);
    for (const c of childrenByParentDocId?.get(adhyayaDocId) ?? []) {
      ids.add(c.documentId);
    }
    return [...ids];
  }

  if (isDefaultKhanda && adhyayaDocId) {
    ids.add(adhyayaDocId);
    for (const c of childrenByParentDocId?.get(adhyayaDocId) ?? []) {
      ids.add(c.documentId);
    }
    return [...ids];
  }

  if (
    adhyayaDocId &&
    resolvedSecId &&
    adhyayaDocId !== resolvedSecId &&
    (strapiMantrasBySecDocId.get(adhyayaDocId) ?? []).length > 0 &&
    (strapiMantrasBySecDocId.get(resolvedSecId) ?? []).length > 0
  ) {
    ids.add(adhyayaDocId);
  }

  return [...ids];
}

/**
 * All granthas: union CMS mantras from every Strapi section that owns this portal bucket
 * (flat adhyaya, _default + child khanda, named khanda with split parent/child rows, L3 pada).
 */
export function mergeStrapiMantraRefsForPortalMantraOwner(
  primaryList: StrapiMantraRef[],
  strapiMantrasBySecDocId: Map<string, StrapiMantraRef[]>,
  ctx: PortalMantraOwnerMergeContext,
): StrapiMantraRef[] {
  const sectionIds = collectMantraSectionDocIdsForPortalOwner(ctx, strapiMantrasBySecDocId);
  return mergeStrapiMantraRefLists(primaryList, sectionIds, strapiMantrasBySecDocId);
}

/** @deprecated Use mergeStrapiMantraRefsForPortalMantraOwner */
export function mergeStrapiMantraRefsForFlatAdhyaya(
  adhyayaDocId: string | undefined,
  primaryList: StrapiMantraRef[],
  strapiMantrasBySecDocId: Map<string, StrapiMantraRef[]>,
  childrenByParentDocId?: Map<string, Array<{ documentId: string }>>,
): StrapiMantraRef[] {
  return mergeStrapiMantraRefsForPortalMantraOwner(primaryList, strapiMantrasBySecDocId, {
    adhyayaDocId,
    khandaTitle: "_default",
    cfg: { levelTwoEnabled: false },
    childrenByParentDocId,
  });
}

export type EditorManthraRow = {
  id: string;
  title: string;
  order?: number;
  strapiDocumentId?: string;
  _isNewLocal?: boolean;
  ShlokaManthraEntry?: unknown;
  BhashyamForShlokaManthra?: { SanskritTextEntry?: unknown };
};

function editorManthraRichness(m: EditorManthraRow): number {
  let s = scoreStrapiManthraRowContent(m.ShlokaManthraEntry);
  if (entryContentCharCount(m.BhashyamForShlokaManthra?.SanskritTextEntry) > 0) s += 50;
  if (isPublishedStrapiDocId(m.strapiDocumentId)) s += 1;
  if (m._isNewLocal) s += 200;
  return s;
}

function pickEditorManthraForDocId<T extends EditorManthraRow>(candidates: T[]): T {
  const sorted = sortMantrasByDisplayOrder(candidates);
  const established = sorted.filter((m) => !m._isNewLocal);
  const pool = established.length > 0 ? established : sorted;
  return pool.reduce(
    (best, m) => (editorManthraRichness(m) > editorManthraRichness(best) ? m : best),
    pool[0]!,
  );
}

/**
 * After insert/sync: at most one portal row per CMS documentId. Losers keep portal verse
 * bodies but drop the shared link so they can claim a new row on the next sync.
 */
export function enforceUniqueStrapiDocumentIdsAmongMantras<
  T extends EditorManthraRow,
>(manthras: T[], sectionRefs?: StrapiMantraRef[]): T[] {
  const sorted = sortMantrasByDisplayOrder(manthras);
  const byDoc = new Map<string, T[]>();
  for (const m of sorted) {
    const docId = (m.strapiDocumentId ?? "").trim();
    if (!isPublishedStrapiDocId(docId)) continue;
    const group = byDoc.get(docId) ?? [];
    group.push(m);
    byDoc.set(docId, group);
  }
  const winnerIdByDoc = new Map<string, string>();
  for (const [docId, group] of byDoc) {
    if (group.length <= 1) continue;
    // First portal row in display order keeps the CMS link (labels may lag after insert).
    const winner = pickEditorManthraForDocId(group);
    winnerIdByDoc.set(docId, winner.id);
  }
  return manthras.map((m) => {
    const docId = (m.strapiDocumentId ?? "").trim();
    if (!isPublishedStrapiDocId(docId)) return m;
    const winnerId = winnerIdByDoc.get(docId);
    if (!winnerId || winnerId === m.id) return m;
    return { ...m, strapiDocumentId: undefined };
  });
}

/** Portal row must stay in hierarchy even when CMS resolve fails (new insert / unsaved verse). */
export function portalManthraShouldRetainInHierarchy(m: {
  title?: string;
  _isNewLocal?: boolean;
  ShlokaManthraEntry?: unknown;
  BhashyamForShlokaManthra?: unknown;
}): boolean {
  if (m._isNewLocal) return true;
  if (scoreStrapiManthraRowContent(m.ShlokaManthraEntry) >= MANTRA_LINK_MIN_CONTENT_SCORE) {
    return true;
  }
  if (entryContentCharCount(m.BhashyamForShlokaManthra?.SanskritTextEntry) > 0) return true;
  return !!mantraNumberSuffix(m.title);
}

/**
 * Editor list: one row per portal `id` (never hide inserted verses like 1.1.2).
 */
export function dedupeManthrasForEditor<T extends EditorManthraRow>(
  manthras: T[],
  _leaf?: string,
): T[] {
  const seenId = new Set<string>();
  return sortMantrasByDisplayOrder(manthras).filter((m) => {
    if (!m.id || seenId.has(m.id)) return false;
    seenId.add(m.id);
    return true;
  });
}

/**
 * When the list jumps 1.1.1 → 1.1.3, surface a placeholder Shloka 1.1.2 so the user can
 * restore the inserted verse (common after insert-between + save without CMS slot).
 */
export function insertPlaceholderRowsForMissingSuffixGaps<
  T extends { id: string; title: string; order: number; _isNewLocal?: boolean },
>(
  manthras: T[],
  ctx: MantraTitleCtx,
  createId: () => string,
  maxInserts = 5,
): T[] {
  const sorted = sortMantrasByDisplayOrder(manthras);
  const parsed: Array<{ m: T; n: number; prefix: string }> = [];
  for (const m of sorted) {
    const suf = mantraNumberSuffix(m.title);
    if (!suf || !titleUsesConfiguredLeaf(m.title, ctx.leaf)) continue;
    const parts = suf.split(".");
    const n = parseInt(parts[parts.length - 1] ?? "", 10);
    if (!Number.isFinite(n)) continue;
    const prefix = parts.slice(0, -1).join(".");
    parsed.push({ m, n, prefix });
  }
  if (parsed.length < 2) return sorted;
  const prefix0 = parsed[0]!.prefix;
  if (!parsed.every((p) => p.prefix === prefix0)) return sorted;

  const present = new Set(parsed.map((p) => p.n));
  const min = Math.min(...parsed.map((p) => p.n));
  const max = Math.max(...parsed.map((p) => p.n));
  const inserts: T[] = [];
  for (let n = min; n <= max && inserts.length < maxInserts; n++) {
    if (present.has(n)) continue;
    const title = buildMantraDisplayTitle(ctx.leaf, n, ctx);
    inserts.push({
      id: createId(),
      title,
      order: n,
      _isNewLocal: true,
    } as T);
  }
  if (inserts.length === 0) return sorted;
  return sortMantrasByDisplayOrder([...sorted, ...inserts]);
}

/** Walk hierarchy and add placeholder rows for missing 1.1.n-style gaps (e.g. 1.1.1 then 1.1.3). */
export function fillMissingVerseGapsInHierarchy<T extends SyncAdhyayaNode>(
  list: T[],
  cfg: GranthaStructureConfig,
  createId: () => string,
): T[] {
  const levelThree = !!cfg.levelThreeEnabled;
  return sortNodesByOrder(list).map((a, ai) => {
    const khandas = sortNodesByOrder(a.khandas ?? []).map((k, ki) => {
      const khandaCtx = buildMantraTitleCtx(ai, k, ki, cfg);
      if (levelThree && (k.padas ?? []).length > 0) {
        const padas = sortNodesByOrder(k.padas ?? []).map((p, pi) => {
          const padaCtx = buildMantraTitleCtx(ai, k, ki, cfg, pi);
          return {
            ...p,
            manthras: insertPlaceholderRowsForMissingSuffixGaps(p.manthras ?? [], padaCtx, createId),
          };
        });
        return { ...k, padas, manthras: [] as SyncManthraNode[] };
      }
      return {
        ...k,
        manthras: insertPlaceholderRowsForMissingSuffixGaps(k.manthras ?? [], khandaCtx, createId),
      };
    });
    return { ...a, khandas } as T;
  });
}

/**
 * Flat granthas (one top-level Strapi section with all mantras, e.g. Atma Bodha "Shloka") often
 * have portal adhyayas with no documentId. Link them so enrich and publish resolve the same rows.
 */
export function linkFlatGranthaAdhyayasToSoleStrapiSection<
  T extends { documentId?: string; khandas?: unknown[] },
>(
  hierarchy: T[],
  sections: Array<{
    documentId?: string;
    parent?: { documentId?: string };
    manthras?: unknown[];
  }>,
): T[] {
  const topWithMantras = sections.filter(
    (s) => !s.parent?.documentId && Array.isArray(s.manthras) && s.manthras.length > 0,
  );
  if (topWithMantras.length !== 1) return hierarchy;
  const soleDocId = topWithMantras[0]?.documentId;
  if (!isPublishedStrapiDocId(soleDocId)) return hierarchy;
  return hierarchy.map((a) => {
    if (isPublishedStrapiDocId(a.documentId)) return a;
    return { ...a, documentId: soleDocId };
  });
}

export function countMantrasOnLeafSections(
  sections: Array<{ documentId?: string; parent?: { documentId?: string }; manthras?: unknown[] }>,
): number {
  if (!sections?.length) return 0;
  const parentDocIds = new Set<string>();
  for (const s of sections) {
    const pid = s.parent?.documentId;
    if (pid) parentDocIds.add(pid);
  }
  return sections
    .filter((s) => s.documentId && !parentDocIds.has(s.documentId))
    .reduce((sum, s) => sum + (Array.isArray(s.manthras) ? s.manthras.length : 0), 0);
}

/** Count mantras on a section node and all descendants (for Sections admin tree). */
export function countLeafMantrasInSectionTree(
  node: { documentId?: string; manthras?: unknown[] },
  childrenByParentDocId: Map<string, Array<{ documentId?: string; manthras?: unknown[] }>>,
): number {
  const children = node.documentId ? childrenByParentDocId.get(node.documentId) ?? [] : [];
  if (children.length === 0) {
    return Array.isArray(node.manthras) ? node.manthras.length : 0;
  }
  return children.reduce(
    (sum, child) => sum + countLeafMantrasInSectionTree(child, childrenByParentDocId),
    0,
  );
}

/**
 * When L3 is enabled and a khanda has padas, mantras belong on padas only.
 * Clears stray khanda.manthras left by Strapi supplement / legacy flat imports.
 */
export function enforceMantraPlacementByStructure<T extends SyncAdhyayaNode>(
  list: T[],
  cfg: GranthaStructureConfig,
): T[] {
  if (!cfg.levelThreeEnabled) return list;
  return list.map((a) => ({
    ...a,
    khandas: (a.khandas ?? []).map((k) => {
      if ((k.padas ?? []).length === 0) return k;
      return { ...k, manthras: [] as SyncManthraNode[] };
    }),
  })) as T[];
}

/**
 * When the book structure is "flat" (no real khandas), ensure each adhyaya has a single `_default` khanda.
 * When L3 is off, collapse padas into khanda.manthras. Collect Strapi section documentIds that are removed
 * from the logical tree so the client can queue them for DELETE on publish.
 */
export function prepareHierarchyForContentStep(
  list: SyncAdhyayaNode[],
  cfg: GranthaStructureConfig,
): { hierarchy: SyncAdhyayaNode[]; sectionDocIdsToMarkDeleted: string[] } {
  const levelTwoEnabled = cfg.levelTwoEnabled !== false;
  const levelThreeEnabled = !!cfg.levelThreeEnabled;

  if (levelTwoEnabled && levelThreeEnabled) {
    return { hierarchy: list, sectionDocIdsToMarkDeleted: [] };
  }

  const sectionDocIdsToMarkDeleted: string[] = [];
  const pushSectionDoc = (id?: string) => {
    if (isPublishedStrapiDocId(id)) sectionDocIdsToMarkDeleted.push(id);
  };

  const next = list.map((a) => {
    const khandas = a.khandas ?? [];

    if (!levelTwoEnabled) {
      const needsMerge =
        khandas.length !== 1 ||
        khandas[0]?.title !== "_default" ||
        (khandas[0]?.padas ?? []).length > 0 ||
        khandas.some((k) => (k.padas ?? []).length > 0);
      if (!needsMerge) return a;

      const preferred = khandas.find((k) => k.title === "_default") ?? khandas[0];
      for (const k of khandas) {
        if (preferred && k.id === preferred.id) continue;
        pushSectionDoc(k.documentId);
        for (const p of k.padas ?? []) pushSectionDoc(p.documentId);
      }
      if (preferred) {
        for (const p of preferred.padas ?? []) pushSectionDoc(p.documentId);
      }

      const allManthras: SyncManthraNode[] = [];
      for (const k of khandas) {
        for (const m of k.manthras ?? []) allManthras.push(m);
        for (const p of k.padas ?? []) {
          for (const m of p.manthras ?? []) allManthras.push(m);
        }
      }

      return {
        ...a,
        khandas: [
          {
            id: preferred?.id ?? newLocalId(),
            title: "_default",
            order: 1,
            padas: [],
            manthras: sortNodesByOrder(allManthras),
            expanded: true,
            ...(preferred?.documentId ? { documentId: preferred.documentId } : {}),
          },
        ],
      };
    }

    if (!levelThreeEnabled) {
      let anyPada = false;
      for (const k of khandas) {
        if ((k.padas ?? []).length > 0) {
          anyPada = true;
          break;
        }
      }
      if (!anyPada) return a;

      const newKhandas = khandas.map((k) => {
        const padas = k.padas ?? [];
        if (padas.length === 0) return k;
        for (const p of padas) pushSectionDoc(p.documentId);
        const fromPadas = padas.flatMap((p) => p.manthras ?? []);
        return { ...k, padas: [], manthras: sortNodesByOrder([...(k.manthras ?? []), ...fromPadas]) };
      });
      return { ...a, khandas: newKhandas };
    }

    return a;
  });

  return { hierarchy: next, sectionDocIdsToMarkDeleted };
}

export function scoreStrapiManthraRowContent(entry: unknown): number {
  if (!entry || typeof entry !== "object") return 0;
  const e = entry as { SanskritTextEntry?: unknown; EnglishTranslationText?: unknown };
  return (
    entryContentCharCount(e.SanskritTextEntry) + entryContentCharCount(e.EnglishTranslationText)
  );
}

/** One row per section + verse suffix — keep the CMS row with the most text (matches Grantha linking). */
export function dedupePublishedMantrasForDisplay<
  T extends {
    documentId?: string;
    ShlokaManthraNumber?: string;
    ShlokaManthraEntry?: unknown;
    section?: { documentId?: string };
  },
>(rows: T[]): T[] {
  const byKey = new Map<string, { row: T; score: number }>();
  for (const m of rows) {
    const sec = m.section?.documentId ?? "__none__";
    const numSuffix = mantraNumberSuffix(String(m.ShlokaManthraNumber ?? ""));
    const key = numSuffix ? `${sec}:${numSuffix}` : `${sec}:__${m.documentId ?? Math.random()}`;
    const score = scoreStrapiManthraRowContent(m.ShlokaManthraEntry);
    const leafOrd = mantraSuffixLeafOrder(numSuffix);
    const orderBonus =
      leafOrd != null && typeof (m as { order?: number }).order === "number" && (m as { order?: number }).order === leafOrd
        ? 500
        : 0;
    const emptyPenalty = score < 8 ? -2000 : 0;
    const bareLabelPenalty = isBareLeafCounterTitle(String(m.ShlokaManthraNumber ?? "")) ? -3000 : 0;
    const totalScore = score + orderBonus + emptyPenalty + bareLabelPenalty;
    const prev = byKey.get(key);
    if (!prev || totalScore > prev.score) byKey.set(key, { row: m, score: totalScore });
  }
  const deduped = [...byKey.values()].map((v) => v.row);

  // Drop bare leaf-counter stubs (e.g. "Vaakhyaa 1") when the same section has real dotted verses.
  const bySection = new Map<string, T[]>();
  for (const m of deduped) {
    const sec = m.section?.documentId ?? "__none__";
    if (!bySection.has(sec)) bySection.set(sec, []);
    bySection.get(sec)!.push(m);
  }
  const drop = new Set<T>();
  for (const secRows of bySection.values()) {
    const hasDottedVerse = secRows.some((m) => {
      const suf = mantraNumberSuffix(String(m.ShlokaManthraNumber ?? ""));
      return !!suf && suf.includes(".");
    });
    if (!hasDottedVerse) continue;
    for (const m of secRows) {
      const label = String(m.ShlokaManthraNumber ?? "");
      if (!isBareLeafCounterTitle(label)) continue;
      drop.add(m);
    }
  }
  return deduped.filter((m) => !drop.has(m));
}

export type ManthraTabRow = {
  documentId?: string;
  ShlokaManthraNumber?: string;
  ShlokaManthraEntry?: unknown;
  order?: number;
  section?: { documentId?: string; title?: string };
  grantha?: { documentId?: string; GranthaName?: string };
};

/** Mantras tab: attach grantha from sections, dedupe duplicates, canonicalize khanda paths. */
export function normalizeManthrasForMantrasTab<
  T extends ManthraTabRow,
  S extends StrapiSectionNode & { grantha?: { documentId?: string; GranthaName?: string } },
>(rows: T[], allSections: S[]): T[] {
  const sectionByDocId = buildSectionByDocIdMap(allSections);
  const normalized = rows.map((m) => {
    if (m.grantha) return m;
    const sectionDocId = m.section?.documentId;
    if (!sectionDocId) return m;
    const sec = sectionByDocId.get(sectionDocId);
    if (!sec?.grantha) return m;
    return { ...m, grantha: sec.grantha };
  });
  const deduped = dedupePublishedMantrasForDisplay(normalized);

  const sectionHasDottedVerse = new Map<string, boolean>();
  for (const m of deduped) {
    const sec = m.section?.documentId;
    if (!sec) continue;
    const suf = mantraNumberSuffix(m.ShlokaManthraNumber);
    if (suf?.includes(".")) sectionHasDottedVerse.set(sec, true);
  }

  const byCanonicalDisplayKey = new Map<string, { row: T; score: number }>();
  for (const m of deduped) {
    const sectionDocId = m.section?.documentId;
    const label = String(m.ShlokaManthraNumber ?? "");
    if (
      sectionDocId &&
      sectionHasDottedVerse.get(sectionDocId) &&
      isBareLeafCounterTitle(label)
    ) {
      continue;
    }
    const granthaId = m.grantha?.documentId || "__none__";
    const granthaSections = allSections.filter(
      (s) =>
        s.grantha?.documentId === granthaId ||
        (s.grantha?.GranthaName && s.grantha?.GranthaName === m.grantha?.GranthaName),
    );
    const hasKhandaStructure = strapiGranthaHasKhandaSections(granthaSections);
    if (!hasKhandaStructure || !sectionDocId) {
      byCanonicalDisplayKey.set(`${m.documentId}`, { row: m, score: 0 });
      continue;
    }

    const suffix = mantraNumberSuffix(m.ShlokaManthraNumber);
    const leafOrd = mantraSuffixLeafOrder(suffix);
    if (leafOrd == null) {
      byCanonicalDisplayKey.set(`${m.documentId}`, { row: m, score: 0 });
      continue;
    }

    const path = buildSectionAncestorPath(sectionDocId, sectionByDocId);
    const pathKey = path.map((p) => p.documentId).join("/") || sectionDocId;
    const canonicalKey = `${granthaId}:${pathKey}:${leafOrd}`;

    const contentScore = scoreStrapiManthraRowContent(m.ShlokaManthraEntry);
    const suffixDepth = suffix?.split(".").length ?? 0;
    const misplacedPenalty = isMantraSectionMisplacedOnAdhyaya(sectionDocId, granthaSections)
      ? -5000
      : 0;
    const score =
      contentScore + suffixDepth * 100 + (path.length > 1 ? 1000 : 0) + misplacedPenalty;

    const prev = byCanonicalDisplayKey.get(canonicalKey);
    if (!prev || score > prev.score) {
      byCanonicalDisplayKey.set(canonicalKey, { row: m, score });
    }
  }

  return [...byCanonicalDisplayKey.values()]
    .map((x) => x.row)
    .sort((a, b) => {
      const bySuffix = compareMantraNumberSuffix(
        mantraNumberSuffix(a.ShlokaManthraNumber),
        mantraNumberSuffix(b.ShlokaManthraNumber),
      );
      if (bySuffix !== 0) return bySuffix;
      return (a.order ?? 0) - (b.order ?? 0);
    });
}

/** Section row from Strapi `sections/by-grantha` (metadata + optional manthras). */
export type StrapiSectionNode = {
  documentId?: string;
  title?: string;
  type?: string | null;
  parent?: { documentId?: string; title?: string; type?: string | null };
};

/** True when this grantha has at least one section whose parent is another section (e.g. Khanda under Adhyaya). */
export function strapiGranthaHasKhandaSections(sections: StrapiSectionNode[]): boolean {
  if (!sections?.length) return false;
  const docIds = new Set(
    sections.map((s) => s.documentId).filter((id): id is string => isPublishedStrapiDocId(id)),
  );
  return sections.some((sec) => {
    const pid = sec.parent?.documentId;
    return !!pid && docIds.has(pid);
  });
}

export function buildSectionByDocIdMap(
  sections: StrapiSectionNode[],
): Map<string, StrapiSectionNode> {
  const map = new Map<string, StrapiSectionNode>();
  for (const s of sections) {
    if (isPublishedStrapiDocId(s.documentId)) map.set(s.documentId, s);
  }
  return map;
}

/** Root → leaf chain for a section (e.g. Prathama Adhyaya → Prathama Khanda). */
export function buildSectionAncestorPath(
  sectionDocId: string,
  sectionsByDocId: Map<string, StrapiSectionNode>,
): StrapiSectionNode[] {
  const path: StrapiSectionNode[] = [];
  let cur = sectionsByDocId.get(sectionDocId);
  const seen = new Set<string>();
  while (cur?.documentId) {
    if (seen.has(cur.documentId)) break;
    seen.add(cur.documentId);
    path.unshift(cur);
    const pid = cur.parent?.documentId;
    cur = pid ? sectionsByDocId.get(pid) : undefined;
  }
  return path;
}

export function sectionPathLabel(path: StrapiSectionNode[]): string {
  return path.map((s) => s.title?.trim() || "Section").join(" → ");
}

/**
 * Mantras whose `Section` is the adhyaya row while child khanda sections exist in Strapi.
 * Those rows show as "Adhyaya → mantras" in the list and often carry stale/wrong content.
 */
export function isMantraSectionMisplacedOnAdhyaya(
  mantraSectionDocId: string | undefined,
  sections: StrapiSectionNode[],
): boolean {
  if (!mantraSectionDocId || !strapiGranthaHasKhandaSections(sections)) return false;
  const byId = buildSectionByDocIdMap(sections);
  const path = buildSectionAncestorPath(mantraSectionDocId, byId);
  return path.length === 1;
}
