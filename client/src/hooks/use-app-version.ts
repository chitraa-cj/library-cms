import { useEffect, useRef } from "react";
import { CMS_FETCH_INIT } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const STORAGE_KEY = "cms_app_build_id";

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
 * Prompt a refresh when the server build id changes (incognito always looks fresh).
 */
export function useAppVersionRefreshPrompt(): void {
  const { toast } = useToast();
  const promptedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      const serverId = await fetchServerBuildId();
      if (cancelled || !serverId || serverId === "dev") return;

      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (!stored) {
        sessionStorage.setItem(STORAGE_KEY, serverId);
        return;
      }
      if (stored === serverId || promptedRef.current) return;

      promptedRef.current = true;
      toast({
        title: "Update available",
        description: "A new version of the CMS is live. Refresh the page to get the latest features and fixes.",
        duration: 60_000,
      });
    };

    void check();
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [toast]);
}
