/**
 * One line per publish lifecycle event, in a shape that greps and parses.
 *
 *   [publish] manthra.accepted draft=412 job=k3f9a2b1c0 manthra=m-17 user=3
 *   [publish] manthra.failed   draft=412 job=k3f9a2b1c0 ms=8120 code=schema_out_of_date
 *
 * The web process previously logged a publish failure as a bare `console.error(error)` —
 * a stack with no job id, no draft id and no duration, which is why "publishing is
 * failing" could not be told apart from "publishing is slow" in the logs.
 *
 * Values are sanitised the same way the job row's `error` column is, so a Strapi URL with
 * a token in it cannot reach the log. Payloads, draft contents and credentials are never
 * accepted here — pass identifiers and counts.
 */
import { sanitizePublishError } from "./config";

export type PublishLogField = string | number | boolean | null | undefined;

const MAX_VALUE = 200;

function render(value: PublishLogField): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const clean = sanitizePublishError(value).replace(/\s+/g, " ").trim();
  return clean.length > MAX_VALUE ? `${clean.slice(0, MAX_VALUE)}…` : clean;
}

/**
 * `event` is a dotted noun.verb — `grantha.queued`, `manthra.done`, `status.unavailable`.
 * Keep the vocabulary small so a release can be audited with one grep.
 */
export function publishLog(
  event: string,
  fields: Record<string, PublishLogField> = {},
  level: "info" | "warn" | "error" = "info",
): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${render(v)}`);
  const line = `[publish] ${event}${parts.length ? ` ${parts.join(" ")}` : ""}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
