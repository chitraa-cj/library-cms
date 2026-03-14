import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStrapiSync } from "@/hooks/use-strapi-sync";

function formatRelativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return date.toLocaleTimeString();
}

export default function StrapiSyncBar() {
  const { syncAll, isSyncing, lastSyncedAt } = useStrapiSync();

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {isSyncing ? (
        <span className="flex items-center gap-1.5">
          <RefreshCw className="w-3 h-3 animate-spin" />
          Syncing with Strapi…
        </span>
      ) : lastSyncedAt ? (
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
          Synced {formatRelativeTime(lastSyncedAt)}
        </span>
      ) : (
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 inline-block" />
          Auto-syncs every 30s
        </span>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={syncAll}
        disabled={isSyncing}
        title="Sync now from Strapi"
        data-testid="button-sync-strapi"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? "animate-spin" : ""}`} />
      </Button>
    </div>
  );
}
