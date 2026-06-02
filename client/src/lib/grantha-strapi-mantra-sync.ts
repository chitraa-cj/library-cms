import { apiRequest, ApiError } from "@/lib/queryClient";
import {
  assignSpacedSortKeysFromPortalOrder,
  portalIndexToStrapiSortKey,
} from "@shared/mantra-sort-key";
import {
  sortNodesByOrder,
  sortMantrasByDisplayOrder,
  isPublishedStrapiDocId,
  pickPreferredStrapiMantraRef,
  titleUsesConfiguredLeaf,
  type GranthaStructureConfig,
  type StrapiMantraRef,
} from "@/lib/grantha-structure-sync";

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
    return sortMantrasByDisplayOrder(p?.manthras ?? []);
  }
  return sortMantrasByDisplayOrder(k.manthras ?? []);
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

async function strapiCreateBlankMantraAtEnd(params: {
  sectionDocumentId: string;
  ShlokaManthraNumber: string;
}): Promise<string | undefined> {
  const res = await apiRequest("POST", "/api/strapi/manthras/create-blank-in-section", {
    sectionDocumentId: params.sectionDocumentId,
    ShlokaManthraNumber: params.ShlokaManthraNumber,
  });
  const json = await res.json();
  const docId = json?.data?.documentId ?? json?.data?.document?.documentId;
  return typeof docId === "string" && docId.length > 0 ? docId : undefined;
}

/** O(1) insert: fractional sort key between anchor and next row — no sibling shifts. */
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

export async function listStrapiMantrasInSection(sectionDocumentId: string): Promise<StrapiMantraRef[]> {
  if (!isPublishedStrapiDocId(sectionDocumentId)) return [];
  const base = [
    `filters[Section][documentId][$eq]=${encodeURIComponent(sectionDocumentId)}`,
    "fields[0]=documentId",
    "fields[1]=ShlokaManthraNumber",
    "fields[2]=order",
    "sort[0]=order:asc",
    "pagination[pageSize]=100",
  ].join("&");

  const firstRes = await apiRequest("GET", `/api/strapi/manthras?${base}&pagination[page]=1`);
  const firstJson = await firstRes.json().catch(() => ({}));
  const total: number = firstJson?.meta?.pagination?.total ?? 0;
  const pageSize: number = firstJson?.meta?.pagination?.pageSize ?? 100;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const rows: any[] = [...(firstJson?.data ?? [])];
  if (pageCount > 1) {
    const rest = await Promise.all(
      Array.from({ length: pageCount - 1 }, (_, i) =>
        apiRequest("GET", `/api/strapi/manthras?${base}&pagination[page]=${i + 2}`).then((r) => r.json()),
      ),
    );
    for (const p of rest) rows.push(...(p?.data ?? []));
  }

  return rows
    .filter((r) => typeof r.documentId === "string")
    .map((r) => ({
      title: String(r.ShlokaManthraNumber ?? ""),
      docId: r.documentId as string,
      order: typeof r.order === "number" ? r.order : 0,
    }));
}

export async function lookupStrapiMantraDocIdByLabel(
  sectionDocumentId: string,
  label: string,
  configuredLeaf: string,
  cachedSectionList?: StrapiMantraRef[],
  preferredDocId?: string,
): Promise<string | undefined> {
  const trimmed = label.trim();
  const leaf = (configuredLeaf || "Mantra").trim();
  if (!trimmed || !isPublishedStrapiDocId(sectionDocumentId)) return undefined;

  const refs = cachedSectionList ?? (await listStrapiMantrasInSection(sectionDocumentId));
  const exact = refs.filter((r) => r.title.trim().toLowerCase() === trimmed.toLowerCase());
  const exactPick = pickPreferredStrapiMantraRef(exact, preferredDocId);
  if (exactPick) return exactPick.docId;
  return undefined;
}

export type MantraSectionSyncTarget = {
  adhyayaId: string;
  khandaId: string;
  padaId?: string;
};

export type MantraDocIdPatch = MantraSectionSyncTarget & {
  manthraId: string;
  strapiDocumentId: string;
};

function pushMantraSectionSyncTarget(
  targets: MantraSectionSyncTarget[],
  seenSectionDocIds: Set<string>,
  snapshot: SnapshotAdhyaya[],
  adhyayaId: string,
  khandaId: string,
  padaId: string | undefined,
  cfg: GranthaStructureConfig,
): void {
  const secId = resolveMantraSectionStrapiDocumentId(snapshot, adhyayaId, khandaId, padaId, cfg);
  if (!secId || seenSectionDocIds.has(secId)) return;
  seenSectionDocIds.add(secId);
  targets.push({ adhyayaId, khandaId, padaId });
}

export function collectMantraSectionSyncTargets(
  snapshot: SnapshotAdhyaya[],
  cfg: GranthaStructureConfig,
): MantraSectionSyncTarget[] {
  const targets: MantraSectionSyncTarget[] = [];
  const seenSectionDocIds = new Set<string>();

  for (const a of snapshot) {
    for (const k of a.khandas ?? []) {
      const padas = k.padas ?? [];
      const hasPadas = padas.length > 0;
      const khandaHasDirectMantras = (k.manthras ?? []).length > 0;

      if (cfg.levelThreeEnabled && hasPadas) {
        for (const p of padas) {
          pushMantraSectionSyncTarget(targets, seenSectionDocIds, snapshot, a.id, k.id, p.id, cfg);
        }
        // Legacy rows: mantras still on khanda while L3 padas exist — sync that section too.
        if (khandaHasDirectMantras) {
          pushMantraSectionSyncTarget(targets, seenSectionDocIds, snapshot, a.id, k.id, undefined, cfg);
        }
      } else {
        pushMantraSectionSyncTarget(targets, seenSectionDocIds, snapshot, a.id, k.id, undefined, cfg);
      }
    }
  }
  return targets;
}

export function applyMantraDocIdPatches<T extends SnapshotAdhyaya>(
  snapshot: T[],
  patches: MantraDocIdPatch[],
): T[] {
  let result = snapshot;
  const bySection = new Map<string, MantraDocIdPatch[]>();
  for (const p of patches) {
    const key = `${p.adhyayaId}\0${p.khandaId}\0${p.padaId ?? ""}`;
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key)!.push(p);
  }
  for (const group of bySection.values()) {
    const first = group[0];
    result = mergeMantraStrapiDocumentIds(
      result,
      first.adhyayaId,
      first.khandaId,
      first.padaId,
      group.map((g) => ({ manthraId: g.manthraId, strapiDocumentId: g.strapiDocumentId })),
    );
  }
  return result;
}

export type BatchIdentitySyncSummary = {
  labelsUpdated: number;
  orderOnly: number;
  failed: number;
};

async function strapiBatchIdentitySync(
  updates: Array<{ documentId: string; order: number; ShlokaManthraNumber: string }>,
  options?: { sortKeysOnly?: boolean; configuredLeaf?: string },
): Promise<BatchIdentitySyncSummary> {
  const summary: BatchIdentitySyncSummary = { labelsUpdated: 0, orderOnly: 0, failed: 0 };
  if (updates.length === 0) return summary;
  const CHUNK = 500;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    const res = await apiRequest("POST", "/api/strapi/manthras/batch-identity-sync", {
      updates: chunk,
      sortKeysOnly: options?.sortKeysOnly === true,
      configuredLeaf: options?.configuredLeaf,
    });
    const json = await res.json().catch(() => ({}));
    const results: Array<{ documentId: string; ok?: boolean; error?: string; labelSkipped?: boolean }> =
      json?.results ?? [];
    for (const r of results) {
      if (!r || r.ok === false) {
        summary.failed += 1;
        continue;
      }
      if (r.labelSkipped) summary.orderOnly += 1;
      else summary.labelsUpdated += 1;
    }
    if (summary.failed > 0) {
      const detail = results.find((r) => r && r.ok === false)?.error ?? "unknown";
      throw new Error(`${summary.failed} mantra identity update(s) failed: ${detail}`);
    }
  }
  return summary;
}

/**
 * Structural sync after insert/delete: create missing Strapi rows only (fractional sort keys).
 * Does NOT rewrite verse labels for the whole section — use syncMantraSectionLabelsToStrapi for that.
 */
export async function pushMantraSectionStructureToStrapi(
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
      docId = await strapiCreateBlankMantraAtEnd({
        sectionDocumentId,
        ShlokaManthraNumber: "",
      });
    }

    if (docId) {
      resolved.set(m.id, docId);
      patches.push({ manthraId: m.id, strapiDocumentId: docId });
    }
  }

  return patches;
}

/**
 * Explicit "Sync verse numbers to CMS" — writes portal display titles + spaced sort keys
 * for every linked row in the section (like saving the sheet in Excel).
 */
export async function syncMantraSectionLabelsToStrapi(
  snapshot: SnapshotAdhyaya[],
  adhyayaId: string,
  khandaId: string,
  padaId: string | undefined,
  cfg: GranthaStructureConfig,
): Promise<BatchIdentitySyncSummary> {
  const empty: BatchIdentitySyncSummary = { labelsUpdated: 0, orderOnly: 0, failed: 0 };
  const sectionDocumentId = resolveMantraSectionStrapiDocumentId(snapshot, adhyayaId, khandaId, padaId, cfg);
  if (!sectionDocumentId) return empty;

  const sorted = getSortedMantrasFromSnapshot(snapshot, adhyayaId, khandaId, padaId, cfg);
  const sortKeys = assignSpacedSortKeysFromPortalOrder(sorted);

  const updates: Array<{ documentId: string; order: number; ShlokaManthraNumber: string }> = [];
  const seenDocIds = new Set<string>();
  for (const m of sorted) {
    const documentId = m.strapiDocumentId;
    if (!isPublishedStrapiDocId(documentId) || seenDocIds.has(documentId)) continue;
    seenDocIds.add(documentId);
    updates.push({
      documentId,
      order: sortKeys.get(m.id) ?? portalIndexToStrapiSortKey(m.order),
      ShlokaManthraNumber: (m.title ?? "").trim(),
    });
  }

  const leaf = (cfg.leafName || "Mantra").trim() || "Mantra";
  return strapiBatchIdentitySync(updates, { sortKeysOnly: false, configuredLeaf: leaf });
}

/**
 * After insert/delete: align Strapi fractional sort keys with portal list order (1…n → 1000, 2000…).
 * Does not change ShlokaManthraNumber labels.
 */
export async function syncMantraSectionSortKeysToStrapi(
  snapshot: SnapshotAdhyaya[],
  adhyayaId: string,
  khandaId: string,
  padaId: string | undefined,
  cfg: GranthaStructureConfig,
): Promise<number> {
  const sectionDocumentId = resolveMantraSectionStrapiDocumentId(snapshot, adhyayaId, khandaId, padaId, cfg);
  if (!sectionDocumentId) return 0;

  const sorted = getSortedMantrasFromSnapshot(snapshot, adhyayaId, khandaId, padaId, cfg);
  const sortKeys = assignSpacedSortKeysFromPortalOrder(sorted);

  const updates: Array<{ documentId: string; order: number; ShlokaManthraNumber: string }> = [];
  const seenDocIds = new Set<string>();
  for (const m of sorted) {
    const documentId = m.strapiDocumentId;
    if (!isPublishedStrapiDocId(documentId) || seenDocIds.has(documentId)) continue;
    seenDocIds.add(documentId);
    updates.push({
      documentId,
      order: sortKeys.get(m.id) ?? portalIndexToStrapiSortKey(m.order),
      ShlokaManthraNumber: "",
    });
  }

  if (updates.length === 0) return 0;
  const leaf = (cfg.leafName || "Mantra").trim() || "Mantra";
  const summary = await strapiBatchIdentitySync(updates, { sortKeysOnly: true, configuredLeaf: leaf });
  return summary.labelsUpdated + summary.orderOnly;
}

/** @deprecated Use pushMantraSectionStructureToStrapi — kept for callers migrating gradually. */
export async function pushMantraSectionIdentityToStrapi(
  snapshot: SnapshotAdhyaya[],
  adhyayaId: string,
  khandaId: string,
  padaId: string | undefined,
  cfg: GranthaStructureConfig,
  options?: { allowCreate?: boolean },
): Promise<Array<{ manthraId: string; strapiDocumentId: string }>> {
  if (options?.allowCreate === false) {
    return [];
  }
  return pushMantraSectionStructureToStrapi(snapshot, adhyayaId, khandaId, padaId, cfg);
}

export async function syncAllMantraSectionLabelsInGrantha(
  snapshot: SnapshotAdhyaya[],
  cfg: GranthaStructureConfig,
): Promise<BatchIdentitySyncSummary> {
  const total: BatchIdentitySyncSummary = { labelsUpdated: 0, orderOnly: 0, failed: 0 };
  for (const ctx of collectMantraSectionSyncTargets(snapshot, cfg)) {
    const part = await syncMantraSectionLabelsToStrapi(
      snapshot,
      ctx.adhyayaId,
      ctx.khandaId,
      ctx.padaId,
      cfg,
    );
    total.labelsUpdated += part.labelsUpdated;
    total.orderOnly += part.orderOnly;
    total.failed += part.failed;
  }
  return total;
}

export async function syncMantraSectionAfterStructuralEdits(
  snapshot: SnapshotAdhyaya[],
  adhyayaId: string,
  khandaId: string,
  padaId: string | undefined,
  cfg: GranthaStructureConfig,
  deleteDocumentIds: string[],
): Promise<{
  patches: Array<{ manthraId: string; strapiDocumentId: string }>;
  failedDeleteIds: string[];
  sortKeysUpdated: number;
  labelsUpdated: number;
}> {
  const failedDeleteIds = await strapiDeleteMantrasBestEffort(deleteDocumentIds);
  const patches = await pushMantraSectionStructureToStrapi(snapshot, adhyayaId, khandaId, padaId, cfg);
  let snapForSort = snapshot;
  if (patches.length > 0) {
    snapForSort = applyMantraDocIdPatches(snapshot, patches.map((p) => ({
      adhyayaId,
      khandaId,
      padaId,
      manthraId: p.manthraId,
      strapiDocumentId: p.strapiDocumentId,
    })));
  }
  const sortKeysUpdated = await syncMantraSectionSortKeysToStrapi(
    snapForSort,
    adhyayaId,
    khandaId,
    padaId,
    cfg,
  );
  // After insert/delete the portal reindexes verse titles — only sync fractional sort keys here.
  // Pushing new ShlokaManthraNumber labels automatically would fail integrity when Strapi still
  // has the old verse numbers (497+ rows). Use "Sync verse numbers to CMS" when intentional.
  return { patches, failedDeleteIds, sortKeysUpdated, labelsUpdated: 0 };
}

/** Create Strapi rows for any portal mantras in this grantha that still lack a documentId. */
export async function syncAllPendingNewMantrasToStrapi(
  snapshot: SnapshotAdhyaya[],
  cfg: GranthaStructureConfig,
): Promise<Array<{ manthraId: string; strapiDocumentId: string; adhyayaId: string; khandaId: string; padaId?: string }>> {
  const allPatches: Array<{ manthraId: string; strapiDocumentId: string; adhyayaId: string; khandaId: string; padaId?: string }> = [];
  let snap = snapshot;

  for (const ctx of collectMantraSectionSyncTargets(snapshot, cfg)) {
    const sorted = getSortedMantrasFromSnapshot(snap, ctx.adhyayaId, ctx.khandaId, ctx.padaId, cfg);
    if (!sorted.some((m) => !isPublishedStrapiDocId(m.strapiDocumentId))) continue;

    const patches = await pushMantraSectionStructureToStrapi(
      snap,
      ctx.adhyayaId,
      ctx.khandaId,
      ctx.padaId,
      cfg,
    );
    if (patches.length === 0) continue;

    for (const p of patches) {
      allPatches.push({ ...p, adhyayaId: ctx.adhyayaId, khandaId: ctx.khandaId, padaId: ctx.padaId });
    }
    snap = applyMantraDocIdPatches(
      snap,
      patches.map((p) => ({ ...ctx, manthraId: p.manthraId, strapiDocumentId: p.strapiDocumentId })),
    );
    await syncMantraSectionSortKeysToStrapi(snap, ctx.adhyayaId, ctx.khandaId, ctx.padaId, cfg);
  }

  return allPatches;
}

export type UnlinkedGranthaDraftMantra = {
  granthaDraftId: number;
  granthaName: string;
  strapiGranthaDocId?: string;
  adhyayaId: string;
  khandaId: string;
  padaId?: string;
  manthraId: string;
  title: string;
  isNewLocal: boolean;
};

/** Portal-only rows saved in a grantha draft but not yet linked to a Strapi manthra documentId. */
export function collectUnlinkedMantrasFromGranthaDraft(draft: {
  id: number;
  strapiDocumentId?: string | null;
  data?: Record<string, unknown>;
}): UnlinkedGranthaDraftMantra[] {
  const d = (draft.data ?? {}) as Record<string, any>;
  const cfg = (d.structureConfig ?? {}) as GranthaStructureConfig;
  const hierarchy = (d.hierarchy ?? []) as SnapshotAdhyaya[];
  const granthaName = String(d.GranthaName ?? "").trim() || `Draft #${draft.id}`;
  const out: UnlinkedGranthaDraftMantra[] = [];

  const visit = (
    m: ManthraSnap & { _isNewLocal?: boolean },
    ctx: { adhyayaId: string; khandaId: string; padaId?: string },
  ) => {
    if (isPublishedStrapiDocId(m.strapiDocumentId)) return;
    const title = (m.title ?? "").trim();
    if (!title && !m._isNewLocal) return;
    out.push({
      granthaDraftId: draft.id,
      granthaName,
      strapiGranthaDocId: draft.strapiDocumentId ?? undefined,
      ...ctx,
      manthraId: m.id,
      title: title || "(blank new verse)",
      isNewLocal: !!m._isNewLocal,
    });
  };

  for (const a of hierarchy) {
    for (const k of a.khandas ?? []) {
      const padas = k.padas ?? [];
      const skipKhanda = !!cfg.levelThreeEnabled && padas.length > 0;
      if (!skipKhanda) {
        for (const m of k.manthras ?? []) {
          visit(m, { adhyayaId: a.id, khandaId: k.id });
        }
      }
      for (const p of padas) {
        for (const m of p.manthras ?? []) {
          visit(m, { adhyayaId: a.id, khandaId: k.id, padaId: p.id });
        }
      }
    }
  }
  return out;
}

/** @deprecated Alias */
export async function syncAllMantraSectionsInGrantha(
  snapshot: SnapshotAdhyaya[],
  cfg: GranthaStructureConfig,
  options?: { allowCreate?: boolean },
): Promise<MantraDocIdPatch[]> {
  void options;
  const all: MantraDocIdPatch[] = [];
  for (const ctx of collectMantraSectionSyncTargets(snapshot, cfg)) {
    const patches = await pushMantraSectionStructureToStrapi(
      snapshot,
      ctx.adhyayaId,
      ctx.khandaId,
      ctx.padaId,
      cfg,
    );
    for (const p of patches) {
      all.push({ ...ctx, ...p });
    }
  }
  return all;
}
