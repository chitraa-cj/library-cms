import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, CMS_FETCH_INIT } from "@/lib/queryClient";
import {
  clearCachedAuthUser,
  hasActivePublishJob,
  readCachedAuthUser,
  writeCachedAuthUser,
} from "@/lib/auth-session-cache";
import type { User, LoginData } from "@shared/schema";
import { useLocation } from "wouter";

export type AuthQueryData = {
  user: User | null;
  /** Server unreachable — keep editing with last known session (not a real logout). */
  degraded: boolean;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchAuthUser(): Promise<AuthQueryData> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch("/api/auth/user", CMS_FETCH_INIT);
      if (res.status === 401) {
        // While a publish job is in flight the server is under heavy load and a single
        // failed deserializeUser can briefly return 401 even though the session is fine.
        // Treat it as degraded (keep cached user) so the editor doesn't get bounced to
        // the login screen mid-publish. A real logout will resolve on the next refetch
        // after the job completes.
        const cached = readCachedAuthUser();
        if (cached && hasActivePublishJob()) {
          console.warn("[auth] 401 while publish job active — keeping cached user (degraded mode)");
          return { user: cached, degraded: true };
        }
        clearCachedAuthUser();
        return { user: null, degraded: false };
      }
      if (!res.ok) {
        throw new Error(`Auth check failed (${res.status})`);
      }
      const user = (await res.json()) as User;
      writeCachedAuthUser(user);
      return { user, degraded: false };
    } catch (e) {
      lastError = e;
      if (attempt < 3) {
        await sleep(400 * (attempt + 1));
      }
    }
  }

  const cached = readCachedAuthUser();
  if (cached) {
    console.warn("[auth] Session check failed — keeping cached user (server busy or restarting):", lastError);
    return { user: cached, degraded: true };
  }

  throw lastError instanceof Error ? lastError : new Error("Could not verify session");
}

export function useAuth() {
  const [, setLocation] = useLocation();

  const {
    data,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery<AuthQueryData>({
    queryKey: ["/api/auth/user"],
    queryFn: fetchAuthUser,
    retry: false,
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    placeholderData: (prev) => {
      if (prev) return prev;
      const cached = readCachedAuthUser();
      if (cached) return { user: cached, degraded: true };
      return undefined;
    },
  });

  const user = data?.user ?? null;
  const authDegraded = data?.degraded ?? false;

  const loginMutation = useMutation({
    mutationFn: async (credentials: LoginData) => {
      const res = await apiRequest("POST", "/api/auth/login", credentials);
      return res.json() as Promise<User>;
    },
    onSuccess: (loggedIn) => {
      writeCachedAuthUser(loggedIn);
      queryClient.setQueryData<AuthQueryData>(["/api/auth/user"], {
        user: loggedIn,
        degraded: false,
      });
    },
  });

  const registerMutation = useMutation({
    mutationFn: async (payload: LoginData & { displayName?: string }) => {
      const res = await apiRequest("POST", "/api/auth/register", payload);
      return res.json() as Promise<User>;
    },
    onSuccess: (registered) => {
      writeCachedAuthUser(registered);
      queryClient.setQueryData<AuthQueryData>(["/api/auth/user"], {
        user: registered,
        degraded: false,
      });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/logout");
    },
    onSuccess: () => {
      clearCachedAuthUser();
      queryClient.setQueryData<AuthQueryData>(["/api/auth/user"], {
        user: null,
        degraded: false,
      });
      setLocation("/");
    },
  });

  return {
    user,
    authDegraded,
    isLoading,
    isFetching,
    authError: error,
    retryAuth: refetch,
    isAuthenticated: !!user,
    login: loginMutation,
    register: registerMutation,
    logout: logoutMutation,
  };
}
