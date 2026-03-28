import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { Download, DatabaseBackup, BookOpen, ScrollText, Hash, Loader2, ShieldCheck, Eye } from "lucide-react";
import type { GranthaBackupMeta } from "@shared/schema";

export default function BackupsPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [creatingId, setCreatingId] = useState<number | null>(null);

  const { data: backups = [], isLoading } = useQuery<GranthaBackupMeta[]>({
    queryKey: ["/api/admin/backups"],
  });

  const createBackupMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/backup");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/backups"] });
      toast({
        title: "Snapshot created",
        description: `Backed up ${data.granthaCount} granthas, ${data.sectionCount} sections, ${data.manthraCount} manthras.`,
      });
    },
    onError: (err: any) => {
      toast({
        title: "Backup failed",
        description: err.message || "Could not create snapshot.",
        variant: "destructive",
      });
    },
  });

  function handleDownload(backupId: number) {
    window.open(`/api/admin/backups/${backupId}/download`, "_blank");
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <DatabaseBackup className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-semibold" data-testid="page-title-backups">Snapshots</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Read-only snapshots of all Strapi content — granthas, sections, and manthras with full text.
            Snapshots cannot be edited or deleted.
          </p>
        </div>
        {isAdmin && (
          <Button
            onClick={() => createBackupMutation.mutate()}
            disabled={createBackupMutation.isPending}
            data-testid="button-create-backup"
          >
            {createBackupMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Creating…
              </>
            ) : (
              <>
                <DatabaseBackup className="w-4 h-4 mr-2" />
                Take Snapshot
              </>
            )}
          </Button>
        )}
      </div>

      {createBackupMutation.isPending && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="py-4">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 animate-spin text-primary" />
              <div>
                <p className="text-sm font-medium">Creating snapshot…</p>
                <p className="text-xs text-muted-foreground">
                  Fetching all granthas, sections, and manthras from Strapi. This may take up to a minute.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : backups.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center">
            <DatabaseBackup className="w-10 h-10 mx-auto text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium text-muted-foreground">No snapshots yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              {isAdmin ? 'Click "Take Snapshot" to create the first full backup.' : "No snapshots have been created yet. Ask an administrator to take one."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {backups.map((backup) => (
            <Card key={backup.id} className="hover:shadow-sm transition-shadow" data-testid={`card-backup-${backup.id}`}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <ShieldCheck className="w-4 h-4 text-green-600 flex-shrink-0" />
                    <CardTitle className="text-sm font-medium truncate" data-testid={`text-backup-label-${backup.id}`}>
                      Snapshot #{backup.id}
                    </CardTitle>
                    <Badge variant="outline" className="text-xs shrink-0">Immutable</Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <Link href={`/admin/backups/${backup.id}`}>
                      <Button size="sm" variant="default" data-testid={`button-browse-backup-${backup.id}`}>
                        <Eye className="w-3.5 h-3.5 mr-1.5" />
                        Browse
                      </Button>
                    </Link>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleDownload(backup.id)}
                      data-testid={`button-download-backup-${backup.id}`}
                    >
                      <Download className="w-3.5 h-3.5 mr-1.5" />
                      Download
                    </Button>
                  </div>
                </div>
                <CardDescription className="text-xs" data-testid={`text-backup-date-${backup.id}`}>
                  Created {new Date(backup.createdAt).toLocaleString()}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-6 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5" data-testid={`text-backup-granthas-${backup.id}`}>
                    <BookOpen className="w-3.5 h-3.5" />
                    {backup.granthaCount} granthas
                  </span>
                  <span className="flex items-center gap-1.5" data-testid={`text-backup-sections-${backup.id}`}>
                    <ScrollText className="w-3.5 h-3.5" />
                    {backup.sectionCount} sections
                  </span>
                  <span className="flex items-center gap-1.5" data-testid={`text-backup-manthras-${backup.id}`}>
                    <Hash className="w-3.5 h-3.5" />
                    {backup.manthraCount} manthras
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
