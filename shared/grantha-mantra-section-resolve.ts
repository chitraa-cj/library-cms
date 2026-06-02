/**
 * Resolve which Strapi section owns mantras for a portal hierarchy node.
 * Shared by client sync, server slot sync, and publish — must stay aligned.
 */

export const STRAPI_DOC_ID_MIN = 10;

export function isPublishedStrapiDocId(id: string | undefined | null): id is string {
  return typeof id === "string" && id.length >= STRAPI_DOC_ID_MIN;
}

export type StrapiSectionRef = {
  documentId: string;
  title?: string;
};

export type MantraSectionNode = {
  id: string;
  title?: string;
  documentId?: string;
  khandas?: MantraKhandaNode[];
};

export type MantraKhandaNode = {
  id: string;
  title?: string;
  documentId?: string;
  padas?: MantraPadaNode[];
  manthras?: unknown[];
};

export type MantraPadaNode = {
  id: string;
  title?: string;
  documentId?: string;
  manthras?: unknown[];
};

export type GranthaStructureConfigLite = {
  levelTwoEnabled?: boolean;
  levelThreeEnabled?: boolean;
};

export type MantraSectionResolveContext = {
  /** Strapi child sections by parent section documentId (from grantha section fetch). */
  childrenByParentDocId?: Map<string, StrapiSectionRef[]>;
};

/**
 * Sync section resolution — mirrors publish (`server/routes.ts`) with Strapi child fallback
 * for Vivekachudamani-style granthas where mantras live on `_default` in the portal but on
 * a real khanda section in Strapi.
 */
export function resolveMantraOwnerSectionDocId(
  snapshot: MantraSectionNode[],
  adhyayaId: string,
  khandaId: string,
  padaId: string | undefined,
  cfg: GranthaStructureConfigLite,
  ctx?: MantraSectionResolveContext,
): string | undefined {
  const a = snapshot.find((x) => x.id === adhyayaId);
  const k = a?.khandas?.find((x) => x.id === khandaId);
  if (!a || !k) return undefined;

  const levelThree = !!cfg.levelThreeEnabled;
  const levelTwo = cfg.levelTwoEnabled !== false;

  if (levelThree && padaId) {
    const p = k.padas?.find((x) => x.id === padaId);
    if (isPublishedStrapiDocId(p?.documentId)) return p!.documentId;
    return undefined;
  }

  const isDefaultKhanda = k.title === "_default" || !levelTwo;

  if (isDefaultKhanda) {
    const adhyayaDocId = a.documentId;
    if (levelTwo && k.title === "_default" && isPublishedStrapiDocId(adhyayaDocId)) {
      const childSecs = ctx?.childrenByParentDocId?.get(adhyayaDocId!) ?? [];
      if (childSecs.length > 0) {
        const realKhandaInPortal = (a.khandas ?? []).find(
          (kh) => kh.title && kh.title !== "_default" && isPublishedStrapiDocId(kh.documentId),
        );
        if (realKhandaInPortal?.documentId) return realKhandaInPortal.documentId;
        const titleMatch = realKhandaInPortal?.title
          ? childSecs.find(
              (c) =>
                (c.title ?? "").trim().toLowerCase() ===
                (realKhandaInPortal.title ?? "").trim().toLowerCase(),
            )
          : undefined;
        if (titleMatch?.documentId) return titleMatch.documentId;
        return childSecs[0]?.documentId;
      }
    }
    return isPublishedStrapiDocId(adhyayaDocId) ? adhyayaDocId : undefined;
  }

  if (isPublishedStrapiDocId(k.documentId)) return k.documentId!;

  const adhyayaDocId = a.documentId;
  if (isPublishedStrapiDocId(adhyayaDocId) && k.title?.trim()) {
    const childSecs = ctx?.childrenByParentDocId?.get(adhyayaDocId!) ?? [];
    const byTitle = childSecs.find(
      (c) => (c.title ?? "").trim().toLowerCase() === k.title!.trim().toLowerCase(),
    );
    if (byTitle?.documentId) return byTitle.documentId;
  }

  return undefined;
}
