import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Draft } from "@shared/schema";

export interface PublishProgress {
  done: number;
  total: number;
  current: string;
}

export function useDrafts(contentType: string) {
  const { toast } = useToast();

  const [publishProgress, setPublishProgress] = useState<PublishProgress | null>(null);

  const draftsQuery = useQuery<Draft[]>({
    queryKey: ["/api/drafts", contentType],
    queryFn: async () => {
      const res = await fetch(`/api/drafts?contentType=${contentType}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch drafts");
      return res.json();
    },
  });

  const saveDraftMutation = useMutation({
    mutationFn: async ({
      title,
      data,
      strapiDocumentId,
      draftId,
    }: {
      title: string;
      data: any;
      strapiDocumentId?: string;
      draftId?: number;
    }) => {
      if (draftId) {
        const res = await apiRequest("PUT", `/api/drafts/${draftId}`, {
          title,
          data,
        });
        return res.json();
      }
      const res = await apiRequest("POST", "/api/drafts", {
        contentType,
        title,
        data,
        strapiDocumentId,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/drafts", contentType] });
      toast({
        title: "Draft saved",
        description: "Your changes have been saved as a draft.",
      });
    },
    onError: (err: any) => {
      toast({
        variant: "destructive",
        title: "Error saving draft",
        description: err.message,
      });
    },
  });

  const publishMutation = useMutation({
    mutationFn: async (draftId: number) => {
      setPublishProgress(null);

      const res = await apiRequest("POST", `/api/drafts/${draftId}/publish`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || `HTTP ${res.status}`);
      }
      const data = await res.json();

      if (data.async && data.jobId) {
        const jobId: string = data.jobId;
        const maxAttempts = 450; // poll for up to 15 minutes (every 2 s) — matches server job TTL
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          try {
            const statusRes = await fetch(
              `/api/drafts/${draftId}/publish-status?jobId=${encodeURIComponent(jobId)}`,
              { credentials: "include" }
            );
            if (!statusRes.ok) continue;
            const status = await statusRes.json();
            if (status.progress) {
              setPublishProgress({
                done: status.progress.done,
                total: status.progress.total,
                current: status.progress.current,
              });
            }
            if (status.status === "done") {
              setPublishProgress(null);
              return status.result;
            }
            if (status.status === "failed") {
              setPublishProgress(null);
              throw new Error(status.error || "Publish failed");
            }
          } catch (pollErr: any) {
            if (pollErr.message && !pollErr.message.includes("fetch")) throw pollErr;
          }
        }
        setPublishProgress(null);
        throw new Error("Publish is taking too long. Check the server logs and try again.");
      }

      return data;
    },
    onSuccess: (data: any) => {
      setPublishProgress(null);
      queryClient.invalidateQueries({ queryKey: ["/api/drafts", contentType] });
      queryClient.invalidateQueries({ queryKey: ["/api/strapi"] });

      const allWarnings: Array<{ manthra: string; error: string }> | undefined = data?.warnings;
      if (allWarnings && allWarnings.length > 0) {
        const warnings = allWarnings.filter((w) => !w.error.startsWith("[WARNING]"));
        const notices = allWarnings.filter((w) => w.error.startsWith("[WARNING]"));
        if (warnings.length > 0) {
          const list = warnings.map((w) => `• ${w.manthra}: ${w.error}`).join("\n");
          toast({
            variant: "destructive",
            title: `Published with ${warnings.length} error${warnings.length === 1 ? "" : "s"}`,
            description: `The grantha was saved but ${warnings.length} item${warnings.length === 1 ? "" : "s"} failed to sync to Strapi:\n${list}`,
          });
        } else {
          toast({
            title: "Published",
            description: "Content has been published to the CMS.",
          });
        }
        if (notices.length > 0) {
          const list = notices.map((w) => `• ${w.manthra}: ${w.error.replace(/^\[WARNING\]\s*/, "")}`).join("\n");
          toast({
            title: `${notices.length} item${notices.length === 1 ? "" : "s"} synced with reduced content`,
            description: list,
          });
        }
      } else {
        toast({
          title: "Published",
          description: "Content has been published to the CMS.",
        });
      }
    },
    onError: (err: any) => {
      setPublishProgress(null);
      toast({
        variant: "destructive",
        title: "Publish failed",
        description: err.message,
      });
    },
  });

  const deleteDraftMutation = useMutation({
    mutationFn: async (draftId: number) => {
      const res = await apiRequest("DELETE", `/api/drafts/${draftId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/drafts", contentType] });
      toast({ title: "Draft deleted" });
    },
    onError: (err: any) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: err.message,
      });
    },
  });

  const unpublishedDrafts = (draftsQuery.data || []).filter(
    (d) => d.status === "draft"
  );

  return {
    drafts: draftsQuery.data || [],
    unpublishedDrafts,
    isLoadingDrafts: draftsQuery.isLoading,
    saveDraft: saveDraftMutation,
    publishDraft: publishMutation,
    publishProgress,
    deleteDraft: deleteDraftMutation,
  };
}
