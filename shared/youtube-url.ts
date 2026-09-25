/**
 * Parsing/formatting helpers for the YouTube links pinned to a grantha (or any other
 * node) as VideoResource rows. Pure and dependency-free so the portal client, the
 * Express proxy and any script can all normalize a pasted link the same way.
 *
 * What users paste varies a lot (watch links, share links, shorts, embeds, a bare id,
 * often with a `t=` timestamp). We always store the canonical watch URL plus the
 * timestamp as `start_seconds`, so the reading app never has to re-parse.
 */

export interface ParsedYouTubeLink {
  /** The 11-character YouTube video id. */
  videoId: string;
  /** Deep-link offset parsed from `t` / `start`, in seconds (0 when absent). */
  startSeconds: number;
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Hosts we accept a link from (with or without a `www.`/`m.`/`music.` prefix). */
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
]);

/** `90`, `90s`, `1m30s`, `1h2m3s` -> seconds. Returns 0 for anything unparseable. */
export function parseYouTubeTimestamp(raw: string | null | undefined): number {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return 0;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  const m = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return 0;
  return (
    parseInt(m[1] ?? "0", 10) * 3600 +
    parseInt(m[2] ?? "0", 10) * 60 +
    parseInt(m[3] ?? "0", 10)
  );
}

/** Strip a leading `www.` / `m.` / `music.` so host matching stays simple. */
function baseHost(hostname: string): string {
  return hostname.replace(/^(www|m|music)\./i, "").toLowerCase();
}

/**
 * Parse anything a user is likely to paste into a YouTube video id + start offset.
 * Returns null when the input is not recognizably a YouTube video.
 */
export function parseYouTubeLink(input: string | null | undefined): ParsedYouTubeLink | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  // A bare video id pasted on its own.
  if (VIDEO_ID_RE.test(raw)) return { videoId: raw, startSeconds: 0 };

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!YOUTUBE_HOSTS.has(baseHost(url.hostname))) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  let videoId: string | null = null;

  if (baseHost(url.hostname) === "youtu.be") {
    videoId = segments[0] ?? null;
  } else if (segments[0] === "watch") {
    videoId = url.searchParams.get("v");
  } else if (["embed", "shorts", "live", "v"].includes(segments[0] ?? "")) {
    videoId = segments[1] ?? null;
  } else {
    // e.g. /watch?v=... reached through a redirect wrapper that kept the query
    videoId = url.searchParams.get("v");
  }

  if (!videoId || !VIDEO_ID_RE.test(videoId)) return null;

  // `t` is the share-link timestamp; `start` is the embed one. `#t=` also occurs.
  const hashTime = url.hash.startsWith("#t=") ? url.hash.slice(3) : null;
  const startSeconds = parseYouTubeTimestamp(
    url.searchParams.get("t") ?? url.searchParams.get("start") ?? hashTime,
  );

  return { videoId, startSeconds };
}

/** The canonical watch URL we store for a video id. */
export function canonicalYouTubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Still frame for a video id — used for the row preview in the editor. */
export function youTubeThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}
