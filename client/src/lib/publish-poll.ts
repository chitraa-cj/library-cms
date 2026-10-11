/**
 * What a publish-status poll response means.
 *
 * Both pollers (the grantha one in `use-drafts.ts`, the per-verse one in `granthas.tsx`)
 * used to say `if (!statusRes.ok) continue;` — every failure was read as "not ready yet".
 * A server answering 500 to every single poll therefore looked identical to a publish that
 * was simply slow, and the editor's only feedback, twenty minutes later, was "taking
 * longer than expected". That is how a missing database column reached the user as a
 * timeout.
 *
 * The rule this encodes: a failure that cannot resolve itself by waiting is reported at
 * once; a failure that might (a restart, a blip) is tolerated for a bounded number of
 * polls and then reported with the server's own wording. Nothing is ever reported as
 * SUCCESS that the server has not confirmed.
 */

/** Consecutive failed polls tolerated before the editor is told. ~5-10s of polling. */
export const MAX_CONSECUTIVE_STATUS_ERRORS = 10;

export type PollDecision =
  /** Keep polling. */
  | { kind: "wait" }
  /** 401 — bounded separately by the caller, which knows its own session handling. */
  | { kind: "auth" }
  /** Stop. The publish did not succeed, or we can no longer tell whether it did. */
  | { kind: "fail"; message: string; certain: boolean }
  /** A status body worth reading. */
  | { kind: "read" };

interface PollInput {
  httpStatus: number;
  /** Parsed JSON body, or null when the response had none. */
  body: { message?: unknown; code?: unknown } | null;
  /** How many polls in a row have now failed, including this one. */
  consecutiveErrors: number;
  maxConsecutiveErrors?: number;
}

function serverMessage(body: PollInput["body"], httpStatus: number): string {
  return typeof body?.message === "string" && body.message
    ? body.message
    : `HTTP ${httpStatus}`;
}

export function decidePollResponse({
  httpStatus,
  body,
  consecutiveErrors,
  maxConsecutiveErrors = MAX_CONSECUTIVE_STATUS_ERRORS,
}: PollInput): PollDecision {
  if (httpStatus >= 200 && httpStatus < 300) return { kind: "read" };
  if (httpStatus === 401) return { kind: "auth" };

  const message = serverMessage(body, httpStatus);

  // The schema will not repair itself between two polls, and the route refused the
  // publish before it started — so this is a CERTAIN failure, nothing reached Strapi.
  if (body?.code === "schema_out_of_date") {
    return { kind: "fail", message, certain: true };
  }

  // Someone else's job, or a job that no longer exists. Neither is waiting on us.
  if (httpStatus === 403) return { kind: "fail", message, certain: true };
  if (httpStatus === 404) {
    return {
      kind: "fail",
      certain: false,
      message:
        "That publish job no longer exists on the server (it may have been cleared by a restart). " +
        "Check the content in Strapi before publishing again.",
    };
  }

  // Everything else — 5xx, a proxy error, a transient blip. Wait a few more polls; the
  // server process may simply be restarting under us.
  if (consecutiveErrors < maxConsecutiveErrors) return { kind: "wait" };

  return {
    kind: "fail",
    certain: false,
    message:
      `Lost contact with the publish job: ${message}. ` +
      "It may or may not have finished on the server — check Strapi before publishing again.",
  };
}

/**
 * The message shown when polling runs out of time while the job was still reporting
 * progress. Deliberately phrased as an UNKNOWN outcome, not a failure: the server is very
 * likely still working, and a blind retry is the thing most likely to duplicate content.
 */
export function timedOutMessage(what: "Mantra" | "Publish"): string {
  return (
    `${what} publish is taking longer than expected. It may still be running on the server — ` +
    "reload this page to pick the job back up, and check Strapi before republishing."
  );
}
