import { isBlankMantraLabel, validateMantraLabelForCmsCreate } from "@shared/mantra-cms-guard";
import { sortKeyBetween, STRAPI_SORT_GAP } from "@shared/mantra-sort-key";
import {
  isPublishedStrapiDocId,
  type GranthaStructureConfigLite,
  type MantraSectionNode,
  resolveMantraOwnerSectionDocId,
  type StrapiSectionRef,
} from "@shared/grantha-mantra-section-resolve";
import { strapiRequest, withSectionLock } from "./strapi";
import { applyHierarchyRepairInPlace } from "./grantha-hierarchy-repair";
import {
  sortMantrasByDisplayOrder,
  buildMantraTitleCtx,
  mantraLabelFromListPosition,
  type GranthaStructureConfig,
} from "../client/src/lib/grantha-structure-sync";

type MantraRow = {
  id: string;
  title?: string;
  order?: number;
  strapiDocumentId?: string;
  _isNewLocal?: boolean;
};

/** Safety cap — large granthas must not create hundreds of CMS rows in one HTTP request. */
const MAX_SLOT_CREATES_PER_REQUEST = 15;

type MantraPadaNode = {
  id: string;
  title?: string;
  documentId?: string;
  order?: number;
  manthras?: MantraRow[];
};

export type MantraSlotPatch = {
  manthraId: string;
  strapiDocumentId: string;
  adhyayaId: string;
  khandaId: string;
  padaId?: string;
  sectionDocumentId: string;
};

type ResolveSectionFn = (
  knownDocId: string | undefined,
  title: string,
  type: string | undefined,
  order: number | undefined,
  granthaDocId: string,
  parentDocId: string | undefined,
  skipMetadataUpdate?: boolean,
) => Promise<string | undefined>;

type MapSectionTypeFn = (name: string) => string | undefined;

async function listSectionMantraOrders(sectionDocId: string): Promise<
  Array<{ documentId: string; order: number; ShlokaManthraNumber?: string }>
> {
  const s = encodeURIComponent(sectionDocId);
  const all: Array<{ documentId: string; order: number; ShlokaManthraNumber?: string }> = [];
  let page = 1;
  while (true) {
    const r = await strapiRequest(
      `/api/manthras?filters[Section][documentId][$eq]=${s}&fields[0]=documentId&fields[1]=order&fields[2]=ShlokaManthraNumber&sort[0]=order:asc&pagination[pageSize]=100&pagination[page]=${page}`,
    );
    for (const row of r.data ?? []) {
      if (typeof row.documentId === "string") {
        all.push({
          documentId: row.documentId,
          order: typeof row.order === "number" ? row.order : 0,
          ShlokaManthraNumber: row.ShlokaManthraNumber,
        });
      }
    }
    if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  return all;
}

/** Reuse a stray CMS row that has no verse label instead of POSTing another orphan. */
async function claimOrCreateMantraInSection(
  sectionDocumentId: string,
  sortKey: number,
  label: string,
): Promise<string | undefined> {
  const trimmed = label.trim();
  const labelErr = validateMantraLabelForCmsCreate(trimmed);
  if (labelErr) {
    console.warn(`[sync-mantra-slots] Refusing create in ${sectionDocumentId}: ${labelErr}`);
    return undefined;
  }

  const existing = await listSectionMantraOrders(sectionDocumentId);
  const blank = existing.find((r) => isBlankMantraLabel(r.ShlokaManthraNumber));
  if (blank) {
    await strapiRequest(`/api/manthras/${blank.documentId}`, {
      method: "PUT",
      body: JSON.stringify({
        data: { ShlokaManthraNumber: trimmed, order: sortKey, Section: sectionDocumentId },
      }),
    });
    return blank.documentId;
  }

  const created = await strapiRequest("/api/manthras", {
    method: "POST",
    body: JSON.stringify({
      data: {
        ShlokaManthraNumber: trimmed,
        order: sortKey,
        Section: sectionDocumentId,
      },
    }),
  });
  const docId = created?.data?.documentId;
  return typeof docId === "string" && docId.length >= 10 ? docId : undefined;
}

async function insertMantraAfterInSection(
  sectionDocumentId: string,
  afterDocumentId: string,
  label: string,
): Promise<string | undefined> {
  return withSectionLock(sectionDocumentId, async () => {
    const all = await listSectionMantraOrders(sectionDocumentId);
    const anchorIdx = all.findIndex((m) => m.documentId === afterDocumentId);
    if (anchorIdx < 0) return undefined;

    const prevSort = all[anchorIdx].order;
    const nextSort = all[anchorIdx + 1]?.order;
    let { sortKey: newSortKey, needsRecompact } = sortKeyBetween(prevSort, nextSort);

    if (needsRecompact) {
      const gap = STRAPI_SORT_GAP;
      for (let i = 0; i < all.length; i++) {
        const docId = all[i].documentId;
        await strapiRequest(`/api/manthras/${docId}`, {
          method: "PUT",
          body: JSON.stringify({ data: { order: (i + 1) * gap } }),
        });
      }
      const refreshed = await listSectionMantraOrders(sectionDocumentId);
      const anchorIdx2 = refreshed.findIndex((m) => m.documentId === afterDocumentId);
      newSortKey = sortKeyBetween(
        refreshed[anchorIdx2]?.order,
        refreshed[anchorIdx2 + 1]?.order,
      ).sortKey;
    }

    return claimOrCreateMantraInSection(sectionDocumentId, newSortKey, label);
  });
}

async function fetchGranthaSectionTree(granthaDocId: string): Promise<{
  childrenByParentDocId: Map<string, StrapiSectionRef[]>;
}> {
  const childrenByParentDocId = new Map<string, StrapiSectionRef[]>();
  const g = encodeURIComponent(granthaDocId);
  let page = 1;
  while (true) {
    const r = await strapiRequest(
      `/api/sections?filters[grantha][documentId][$eq]=${g}&fields[0]=documentId&fields[1]=title&fields[2]=order&populate[parent][fields][0]=documentId&pagination[pageSize]=100&pagination[page]=${page}`,
    );
    for (const sec of r.data ?? []) {
      const parentId: string | undefined = sec.parent?.documentId;
      if (!parentId || typeof sec.documentId !== "string") continue;
      const list = childrenByParentDocId.get(parentId) ?? [];
      list.push({ documentId: sec.documentId, title: sec.title });
      childrenByParentDocId.set(parentId, list);
    }
    if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  return { childrenByParentDocId };
}

async function resolveSectionDocIdForMantras(
  granthaDocId: string,
  adhyaya: MantraSectionNode,
  khanda: NonNullable<MantraSectionNode["khandas"]>[number],
  pada: MantraPadaNode | undefined,
  structureConfig: GranthaStructureConfigLite,
  childrenByParentDocId: Map<string, StrapiSectionRef[]>,
  resolveSection: ResolveSectionFn,
  mapSectionType: MapSectionTypeFn,
  padaId?: string,
): Promise<string | undefined> {
  const L1name = "Adhyaya";
  const L2name = "Khanda";
  const L3name = "Pada";
  const levelTwoEnabled = structureConfig.levelTwoEnabled !== false;
  const levelThreeEnabled = !!structureConfig.levelThreeEnabled;
  const L1type = mapSectionType(L1name);
  const L2type = mapSectionType(L2name);
  const L3type = mapSectionType(L3name);
  const skip = true;

  let adhyayaDocId = isPublishedStrapiDocId(adhyaya.documentId) ? adhyaya.documentId : undefined;
  if (!adhyayaDocId) {
      adhyayaDocId = await resolveSection(
        adhyaya.documentId,
        adhyaya.title ?? L1name,
        L1type,
        (adhyaya as { order?: number }).order ?? undefined,
        granthaDocId,
        undefined,
        skip,
      );
  }
  if (!adhyayaDocId) return undefined;

  const snapshot = [{ ...adhyaya, documentId: adhyayaDocId }] as MantraSectionNode[];
  const fromTree = resolveMantraOwnerSectionDocId(
    snapshot,
    adhyaya.id,
    khanda.id,
    padaId,
    structureConfig,
    { childrenByParentDocId },
  );
  if (fromTree) return fromTree;

  const isDefaultKhanda = khanda.title === "_default" || !levelTwoEnabled;
  if (isDefaultKhanda && levelTwoEnabled && khanda.title === "_default") {
    const childCheck = await strapiRequest(
      `/api/sections?filters[parent][documentId][$eq]=${encodeURIComponent(adhyayaDocId)}&filters[grantha][documentId][$eq]=${encodeURIComponent(granthaDocId)}&fields[0]=documentId&fields[1]=title&pagination[pageSize]=10`,
    );
    const childSecs: StrapiSectionRef[] = (childCheck?.data ?? []).map((c: any) => ({
      documentId: c.documentId,
      title: c.title,
    }));
    if (childSecs.length > 0) {
      const realKhanda = (adhyaya.khandas ?? []).find(
        (k) => k.title && k.title !== "_default" && isPublishedStrapiDocId(k.documentId),
      );
      const match =
        (realKhanda?.documentId
          ? childSecs.find((c) => c.documentId === realKhanda.documentId)
          : undefined) ??
        (realKhanda?.title
          ? childSecs.find(
              (c) =>
                (c.title ?? "").trim().toLowerCase() ===
                (realKhanda.title ?? "").trim().toLowerCase(),
            )
          : undefined) ??
        childSecs[0];
      if (match?.documentId) return match.documentId;
    }
  }

  if (!isDefaultKhanda) {
    let khandaDocId = isPublishedStrapiDocId(khanda.documentId) ? khanda.documentId : undefined;
    if (!khandaDocId) {
      khandaDocId = await resolveSection(
        khanda.documentId,
        khanda.title ?? L2name,
        L2type,
        (khanda as { order?: number }).order ?? undefined,
        granthaDocId,
        adhyayaDocId,
        skip,
      );
    }
    if (levelThreeEnabled && padaId && pada) {
      let padaDocId = isPublishedStrapiDocId(pada.documentId) ? pada.documentId : undefined;
      if (!padaDocId) {
        padaDocId = await resolveSection(
          pada.documentId,
          pada.title ?? L3name,
          L3type,
          pada.order ?? undefined,
          granthaDocId,
          khandaDocId,
          skip,
        );
      }
      return padaDocId;
    }
    return khandaDocId;
  }

  return adhyayaDocId;
}

function applyPatchesToHierarchy(hierarchy: any[], patches: MantraSlotPatch[]): any[] {
  if (patches.length === 0) return hierarchy;
  const byMantra = new Map(patches.map((p) => [p.manthraId, p.strapiDocumentId]));
  return hierarchy.map((a) => ({
    ...a,
    khandas: (a.khandas ?? []).map((k: any) => ({
      ...k,
      manthras: (k.manthras ?? []).map((m: any) =>
        byMantra.has(m.id) ? { ...m, strapiDocumentId: byMantra.get(m.id), _isNewLocal: false } : m,
      ),
      padas: (k.padas ?? []).map((p: any) => ({
        ...p,
        manthras: (p.manthras ?? []).map((m: any) =>
          byMantra.has(m.id) ? { ...m, strapiDocumentId: byMantra.get(m.id), _isNewLocal: false } : m,
        ),
      })),
    })),
  }));
}

function sortedMantrasInSection(
  adhyaya: MantraSectionNode,
  khanda: NonNullable<MantraSectionNode["khandas"]>[number],
  padaId: string | undefined,
  cfg: GranthaStructureConfig,
): MantraRow[] {
  if (cfg.levelThreeEnabled && padaId) {
    const p = khanda.padas?.find((x) => x.id === padaId);
    return sortMantrasByDisplayOrder((p?.manthras ?? []) as MantraRow[]);
  }
  return sortMantrasByDisplayOrder((khanda.manthras ?? []) as MantraRow[]);
}

/** Create Strapi manthra rows for portal-only verses and return patches (+ updated hierarchy). */
export async function syncPendingMantraSlotsFromDraft(opts: {
  draftData: Record<string, any>;
  granthaDocId: string;
  resolveSection: ResolveSectionFn;
  mapSectionType: MapSectionTypeFn;
  scope?: { adhyayaId?: string; khandaId?: string; padaId?: string };
  hierarchyOverride?: unknown[];
  /** When set, only these portal rows may get new CMS slots (insert-after flow). */
  onlyManthraIds?: string[];
}): Promise<{ patches: MantraSlotPatch[]; hierarchy: any[]; errors: string[]; remainingPending?: number }> {
  const { draftData, granthaDocId, resolveSection, mapSectionType, scope, hierarchyOverride, onlyManthraIds } =
    opts;
  const structureConfig = (draftData.structureConfig ?? {}) as GranthaStructureConfig;
  const configuredLeaf = String(structureConfig.leafName || "Mantra").trim() || "Mantra";
  let hierarchy: any[] = Array.isArray(hierarchyOverride)
    ? hierarchyOverride
    : Array.isArray(draftData.hierarchy)
      ? draftData.hierarchy
      : [];

  applyHierarchyRepairInPlace(hierarchy, structureConfig as Record<string, unknown>, configuredLeaf);

  const { childrenByParentDocId } = await fetchGranthaSectionTree(granthaDocId);
  const patches: MantraSlotPatch[] = [];
  const errors: string[] = [];
  const onlySet = onlyManthraIds?.length ? new Set(onlyManthraIds) : null;
  let remainingPending = 0;

  outer: for (const adhyaya of hierarchy as MantraSectionNode[]) {
    const adhyayaIndex = (hierarchy as MantraSectionNode[]).findIndex((x) => x.id === adhyaya.id);
    for (const khanda of adhyaya.khandas ?? []) {
      const khandaIndex = (adhyaya.khandas ?? []).findIndex((x) => x.id === khanda.id);
      const padas = khanda.padas ?? [];
      const targets: Array<{ padaId?: string; pada?: MantraPadaNode }> =
        structureConfig.levelThreeEnabled && padas.length > 0
          ? padas.map((p) => ({ padaId: p.id, pada: p as MantraPadaNode }))
          : [{ padaId: undefined, pada: undefined }];

      for (const { padaId, pada } of targets) {
        if (
          scope?.adhyayaId &&
          (scope.adhyayaId !== adhyaya.id ||
            scope.khandaId !== khanda.id ||
            (scope.padaId ?? undefined) !== (padaId ?? undefined))
        ) {
          continue;
        }

        const sectionDocId = await resolveSectionDocIdForMantras(
          granthaDocId,
          adhyaya,
          khanda,
          pada,
          structureConfig,
          childrenByParentDocId,
          resolveSection,
          mapSectionType,
          padaId,
        );

        if (!sectionDocId) {
          const label = padaId ? `${khanda.title}/${pada?.title}` : khanda.title ?? adhyaya.title;
          errors.push(`Could not resolve Strapi section for "${label}" — mantras cannot sync to CMS yet.`);
          continue;
        }

        const sorted = sortedMantrasInSection(adhyaya, khanda, padaId, structureConfig);
        const resolved = new Map<string, string>();
        const padaIndex =
          structureConfig.levelThreeEnabled && padaId
            ? (khanda.padas ?? []).findIndex((x) => x.id === padaId)
            : undefined;
        const titleCtx =
          adhyayaIndex >= 0 && khandaIndex >= 0
            ? buildMantraTitleCtx(
                adhyayaIndex,
                khanda,
                khandaIndex,
                structureConfig as GranthaStructureConfig,
                padaIndex != null && padaIndex >= 0 ? padaIndex : undefined,
              )
            : null;

        for (let i = 0; i < sorted.length; i++) {
          const m = sorted[i] as MantraRow;
          if (isPublishedStrapiDocId(m.strapiDocumentId)) {
            resolved.set(m.id, m.strapiDocumentId!);
            continue;
          }

          const isExplicitTarget = onlySet ? onlySet.has(m.id) : !!m._isNewLocal;
          if (!isExplicitTarget) continue;

          if (patches.length >= MAX_SLOT_CREATES_PER_REQUEST) {
            remainingPending++;
            continue;
          }

          const portalLabel = titleCtx
            ? mantraLabelFromListPosition(m.title, i + 1, titleCtx)
            : (m.title ?? "").trim();
          if (isBlankMantraLabel(portalLabel)) {
            errors.push(
              `Skipped CMS slot for portal verse ${m.id} — no Shloka label (renumber the section in the editor, then Save & Publish).`,
            );
            continue;
          }

          let docId: string | undefined;

          const prevWithStrapi = sorted
            .slice(0, i)
            .reverse()
            .find((x) => isPublishedStrapiDocId(resolved.get(x.id) ?? x.strapiDocumentId));

          if (prevWithStrapi) {
            const afterDocId = resolved.get(prevWithStrapi.id) ?? prevWithStrapi.strapiDocumentId!;
            docId = await insertMantraAfterInSection(sectionDocId, afterDocId, portalLabel);
          } else {
            docId = await withSectionLock(sectionDocId, async () => {
              const all = await listSectionMantraOrders(sectionDocId);
              const maxOrder = all.length > 0 ? Math.max(...all.map((r) => r.order)) : 0;
              const newSortKey = maxOrder > 0 ? maxOrder + STRAPI_SORT_GAP : STRAPI_SORT_GAP;
              return claimOrCreateMantraInSection(sectionDocId, newSortKey, portalLabel);
            });
          }

          if (docId) {
            resolved.set(m.id, docId);
            patches.push({
              manthraId: m.id,
              strapiDocumentId: docId,
              adhyayaId: adhyaya.id,
              khandaId: khanda.id,
              padaId,
              sectionDocumentId: sectionDocId,
            });
          } else {
            errors.push(`Failed to create CMS row for "${portalLabel || m.id}" in section ${sectionDocId}.`);
          }
        }
        if (patches.length >= MAX_SLOT_CREATES_PER_REQUEST) break outer;
      }
    }
  }

  if (remainingPending > 0) {
    errors.push(
      `${remainingPending} portal-only verse(s) still pending CMS slot sync — use + insert or Save after publish completes (max ${MAX_SLOT_CREATES_PER_REQUEST} per request).`,
    );
  }

  if (patches.length > 0) {
    hierarchy = applyPatchesToHierarchy(hierarchy, patches);
  }

  return { patches, hierarchy, errors, remainingPending };
}
