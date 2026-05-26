import { getCachedManthraDetail } from "@/lib/mantra-cms-cache";
import { fetchManthraForGranthaEditor } from "@/lib/resolve-strapi-mantra-detail";
import {
  isPublishedStrapiDocId,
  MANTRA_LINK_MIN_CONTENT_SCORE,
  type GranthaStructureConfig,
} from "@/lib/grantha-structure-sync";
import { resolveMantraSectionStrapiDocumentId } from "@/lib/grantha-strapi-mantra-sync";
import { entryContentCharCount } from "@/lib/strapi-blocks";
import { mantraNodeHasHydratedShloka } from "@/lib/strapi-mantra-hydration";

export type ManthraPrefetchNode = {
  strapiDocumentId?: string;
  title?: string;
  ShlokaManthraEntry?: unknown;
};

export type AdhyayaLike = {
  id: string;
  documentId?: string;
  khandas: {
    id: string;
    title?: string;
    documentId?: string;
    manthras: ManthraPrefetchNode[];
    padas?: { id: string; documentId?: string; manthras: ManthraPrefetchNode[] }[];
  }[];
};

/** Live editor snapshot — getters so prefetch always sees current hierarchy. */
export type GranthaMantraPrefetchContext = {
  getGranthaDocId: () => string | undefined;
  getStructureConfig: () => GranthaStructureConfig;
  getAdhyayas: () => AdhyayaLike[];
};

const CONCURRENCY = 4;
const DEFAULT_BULK_CAP = 400;

let generation = 0;
let queue: string[] = [];
let inFlight = 0;
let prefetchCtx: GranthaMantraPrefetchContext | null = null;

function shlokaManthraEntryRichness(entry: unknown): number {
  if (!entry || typeof entry !== "object") return 0;
  const e = entry as { SanskritTextEntry?: unknown; EnglishTranslationText?: unknown };
  return (
    entryContentCharCount(e.SanskritTextEntry as any) +
    entryContentCharCount(e.EnglishTranslationText as any)
  );
}

function isManthraCacheWarm(documentId: string): boolean {
  const hit = getCachedManthraDetail(documentId);
  if (!hit) return false;
  return (hit.contentScore ?? 0) >= MANTRA_LINK_MIN_CONTENT_SCORE;
}

export function setGranthaMantraPrefetchContext(ctx: GranthaMantraPrefetchContext | null): void {
  prefetchCtx = ctx;
}

function editorOptsForDocumentId(documentId: string): Parameters<typeof fetchManthraForGranthaEditor>[0] {
  const base = { documentId, granthaDocId: prefetchCtx?.getGranthaDocId() };
  const ctx = prefetchCtx;
  if (!ctx) return base;

  const cfg = ctx.getStructureConfig();
  const adhyayas = ctx.getAdhyayas();

  for (const a of adhyayas) {
    for (const k of a.khandas) {
      for (const m of k.manthras) {
        if (m.strapiDocumentId !== documentId) continue;
        const sectionDocId = resolveMantraSectionStrapiDocumentId(
          adhyayas as Parameters<typeof resolveMantraSectionStrapiDocumentId>[0],
          a.id,
          k.id,
          undefined,
          cfg,
        );
        const localRich = shlokaManthraEntryRichness(m.ShlokaManthraEntry);
        return {
          ...base,
          sectionDocId,
          shlokaManthraNumber: m.title,
          localContentScore: localRich,
          background: mantraNodeHasHydratedShloka(m),
        };
      }
      for (const p of k.padas ?? []) {
        for (const m of p.manthras) {
          if (m.strapiDocumentId !== documentId) continue;
          const sectionDocId = resolveMantraSectionStrapiDocumentId(
            adhyayas as Parameters<typeof resolveMantraSectionStrapiDocumentId>[0],
            a.id,
            k.id,
            p.id,
            cfg,
          );
          const localRich = shlokaManthraEntryRichness(m.ShlokaManthraEntry);
          return {
            ...base,
            sectionDocId,
            shlokaManthraNumber: m.title,
            localContentScore: localRich,
            background: mantraNodeHasHydratedShloka(m),
          };
        }
      }
    }
  }

  return base;
}

function drain(gen: number): void {
  while (inFlight < CONCURRENCY && queue.length > 0 && gen === generation) {
    const id = queue.shift()!;
    if (isManthraCacheWarm(id)) continue;
    inFlight += 1;
    void fetchManthraForGranthaEditor(editorOptsForDocumentId(id))
      .catch(() => {})
      .finally(() => {
        inFlight -= 1;
        drain(gen);
      });
  }
}

function enqueue(ids: string[], front: boolean): void {
  const gen = generation;
  const seen = new Set(queue);
  const fresh = ids.filter((id) => {
    if (!id || !isPublishedStrapiDocId(id)) return false;
    if (isManthraCacheWarm(id)) return false;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (!fresh.length) return;
  if (front) queue.unshift(...fresh);
  else queue.push(...fresh);
  drain(gen);
}

/** Drop queued work when leaving the grantha editor. */
export function cancelGranthaMantraPrefetch(): void {
  generation += 1;
  queue = [];
  prefetchCtx = null;
}

/** High-priority warm (hover / about to open). */
export function prefetchManthraDocumentId(documentId: string | undefined): void {
  if (!documentId) return;
  enqueue([documentId], true);
}

export function collectPublishedManthraDocIdsFromHierarchy(adhyayas: AdhyayaLike[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const a of adhyayas) {
    for (const k of a.khandas) {
      for (const m of k.manthras) {
        const id = m.strapiDocumentId;
        if (id && isPublishedStrapiDocId(id) && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
      for (const p of k.padas ?? []) {
        for (const m of p.manthras) {
          const id = m.strapiDocumentId;
          if (id && isPublishedStrapiDocId(id) && !seen.has(id)) {
            seen.add(id);
            ids.push(id);
          }
        }
      }
    }
  }
  return ids;
}

/** Flat verse order for neighbor prefetch when a dialog opens. */
export function collectManthraDocIdsInTreeOrder(adhyayas: AdhyayaLike[]): string[] {
  const ids: string[] = [];
  for (const a of adhyayas) {
    for (const k of a.khandas) {
      for (const m of k.manthras) {
        if (m.strapiDocumentId) ids.push(m.strapiDocumentId);
      }
      for (const p of k.padas ?? []) {
        for (const m of p.manthras) {
          if (m.strapiDocumentId) ids.push(m.strapiDocumentId);
        }
      }
    }
  }
  return ids;
}

export function prefetchManthraNeighbors(
  adhyayas: AdhyayaLike[],
  ctx: { adhyayaId: string; khandaId: string; manthraId: string; padaId?: string },
): void {
  const ordered = collectManthraDocIdsInTreeOrder(adhyayas);
  const snap = adhyayas as {
    id: string;
    khandas: {
      id: string;
      manthras: { id: string; strapiDocumentId?: string }[];
      padas?: { id: string; manthras: { id: string; strapiDocumentId?: string }[] }[];
    }[];
  }[];
  let targetDocId: string | undefined;
  outer: for (const a of snap) {
    if (a.id !== ctx.adhyayaId) continue;
    for (const k of a.khandas) {
      if (k.id !== ctx.khandaId) continue;
      if (ctx.padaId) {
        for (const p of k.padas ?? []) {
          if (p.id !== ctx.padaId) continue;
          const m = p.manthras.find((x) => x.id === ctx.manthraId);
          targetDocId = m?.strapiDocumentId;
          break outer;
        }
      } else {
        const m = k.manthras.find((x) => x.id === ctx.manthraId);
        targetDocId = m?.strapiDocumentId;
        break outer;
      }
    }
  }
  if (!targetDocId) return;
  const idx = ordered.indexOf(targetDocId);
  if (idx < 0) return;
  const priority: string[] = [];
  for (let i = Math.max(0, idx - 2); i <= Math.min(ordered.length - 1, idx + 2); i++) {
    const id = ordered[i];
    if (id) priority.push(id);
  }
  const rest = ordered.filter((id) => !priority.includes(id));
  prefetchManthraDocumentIds(rest, { priority, max: 48 });
}

/**
 * Background-load full CMS rows (teekas, bhashyam) after grantha open.
 * SK/EN usually already come from sections/by-grantha.
 */
export function prefetchGranthaMantrasFromHierarchy(
  adhyayas: AdhyayaLike[],
  opts?: { priorityFirst?: number; max?: number },
): void {
  const all = collectPublishedManthraDocIdsFromHierarchy(adhyayas);
  const cap = opts?.max ?? DEFAULT_BULK_CAP;
  const trimmed = all.slice(0, cap);
  const n = opts?.priorityFirst ?? 24;
  const priority = trimmed.slice(0, n);
  const rest = trimmed.slice(n);
  prefetchManthraDocumentIds(rest, { priority });
}

export function prefetchManthraDocumentIds(
  docIds: string[],
  opts?: { priority?: string[]; max?: number },
): void {
  const cap = opts?.max ?? DEFAULT_BULK_CAP;
  const priority = (opts?.priority ?? []).slice(0, cap);
  const priSet = new Set(priority);
  const rest = docIds.filter((id) => !priSet.has(id)).slice(0, Math.max(0, cap - priority.length));
  enqueue(priority, true);
  enqueue(rest, false);
}
