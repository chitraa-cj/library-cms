/**
 * Resolve which YouTube video(s) apply to a node in the grantha hierarchy.
 *
 * A VideoResource is pinned to exactly one node via (target_type, target_doc_id).
 * A node is any of: the whole grantha, a section (adhyaya / khanda / kanda / pada),
 * or a single manthra. Every node already carries a stable Strapi `documentId`, so
 * that id is the join key — no polymorphic relation gymnastics needed.
 *
 * Scope policy (decided with product): INHERIT-WITH-FALLBACK, MANY-PER-NODE.
 *   - A node shows ALL of its own videos (ordered by sortOrder) when it has any.
 *   - When a node has none of its own, it falls back to the NEAREST ancestor that
 *     does (pada -> khanda -> adhyaya -> grantha), and shows that ancestor's videos.
 *   - `inheritedFrom` tells the reader whether the videos are the node's own or borrowed.
 *
 * This module is pure (no I/O) so it can run identically on the server proxy and in
 * the client. Mirror any change here in both consumers, like the mantra/section
 * resolve helpers already do.
 */

export type VideoTargetType = "grantha" | "section" | "manthra";

/** Which kind of section a section-scoped video is pinned to (display / filtering only). */
export type VideoSectionKind = "adhyaya" | "khanda" | "kanda" | "pada";

export interface VideoResource {
  /** Strapi documentId of the VideoResource row itself. */
  documentId?: string;
  youtubeUrl: string;
  title?: string;
  targetType: VideoTargetType;
  /** Strapi documentId of the node this video is pinned to. */
  targetDocId: string;
  targetSectionType?: VideoSectionKind | null;
  /** Deep-link offset into the video, in seconds. */
  startSeconds?: number | null;
  language?: string | null;
  /** Orders the multiple videos that share one node. Ascending. */
  sortOrder?: number | null;
}

/**
 * One rung of a node's ancestry chain, ordered SELF FIRST then toward the root.
 * For a manthra that is typically:
 *   [{manthra}, {pada?}, {khanda}, {adhyaya}, {grantha}]
 * The caller builds this from whatever hierarchy it already has in hand.
 */
export interface VideoNodeRef {
  type: VideoTargetType;
  documentId: string;
}

export interface ResolvedVideos {
  videos: VideoResource[];
  /**
   * null  -> the videos belong to the requested node itself.
   * else  -> the node had none of its own; these were inherited from this ancestor.
   */
  inheritedFrom: VideoNodeRef | null;
}

const EMPTY: ResolvedVideos = { videos: [], inheritedFrom: null };

function bySortOrder(a: VideoResource, b: VideoResource): number {
  const av = a.sortOrder ?? 0;
  const bv = b.sortOrder ?? 0;
  if (av !== bv) return av - bv;
  // Stable secondary key so ordering is deterministic when sortOrder ties/absent.
  return (a.title ?? a.documentId ?? "").localeCompare(b.title ?? b.documentId ?? "");
}

/**
 * Group every video by the documentId it targets. Build this once from the full
 * VideoResource list, then resolve many nodes against it cheaply.
 */
export function indexVideosByTarget(
  videos: VideoResource[],
): Map<string, VideoResource[]> {
  const byTarget = new Map<string, VideoResource[]>();
  for (const v of videos) {
    if (!v?.targetDocId || !v?.youtubeUrl) continue;
    const bucket = byTarget.get(v.targetDocId);
    if (bucket) bucket.push(v);
    else byTarget.set(v.targetDocId, [v]);
  }
  for (const bucket of byTarget.values()) bucket.sort(bySortOrder);
  return byTarget;
}

/**
 * Resolve the videos to show for a node, applying inherit-with-fallback.
 *
 * @param chain  Ancestry ordered SELF FIRST toward the root (see VideoNodeRef).
 * @param index  Output of {@link indexVideosByTarget}.
 */
export function resolveVideosForNode(
  chain: VideoNodeRef[],
  index: Map<string, VideoResource[]>,
): ResolvedVideos {
  if (!chain?.length) return EMPTY;
  const [self, ...ancestors] = chain;

  const own = index.get(self.documentId);
  if (own && own.length) return { videos: own, inheritedFrom: null };

  for (const ancestor of ancestors) {
    const inherited = index.get(ancestor.documentId);
    if (inherited && inherited.length) {
      return { videos: inherited, inheritedFrom: ancestor };
    }
  }
  return EMPTY;
}

/**
 * Convenience wrapper when you only have the flat VideoResource list (small collection).
 * Prefer indexVideosByTarget + resolveVideosForNode when resolving many nodes.
 */
export function resolveVideos(
  chain: VideoNodeRef[],
  videos: VideoResource[],
): ResolvedVideos {
  return resolveVideosForNode(chain, indexVideosByTarget(videos));
}

/** Map a raw Strapi VideoResource entry (snake/PascalCase attrs) to our shape. */
export function fromStrapiVideoResource(entry: any): VideoResource | null {
  const a = entry?.attributes ?? entry;
  if (!a) return null;
  const youtubeUrl = a.youtube_url ?? a.youtubeUrl;
  const targetDocId = a.target_doc_id ?? a.targetDocId;
  const targetType = a.target_type ?? a.targetType;
  if (!youtubeUrl || !targetDocId || !targetType) return null;
  return {
    documentId: entry?.documentId ?? a.documentId,
    youtubeUrl,
    title: a.title ?? undefined,
    targetType,
    targetDocId,
    targetSectionType: a.target_section_type ?? a.targetSectionType ?? null,
    startSeconds: a.start_seconds ?? a.startSeconds ?? null,
    language: a.language ?? null,
    sortOrder: a.sort_order ?? a.sortOrder ?? null,
  };
}
