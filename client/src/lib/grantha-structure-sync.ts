/**
 * Pure helpers for Grantha hierarchy ↔ structure config alignment.
 * Kept out of the page component so async loaders (e.g. openEdit) can run
 * the same normalization as the wizard "Next" step without ordering bugs.
 */

export const STRAPI_DOCUMENT_ID_MIN_LENGTH = 10;

export function isPublishedStrapiDocId(id: string | undefined): id is string {
  return typeof id === "string" && id.length >= STRAPI_DOCUMENT_ID_MIN_LENGTH;
}

export function sortNodesByOrder<T extends { order?: number }>(nodes: T[]): T[] {
  return [...nodes].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Subset of portal `structureConfig` used for sync logic */
export interface GranthaStructureConfig {
  levelOneEnabled?: boolean;
  levelOneName?: string;
  levelTwoEnabled?: boolean;
  levelTwoName?: string;
  levelThreeEnabled?: boolean;
  levelThreeName?: string;
  leafName?: string;
}

export interface SyncManthraNode {
  id: string;
  title: string;
  order: number;
  strapiDocumentId?: string;
}

export interface SyncPadaNode {
  id: string;
  title: string;
  order: number;
  manthras: SyncManthraNode[];
  expanded: boolean;
  documentId?: string;
}

export interface SyncKhandaNode {
  id: string;
  title: string;
  order: number;
  padas: SyncPadaNode[];
  manthras: SyncManthraNode[];
  expanded: boolean;
  documentId?: string;
}

export interface SyncAdhyayaNode {
  id: string;
  title: string;
  order: number;
  khandas: SyncKhandaNode[];
  expanded: boolean;
  documentId?: string;
}

function newLocalId(): string {
  return Math.random().toString(36).slice(2, 9);
}

export function collectPublishedManthraDocIdsFromKhanda(k: SyncKhandaNode): string[] {
  const ids: string[] = [];
  for (const m of k.manthras ?? []) {
    if (isPublishedStrapiDocId(m.strapiDocumentId)) ids.push(m.strapiDocumentId);
  }
  for (const p of k.padas ?? []) {
    for (const m of p.manthras ?? []) {
      if (isPublishedStrapiDocId(m.strapiDocumentId)) ids.push(m.strapiDocumentId);
    }
  }
  return ids;
}

export function collectPublishedManthraDocIdsFromAdhyaya(a: SyncAdhyayaNode): string[] {
  const ids: string[] = [];
  for (const k of a.khandas ?? []) {
    ids.push(...collectPublishedManthraDocIdsFromKhanda(k));
  }
  return ids;
}

/**
 * When the book structure is "flat" (no real khandas), ensure each adhyaya has a single `_default` khanda.
 * When L3 is off, collapse padas into khanda.manthras. Collect Strapi section documentIds that are removed
 * from the logical tree so the client can queue them for DELETE on publish.
 */
export function prepareHierarchyForContentStep(
  list: SyncAdhyayaNode[],
  cfg: GranthaStructureConfig,
): { hierarchy: SyncAdhyayaNode[]; sectionDocIdsToMarkDeleted: string[] } {
  const levelTwoEnabled = cfg.levelTwoEnabled !== false;
  const levelThreeEnabled = !!cfg.levelThreeEnabled;

  if (levelTwoEnabled && levelThreeEnabled) {
    return { hierarchy: list, sectionDocIdsToMarkDeleted: [] };
  }

  const sectionDocIdsToMarkDeleted: string[] = [];
  const pushSectionDoc = (id?: string) => {
    if (isPublishedStrapiDocId(id)) sectionDocIdsToMarkDeleted.push(id);
  };

  const next = list.map((a) => {
    const khandas = a.khandas ?? [];

    if (!levelTwoEnabled) {
      const needsMerge =
        khandas.length !== 1 ||
        khandas[0]?.title !== "_default" ||
        (khandas[0]?.padas ?? []).length > 0 ||
        khandas.some((k) => (k.padas ?? []).length > 0);
      if (!needsMerge) return a;

      const preferred = khandas.find((k) => k.title === "_default") ?? khandas[0];
      for (const k of khandas) {
        if (preferred && k.id === preferred.id) continue;
        pushSectionDoc(k.documentId);
        for (const p of k.padas ?? []) pushSectionDoc(p.documentId);
      }
      if (preferred) {
        for (const p of preferred.padas ?? []) pushSectionDoc(p.documentId);
      }

      const allManthras: SyncManthraNode[] = [];
      for (const k of khandas) {
        for (const m of k.manthras ?? []) allManthras.push(m);
        for (const p of k.padas ?? []) {
          for (const m of p.manthras ?? []) allManthras.push(m);
        }
      }

      return {
        ...a,
        khandas: [
          {
            id: preferred?.id ?? newLocalId(),
            title: "_default",
            order: 1,
            padas: [],
            manthras: sortNodesByOrder(allManthras),
            expanded: true,
            ...(preferred?.documentId ? { documentId: preferred.documentId } : {}),
          },
        ],
      };
    }

    if (!levelThreeEnabled) {
      let anyPada = false;
      for (const k of khandas) {
        if ((k.padas ?? []).length > 0) {
          anyPada = true;
          break;
        }
      }
      if (!anyPada) return a;

      const newKhandas = khandas.map((k) => {
        const padas = k.padas ?? [];
        if (padas.length === 0) return k;
        for (const p of padas) pushSectionDoc(p.documentId);
        const fromPadas = padas.flatMap((p) => p.manthras ?? []);
        return { ...k, padas: [], manthras: sortNodesByOrder([...(k.manthras ?? []), ...fromPadas]) };
      });
      return { ...a, khandas: newKhandas };
    }

    return a;
  });

  return { hierarchy: next, sectionDocIdsToMarkDeleted };
}
