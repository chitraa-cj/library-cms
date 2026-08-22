// Short-TTL in-memory cache for the three heavy "bulk" grantha-editor GETs:
//   - sections/by-grantha/:granthaDocId   (kind "sections")
//   - manthras/teekas-by-grantha/:granthaDocId  (kind "teekas")
//   - manthras/full-by-grantha/:granthaDocId    (kind "full")
//
// These are re-fetched on every editor open and are the dominant cost for large
// granthas (Gita ~700 verses, Chandogya with 43 languages/verse). Caching the
// computed response envelope makes repeat opens within the TTL instant.
//
// CORRECTNESS: the cache must be busted whenever that grantha's mantras/sections
// are written or published, otherwise the editor would show stale content. Every
// write site calls invalidateGranthaBulkCache(granthaDocId). Writes in strapi.ts
// that only know a section documentId use invalidateBySectionDocId() (resolved via
// the section→grantha index populated when sections/by-grantha builds its response).
// When a write cannot be mapped to a grantha, callers fall back to
// invalidateAllBulkCache() — always prefer a full flush over serving stale data.
//
// This cache is per-process. If the app runs as multiple instances, another
// instance's write will not invalidate this instance's cache; the short TTL bounds
// that staleness. Mirrors the sectionReadCache precedent in routes.ts.

type BulkKind = "sections" | "teekas" | "full";

// Sections change rarely mid-session but structural inserts must show up quickly;
// full/teekas content is heavier and edited less often, so a slightly longer TTL is
// fine. Invalidation (below) is the authoritative freshness mechanism; TTL is only a
// backstop for out-of-band Strapi edits the server never observes.
const TTL_MS: Record<BulkKind, number> = {
  sections: 30 * 1000,
  teekas: 60 * 1000,
  full: 60 * 1000,
};

const MAX_ENTRIES = 128;

const cache = new Map<string, { at: number; data: unknown }>();

/** sectionDocId → granthaDocId, learned from sections/by-grantha responses. */
const sectionToGrantha = new Map<string, string>();

function keyFor(kind: BulkKind, granthaDocId: string): string {
  return `${kind}:${granthaDocId}`;
}

export function getBulkCache<T>(kind: BulkKind, granthaDocId: string): T | undefined {
  if (!granthaDocId) return undefined;
  const hit = cache.get(keyFor(kind, granthaDocId));
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL_MS[kind]) {
    cache.delete(keyFor(kind, granthaDocId));
    return undefined;
  }
  return hit.data as T;
}

export function setBulkCache<T>(kind: BulkKind, granthaDocId: string, data: T): T {
  if (!granthaDocId) return data;
  cache.set(keyFor(kind, granthaDocId), { at: Date.now(), data });
  if (cache.size > MAX_ENTRIES) {
    // Drop oldest ~quarter to bound growth on long-running servers.
    const keys = [...cache.keys()].slice(0, Math.ceil(MAX_ENTRIES / 4));
    for (const k of keys) cache.delete(k);
  }
  return data;
}

/** Record which grantha a section belongs to so section-scoped writes can invalidate. */
export function rememberSectionGrantha(sectionDocId: string, granthaDocId: string): void {
  if (!sectionDocId || !granthaDocId) return;
  sectionToGrantha.set(sectionDocId, granthaDocId);
  if (sectionToGrantha.size > 20000) {
    const keys = [...sectionToGrantha.keys()].slice(0, 5000);
    for (const k of keys) sectionToGrantha.delete(k);
  }
}

/** Drop all three kinds for one grantha. Call after any write to that grantha. */
export function invalidateGranthaBulkCache(granthaDocId: string): void {
  if (!granthaDocId) return;
  for (const kind of ["sections", "teekas", "full"] as BulkKind[]) {
    cache.delete(keyFor(kind, granthaDocId));
  }
}

/**
 * Invalidate by section documentId. Resolves the grantha via the section→grantha
 * index; if unknown, flushes everything (correctness over granularity).
 * Returns true if it resolved to a specific grantha, false if it full-flushed.
 */
export function invalidateBySectionDocId(sectionDocId: string): boolean {
  if (!sectionDocId) return false;
  const granthaDocId = sectionToGrantha.get(sectionDocId);
  if (granthaDocId) {
    invalidateGranthaBulkCache(granthaDocId);
    return true;
  }
  invalidateAllBulkCache();
  return false;
}

/** Nuclear flush — used when a write cannot be mapped to a grantha. */
export function invalidateAllBulkCache(): void {
  cache.clear();
}
