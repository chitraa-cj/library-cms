import { useEffect, useRef, useState, type ReactNode } from "react";
import { CMS_FETCH_INIT, queryClient } from "@/lib/queryClient";
import { clearCachedAuthUser } from "@/lib/auth-session-cache";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "cms_app_build_id";

declare global {
  interface Window {
    __CMS_BUILD_ID__?: string;
  }
}

async function fetchServerBuildId(): Promise<string | null> {
  try {
    const res = await fetch("/api/app-version", CMS_FETCH_INIT);
    if (!res.ok) return null;
    const json = (await res.json()) as { buildId?: string };
    return json.buildId?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * After deploy, users with an old tab keep stale JS and cached API responses.
 * Incognito always loads fresh bundles — normal tabs may run yesterday's code until reload.
 */
export function useAppVersionRefreshPrompt(): ReactNode {
  const [staleBuild, setStaleBuild] = useState(false);
  const [serverBuildId, setServerBuildId] = useState<string | null>(null);
  const checkingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      if (checkingRef.current) return;
      checkingRef.current = true;
      try {
        const serverId = await fetchServerBuildId();
        if (cancelled || !serverId || serverId === "dev") return;

        window.__CMS_BUILD_ID__ = serverId;
        const stored = sessionStorage.getItem(STORAGE_KEY);
        if (!stored) {
          sessionStorage.setItem(STORAGE_KEY, serverId);
          return;
        }
        if (stored === serverId) return;

        // Stale bundle — clear cached auth snapshot so role/profile refetch after reload.
        clearCachedAuthUser();
        void queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
        setServerBuildId(serverId);
        setStaleBuild(true);
      } finally {
        checkingRef.current = false;
      }
    };

    void check();
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (!staleBuild) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 backdrop-blur-sm p-6"
      role="alertdialog"
      aria-labelledby="cms-update-title"
      aria-describedby="cms-update-desc"
    >
      <div className="max-w-md w-full rounded-xl border bg-card p-6 shadow-lg space-y-4">
        <div>
          <h2 id="cms-update-title" className="text-lg font-semibold">
            Update available
          </h2>
          <p id="cms-update-desc" className="text-sm text-muted-foreground mt-2">
            A new version of the CMS is live. This tab is still running an older build
            {serverBuildId ? ` (${serverBuildId.slice(0, 19)}…)` : ""}.
            Refresh to get the latest features and fixes. Incognito works because it always
            loads the newest code — your normal browser tab does not until you reload.
          </p>
        </div>
        <Button
          className="w-full"
          onClick={() => {
            if (serverBuildId) sessionStorage.setItem(STORAGE_KEY, serverBuildId);
            window.location.reload();
          }}
        >
          Refresh now
        </Button>
      </div>
    </div>
  );
}
