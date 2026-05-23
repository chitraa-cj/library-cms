import { apiRequest, ApiError } from "@/lib/queryClient";
import type { SnapshotAdhyaya } from "@/lib/grantha-strapi-mantra-sync";
import {
  isPublishedStrapiDocId,
  sortNodesByOrder,
  type GranthaStructureConfig,
} from "@/lib/grantha-structure-sync";

/** Mirrors `SECTION_TYPE_MAP` + validation in `server/routes.ts` (`findOrCreateSection`). */
const VALID_STRAPI_SECTION_TYPES = new Set([
  "adhyay",
  "khanda",
  "valli",
  "pada",
  "kanda",
  "sukta",
  "varga",
  "anuvaka",
  "prakarana",
  "chapter",
  "part",
  "section",
  "book",
]);

const SECTION_TYPE_MAP: Record<string, string> = {
  adhyaya: "adhyay",
  adhyay: "adhyay",
  khanda: "khanda",
  valli: "valli",
  valla: "valli",
  pada: "pada",
  kanda: "kanda",
  sukta: "sukta",
  varga: "varga",
  anuvaka: "anuvaka",
  prakarana: "prakarana",
  brahmana: "brahmana",
  chapter: "chapter",
  part: "part",
  section: "section",
  book: "book",
  parichcheda: "section",
  pariccheda: "section",
  prasthanam: "book",
};

export function effectiveStrapiSectionTypeFromPortalName(name: string): string | undefined {
  if (!name?.trim()) return undefined;
  const mapped = SECTION_TYPE_MAP[name.toLowerCase().trim()];
  if (!mapped) return undefined;
  return VALID_STRAPI_SECTION_TYPES.has(mapped) ? mapped : "section";
}

export type SectionOrderSyncRow = { documentId: string; order: number; title: string };

/**
 * Push portal `order` + `title` to Strapi for every sibling section that already has a
 * `documentId` — required when inserting between existing sections so Strapi ordering
 * matches the editor (contiguous orders after normalization).
 */
export async function syncStrapiSectionOrderAndTitles(rows: SectionOrderSyncRow[]): Promise<void> {
  const valid = rows.filter((r) => isPublishedStrapiDocId(r.documentId));
  const CHUNK = 5;
  for (let i = 0; i < valid.length; i += CHUNK) {
    await Promise.all(
      valid.slice(i, i + CHUNK).map((r) =>
        apiRequest("PUT", `/api/strapi/sections/${r.documentId}`, {
          data: { order: r.order, title: r.title.trim() },
        }),
      ),
    );
  }
}

export function l1SectionSyncRowsFromAdhyayas(
  adhyayas: Array<{ order?: number; title: string; documentId?: string }>,
): SectionOrderSyncRow[] {
  return sortNodesByOrder(adhyayas)
    .filter((a) => isPublishedStrapiDocId(a.documentId))
    .map((a) => ({ documentId: a.documentId!, order: a.order ?? 0, title: a.title ?? "" }));
}

export function l2SectionSyncRowsFromKhandas(
  khandas: Array<{ order?: number; title: string; documentId?: string }>,
): SectionOrderSyncRow[] {
  return sortNodesByOrder(khandas)
    .filter((k) => k.title !== "_default" && isPublishedStrapiDocId(k.documentId))
    .map((k) => ({ documentId: k.documentId!, order: k.order ?? 0, title: k.title ?? "" }));
}

export function l3SectionSyncRowsFromPadas(
  padas: Array<{ order?: number; title: string; documentId?: string }>,
): SectionOrderSyncRow[] {
  return sortNodesByOrder(padas)
    .filter((p) => isPublishedStrapiDocId(p.documentId))
    .map((p) => ({ documentId: p.documentId!, order: p.order ?? 0, title: p.title ?? "" }));
}

/**
 * All Strapi-linked sections in portal order (L1 → L2 → L3 per adhyaya), with sibling-scoped
 * `order` and titles as shown in the editor — use after any hierarchy normalization so Strapi
 * lists match insert position and subsequent indices.
 */
export function collectAllSectionOrderSyncRowsFromHierarchy(
  adhyayas: SnapshotAdhyaya[],
  cfg: GranthaStructureConfig,
): SectionOrderSyncRow[] {
  const rows: SectionOrderSyncRow[] = [];
  const l2On = cfg.levelTwoEnabled !== false;
  const l3On = !!cfg.levelThreeEnabled;

  for (const a of sortNodesByOrder(adhyayas)) {
    if (isPublishedStrapiDocId(a.documentId)) {
      rows.push({ documentId: a.documentId!, order: a.order ?? 0, title: a.title ?? "" });
    }
    if (!l2On) continue;
    for (const k of sortNodesByOrder(a.khandas ?? [])) {
      if (k.title !== "_default" && isPublishedStrapiDocId(k.documentId)) {
        rows.push({ documentId: k.documentId!, order: k.order ?? 0, title: k.title ?? "" });
      }
      if (l3On) {
        rows.push(...l3SectionSyncRowsFromPadas(k.padas ?? []));
      }
    }
  }
  return rows;
}

export async function postStrapiSection(params: {
  title: string;
  order: number;
  granthaDocumentId: string;
  parentDocumentId?: string;
  portalTypeName: string;
}): Promise<string | undefined> {
  const type = effectiveStrapiSectionTypeFromPortalName(params.portalTypeName);
  const data: Record<string, unknown> = {
    title: params.title.trim(),
    grantha: params.granthaDocumentId,
    order: params.order,
  };
  if (type) data.type = type;
  if (params.parentDocumentId && isPublishedStrapiDocId(params.parentDocumentId)) {
    data.parent = params.parentDocumentId;
  }
  const res = await apiRequest("POST", "/api/strapi/sections", { data });
  const json = await res.json();
  const docId = json?.data?.documentId ?? json?.data?.document?.documentId;
  return typeof docId === "string" && docId.length >= 10 ? docId : undefined;
}

/** L3 → L2 → L1 so Strapi parent relations are torn down safely after mantras are gone. */
export function collectSectionDocumentIdsChildToParentForAdhyaya(target: {
  documentId?: string;
  khandas: Array<{
    documentId?: string;
    padas?: Array<{ documentId?: string }>;
  }>;
}): string[] {
  const out: string[] = [];
  for (const k of target.khandas ?? []) {
    for (const p of k.padas ?? []) {
      if (isPublishedStrapiDocId(p.documentId)) out.push(p.documentId!);
    }
    if (isPublishedStrapiDocId(k.documentId)) out.push(k.documentId!);
  }
  if (isPublishedStrapiDocId(target.documentId)) out.push(target.documentId!);
  return out;
}

export function collectSectionDocumentIdsChildToParentForKhanda(k: {
  documentId?: string;
  padas?: Array<{ documentId?: string }>;
}): string[] {
  const out: string[] = [];
  for (const p of k.padas ?? []) {
    if (isPublishedStrapiDocId(p.documentId)) out.push(p.documentId!);
  }
  if (isPublishedStrapiDocId(k.documentId)) out.push(k.documentId!);
  return out;
}

async function deleteStrapiMantraBestEffort(documentId: string): Promise<boolean> {
  try {
    await apiRequest("DELETE", `/api/strapi/manthras/${documentId}`);
    return true;
  } catch (e: unknown) {
    if (e instanceof ApiError && e.status === 404) return true;
    return false;
  }
}

async function deleteStrapiSectionBestEffort(documentId: string): Promise<boolean> {
  try {
    await apiRequest("DELETE", `/api/strapi/sections/${documentId}`);
    return true;
  } catch (e: unknown) {
    if (e instanceof ApiError && e.status === 404) return true;
    return false;
  }
}

/** Sequential mantra deletes to avoid races; sections are ordered child → parent. */
export async function strapiDeleteMantrasThenSections(params: {
  mantraDocumentIds: string[];
  sectionDocumentIdsChildToParent: string[];
}): Promise<{ failedMantraIds: string[]; failedSectionIds: string[] }> {
  const failedMantraIds: string[] = [];
  for (const id of params.mantraDocumentIds) {
    const ok = await deleteStrapiMantraBestEffort(id);
    if (!ok) failedMantraIds.push(id);
  }

  const failedSectionIds: string[] = [];
  for (const sid of params.sectionDocumentIdsChildToParent) {
    const ok = await deleteStrapiSectionBestEffort(sid);
    if (!ok) failedSectionIds.push(sid);
  }

  return { failedMantraIds, failedSectionIds };
}

export async function deleteStrapiTeekaBestEffort(documentId: string): Promise<boolean> {
  try {
    await apiRequest("DELETE", `/api/strapi/teekas/${documentId}`);
    return true;
  } catch (e: unknown) {
    if (e instanceof ApiError && e.status === 404) return true;
    return false;
  }
}
