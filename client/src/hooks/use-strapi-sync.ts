import { useCallback, useEffect, useRef, useState } from "react";
import { useIsFetching } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { syncGranthaCmsCaches } from "@/lib/strapi-cache-sync";

const STRAPI_QUERY_KEY = "/api/strapi";
const POLL_INTERVAL_MS = 30_000;

export function useStrapiSync() {
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const isFetching = useIsFetching({ queryKey: [STRAPI_QUERY_KEY] });
  const prevFetching = useRef(0);

  useEffect(() => {
    if (prevFetching.current > 0 && isFetching === 0) {
      setLastSyncedAt(new Date());
    }
    prevFetching.current = isFetching;
  }, [isFetching]);

  const syncAll = useCallback(async () => {
    await syncGranthaCmsCaches(queryClient);
  }, []);

  return {
    syncAll,
    isSyncing: isFetching > 0,
    lastSyncedAt,
  };
}

export const STRAPI_POLL_INTERVAL = POLL_INTERVAL_MS;
