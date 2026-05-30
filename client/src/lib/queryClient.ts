import { QueryClient, QueryFunction } from "@tanstack/react-query";

/** CMS data must never come from the browser HTTP cache (stale Upanishad text, old UI). */
export const CMS_FETCH_INIT: RequestInit = {
  credentials: "include",
  cache: "no-store",
};

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const raw = await res.text();
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = raw;
    }
    const message =
      (parsed && typeof parsed === "object" && "message" in (parsed as any) && typeof (parsed as any).message === "string"
        ? (parsed as any).message
        : raw) || res.statusText || `HTTP ${res.status}`;
    const friendly =
      res.status === 504 ||
      (typeof message === "string" &&
        (message.includes("504 Gateway Time-out") || message.includes("<title>504")))
        ? "Gateway timeout (504). Large mantra publishes run in the background — wait for the progress toast or retry in a minute."
        : typeof message === "string" && message.includes("<html")
          ? `Server error (${res.status}). The request may still be processing — check Strapi or retry shortly.`
          : message;
    throw new ApiError(friendly, res.status, parsed);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
  options?: { headers?: Record<string, string>; signal?: AbortSignal },
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...(options?.headers ?? {}),
    },
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
    cache: "no-store",
    signal: options?.signal,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, CMS_FETCH_INIT);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: true,
      refetchOnMount: true,
      staleTime: 0,
      gcTime: 5 * 60 * 1000,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
