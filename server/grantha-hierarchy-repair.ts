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
  const changed = JSON.stringify(hierarchy) !== JSON.stringify(repaired);
  if (changed) {
    hierarchy.splice(0, hierarchy.length, ...(repaired as unknown[]));
  }
  return changed;
}
