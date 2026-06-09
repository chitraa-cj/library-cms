import { useSyncExternalStore } from "react";

/**
 * Global "a grantha publish is running" flag. Publishing rebuilds the CMS grantha (delete +
 * recreate) and can take minutes; navigating away mid-publish risks an inconsistent CMS state.
 * The grantha editor sets this while a publish is in flight and the app shell (DashboardLayout)
 * reads it to block navigation to other screens until the publish finishes.
 */
let locked = false;
const listeners = new Set<() => void>();

export function setPublishLock(next: boolean): void {
  if (locked === next) return;
  locked = next;
  for (const l of listeners) l();
}

export function isPublishLocked(): boolean {
  return locked;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function usePublishLock(): boolean {
  return useSyncExternalStore(subscribe, isPublishLocked, isPublishLocked);
}
