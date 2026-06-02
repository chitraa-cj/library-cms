/**
 * Pure helpers for Grantha hierarchy ↔ structure config alignment.
 * Kept out of the page component so async loaders (e.g. openEdit) can run
 * the same normalization as the wizard "Next" step without ordering bugs.
 */

import { entryContentCharCount } from "./strapi-blocks";
import { portalIndexToStrapiSortKey, STRAPI_SORT_GAP } from "@shared/mantra-sort-key";

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
): StrapiMantraRef | undefined {
  const label = (portalTitle ?? "").trim();
  if (!label || sectionMantras.length === 0) return undefined;
  const lower = label.toLowerCase();
  const hits = sectionMantras.filter((sm) => sm.title.trim().toLowerCase() === lower);
  if (hits.length === 0) return undefined;
  return pickBestStrapiMantraRefForLink(hits, preferredDocId);
}

export function findStrapiMantraByLeafAndSuffix(
  mantras: StrapiMantraRef[],
  portalTitle: string | undefined,
  configuredLeaf: string,
  preferredDocId?: string,
): StrapiMantraRef | undefined {
  const leaf = (configuredLeaf || "Mantra").trim();
  let label = (portalTitle ?? "").trim();
  const suffix = mantraNumberSuffix(label);
  if (!suffix) return undefined;
  if (!titleUsesConfiguredLeaf(label, leaf)) {
    label = canonicalMantraTitle(leaf, suffix);
  }
  const hits = mantras.filter(
    (sm) =>
      mantraNumberSuffix(sm.title) === suffix &&
      titleUsesConfiguredLeaf(sm.title, leaf),
  );
  if (hits.length === 0) return undefined;
  return pickBestStrapiMantraRefForLink(hits, preferredDocId);
}

export interface ResolvePortalMantraStrapiOptions {
  configuredLeaf: string;
  /** Fallback only when `sectionMantras` is empty (legacy / no section context). */
  byExactTitle?: Map<string, string>;
  sectionMantras: StrapiMantraRef[];
  byOrder: Map<number, StrapiMantraRef>;
  ambiguousOrders: Set<number>;
}

/**
 * Map a portal mantra node to the correct Strapi documentId.
 * Only matches Strapi rows with the same configured leaf + verse number (never Mantra ↔ Shloka).
 */
export function resolvePortalMantraToStrapiDoc(
  portal: { title?: string; order?: number; strapiDocumentId?: string },
  opts: ResolvePortalMantraStrapiOptions,
): { docId: string | undefined } | undefined {
  const { configuredLeaf, byExactTitle, sectionMantras, byOrder, ambiguousOrders } = opts;
  const leaf = (configuredLeaf || "Mantra").trim();

  if (portal.title) {
    const exactInSection = findStrapiMantraByExactTitleInSection(
      sectionMantras,
      portal.title,
      portal.strapiDocumentId,
    );
    if (exactInSection) {
      return { docId: exactInSection.docId };
    }
    if (sectionMantras.length === 0 && byExactTitle?.has(portal.title)) {
      return { docId: byExactTitle.get(portal.title)! };
    }
  }

  const byLeafAndSuffix = portal.title
    ? findStrapiMantraByLeafAndSuffix(
        sectionMantras,
        portal.title,
        leaf,
        portal.strapiDocumentId,
      )
    : undefined;

  if (byLeafAndSuffix) {
    if (!portal.strapiDocumentId || portal.strapiDocumentId !== byLeafAndSuffix.docId) {
      return { docId: byLeafAndSuffix.docId };
    }
    return { docId: byLeafAndSuffix.docId };
  }

  if (portal.strapiDocumentId) {
    const sm = sectionMantras.find((s) => s.docId === portal.strapiDocumentId);
    if (sm) {
      if (
        !portal.title ||
        (portal.title.trim().toLowerCase() === sm.title.trim().toLowerCase()) ||
        mantrasShareLeafAndSuffix(portal.title, sm.title, leaf)
      ) {
        return { docId: portal.strapiDocumentId };
      }
      return { docId: undefined };
    }
    if (
      portal.order != null &&
      isStrapiFractionalSortKey(portal.order) &&
      !ambiguousOrders.has(portal.order) &&
      byOrder.has(portal.order)
    ) {
      const remapped = byOrder.get(portal.order)!;
      if (titleUsesConfiguredLeaf(remapped.title, leaf)) {
        return { docId: remapped.docId };
      }
      return { docId: undefined };
    }
    return { docId: undefined };
  }

  if (
    portal.order != null &&
    isStrapiFractionalSortKey(portal.order) &&
    !ambiguousOrders.has(portal.order) &&
    byOrder.has(portal.order)
  ) {
    const sm = byOrder.get(portal.order)!;
    if (titleUsesConfiguredLeaf(sm.title, leaf)) {
      return { docId: sm.docId };
    }
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

/** Drop duplicate portal rows (same id or same Strapi documentId) before renumbering. */
export function dedupeMantrasInDisplayOrder<T extends { id: string; strapiDocumentId?: string }>(
  manthrasInDisplayOrder: T[],
): T[] {
  const seenIds = new Set<string>();
  const seenDocIds = new Set<string>();
  const out: T[] = [];
  for (const m of manthrasInDisplayOrder) {
    if (m.id && seenIds.has(m.id)) continue;
    const docId = (m.strapiDocumentId ?? "").trim();
    if (docId.length >= STRAPI_DOCUMENT_ID_MIN_LENGTH && seenDocIds.has(docId)) continue;
    if (m.id) seenIds.add(m.id);
    if (docId.length >= STRAPI_DOCUMENT_ID_MIN_LENGTH) seenDocIds.add(docId);
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
 */
export function reindexMantrasInListOrder<T extends { id: string; title: string; order: number }>(
  manthrasInDisplayOrder: T[],
  ctx: MantraTitleCtx,
): T[] {
  return assignContiguousOrderAndTitles(manthrasInDisplayOrder, ctx);
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

/**
 * Persist/save prep: sort sections, fix contiguous `order`, dedupe linked rows — **without**
 * rewriting ShlokaManthraNumber titles. Verse labels change only via explicit renumber or
 * "Sync verse numbers to CMS".
 */
export function prepareHierarchyForSave<T extends SyncAdhyayaNode>(
  list: T[],
  cfg: GranthaStructureConfig,
): T[] {
  const levelThree = !!cfg.levelThreeEnabled;

  return sortNodesByOrder(list).map((a, ai) => {
    const khandas = sortNodesByOrder(a.khandas ?? []).map((k, ki) => {
      if (levelThree && (k.padas ?? []).length > 0) {
        const padas = sortNodesByOrder(k.padas ?? []).map((p, pi) => ({
          ...p,
          order: pi + 1,
          manthras: reindexMantraOrdersPreservingTitles(
            dedupeMantrasInDisplayOrder(sortMantrasByDisplayOrder(p.manthras ?? [])),
          ),
        }));
        return { ...k, order: ki + 1, padas, manthras: [] as SyncManthraNode[] };
      }
      return {
        ...k,
        order: ki + 1,
        padas: [] as SyncPadaNode[],
        manthras: reindexMantraOrdersPreservingTitles(
          dedupeMantrasInDisplayOrder(sortMantrasByDisplayOrder(k.manthras ?? [])),
        ),
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
 * Sanskrit ordinals used for default section labels in the portal editor.
 * Keep in sync with `ORDINALS` in `client/src/pages/granthas.tsx`.
 */
const PORTAL_SECTION_ORDINALS = [
  "Prathama",
  "Dvitiya",
  "Tritiya",
  "Chaturtha",
  "Panchama",
  "Shashthi",
  "Saptama",
  "Ashtama",
  "Navama",
  "Dashama",
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
  const ordAlt = PORTAL_SECTION_ORDINALS.join("|");
  const re = new RegExp(`^(?:${ordAlt}|\\d+)\\s+${escapeRegExp(name)}\\s*$`, "i");
  if (!re.test(t)) return t;
  return `${editorOrdinalLabel(position1Based)} ${name}`;
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
    const totalScore = score + orderBonus + emptyPenalty;
    const prev = byKey.get(key);
    if (!prev || totalScore > prev.score) byKey.set(key, { row: m, score: totalScore });
  }
  return [...byKey.values()].map((v) => v.row);
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
