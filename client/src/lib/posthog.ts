import posthog from "posthog-js";

const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const host = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? "https://app.posthog.com";

export function initPostHog() {
  if (!key) return;
  posthog.init(key, {
    api_host: host,
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: false,
    loaded: (ph) => {
      (window as any).posthog = ph;
    },
  });
}

export function identifyUser(username: string, props?: Record<string, any>) {
  if (!key) return;
  posthog.identify(username, props);
}

export function resetUser() {
  if (!key) return;
  posthog.reset();
}

export function track(event: string, properties?: Record<string, any>) {
  if (!key) return;
  posthog.capture(event, properties);
}
