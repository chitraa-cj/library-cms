import type { QueryClient } from "@tanstack/react-query";
import { invalidateManthraCache } from "@/lib/mantra-cms-cache";

const STRAPI_LIST_KEYS = [
  ["/api/strapi", "manthras"],
  ["/api/strapi", "sections"],
  ["/api/strapi", "granthas"],
  ["/api/strapi", "teekas"],
] as const;

const DRAFT_LIST_KEYS = [
  ["/api/drafts", "granthas"],
  ["/api/drafts", "manthras"],
  ["/api/drafts", "sections"],
] as const;

export type SyncGranthaCmsCachesOptions = {
  /** When false, only invalidate (tabs refresh on next focus/poll). Default true. */
  refetchActive?: boolean;
};

/**
 * After grantha publish or Strapi edits: invalidate CMS queries. Refetch runs in the
 * background so Save & Publish is not blocked on large Mantras/Sections list downloads.
 */
export function syncGranthaCmsCaches(
  queryClient: QueryClient,
  options?: SyncGranthaCmsCachesOptions,
): void {
  invalidateManthraCache();
  const refetchActive = options?.refetchActive !== false;
  void (async () => {
    await queryClient.invalidateQueries({ queryKey: ["/api/strapi"] });
    for (const key of DRAFT_LIST_KEYS) {
      void queryClient.invalidateQueries({ queryKey: [...key] });
    }
    void queryClient.invalidateQueries({ queryKey: ["/api/cms/manthras-unified"] });
    if (!refetchActive) return;
    for (const key of STRAPI_LIST_KEYS) {
      void queryClient.refetchQueries({ queryKey: [...key], type: "active" });
    }
  })();
}

/** Fast path after bulk publish: invalidate only (no large list refetch). */
export function invalidateGranthaCmsCaches(queryClient: QueryClient): void {
  syncGranthaCmsCaches(queryClient, { refetchActive: false });
}
