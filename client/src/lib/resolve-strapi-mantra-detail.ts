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

/**
 * Total publishable text on a mantra — Shloka + Bhashyam + every Teeka.
 * Scoring only the verse text wrongly treats a commentary-only mantra (bhashyam/teeka
 * added but no Shloka) as "empty", which makes the resolver swap it for a content-bearing
 * sibling and surface that sibling's bhashyam/teeka on the wrong verse.
 */
export function mantraContentScore(mantra: unknown): number {
  if (!mantra || typeof mantra !== "object") return 0;
  const m = mantra as Record<string, any>;
  let score = entryContentScore(m.ShlokaManthraEntry) + entryContentScore(m.BhashyamEntry);
  if (Array.isArray(m.Teekas)) {
    for (const t of m.Teekas) score += entryContentScore(t?.TeekaEntry);
  }
  return score;
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
      contentScore: mantraContentScore(data),
    };
  },
    { bypassCache: opts?.bypassCache },
  );
}

/**
 * Grantha editor: lazy-hydrate a verse's OWN content by its OWN documentId (cached).
 *
 * Draft-first model: the local draft node is the source of truth. This only fetches the
 * heavy fields (bhashyam/teeka, full translations) for an EXISTING verse by its own
 * documentId — it never resolves by label to a sibling. Inserted verses (no documentId /
 * _isNewLocal) never reach here (the editor effect short-circuits them). If the verse's own
 * row can't be loaded, we keep the local draft content rather than label-resolving — that
 * label fallback is exactly what grafted a neighbour's bhashyam onto the wrong verse.
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

  try {
    return await fetchManthraByDocumentId(opts.documentId, {
      bypassCache: opts.bypassCache,
    });
  } catch (err) {
    if (isManthraFetchAbortError(err)) throw err;
    // Keep the local draft node — never fall back to label-based sibling resolution.
    return null;
  }
}

/** True when portal title and CMS ShlokaManthraNumber refer to the same verse suffix (e.g. 1.1.2). */
export function labelsShareVerseSuffix(a: string, b: string): boolean {
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
  // The clicked row's own documentId is authoritative. A freshly-inserted ("+") mantra is
  // legitimately empty, so a content-score swap would silently redirect the edit to a
  // content-bearing sibling that shares the verse-suffix label — surfacing that sibling's
  // bhashyam/teeka on the new verse and writing the user's edits to the wrong row. So we
  // only fall through to label-based resolution when this row cannot be loaded at all
  // (orphaned / locale-null), never merely because it is empty.
  try {
    return await fetchManthraByDocumentId(item.documentId, { signal });
  } catch (err) {
    if (isManthraFetchAbortError(err)) throw err;
    return await fetchResolvedManthraDetail({
      documentId: item.documentId,
      granthaDocId: item.grantha?.documentId,
      sectionDocId: item.section?.documentId,
      shlokaManthraNumber: item.ShlokaManthraNumber,
      signal,
    });
  }
}
