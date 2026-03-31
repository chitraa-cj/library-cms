import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Draft } from "@shared/schema";

export function useDrafts(contentType: string) {
  const { toast } = useToast();

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
      const res = await apiRequest("POST", `/api/drafts/${draftId}/publish`);
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/drafts", contentType] });
      queryClient.invalidateQueries({ queryKey: ["/api/strapi"] });

      const warnings: Array<{ manthra: string; error: string }> | undefined = data?.warnings;
      if (warnings && warnings.length > 0) {
        const list = warnings
          .map((w) => `• ${w.manthra}: ${w.error}`)
          .join("\n");
        toast({
          variant: "destructive",
          title: `Published with ${warnings.length} error${warnings.length === 1 ? "" : "s"}`,
          description: `The grantha was saved but ${warnings.length} mantra${warnings.length === 1 ? "" : "s"} failed to sync to Strapi:\n${list}`,
        });
      } else {
        toast({
          title: "Published",
          description: "Content has been published to the CMS.",
        });
      }
    },
    onError: (err: any) => {
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
    deleteDraft: deleteDraftMutation,
  };
}
