import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  ArrowDown,
  ArrowUp,
  Loader2,
  Play,
  Plus,
  Save,
  X,
} from "lucide-react";
import {
  parseYouTubeLink,
  youTubeThumbnailUrl,
} from "@shared/youtube-url";
import type { VideoTargetType } from "@shared/video-resource-resolve";

/** One row of a node's video list while it is being edited. */
export interface NodeVideoDraft {
  /** Stable key for React / reordering — not persisted. */
  key: string;
  /** Strapi documentId of the VideoResource row, once it has been saved. */
  documentId?: string;
  youtubeUrl: string;
  title: string;
  startSeconds?: number;
}

/** Shape returned by `/api/strapi/video-resources/for-target/:type/:docId`. */
export interface SavedNodeVideo {
  documentId: string;
  youtubeUrl: string;
  videoId: string | null;
  title: string;
  startSeconds: number;
  language: string | null;
  order: number;
}

let videoKeySeq = 0;
const nextKey = () => `nv-${Date.now().toString(36)}-${videoKeySeq++}`;

export function newNodeVideoDraft(): NodeVideoDraft {
  return { key: nextKey(), youtubeUrl: "", title: "" };
}

/** Saved CMS rows -> editor rows. */
export function nodeVideosFromSaved(rows: SavedNodeVideo[]): NodeVideoDraft[] {
  return rows.map((row) => ({
    key: row.documentId || nextKey(),
    documentId: row.documentId,
    youtubeUrl: row.youtubeUrl,
    title: row.title || "",
    startSeconds: row.startSeconds || 0,
  }));
}

/** Portal-draft JSON (`_videos`) -> editor rows. Keys are regenerated on load. */
export function nodeVideosFromDraftPayload(raw: any): NodeVideoDraft[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v: any) => ({
      key: nextKey(),
      documentId: typeof v?.documentId === "string" && v.documentId ? v.documentId : undefined,
      youtubeUrl: String(v?.youtubeUrl ?? "").trim(),
      title: String(v?.title ?? ""),
      startSeconds: Number(v?.startSeconds) > 0 ? Math.floor(Number(v.startSeconds)) : 0,
    }))
    .filter((v) => v.youtubeUrl !== "");
}

/** Editor rows -> portal-draft JSON. Order in the array is the display order. */
export function nodeVideosToDraftPayload(videos: NodeVideoDraft[]) {
  return videos
    .filter((v) => v.youtubeUrl.trim() !== "")
    .map((v, i) => ({
      documentId: v.documentId,
      youtubeUrl: v.youtubeUrl.trim(),
      title: v.title.trim(),
      startSeconds: v.startSeconds ?? 0,
      order: i + 1,
    }));
}

/** The comparable part of a row — used to tell "edited" from "same as saved". */
function rowSignature(v: NodeVideoDraft): string {
  return JSON.stringify([v.documentId ?? "", v.youtubeUrl.trim(), v.title.trim(), v.startSeconds ?? 0]);
}

export function listSignature(videos: NodeVideoDraft[]): string {
  return videos.map(rowSignature).join("|");
}

/** React-Query key for one node's saved video list. */
export function nodeVideosQueryKey(targetType: VideoTargetType, targetDocId?: string) {
  return ["/api/strapi/video-resources/for-target", targetType, targetDocId] as const;
}

interface NodeVideosProps {
  /** Which kind of node these videos are pinned to. */
  targetType: VideoTargetType;
  /** Strapi documentId of the node, or undefined when it isn't in the CMS yet. */
  targetDocId?: string;
  videos: NodeVideoDraft[];
  onChange: (videos: NodeVideoDraft[]) => void;
  viewOnly?: boolean;
  /** Heading above the list. */
  label?: string;
  /** Helper line under the heading. */
  description?: string;
  /** Shown instead of the Save button when the node has no documentId yet. */
  unsavedNodeHint?: string;
  /** Prefix for data-testid attributes (e.g. "grantha-video", "manthra-video"). */
  testIdPrefix?: string;
  /** Tighter spacing + no md:col-span-2, for use inside a dialog. */
  compact?: boolean;
}

/**
 * The videos pinned to ONE node of the grantha hierarchy — the whole grantha, a
 * section, or a single manthra — as an ordered list. Position in the list IS the
 * display order on the reading site (1, 2, 3…), and a node can carry as many videos
 * as it likes. Like the cover image, saving writes straight to the CMS — no republish.
 * For a node that isn't in the CMS yet the list is kept in the portal draft and
 * written on its first publish.
 *
 * Resolution on the reading side is inherit-with-fallback (see
 * `shared/video-resource-resolve.ts`): a manthra with its own videos shows those,
 * otherwise it borrows the nearest ancestor's.
 */
export default function NodeVideos({
  targetType,
  targetDocId,
  videos,
  onChange,
  viewOnly = false,
  label = "Videos",
  description,
  unsavedNodeHint,
  testIdPrefix = "node-video",
  compact = false,
}: NodeVideosProps) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  /** Signature of what the CMS currently holds, so we can show "unsaved changes". */
  const [savedSignature, setSavedSignature] = useState<string | null>(null);
  /** Which node we have already seeded from the CMS (re-seed when it changes). */
  const seededForRef = useRef<string | null>(null);

  const { data, isLoading } = useQuery<{ data: SavedNodeVideo[]; available: boolean; message?: string }>({
    queryKey: nodeVideosQueryKey(targetType, targetDocId),
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/strapi/video-resources/for-target/${targetType}/${targetDocId}`,
      );
      return res.json();
    },
    enabled: !!targetDocId,
    staleTime: 60_000,
  });

  // Seed the editor from the CMS once per node. The CMS is the source of truth for a
  // node that exists there (saves here write to it immediately), so a fetched list
  // replaces whatever the portal draft carried — but only on first load, never on a
  // refetch that would wipe in-progress edits.
  useEffect(() => {
    if (!targetDocId || !data?.available) return;
    const fetched = nodeVideosFromSaved(data.data ?? []);
    const fetchedSignature = listSignature(fetched);

    if (seededForRef.current !== targetDocId) {
      seededForRef.current = targetDocId;
      setSavedSignature(fetchedSignature);
      // An empty CMS list never wipes rows the editor already holds — those are
      // draft-only rows (a node published moments ago, or links not saved yet).
      if (fetched.length > 0 || videos.length === 0) onChange(fetched);
      return;
    }

    // Already seeded: only refresh the "what the CMS holds" baseline when the editor
    // matches it anyway (e.g. the publish flush just wrote this list), so a refetch
    // can clear a stale "Unsaved" badge without ever touching in-progress edits.
    if (savedSignature !== fetchedSignature && listSignature(videos) === fetchedSignature) {
      setSavedSignature(fetchedSignature);
    }
  }, [targetDocId, data, onChange, videos, savedSignature]);

  const cmsUnavailable = !!targetDocId && data?.available === false;

  const parsedRows = useMemo(
    () => videos.map((v) => (v.youtubeUrl.trim() ? parseYouTubeLink(v.youtubeUrl) : null)),
    [videos],
  );
  const firstInvalidIndex = videos.findIndex((v, i) => v.youtubeUrl.trim() !== "" && !parsedRows[i]);
  const hasEmptyRow = videos.some((v) => !v.youtubeUrl.trim());
  const dirty = savedSignature !== null && listSignature(videos) !== savedSignature;
  const canSave =
    !viewOnly && !saving && firstInvalidIndex < 0 && !hasEmptyRow && (dirty || savedSignature === null);

  function update(index: number, patch: Partial<NodeVideoDraft>) {
    onChange(videos.map((v, i) => (i === index ? { ...v, ...patch } : v)));
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= videos.length) return;
    const next = [...videos];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  function remove(index: number) {
    onChange(videos.filter((_, i) => i !== index));
  }

  async function handleSave() {
    if (!targetDocId) return;
    setSaving(true);
    try {
      const res = await apiRequest(
        "PUT",
        `/api/strapi/video-resources/for-target/${targetType}/${targetDocId}`,
        {
          videos: videos.map((v) => ({
            documentId: v.documentId,
            youtubeUrl: v.youtubeUrl.trim(),
            title: v.title.trim(),
            startSeconds: v.startSeconds ?? 0,
          })),
        },
      );
      const json = (await res.json()) as { data: SavedNodeVideo[] };
      const saved = nodeVideosFromSaved(json.data ?? []);
      onChange(saved);
      setSavedSignature(listSignature(saved));
      queryClient.invalidateQueries({ queryKey: nodeVideosQueryKey(targetType, targetDocId) });
      queryClient.invalidateQueries({ queryKey: ["/api/strapi/video-resources/for-node"] });
      toast({
        title: saved.length ? `${saved.length} video${saved.length > 1 ? "s" : ""} saved` : "Videos cleared",
        description: "Saved to the CMS in this order — no need to publish.",
      });
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Could not save videos",
        description: err?.message || "The CMS rejected the video list.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={compact ? "" : "md:col-span-2"} data-testid={`section-${testIdPrefix}s`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label>{label}</Label>
          {description ? (
            <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
          ) : null}
        </div>
        {dirty ? (
          <Badge variant="outline" className="shrink-0 text-amber-600 border-amber-500/50">
            Unsaved
          </Badge>
        ) : null}
      </div>

      {isLoading && targetDocId ? (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading videos…
        </div>
      ) : null}

      <div className="mt-2 space-y-2">
        {videos.map((video, index) => {
          const parsed = parsedRows[index];
          const invalid = video.youtubeUrl.trim() !== "" && !parsed;
          return (
            <div
              key={video.key}
              className="flex items-start gap-2 rounded-lg border p-2"
              data-testid={`row-${testIdPrefix}-${index}`}
            >
              <div className="flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded bg-muted/50">
                {parsed ? (
                  <img
                    src={youTubeThumbnailUrl(parsed.videoId)}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <Play className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
              <Badge variant="secondary" className="mt-2 shrink-0 tabular-nums">
                {index + 1}
              </Badge>
              <div className="grid flex-1 grid-cols-1 gap-2 md:grid-cols-2">
                <div>
                  <Input
                    value={video.youtubeUrl}
                    onChange={(e) => update(index, { youtubeUrl: e.target.value })}
                    placeholder="https://www.youtube.com/watch?v=…"
                    disabled={viewOnly}
                    className={`h-8 text-sm ${invalid ? "border-destructive" : ""}`}
                    data-testid={`input-${testIdPrefix}-url-${index}`}
                  />
                  {invalid ? (
                    <p className="mt-1 text-xs text-destructive">Not a YouTube link.</p>
                  ) : parsed && parsed.startSeconds > 0 ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Starts at {parsed.startSeconds}s
                    </p>
                  ) : null}
                </div>
                <Input
                  value={video.title}
                  onChange={(e) => update(index, { title: e.target.value })}
                  placeholder="Title (optional)"
                  disabled={viewOnly}
                  className="h-8 text-sm"
                  data-testid={`input-${testIdPrefix}-title-${index}`}
                />
              </div>
              <div className="flex shrink-0 items-center">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  disabled={viewOnly || index === 0}
                  onClick={() => move(index, -1)}
                  data-testid={`button-${testIdPrefix}-up-${index}`}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  disabled={viewOnly || index === videos.length - 1}
                  onClick={() => move(index, 1)}
                  data-testid={`button-${testIdPrefix}-down-${index}`}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  disabled={viewOnly}
                  onClick={() => remove(index)}
                  data-testid={`button-${testIdPrefix}-remove-${index}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={viewOnly}
          onClick={() => onChange([...videos, newNodeVideoDraft()])}
          data-testid={`button-add-${testIdPrefix}`}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add video
        </Button>
        {targetDocId ? (
          <Button
            type="button"
            size="sm"
            disabled={!canSave}
            onClick={() => void handleSave()}
            data-testid={`button-save-${testIdPrefix}s`}
          >
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save videos
          </Button>
        ) : null}
        {!targetDocId && videos.length > 0 && unsavedNodeHint ? (
          <span className="text-xs text-muted-foreground">{unsavedNodeHint}</span>
        ) : null}
        {hasEmptyRow ? (
          <span className="text-xs text-muted-foreground">Fill in or remove the empty link to save.</span>
        ) : null}
      </div>

      {cmsUnavailable ? (
        <p className="mt-2 text-xs text-destructive" data-testid={`text-${testIdPrefix}s-unavailable`}>
          {data?.message || "The CMS has no Video Resource collection yet, so videos cannot be saved."}
        </p>
      ) : null}
    </div>
  );
}
