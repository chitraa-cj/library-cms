import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, ApiError } from "@/lib/queryClient";
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
  const publishJobStorageKey = `publish-job:${contentType}`;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const withTransientRetries = async <T>(op: () => Promise<T>, maxAttempts = 3): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await op();
      } catch (error) {
        lastError = error;
        const status = error instanceof ApiError ? error.status : 0;
        const isTransient = status === 0 || status === 408 || status === 429 || status >= 500;
        if (!isTransient || attempt === maxAttempts) break;
        await sleep(300 * attempt);
      }
    }
    throw lastError;
  };

  const persistPublishJob = (draftId: number, jobId: string) => {
    try {
      localStorage.setItem(
        publishJobStorageKey,
        JSON.stringify({ draftId, jobId, startedAt: Date.now() }),
      );
    } catch {
      // ignore localStorage failures
    }
  };

  const clearPersistedPublishJob = () => {
    try {
      localStorage.removeItem(publishJobStorageKey);
    } catch {
      // ignore localStorage failures
    }
  };

  const pollPublishJob = async (draftId: number, jobId: string) => {
    const maxAttempts = 450; // up to 15 minutes, every 2s
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
          clearPersistedPublishJob();
          return status.result;
        }
        if (status.status === "failed_recoverable") {
          const resumeRes = await apiRequest("POST", `/api/drafts/${draftId}/publish`);
          const resumeData = await resumeRes.json();
          if (resumeData?.async && resumeData?.jobId) {
            persistPublishJob(draftId, resumeData.jobId);
            return await pollPublishJob(draftId, resumeData.jobId);
          }
        }
        if (status.status === "failed") {
          setPublishProgress(null);
          clearPersistedPublishJob();
          throw new Error(status.error || "Publish failed");
        }
      } catch (pollErr: any) {
        if (pollErr.message && !pollErr.message.includes("fetch")) throw pollErr;
      }
    }
    setPublishProgress(null);
    throw new Error("Publish is taking too long. Check the server logs and try again.");
  };

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
      const idempotencyKey = `save:${contentType}:${draftId ?? "new"}:${Date.now()}`;
      if (draftId) {
        const existing = (draftsQuery.data || []).find((d) => d.id === draftId);
        const submit = async (expectedUpdatedAt?: Date | null) => {
          const res = await withTransientRetries(() =>
            apiRequest(
              "PUT",
              `/api/drafts/${draftId}`,
              {
                title,
                data,
                expectedUpdatedAt: expectedUpdatedAt ?? undefined,
              },
              { headers: { "Idempotency-Key": idempotencyKey } },
            ),
          );
          return res.json();
        };
        try {
          return await submit(existing?.updatedAt ?? null);
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) {
            const latestRes = await apiRequest("GET", `/api/drafts/${draftId}`);
            const latest = (await latestRes.json()) as Draft;
            return await submit(latest?.updatedAt ?? null);
          }
          throw error;
        }
      }
      const res = await withTransientRetries(() =>
        apiRequest(
          "POST",
          "/api/drafts",
          {
            contentType,
            title,
            data,
            strapiDocumentId,
          },
          { headers: { "Idempotency-Key": idempotencyKey } },
        ),
      );
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
      const description =
        err instanceof ApiError && err.status === 409
          ? "Draft changed in another tab/session. Please save again."
          : err.message;
      toast({
        variant: "destructive",
        title: "Error saving draft",
        description,
      });
    },
  });

  const publishMutation = useMutation({
    mutationFn: async (draftId: number) => {
      setPublishProgress(null);

      const idempotencyKey = `publish:${contentType}:${draftId}:${Date.now()}`;
      const res = await withTransientRetries(
        () =>
          apiRequest("POST", `/api/drafts/${draftId}/publish`, undefined, {
            headers: { "Idempotency-Key": idempotencyKey },
          }),
        4,
      );
      const data = await res.json();

      if (data.async && data.jobId) {
        const jobId: string = data.jobId;
        persistPublishJob(draftId, jobId);
        return pollPublishJob(draftId, jobId);
      }

      return data;
    },
    onSuccess: (data: any) => {
      setPublishProgress(null);
      clearPersistedPublishJob();
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
      clearPersistedPublishJob();
      toast({
        variant: "destructive",
        title: "Publish failed",
        description: err.message,
      });
    },
  });

  // Resume an in-flight publish after page refresh/reload.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(publishJobStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { draftId?: number; jobId?: string };
      if (!parsed?.draftId || !parsed?.jobId) return;
      void pollPublishJob(parsed.draftId, parsed.jobId)
        .then((result) => {
          queryClient.invalidateQueries({ queryKey: ["/api/drafts", contentType] });
          queryClient.invalidateQueries({ queryKey: ["/api/strapi"] });
          const allWarnings: Array<{ manthra: string; error: string }> | undefined = result?.warnings;
          if (allWarnings && allWarnings.length > 0) {
            toast({
              variant: "destructive",
              title: `Published with ${allWarnings.length} warning${allWarnings.length === 1 ? "" : "s"}`,
              description: "Publish resumed after refresh. Review warnings in the editor.",
            });
          } else {
            toast({ title: "Published", description: "Publish resumed after refresh and completed." });
          }
        })
        .catch((err: any) => {
          toast({ variant: "destructive", title: "Publish failed", description: err.message || "Publish failed" });
        });
    } catch {
      // ignore resume parse failures
    }
  }, [contentType]);

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

  const recoverDraftMutation = useMutation({
    mutationFn: async (draftId: number) => {
      const res = await apiRequest("POST", `/api/drafts/${draftId}/recover-latest`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/drafts", contentType] });
      toast({ title: "Draft recovered", description: "Recovered latest server snapshot for this draft." });
    },
    onError: (err: any) => {
      toast({
        variant: "destructive",
        title: "Recover failed",
        description: err.message || "Could not recover the draft snapshot.",
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
    recoverDraft: recoverDraftMutation,
  };
}
