import { MANTRA_LINK_MIN_CONTENT_SCORE } from "@/lib/grantha-structure-sync";
import { apiRequest } from "@/lib/queryClient";
import {
  fetchManthraDetailCached,
  invalidateManthraCacheOnDocIdCorrection,
  setCachedManthraDetail,
} from "@/lib/mantra-cms-cache";

export type ResolvedManthraDetail = {
  data: Record<string, any>;
  documentId: string;
  corrected: boolean;
  contentScore?: number;
};

function entryContentScore(entry: unknown): number {
  if (!entry || typeof entry !== "object") return 0;
  const e = entry as Record<string, unknown>;
  const blocksLen = (v: unknown) => {
    if (!Array.isArray(v)) return 0;
    return v
      .map((b) =>
        ((b as { children?: { text?: string }[] })?.children ?? [])
          .map((c) => c.text || "")
          .join(""),
      )
      .join("")
      .trim().length;
  };
  return blocksLen(e.SanskritTextEntry) + blocksLen(e.EnglishTranslationText);
}

export function isManthraFetchAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

/** One Strapi GET — full manthra (cached). */
export async function fetchManthraByDocumentId(
  documentId: string,
  opts?: { signal?: AbortSignal; bypassCache?: boolean },
): Promise<ResolvedManthraDetail> {
  return fetchManthraDetailCached(
    documentId,
    async () => {
    const res = await apiRequest("GET", `/api/strapi/manthras/${documentId}`, undefined, {
      signal: opts?.signal,
    });
    const json = await res.json();
    const data = json?.data ?? json;
    if (!data?.documentId) {
      throw new Error("Manthra not found in CMS");
    }
    return {
      data,
      documentId: data.documentId || documentId,
      corrected: false,
      contentScore: entryContentScore(data.ShlokaManthraEntry),
    };
  },
    { bypassCache: opts?.bypassCache },
  );
}

/**
 * Grantha editor: direct CMS fetch by documentId (cached).
 * Resolve-for-edit runs only when the row is missing, empty, or duplicate-linked.
 */
export async function fetchManthraForGranthaEditor(opts: {
  documentId: string;
  granthaDocId?: string;
  sectionDocId?: string;
  shlokaManthraNumber?: string;
  localContentScore?: number;
  /** When true, skip network — hierarchy already has shloka from grantha open. */
  skipFetch?: boolean;
  /** Background refresh for teekas/bhashyam only (shloka already in state). */
  background?: boolean;
  /** Foreground editor open — skip in-memory cache so verse text is always fresh. */
  bypassCache?: boolean;
}): Promise<ResolvedManthraDetail | null> {
  if (opts.skipFetch) return null;

  const localScore = opts.localContentScore ?? 0;

  try {
    const direct = await fetchManthraByDocumentId(opts.documentId, {
      bypassCache: opts.bypassCache,
    });
    const remoteScore = direct.contentScore ?? 0;
    const needsResolve =
      remoteScore < MANTRA_LINK_MIN_CONTENT_SCORE ||
      (opts.shlokaManthraNumber &&
        direct.data.ShlokaManthraNumber &&
        !labelsShareSuffix(opts.shlokaManthraNumber, String(direct.data.ShlokaManthraNumber)));

    if (!needsResolve) return direct;
    if (opts.background && localScore >= MANTRA_LINK_MIN_CONTENT_SCORE) {
      return direct;
    }
  } catch {
    /* fall through to resolve */
  }

  if (opts.background && localScore >= MANTRA_LINK_MIN_CONTENT_SCORE) {
    return null;
  }

  return fetchResolvedManthraDetail(opts);
}

function labelsShareSuffix(a: string, b: string): boolean {
  const sa = a.trim().match(/([\d]+(?:\.[\d]+)*)\s*$/)?.[1];
  const sb = b.trim().match(/([\d]+(?:\.[\d]+)*)\s*$/)?.[1];
  return !!(sa && sb && sa === sb);
}

/**
 * Mantras tab + duplicate resolution — section-scoped resolve on server (not whole grantha).
 */
export async function fetchResolvedManthraDetail(opts: {
  documentId: string;
  granthaDocId?: string;
  sectionDocId?: string;
  shlokaManthraNumber?: string;
  configuredLeaf?: string;
  signal?: AbortSignal;
}): Promise<ResolvedManthraDetail> {
  const params = new URLSearchParams();
  if (opts.shlokaManthraNumber?.trim()) params.set("label", opts.shlokaManthraNumber.trim());
  params.set("preferredDocId", opts.documentId);
  if (opts.sectionDocId) params.set("sectionDocId", opts.sectionDocId);

  const res = await fetch(`/api/strapi/manthras/resolve-for-edit?${params.toString()}`, {
    credentials: "include",
    cache: "no-store",
    signal: opts.signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { message?: string }).message || `Resolve failed (${res.status})`);
  }
  const json = (await res.json()) as ResolvedManthraDetail & {
    data: Record<string, any>;
  };
  const result = {
    data: json.data,
    documentId: json.documentId || opts.documentId,
    corrected: !!json.corrected,
    contentScore: json.contentScore,
  };
  invalidateManthraCacheOnDocIdCorrection(opts.documentId, result.documentId, result.corrected);
  setCachedManthraDetail(result.documentId, result);
  return result;
}

/** Mantras tab: direct GET then section-scoped resolve when the list row is empty or duplicate-linked. */
export async function fetchPublishedManthraForEdit(
  item: {
    documentId: string;
    grantha?: { documentId?: string };
    section?: { documentId?: string };
    ShlokaManthraNumber?: string;
  },
  opts?: { signal?: AbortSignal },
): Promise<ResolvedManthraDetail> {
  const signal = opts?.signal;
  let result = await fetchManthraByDocumentId(item.documentId, { signal });
  const score = result.contentScore ?? 0;
  if (score < MANTRA_LINK_MIN_CONTENT_SCORE) {
    result = await fetchResolvedManthraDetail({
      documentId: item.documentId,
      granthaDocId: item.grantha?.documentId,
      sectionDocId: item.section?.documentId,
      shlokaManthraNumber: item.ShlokaManthraNumber,
      signal,
    });
  }
  return result;
}
