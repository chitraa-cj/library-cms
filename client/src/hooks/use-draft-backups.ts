import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export interface DraftBackup {
  key: string;
  ts: string;
  size: number;
}

interface BackupsResponse {
  enabled: boolean;
  backups: DraftBackup[];
}

/**
 * Browse / view / delete the durable S3 backup versions of a single grantha draft.
 * The list query is enabled only when a draftId is provided (the backups dialog passes the
 * open draft's id and null when closed), so it doesn't run for every rendered card.
 */
export function useDraftBackups(draftId: number | null) {
  const { toast } = useToast();

  const backupsQuery = useQuery<BackupsResponse>({
    queryKey: ["/api/drafts", draftId, "backups"],
    enabled: draftId != null,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/drafts/${draftId}/backups`);
      return res.json();
    },
  });

  const fetchBackupContent = async (key: string): Promise<any> => {
    const res = await apiRequest(
      "GET",
      `/api/drafts/${draftId}/backups/content?key=${encodeURIComponent(key)}`,
    );
    return res.json();
  };

  const deleteBackup = useMutation({
    mutationFn: async (key: string) => {
      const res = await apiRequest(
        "DELETE",
        `/api/drafts/${draftId}/backups?key=${encodeURIComponent(key)}`,
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/drafts", draftId, "backups"] });
      toast({ title: "Backup version deleted" });
    },
    onError: (err: any) => {
      toast({
        variant: "destructive",
        title: "Delete failed",
        description: err.message || "Could not delete the backup version.",
      });
    },
  });

  return {
    enabled: backupsQuery.data?.enabled ?? false,
    backups: backupsQuery.data?.backups ?? [],
    isLoading: backupsQuery.isLoading,
    refetch: backupsQuery.refetch,
    fetchBackupContent,
    deleteBackup,
  };
}
