/**
 * "Does this database have the shape the publish pipeline needs?"
 *
 * The queue columns added by `script/migrations/20261003_publish_job_queue.sql`
 * (`cms_publish_jobs.kind` and friends) are read by the FIRST statement of every publish
 * route. When the migration has not been applied on the box, that statement throws
 * `column "kind" does not exist` deep inside drizzle and the editor sees either Postgres's
 * own wording or — on `/publish-status`, whose 500s the poller swallowed — nothing at all
 * for twenty minutes.
 *
 * Checking the catalogue up front costs one indexed query against `information_schema`,
 * cached, and converts that class of outage into one sentence naming the fix.
 *
 * The list below is the schema the publish path actually depends on. Add to it when a
 * migration adds something publishing reads; `tests/migration-files.test.mjs` asserts every
 * entry is backed by a migration file so the two cannot drift apart.
 */
import { sql } from "drizzle-orm";

export interface RequiredRelation {
  table: string;
  /** Columns that must exist on it. An empty list means "the table itself must exist". */
  columns: string[];
}

export const PUBLISH_REQUIRED_SCHEMA: RequiredRelation[] = [
  {
    table: "cms_publish_jobs",
    columns: [
      "id",
      "draft_id",
      "grantha_doc_id",
      "status",
      // 20261003_publish_job_queue.sql — the set whose absence produced
      // `column "kind" does not exist` on every publish.
      "kind",
      "attempts",
      "max_attempts",
      "lease_owner",
      "lease_expires_at",
      "last_heartbeat_at",
      "next_attempt_at",
      "started_at",
      "publish_options",
      "progress_done",
      "progress_total",
      "progress_current",
    ],
  },
  // Lets POST /publish answer "the worker is not running" instead of queueing forever.
  { table: "cms_worker_heartbeats", columns: ["worker_kind", "worker_id", "beat_at"] },
  // Retry checkpoint: without it a retried publish re-creates mantras in Strapi.
  {
    table: "cms_publish_manthra_resolutions",
    columns: ["job_id", "portal_manthra_id", "strapi_document_id"],
  },
  // Replay protection for a double-clicked publish.
  { table: "cms_idempotency_keys", columns: ["key", "route", "request_hash"] },
];

export interface SchemaCheckResult {
  ok: boolean;
  /** `table` or `table.column` for everything the database is missing. */
  missing: string[];
  checkedAt: number;
  /**
   * Set when the catalogue could not be read at all. `ok` is true in that case — see
   * `checkPublishSchema` — so anything that must not pass on an UNKNOWN verdict
   * (`script/check-schema.ts`) has to look here rather than at `ok` alone.
   */
  error?: string;
}

/**
 * Cached so a poll loop does not re-query the catalogue every second.
 *
 * A healthy result is held far longer than an unhealthy one on purpose: once an
 * administrator runs the migration, the portal must recover on its own rather than
 * needing a restart, so a failing verdict is re-checked every few seconds.
 */
const OK_TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 5_000;

let cached: SchemaCheckResult | null = null;
let inFlight: Promise<SchemaCheckResult> | null = null;

function isFresh(result: SchemaCheckResult): boolean {
  const ttl = result.ok ? OK_TTL_MS : FAIL_TTL_MS;
  return Date.now() - result.checkedAt < ttl;
}

/**
 * The pure half of the check: what is required, minus what the catalogue reported.
 * Separated so `tests/publish-error-handling.test.mjs` can exercise it without a database.
 */
export function diffRequiredSchema(
  present: Map<string, Set<string>>,
  required: RequiredRelation[] = PUBLISH_REQUIRED_SCHEMA,
): string[] {
  const missing: string[] = [];
  for (const relation of required) {
    const columns = present.get(relation.table);
    if (!columns) {
      missing.push(relation.table);
      continue;
    }
    for (const column of relation.columns) {
      if (!columns.has(column)) missing.push(`${relation.table}.${column}`);
    }
  }
  return missing;
}

async function runCheck(): Promise<SchemaCheckResult> {
  // Imported here, not at the top: `server/db.ts` throws on a missing DATABASE_URL the
  // moment it loads, and the pure helpers above are unit-tested without a database.
  const { db } = await import("./db");
  const tables = PUBLISH_REQUIRED_SCHEMA.map((r) => r.table);

  // One round trip for both questions: which of these tables exist, and which columns do
  // they have. `information_schema` is restricted to objects the current role can see,
  // which is exactly the right scope — a table we cannot read is as good as missing.
  // One bound parameter per name. Interpolating the ARRAY itself produces
  // `any(($1,$2,…))` — a record, not a text[] — which Postgres rejects with
  // "cannot cast type record to text[]".
  const names = sql.join(
    tables.map((t) => sql`${t}`),
    sql`, `,
  );
  const result = await db.execute(sql`
    select table_name, column_name
      from information_schema.columns
     where table_schema = current_schema()
       and table_name in (${names})
  `);
  const rows = ((result as any)?.rows ?? []) as Array<{
    table_name: string;
    column_name: string;
  }>;

  const present = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = row.table_name;
    if (!present.has(key)) present.set(key, new Set());
    present.get(key)!.add(row.column_name);
  }

  const missing = diffRequiredSchema(present);
  return { ok: missing.length === 0, missing, checkedAt: Date.now() };
}

/**
 * Check the schema, reusing a recent verdict. Concurrent callers share one query.
 *
 * Never throws for a *schema* reason — a database that cannot be reached at all is
 * reported as `ok` so the real connectivity error surfaces from the actual query, with
 * its own message, rather than being mislabelled "run the migration".
 */
export async function checkPublishSchema(force = false): Promise<SchemaCheckResult> {
  if (!force && cached && isFresh(cached)) return cached;
  if (inFlight) return inFlight;

  inFlight = runCheck()
    .then((result) => {
      cached = result;
      return result;
    })
    .catch((err) => {
      const message = (err as any)?.message ?? String(err);
      console.error("[schema-guard] catalogue check failed:", message);
      // Fail OPEN: a guard that cannot answer must not become a second outage. The real
      // query will raise the real error, with its own (now classified) message.
      const result: SchemaCheckResult = {
        ok: true,
        missing: [],
        checkedAt: Date.now(),
        error: message,
      };
      return result;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

export class SchemaOutOfDateError extends Error {
  readonly status = 503;
  readonly code = "schema_out_of_date";
  readonly missing: string[];

  constructor(missing: string[]) {
    super(
      "The portal's database is missing a schema change this release needs " +
        `(${missing.slice(0, 6).join(", ")}${missing.length > 6 ? `, +${missing.length - 6} more` : ""}). ` +
        "Nothing was published. An administrator must run `npm run migrate` on the server; " +
        "publishing works again immediately afterwards, without a redeploy.",
    );
    this.name = "SchemaOutOfDateError";
    this.missing = missing;
  }
}

/**
 * Guard a publish entry point. Throws `SchemaOutOfDateError` (status 503) so the route's
 * existing error handling answers with one actionable sentence instead of letting the
 * first drizzle query fail with Postgres's wording.
 */
export async function assertPublishSchemaReady(): Promise<void> {
  const result = await checkPublishSchema();
  if (!result.ok) throw new SchemaOutOfDateError(result.missing);
}

/**
 * Startup banner. Called by the web process and the publish worker so a box running
 * un-migrated code says so in its own logs at boot, not only when an editor hits Publish.
 */
export async function logSchemaPreflight(processName: string): Promise<SchemaCheckResult> {
  const result = await checkPublishSchema(true);
  if (result.ok) {
    console.log(`[schema-guard] ${processName}: publish schema OK`);
  } else {
    console.error(
      `[schema-guard] ${processName}: DATABASE IS BEHIND THIS BUILD — missing ${result.missing.join(", ")}. ` +
        "Publishing will be refused until `npm run migrate` is run.",
    );
  }
  return result;
}
