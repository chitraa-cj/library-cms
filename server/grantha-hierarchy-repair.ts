import { normalizeHierarchyMantraLeafTitles } from "@shared/grantha-publish-integrity";
import {
  normalizeEditorHierarchy,
  type GranthaStructureConfig,
} from "../client/src/lib/grantha-structure-sync";

/** Re-sort sections, reindex mantra titles/orders, and clear legacy khanda rows when L3 padas exist. */
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

/** Mutate `hierarchy` in place when repair changes verse labels or structure. Returns whether it changed. */
export function applyHierarchyRepairInPlace(
  hierarchy: unknown[],
  structureConfig: Record<string, unknown> | undefined,
  configuredLeaf: string,
): boolean {
  const repaired = repairGranthaHierarchyForPublish(hierarchy, structureConfig, configuredLeaf);
  const changed = JSON.stringify(hierarchy) !== JSON.stringify(repaired);
  if (changed) {
    hierarchy.splice(0, hierarchy.length, ...(repaired as unknown[]));
  }
  return changed;
}
