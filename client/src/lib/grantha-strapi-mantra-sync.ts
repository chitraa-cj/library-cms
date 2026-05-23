import { apiRequest, ApiError } from "@/lib/queryClient";
import { sortNodesByOrder, isPublishedStrapiDocId, type GranthaStructureConfig } from "@/lib/grantha-structure-sync";

/** Minimal hierarchy snapshot for Strapi section + mantra identity sync. */
export type ManthraSnap = {
  id: string;
  title: string;
  order: number;
  strapiDocumentId?: string;
};

export type SnapshotAdhyaya = {
  id: string;
  title: string;
  order?: number;
  documentId?: string;
  khandas: {
    id: string;
    title: string;
    order?: number;
    documentId?: string;
    padas?: { id: string; title: string; order?: number; documentId?: string; manthras: ManthraSnap[] }[];
    manthras: ManthraSnap[];
  }[];
};

/**
 * Strapi section documentId that owns mantras in the editor tree — mirrors publish
 * (`server/routes.ts`): L3 → pada; default khanda → adhyaya; else khanda.
 */
export function resolveMantraSectionStrapiDocumentId(
  snapshot: SnapshotAdhyaya[],
  adhyayaId: string,
  khandaId: string,
  padaId: string | undefined,
  cfg: GranthaStructureConfig,
): string | undefined {
  const a = snapshot.find((x) => x.id === adhyayaId);
  const k = a?.khandas.find((x) => x.id === khandaId);
  if (!a || !k) return undefined;
  const levelThree = !!cfg.levelThreeEnabled;
  const levelTwo = cfg.levelTwoEnabled !== false;
  if (levelThree && padaId) {
    const p = k.padas?.find((x) => x.id === padaId);
    const d = p?.documentId;
    return isPublishedStrapiDocId(d) ? d : undefined;
  }
  const isDefault = k.title === "_default" || !levelTwo;
  if (isDefault) {
    const d = a.documentId;
    return isPublishedStrapiDocId(d) ? d : undefined;
  }
  const d = k.documentId;
  return isPublishedStrapiDocId(d) ? d : undefined;
}

export function getSortedMantrasFromSnapshot(
  snapshot: SnapshotAdhyaya[],
  adhyayaId: string,
  khandaId: string,
  padaId: string | undefined,
  cfg: GranthaStructureConfig,
): ManthraSnap[] {
  const a = snapshot.find((x) => x.id === adhyayaId);
  const k = a?.khandas.find((x) => x.id === khandaId);
  if (!a || !k) return [];
  if (cfg.levelThreeEnabled && padaId) {
    const p = k.padas?.find((x) => x.id === padaId);
    return sortNodesByOrder(p?.manthras ?? []);
  }
  return sortNodesByOrder(k.manthras ?? []);
}

export function mergeMantraStrapiDocumentIds<T extends SnapshotAdhyaya>(
  snapshot: T[],
  adhyayaId: string,
  khandaId: string,
  padaId: string | undefined,
  patches: Array<{ manthraId: string; strapiDocumentId: string }>,
): T[] {
  if (patches.length === 0) return snapshot;
  const pm = new Map(patches.map((p) => [p.manthraId, p.strapiDocumentId]));
  return snapshot.map((node) => {
    if (node.id !== adhyayaId) return node;
    return {
      ...node,
      khandas: node.khandas.map((kh) => {
        if (kh.id !== khandaId) return kh;
        if (padaId && kh.padas) {
          return {
            ...kh,
            padas: kh.padas.map((p) => {
              if (p.id !== padaId) return p;
              return {
                ...p,
                manthras: p.manthras.map((m) =>
                  pm.has(m.id) ? { ...m, strapiDocumentId: pm.get(m.id)! } : m,
                ),
              };
            }),
          };
        }
        return {
          ...kh,
          manthras: kh.manthras.map((m) =>
            pm.has(m.id) ? { ...m, strapiDocumentId: pm.get(m.id)! } : m,
          ),
        };
      }),
    } as T;
  });
}

async function strapiCreateBlankMantra(params: {
  sectionDocumentId: string;
  order: number;
  ShlokaManthraNumber: string;
}): Promise<string | undefined> {
  const res = await apiRequest("POST", "/api/strapi/manthras/create-blank-in-section", params);
  const json = await res.json();
  const docId = json?.data?.documentId ?? json?.data?.document?.documentId;
  return typeof docId === "string" && docId.length > 0 ? docId : undefined;
}

/** Shift subsequent rows in Strapi and insert a blank mantra after `afterDocumentId`. */
async function strapiInsertMantraAfter(params: {
  sectionDocumentId: string;
  afterDocumentId: string;
  afterNum: string;
}): Promise<string | undefined> {
  const res = await apiRequest("POST", "/api/strapi/manthras/insert-between", {
    sectionDocId: params.sectionDocumentId,
    afterDocumentId: params.afterDocumentId,
    afterNum: params.afterNum,
  });
  const json = await res.json();
  const docId = json?.data?.documentId ?? json?.data?.document?.documentId;
  return typeof docId === "string" && docId.length > 0 ? docId : undefined;
}

/** Delete mantras one-by-one (avoids races when several are removed in quick succession). */
export async function strapiDeleteMantrasBestEffort(documentIds: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const documentId of documentIds) {
    if (!isPublishedStrapiDocId(documentId)) continue;
    try {
      await apiRequest("DELETE", `/api/strapi/manthras/${documentId}`);
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 404) continue;
      failed.push(documentId);
    }
  }
  return failed;
}

async function strapiBatchIdentitySync(
  updates: Array<{ documentId: string; order: number; ShlokaManthraNumber: string }>,
): Promise<void> {
  if (updates.length === 0) return;
  const res = await apiRequest("POST", "/api/strapi/manthras/batch-identity-sync", { updates });
  const json = await res.json().catch(() => ({}));
  const results: Array<{ ok?: boolean }> = json?.results ?? [];
  const failed = results.filter((r) => r && r.ok === false).length;
  if (failed > 0) {
    throw new Error(`${failed} mantra identity update(s) failed in Strapi`);
  }
}

/**
 * Ensures Strapi mantras for this section match the editor snapshot: create blanks
 * for rows without `strapiDocumentId`, then batch-PUT `order` + `ShlokaManthraNumber`
 * for every row with a Strapi id.
 */
export async function pushMantraSectionIdentityToStrapi(
  snapshot: SnapshotAdhyaya[],
  adhyayaId: string,
  khandaId: string,
  padaId: string | undefined,
  cfg: GranthaStructureConfig,
): Promise<Array<{ manthraId: string; strapiDocumentId: string }>> {
  const sectionDocumentId = resolveMantraSectionStrapiDocumentId(snapshot, adhyayaId, khandaId, padaId, cfg);
  if (!sectionDocumentId) return [];

  const sorted = getSortedMantrasFromSnapshot(snapshot, adhyayaId, khandaId, padaId, cfg);
  const patches: Array<{ manthraId: string; strapiDocumentId: string }> = [];
  const resolved = new Map<string, string>();

  // Process in display order so consecutive new rows (insert after 2, then after new 3) each
  // call insert-between on the row directly above — never duplicate or skip a slot.
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    if (isPublishedStrapiDocId(m.strapiDocumentId)) {
      resolved.set(m.id, m.strapiDocumentId!);
      continue;
    }

    const prevWithStrapi = sorted
      .slice(0, i)
      .reverse()
      .find((x) => isPublishedStrapiDocId(resolved.get(x.id) ?? x.strapiDocumentId));

    let docId: string | undefined;
    if (prevWithStrapi) {
      const afterDocId = resolved.get(prevWithStrapi.id) ?? prevWithStrapi.strapiDocumentId!;
      docId = await strapiInsertMantraAfter({
        sectionDocumentId,
        afterDocumentId: afterDocId,
        afterNum: prevWithStrapi.title ?? "",
      });
    } else {
      docId = await strapiCreateBlankMantra({
        sectionDocumentId,
        order: m.order,
        ShlokaManthraNumber: m.title ?? "",
      });
    }

    if (docId) {
      resolved.set(m.id, docId);
      patches.push({ manthraId: m.id, strapiDocumentId: docId });
    }
  }

  const updates: Array<{ documentId: string; order: number; ShlokaManthraNumber: string }> = [];
  for (const m of sorted) {
    const documentId = resolved.get(m.id);
    if (!isPublishedStrapiDocId(documentId)) continue;
    updates.push({
      documentId: documentId!,
      order: m.order,
      ShlokaManthraNumber: m.title ?? "",
    });
  }

  await strapiBatchIdentitySync(updates);
  return patches;
}

/**
 * After local insert/delete/renumber: remove deleted Strapi rows first, then mirror
 * the remaining snapshot (create + batch identity). Keeps order compact on consecutive deletes.
 */
export async function syncMantraSectionAfterStructuralEdits(
  snapshot: SnapshotAdhyaya[],
  adhyayaId: string,
  khandaId: string,
  padaId: string | undefined,
  cfg: GranthaStructureConfig,
  deleteDocumentIds: string[],
): Promise<{ patches: Array<{ manthraId: string; strapiDocumentId: string }>; failedDeleteIds: string[] }> {
  const failedDeleteIds = await strapiDeleteMantrasBestEffort(deleteDocumentIds);
  const patches = await pushMantraSectionIdentityToStrapi(snapshot, adhyayaId, khandaId, padaId, cfg);
  return { patches, failedDeleteIds };
}
