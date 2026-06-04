import { isBlankMantraLabel } from "@shared/mantra-cms-guard";
import { strapiRequest } from "./strapi";

export type OrphanMantraRow = {
  documentId: string;
  order: number;
  ShlokaManthraNumber?: string;
  sectionDocumentId?: string;
  sectionTitle?: string;
};

export function isOrphanMantraRow(row: {
  ShlokaManthraNumber?: string | null;
  ShlokaManthraEntry?: unknown;
}): boolean {
  return isBlankMantraLabel(row.ShlokaManthraNumber);
}

/** List mantras under a grantha with blank ShlokaManthraNumber (Mantras tab "No number"). */
export async function listOrphanMantrasForGrantha(granthaDocId: string): Promise<OrphanMantraRow[]> {
  const g = encodeURIComponent(granthaDocId);
  const orphans: OrphanMantraRow[] = [];
  let page = 1;
  while (true) {
    const r = await strapiRequest(
      `/api/manthras?filters[Section][grantha][documentId][$eq]=${g}` +
        `&fields[0]=documentId&fields[1]=order&fields[2]=ShlokaManthraNumber` +
        `&populate[Section][fields][0]=documentId&populate[Section][fields][1]=title` +
        `&pagination[pageSize]=100&pagination[page]=${page}`,
    );
    for (const row of r.data ?? []) {
      if (!isOrphanMantraRow(row)) continue;
      orphans.push({
        documentId: row.documentId,
        order: typeof row.order === "number" ? row.order : 0,
        ShlokaManthraNumber: row.ShlokaManthraNumber,
        sectionDocumentId: row.Section?.documentId,
        sectionTitle: row.Section?.title,
      });
    }
    if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  return orphans;
}

export async function deleteOrphanMantrasForGrantha(
  granthaDocId: string,
  opts?: { dryRun?: boolean },
): Promise<{ deleted: string[]; failed: string[]; orphans: OrphanMantraRow[] }> {
  const orphans = await listOrphanMantrasForGrantha(granthaDocId);
  const deleted: string[] = [];
  const failed: string[] = [];
  if (opts?.dryRun) {
    return { deleted, failed, orphans };
  }
  for (const row of orphans) {
    try {
      await strapiRequest(`/api/manthras/${row.documentId}`, { method: "DELETE" });
      deleted.push(row.documentId);
    } catch (e: any) {
      if (e?.status === 404) {
        deleted.push(row.documentId);
      } else {
        failed.push(row.documentId);
      }
    }
  }
  return { deleted, failed, orphans };
}
