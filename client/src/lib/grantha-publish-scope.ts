/**
 * Tracks what must be published when saving a grantha:
 * - Incremental: only verse content on specific mantra nodes (fast path).
 * - Full: hierarchy, sections, grantha metadata, teekas, or deletions changed.
 */

export type GranthaPublishScope = {
  changedManthraIds: string[];
  requiresFullPublish: boolean;
  granthaMetaDirty: boolean;
};

export type GranthaPublishStrategy = "full" | "incremental" | "none";

export function emptyPublishScope(): GranthaPublishScope {
  return {
    changedManthraIds: [],
    requiresFullPublish: false,
    granthaMetaDirty: false,
  };
}

export function parsePublishScopeFromDraft(data: unknown): GranthaPublishScope {
  const raw = (data as { publishScope?: Partial<GranthaPublishScope> } | null)?.publishScope;
  if (!raw || typeof raw !== "object") return emptyPublishScope();
  return {
    changedManthraIds: Array.isArray(raw.changedManthraIds)
      ? raw.changedManthraIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [],
    requiresFullPublish: raw.requiresFullPublish === true,
    granthaMetaDirty: raw.granthaMetaDirty === true,
  };
}

export function resolveGranthaPublishStrategy(
  scope: GranthaPublishScope,
  options: {
    hasPublishedGrantha: boolean;
    hasPendingDeletions: boolean;
  },
): GranthaPublishStrategy {
  if (!options.hasPublishedGrantha) return "full";
  if (options.hasPendingDeletions || scope.requiresFullPublish || scope.granthaMetaDirty) {
    return "full";
  }
  if (scope.changedManthraIds.length > 0) return "incremental";
  return "none";
}

export type ManthraPublishTarget = {
  adhyayaId: string;
  khandaId: string;
  padaId?: string;
  manthraId: string;
};

/** Resolve local mantra ids to hierarchy paths for batch CMS publish. */
export function collectManthraPublishTargets(
  hierarchy: Array<{
    id: string;
    khandas?: Array<{
      id: string;
      manthras?: Array<{ id: string }>;
      padas?: Array<{ id: string; manthras?: Array<{ id: string }> }>;
    }>;
  }>,
  manthraIds: Iterable<string>,
): ManthraPublishTarget[] {
  const wanted = new Set(manthraIds);
  if (wanted.size === 0) return [];
  const out: ManthraPublishTarget[] = [];
  for (const a of hierarchy) {
    for (const k of a.khandas ?? []) {
      for (const m of k.manthras ?? []) {
        if (wanted.has(m.id)) {
          out.push({ adhyayaId: a.id, khandaId: k.id, manthraId: m.id });
          wanted.delete(m.id);
        }
      }
      for (const p of k.padas ?? []) {
        for (const m of p.manthras ?? []) {
          if (wanted.has(m.id)) {
            out.push({ adhyayaId: a.id, khandaId: k.id, padaId: p.id, manthraId: m.id });
            wanted.delete(m.id);
          }
        }
      }
    }
  }
  return out;
}
