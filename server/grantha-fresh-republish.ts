import { strapiRequest } from "./strapi";

/** Remove Strapi document links so publish creates a fresh CMS tree from portal draft content. */
export function stripHierarchyStrapiLinksForFreshPublish(hierarchy: any[]): any[] {
  const stripManthra = (m: any) => {
    const { strapiDocumentId: _s, _isNewLocal: _n, ...rest } = m;
    return rest;
  };
  return hierarchy.map((adhyaya) => ({
    ...adhyaya,
    documentId: undefined,
    khandas: (adhyaya.khandas ?? []).map((khanda: any) => ({
      ...khanda,
      documentId: undefined,
      manthras: (khanda.manthras ?? []).map(stripManthra),
      padas: (khanda.padas ?? []).map((pada: any) => ({
        ...pada,
        documentId: undefined,
        manthras: (pada.manthras ?? []).map(stripManthra),
      })),
    })),
  }));
}

async function listDocIdsByGranthaFilter(
  apiPath: "manthras" | "sections",
  granthaDocId: string,
): Promise<string[]> {
  const g = encodeURIComponent(granthaDocId);
  const filter =
    apiPath === "manthras"
      ? `filters[Section][grantha][documentId][$eq]=${g}`
      : `filters[grantha][documentId][$eq]=${g}`;
  const all: string[] = [];
  let page = 1;
  while (true) {
    const r = await strapiRequest(
      `/api/${apiPath}?${filter}&fields[0]=documentId&pagination[pageSize]=100&pagination[page]=${page}`,
    );
    for (const row of r.data ?? []) {
      if (typeof row.documentId === "string" && row.documentId.length >= 10) {
        all.push(row.documentId);
      }
    }
    if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  return all;
}

/** Best-effort delete of an entire grantha tree (mantras → sections → grantha). */
export async function deleteGranthaTreeFromStrapi(
  granthaDocId: string,
  onDelete?: (kind: "manthra" | "section" | "grantha", docId: string) => void,
): Promise<{ failedManthras: string[]; failedSections: string[]; granthaDeleted: boolean }> {
  const failedManthras: string[] = [];
  const failedSections: string[] = [];
  const DELETE_CONCURRENCY = 8;

  const runDeletes = async (
    docIds: string[],
    apiPath: "manthras" | "sections",
    failedSink: string[],
  ) => {
    for (let i = 0; i < docIds.length; i += DELETE_CONCURRENCY) {
      const batch = docIds.slice(i, i + DELETE_CONCURRENCY);
      await Promise.all(
        batch.map(async (docId) => {
          try {
            await strapiRequest(`/api/${apiPath}/${docId}`, { method: "DELETE" });
            onDelete?.(apiPath === "manthras" ? "manthra" : "section", docId);
          } catch (e: any) {
            if (e?.status === 404) return;
            failedSink.push(docId);
          }
        }),
      );
    }
  };

  const mantraDocIds = await listDocIdsByGranthaFilter("manthras", granthaDocId);
  await runDeletes(mantraDocIds, "manthras", failedManthras);

  const sectionDocIds = await listDocIdsByGranthaFilter("sections", granthaDocId);
  await runDeletes(sectionDocIds, "sections", failedSections);

  let granthaDeleted = false;
  try {
    await strapiRequest(`/api/granthas/${granthaDocId}`, { method: "DELETE" });
    onDelete?.("grantha", granthaDocId);
    granthaDeleted = true;
  } catch (e: any) {
    if (e?.status === 404) granthaDeleted = true;
  }

  return { failedManthras, failedSections, granthaDeleted };
}
