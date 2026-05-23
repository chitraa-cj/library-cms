/**
 * Pure helpers for Grantha hierarchy ↔ structure config alignment.
 * Kept out of the page component so async loaders (e.g. openEdit) can run
 * the same normalization as the wizard "Next" step without ordering bugs.
 */

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
export type StrapiMantraRef = { title: string; docId: string; order: number };

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

export function findStrapiMantraByLeafAndSuffix(
  mantras: StrapiMantraRef[],
  portalTitle: string | undefined,
  configuredLeaf: string,
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
  return hits.length === 1 ? hits[0] : undefined;
}

export interface ResolvePortalMantraStrapiOptions {
  configuredLeaf: string;
  byExactTitle: Map<string, string>;
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

  if (portal.title && byExactTitle.has(portal.title)) {
    return { docId: byExactTitle.get(portal.title)! };
  }

  const byLeafAndSuffix = portal.title
    ? findStrapiMantraByLeafAndSuffix(sectionMantras, portal.title, leaf)
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

function assignContiguousOrderAndTitles<T extends { id: string; title: string; order: number }>(
  manthrasInDisplayOrder: T[],
  ctx: MantraTitleCtx,
): T[] {
  return manthrasInDisplayOrder.map((m, idx) => {
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
  return assignContiguousOrderAndTitles(sortNodesByOrder(manthras), ctx);
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
  return sortNodesByOrder(manthras ?? []).map((m, idx) => ({
    ...m,
    order: idx + 1,
  }));
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
          const manthras = reindexMantrasInListOrder(sortNodesByOrder(p.manthras ?? []), ctx);
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
      const manthras = reindexMantrasInListOrder(sortNodesByOrder(k.manthras ?? []), ctx);
      return { ...k, order: ki + 1, title: khandaTitle, padas: [], manthras };
    });

    return { ...a, order: aIdx, title: adhyayaTitle, khandas } as T;
  });
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
