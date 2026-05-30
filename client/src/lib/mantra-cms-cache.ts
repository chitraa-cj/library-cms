import type { ResolvedManthraDetail } from "@/lib/resolve-strapi-mantra-detail";

const TTL_MS = 60 * 1000;
const cache = new Map<string, { at: number; value: ResolvedManthraDetail }>();
/** Per documentId — bumped on invalidate / explicit set so stale in-flight loads cannot write. */
const docVersion = new Map<string, number>();
const inFlight = new Map<string, Promise<ResolvedManthraDetail>>();

function getDocVersion(documentId: string): number {
  return docVersion.get(documentId) ?? 0;
}

function bumpDocVersion(documentId: string): void {
  docVersion.set(documentId, getDocVersion(documentId) + 1);
}

function storeCachedManthraDetail(documentId: string, value: ResolvedManthraDetail): void {
  if (!documentId) return;
  cache.set(documentId, { at: Date.now(), value });
}

export function getCachedManthraDetail(documentId: string): ResolvedManthraDetail | undefined {
  const row = cache.get(documentId);
  if (!row) return undefined;
  if (Date.now() - row.at > TTL_MS) {
    cache.delete(documentId);
    return undefined;
  }
  return row.value;
}

/** Authoritative write (e.g. resolve-for-edit); bumps version so older in-flight GETs are ignored. */
export function setCachedManthraDetail(documentId: string, value: ResolvedManthraDetail): void {
  storeCachedManthraDetail(documentId, value);
  bumpDocVersion(documentId);
}

export function invalidateManthraCache(documentId?: string): void {
  if (documentId) {
    cache.delete(documentId);
    inFlight.delete(documentId);
    bumpDocVersion(documentId);
  } else {
    cache.clear();
    inFlight.clear();
    docVersion.clear();
  }
}

/** After resolve-for-edit swaps duplicate links, drop the stale preferred id entry. */
export function invalidateManthraCacheOnDocIdCorrection(
  preferredDocId: string | undefined,
  resolvedDocId: string,
  corrected?: boolean,
): void {
  if (corrected && preferredDocId && preferredDocId !== resolvedDocId) {
    invalidateManthraCache(preferredDocId);
  }
}

export async function fetchManthraDetailCached(
  documentId: string,
  loader: () => Promise<ResolvedManthraDetail>,
  options?: { bypassCache?: boolean },
): Promise<ResolvedManthraDetail> {
  if (!options?.bypassCache) {
    const hit = getCachedManthraDetail(documentId);
    if (hit) return hit;
  }

  const pending = inFlight.get(documentId);
  if (pending) return pending;

  const versionAtStart = getDocVersion(documentId);
  const promise = loader()
    .then((value) => {
      if (getDocVersion(documentId) === versionAtStart) {
        storeCachedManthraDetail(documentId, value);
      }
      return value;
    })
    .finally(() => {
      if (inFlight.get(documentId) === promise) {
        inFlight.delete(documentId);
      }
    });

  inFlight.set(documentId, promise);
  return promise;
}
