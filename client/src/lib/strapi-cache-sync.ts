import type { QueryClient } from "@tanstack/react-query";

/** Invalidate Strapi list queries so Granthas / Sections / Mantras tabs show the same data. */
export function invalidateGranthaCmsCaches(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ["/api/strapi", "manthras"] });
  void queryClient.invalidateQueries({ queryKey: ["/api/strapi", "sections"] });
  void queryClient.invalidateQueries({ queryKey: ["/api/strapi", "granthas"] });
}
