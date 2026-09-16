// Short-TTL, stale-while-revalidate cache for the heavy top-level LIST endpoints
// (/api/strapi/manthras, /api/strapi/granthas, /api/strapi/teekas, …).
//
// WHY: those tabs re-fetch the ENTIRE collection from Strapi over REST on every
// open — plus a 30s poll — and the manthras/granthas lists deep-populate every row,
// which the code's own comments measure at 6–19s per grantha-worth. That is the
// dominant cause of the >2-minute Granthas/Mantras tab loads. Caching the computed
// response envelope makes every load after the first instant.
//
// STALE-WHILE-REVALIDATE: once an entry ages past its TTL we still return it
// immediately and kick off ONE background refresh, so a request never blocks on the
// slow producer once the cache is warm. A failed refresh keeps serving the last-good
// value rather than surfacing an error.
//
// CORRECTNESS: writes must drop the affected key so the next read reflects them.
// Manthra/section/grantha writes flow through invalidateAllBulkCache()/
// invalidateGranthaBulkCache() (grantha-bulk-cache.ts), which also clear this cache;
// direct content-type writes (teekas, etc.) call invalidateListCache(key) themselves.
// The short TTL is only a backstop for out-of-band Strapi edits the server never sees.
//
// Per-process, like grantha-bulk-cache.ts: another instance's write won't invalidate
// this instance, but the TTL bounds that staleness.

type Entry = { at: number; data: unknown; refreshing: boolean };

const cache = new Map<string, Entry>();

/**
 * Return the cached value for `key` if present (serving stale + refreshing in the
 * background once past `ttlMs`), otherwise run `producer`, cache, and return it.
 * The first (cold) call awaits the producer; every later call is served from memory.
 */
export async function cachedList<T>(
  key: string,
  ttlMs: number,
  producer: () => Promise<T>,
): Promise<T> {
  const hit = cache.get(key);
  const now = Date.now();

  if (hit) {
    const stale = now - hit.at > ttlMs;
    if (stale && !hit.refreshing) {
      hit.refreshing = true;
      // Fire-and-forget: keep serving the current value while this refreshes.
      void producer()
        .then((data) => cache.set(key, { at: Date.now(), data, refreshing: false }))
        .catch(() => {
          const e = cache.get(key);
          if (e) e.refreshing = false; // keep last-good value on failure
        });
    }
    return hit.data as T;
  }

  const data = await producer();
  cache.set(key, { at: Date.now(), data, refreshing: false });
  return data;
}

/** Drop one key (pass none to flush everything). Call on any write to that list. */
export function invalidateListCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}
