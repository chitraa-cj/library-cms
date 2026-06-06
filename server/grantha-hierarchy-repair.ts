import { normalizeHierarchyMantraLeafTitles } from "@shared/grantha-publish-integrity";
import {
  normalizeEditorHierarchy,
  prepareHierarchyForSave,
  type GranthaStructureConfig,
} from "../client/src/lib/grantha-structure-sync";

/** Re-sort sections and reindex mantra titles/orders (explicit renumber / delete-with-renumber). */
export function repairGranthaHierarchyForPublish(
  hierarchy: unknown[],
  structureConfig: Record<string, unknown> | undefined,
  configuredLeaf: string,
): unknown[] {
  const cfg = (structureConfig ?? {}) as GranthaStructureConfig;
  const cloned = JSON.parse(JSON.stringify(hierarchy)) as unknown[];
  normalizeHierarchyMantraLeafTitles(cloned, configuredLeaf);
  return normalizeEditorHierarchy(cloned as Parameters<typeof normalizeEditorHierarchy>[0], cfg);
}

/** Sort sections, dedupe rows, fix `order` — keep existing verse labels unchanged. */
export function repairGranthaHierarchyPreservingVerseLabels(
  hierarchy: unknown[],
  structureConfig: Record<string, unknown> | undefined,
  configuredLeaf: string,
): unknown[] {
  const cfg = (structureConfig ?? {}) as GranthaStructureConfig;
  const cloned = JSON.parse(JSON.stringify(hierarchy)) as unknown[];
  normalizeHierarchyMantraLeafTitles(cloned, configuredLeaf);
  return prepareHierarchyForSave(cloned as Parameters<typeof prepareHierarchyForSave>[0], cfg);
}

export type HierarchyRepairOptions = {
  /** When true, rewrite all verse labels from hierarchy position (delete-with-renumber / approved publish). */
  renumberVerseLabels?: boolean;
};

type RepairMantraNode = {
  strapiDocumentId?: string;
  _isNewLocal?: boolean;
  BhashyamForShlokaManthra?: unknown;
  Teekas?: unknown;
};

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Enforce the invariant that no two verse nodes link to the same Strapi documentId.
 *
 * An insert renumber can momentarily make a freshly inserted verse share a neighbor's verse
 * suffix; a tree-wide CMS patch then grafts that neighbor's `strapiDocumentId` (and its
 * bhashyam/teeka) onto the new verse. On publish that overwrites the neighbor's row AND makes
 * the inserted verse show a bhashyam the user never added (the Vivekachudamani "+ verse shows
 * bhashyam" bug). The grafted docId can belong to either the PREVIOUS or the NEXT verse, so a
 * positional "keep the first node" rule picks the wrong owner. Instead, for each shared docId we
 * keep the link on the original verse — the node that is NOT `_isNewLocal` (an inserted verse is
 * the interloper); only if that is ambiguous do we fall back to the first node in document order.
 * Every other node sharing that docId is reset to a brand-new local insert (drop the link → it
 * gets its own fresh CMS row on publish). When a reset node's bhashyam/teeka is byte-identical to
 * the keeper's it was grafted from the shared row, so we clear it too. Returns the number of
 * nodes repaired.
 */
export function dedupeMantraStrapiDocIdsInPlace(hierarchy: unknown[]): number {
  // Pass 1: group every node by its linked docId, in document order.
  const byDocId = new Map<string, RepairMantraNode[]>();
  const visit = (m: RepairMantraNode | undefined) => {
    if (!m) return;
    const docId = m.strapiDocumentId;
    if (typeof docId !== "string" || docId.length < 10) return;
    const list = byDocId.get(docId);
    if (list) list.push(m);
    else byDocId.set(docId, [m]);
  };
  for (const a of (hierarchy as any[]) ?? []) {
    for (const k of a?.khandas ?? []) {
      for (const m of k?.manthras ?? []) visit(m);
      for (const p of k?.padas ?? []) {
        for (const m of p?.manthras ?? []) visit(m);
      }
    }
  }

  // Pass 2: for each docId shared by 2+ nodes, keep the original verse and reset the rest.
  let repaired = 0;
  for (const nodes of byDocId.values()) {
    if (nodes.length < 2) continue;
    const keeper = nodes.find((n) => n._isNewLocal !== true) ?? nodes[0];
    for (const m of nodes) {
      if (m === keeper) continue;
      delete m.strapiDocumentId;
      m._isNewLocal = true;
      if (jsonEqual(m.BhashyamForShlokaManthra, keeper.BhashyamForShlokaManthra)) {
        delete (m as Record<string, unknown>).BhashyamForShlokaManthra;
      }
      if (jsonEqual(m.Teekas, keeper.Teekas)) {
        delete (m as Record<string, unknown>).Teekas;
      }
      repaired++;
    }
  }
  return repaired;
}

/** Mutate `hierarchy` in place when repair changes structure. Returns whether it changed. */
export function applyHierarchyRepairInPlace(
  hierarchy: unknown[],
  structureConfig: Record<string, unknown> | undefined,
  configuredLeaf: string,
  opts?: HierarchyRepairOptions,
): boolean {
  const repaired = opts?.renumberVerseLabels
    ? repairGranthaHierarchyForPublish(hierarchy, structureConfig, configuredLeaf)
    : repairGranthaHierarchyPreservingVerseLabels(hierarchy, structureConfig, configuredLeaf);
  let changed = JSON.stringify(hierarchy) !== JSON.stringify(repaired);
  if (changed) {
    hierarchy.splice(0, hierarchy.length, ...(repaired as unknown[]));
  }
  // Run after the structural sort so nodes are in document order: the first occurrence of a
  // shared documentId (the original verse) keeps the link; later duplicates (inserted verses
  // that grafted a neighbor's link) are reset to fresh local rows.
  if (dedupeMantraStrapiDocIdsInPlace(hierarchy) > 0) changed = true;
  return changed;
}
