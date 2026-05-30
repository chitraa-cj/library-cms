import type { User } from "@shared/schema";

const STORAGE_KEY = "cms_auth_user_snapshot";
const PUBLISH_JOB_PREFIX = "publish-job:";

/**
 * Returns true when a background publish job is currently being polled. Used by
 * the auth refetch path to suppress logout-on-401 during the multi-minute window
 * where the server is under heavy DB load and deserialize occasionally fails.
 */
export function hasActivePublishJob(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PUBLISH_JOB_PREFIX)) return true;
    }
  } catch {
    // ignore (private mode, etc.)
  }
  return false;
}

export function readCachedAuthUser(): User | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as User;
    return parsed?.id ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCachedAuthUser(user: User | null): void {
  try {
    if (!user?.id) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  } catch {
    // ignore quota / private mode
  }
}

export function clearCachedAuthUser(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
