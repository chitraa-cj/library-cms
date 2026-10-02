/**
 * Tunables for the grantha publish worker.
 *
 * Read once at module load (this is a plain `const`), so `.env` must be in place before
 * anything imports it — hence `import "../env"` first in worker-main.ts, and why the
 * tests set `process.env` before their dynamic `import()`. Mirrors
 * `server/translation/config.ts`.
 */

const num = (name: string, fallback: number, min: number, max: number): number => {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.floor(Math.min(Math.max(raw, min), max));
};

export const publishConfig = {
  /**
   * Attempts per job. A retry re-walks the grantha, which is cheap for work already done
   * (`cms_publish_manthra_resolutions` short-circuits the per-mantra label dedup) but is
   * never free, so keep this small.
   */
  maxAttempts: num("PUBLISH_MAX_ATTEMPTS", 3, 1, 5),

  /**
   * Lease length. Deliberately tighter than the translation worker's 15 minutes: the walk
   * does `JSON.stringify` over large payloads and a long synchronous block can starve the
   * heartbeat timer. The cost of a FALSE reap is two workers writing one grantha, so the
   * lease must comfortably exceed the worst heartbeat gap, not the job duration — the
   * heartbeat is what keeps a 20-minute publish alive.
   */
  leaseMs: num("PUBLISH_LEASE_MS", 300_000, 60_000, 3_600_000),
  leaseHeartbeatMs: num("PUBLISH_HEARTBEAT_MS", 30_000, 5_000, 600_000),

  /** Idle poll. Publishing is interactive, so this is far shorter than translation's 15s. */
  pollIntervalMs: num("PUBLISH_POLL_INTERVAL", 5_000, 1_000, 120_000),

  /** Delay before a requeued attempt may be claimed, so a Strapi brownout cannot burn the budget. */
  retryBackoffMs: num("PUBLISH_RETRY_BACKOFF_MS", 15_000, 0, 600_000),

  /**
   * Floor between progress writes. Without it `updatePublishJob` fires once per mantra —
   * 6,058 single-row UPDATEs for Suta Samhita, every one of them WAL.
   */
  progressWriteIntervalMs: num("PUBLISH_PROGRESS_WRITE_MS", 250, 0, 10_000),

  /** How stale a worker heartbeat may be before the API refuses to enqueue. */
  heartbeatStaleMs: num("PUBLISH_HEARTBEAT_STALE_MS", 60_000, 10_000, 600_000),

  workerId:
    process.env.PUBLISH_WORKER_ID ||
    `publish-worker-${process.pid}@${process.env.HOSTNAME || "local"}`,
} as const;

/** Value of `cms_worker_heartbeats.worker_kind` for this worker. */
export const PUBLISH_WORKER_KIND = "publish";

export const PUBLISH_ERROR_MAX = 2000;

/**
 * Trim an error to something safe to store and show. Strips query-string secrets and
 * bearer/cookie blobs, and collapses home directories, before truncating — the same
 * concerns as `sanitizeTranslationError`, minus the Hermex/browser-specific rules.
 */
export function sanitizePublishError(input: unknown): string {
  const raw =
    input instanceof Error
      ? input.message || String(input)
      : typeof input === "string"
        ? input
        : (() => {
            try {
              return JSON.stringify(input);
            } catch {
              return String(input);
            }
          })();

  const cleaned = raw
    .replace(/([?&](?:token|key|secret|password|signature)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/\b(bearer|authorization|cookie)\s*[:=]\s*\S+/gi, "$1 <redacted>")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "<redacted>")
    .replace(/\/(?:home|Users)\/[^/\s]+/g, "~");

  return cleaned.length > PUBLISH_ERROR_MAX
    ? `${cleaned.slice(0, PUBLISH_ERROR_MAX)}…`
    : cleaned;
}
