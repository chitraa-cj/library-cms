import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type {
  ResolvedVideos,
  VideoNodeRef,
  VideoTargetType,
} from "@shared/video-resource-resolve";

/**
 * Resolve the YouTube video(s) to show for a hierarchy node, applying the
 * inherit-with-fallback policy on the server. Pass the node plus its ancestry
 * ordered NEAREST-FIRST toward the root (grantha last).
 *
 * Example for a manthra:
 *   useNodeVideos(
 *     { type: "manthra", documentId: mantraDocId },
 *     [
 *       { type: "section", documentId: khandaDocId },
 *       { type: "section", documentId: adhyayaDocId },
 *       { type: "grantha", documentId: granthaDocId },
 *     ],
 *   )
 */
export function useNodeVideos(
  node: { type: VideoTargetType; documentId: string } | null | undefined,
  ancestors: VideoNodeRef[] = [],
  options?: { enabled?: boolean },
) {
  const docId = node?.documentId;
  const type = node?.type;
  const ancestorsParam = ancestors
    .filter((a) => a?.documentId && a?.type)
    .map((a) => `${a.type}:${a.documentId}`)
    .join(",");

  return useQuery<ResolvedVideos>({
    queryKey: ["/api/strapi/video-resources/for-node", type, docId, ancestorsParam],
    queryFn: async () => {
      const params = new URLSearchParams({ type: type!, docId: docId! });
      if (ancestorsParam) params.set("ancestors", ancestorsParam);
      const res = await apiRequest(
        "GET",
        `/api/strapi/video-resources/for-node?${params.toString()}`,
      );
      const json = await res.json();
      return (json?.data ?? { videos: [], inheritedFrom: null }) as ResolvedVideos;
    },
    enabled: (options?.enabled ?? true) && !!docId && !!type,
    staleTime: 60_000,
  });
}
