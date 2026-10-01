import NodeVideos, {
  newNodeVideoDraft,
  nodeVideosFromSaved,
  nodeVideosFromDraftPayload,
  nodeVideosToDraftPayload,
  nodeVideosQueryKey,
  type NodeVideoDraft,
  type SavedNodeVideo,
} from "@/components/node-videos";

/**
 * The grantha-scoped view of {@link NodeVideos}. Granthas were the first node type to
 * carry videos, so the wizard imports these names; the list itself, and every other
 * node type (section, manthra), live in `node-videos.tsx`.
 */
export type GranthaVideoDraft = NodeVideoDraft;
export type SavedGranthaVideo = SavedNodeVideo;

export const newGranthaVideoDraft = newNodeVideoDraft;
export const granthaVideosFromSaved = nodeVideosFromSaved;
export const granthaVideosFromDraftPayload = nodeVideosFromDraftPayload;
export const granthaVideosToDraftPayload = nodeVideosToDraftPayload;
export const granthaVideosQueryKey = (granthaDocId?: string) =>
  nodeVideosQueryKey("grantha", granthaDocId);

interface GranthaVideosProps {
  videos: GranthaVideoDraft[];
  onChange: (videos: GranthaVideoDraft[]) => void;
  /** Strapi documentId of the grantha, or undefined when it isn't published yet. */
  granthaDocId?: string;
  viewOnly?: boolean;
}

export default function GranthaVideos({
  videos,
  onChange,
  granthaDocId,
  viewOnly = false,
}: GranthaVideosProps) {
  return (
    <NodeVideos
      targetType="grantha"
      targetDocId={granthaDocId}
      videos={videos}
      onChange={onChange}
      viewOnly={viewOnly}
      description={
        "YouTube links for this grantha. They show on the site in the order listed " +
        "here — drag-free: use the arrows to reorder. Saving writes to the CMS " +
        "immediately, no republish needed."
      }
      unsavedNodeHint="Saved with the draft — written to the CMS when you first publish this grantha."
      testIdPrefix="grantha-video"
    />
  );
}
