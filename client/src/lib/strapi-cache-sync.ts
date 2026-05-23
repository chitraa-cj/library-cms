import type { QueryClient } from "@tanstack/react-query";

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

/**
 * After grantha publish, mantra publish, section hierarchy sync, or Strapi edits:
 * invalidate all CMS queries and refetch active tab lists so Granthas / Mantras / Sections
 * show the same data without waiting for the poll interval.
 */
export async function syncGranthaCmsCaches(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ["/api/strapi"] });
  for (const key of DRAFT_LIST_KEYS) {
    void queryClient.invalidateQueries({ queryKey: [...key] });
  }
  await Promise.all(
    STRAPI_LIST_KEYS.map((key) =>
      queryClient.refetchQueries({ queryKey: [...key], type: "active" }),
    ),
  );
}

/** @deprecated Prefer `syncGranthaCmsCaches` (same behavior; refetches active lists). */
export function invalidateGranthaCmsCaches(queryClient: QueryClient): void {
  void syncGranthaCmsCaches(queryClient);
}
