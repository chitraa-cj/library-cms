export type ResolvedManthraDetail = {
  data: Record<string, any>;
  documentId: string;
  corrected: boolean;
  contentScore?: number;
};

/**
 * Single server-backed resolver so Grantha editor and Mantras tab always open
 * the same Strapi row (richest duplicate for this verse within the grantha).
 */
export async function fetchResolvedManthraDetail(opts: {
  documentId: string;
  granthaDocId?: string;
  sectionDocId?: string;
  shlokaManthraNumber?: string;
  configuredLeaf?: string;
}): Promise<ResolvedManthraDetail> {
  const params = new URLSearchParams();
  if (opts.shlokaManthraNumber?.trim()) params.set("label", opts.shlokaManthraNumber.trim());
  params.set("preferredDocId", opts.documentId);
  if (opts.granthaDocId) params.set("granthaDocId", opts.granthaDocId);
  if (opts.sectionDocId) params.set("sectionDocId", opts.sectionDocId);

  const res = await fetch(`/api/strapi/manthras/resolve-for-edit?${params.toString()}`, {
    credentials: "include",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { message?: string }).message || `Resolve failed (${res.status})`);
  }
  const json = (await res.json()) as ResolvedManthraDetail & {
    data: Record<string, any>;
  };
  return {
    data: json.data,
    documentId: json.documentId || opts.documentId,
    corrected: !!json.corrected,
    contentScore: json.contentScore,
  };
}
