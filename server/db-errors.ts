/**
 * Turning a raw Postgres error into something a route can safely return.
 *
 * `POST /api/drafts/:id/publish` used to answer `res.status(500).json({ message:
 * error.message })`, so the portal rendered Postgres's own wording — the editor's
 * "Publish failed — column "kind" does not exist" came from here. That is both a leak of
 * internals and, worse, unactionable: the real cause was a schema migration that had not
 * been applied on the box, and nothing in that sentence says so.
 *
 * Everything below maps an error to a stable `code`, an HTTP status and a sentence an
 * editor can act on. The raw message is never returned in production; it is logged.
 */

/** Stable codes the client may branch on. Keep in sync with the editor's error handling. */
export type DbErrorCode =
  | "schema_out_of_date"
  | "db_unavailable"
  | "db_conflict"
  | "db_timeout";

export interface ClassifiedDbError {
  code: DbErrorCode;
  status: number;
  /** Safe to show a logged-in editor in any environment. */
  message: string;
  /** Raw driver text — logs only. */
  detail: string;
}

/**
 * Postgres SQLSTATEs that mean "the database does not have the shape this build expects".
 * 42703 undefined_column, 42P01 undefined_table, 42704 undefined_object,
 * 42883 undefined_function, 3F000 invalid_schema_name.
 */
const SCHEMA_CODES = new Set(["42703", "42P01", "42704", "42883", "3F000"]);

/**
 * Connectivity / availability. 08xxx are connection exceptions, 53300 too_many_connections,
 * 57P01-57P03 admin shutdown & co, plus the Node-level socket errnos.
 */
const UNAVAILABLE_CODES = new Set([
  "08000",
  "08003",
  "08006",
  "08001",
  "08004",
  "53300",
  "57P01",
  "57P02",
  "57P03",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ECONNRESET",
  "EPIPE",
]);

const MIGRATION_HINT =
  "The portal's database is missing a schema change this release needs. " +
  "An administrator must run `npm run migrate` on the server; publishing will work again " +
  "immediately afterwards, without a redeploy.";

function rawMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Name the missing object when the driver tells us. `err.column` / `err.table` are only
 * populated for some SQLSTATEs, so fall back to parsing the quoted identifier out of the
 * message (`column "kind" does not exist`).
 *
 * This is our own schema, not user data, and it is the one detail that makes the error
 * diagnosable from a screenshot — so unlike the rest of the driver output it is kept.
 */
function missingObject(err: any): string | null {
  const named = err?.column || err?.table || err?.routine_schema;
  if (typeof named === "string" && named) return named;
  const match = /(?:column|relation|table|type|function)\s+"([^"]+)"/i.exec(rawMessage(err));
  return match?.[1] ?? null;
}

/**
 * Classify an error thrown by pg / drizzle. Returns null for anything that is not
 * recognisably a database problem, so callers fall through to their own handling.
 */
export function classifyDbError(err: unknown): ClassifiedDbError | null {
  const code = (err as any)?.code;
  const detail = rawMessage(err);
  if (typeof code !== "string") return null;

  if (SCHEMA_CODES.has(code)) {
    const object = missingObject(err);
    return {
      code: "schema_out_of_date",
      status: 503,
      message: object ? `${MIGRATION_HINT} (missing: ${object})` : MIGRATION_HINT,
      detail,
    };
  }

  if (UNAVAILABLE_CODES.has(code)) {
    return {
      code: "db_unavailable",
      status: 503,
      message:
        "The portal could not reach its database. Nothing was published. Wait a few seconds and try again.",
      detail,
    };
  }

  // 57014 query_canceled (statement_timeout), 55P03 lock_not_available.
  if (code === "57014" || code === "55P03") {
    return {
      code: "db_timeout",
      status: 503,
      message:
        "The database took too long to answer, so this publish was not started. Try again in a moment.",
      detail,
    };
  }

  if (code === "23505") {
    return {
      code: "db_conflict",
      status: 409,
      message: "That work is already in progress. Refresh to pick up the running job.",
      detail,
    };
  }

  return null;
}

/** True when the error means the deployed schema is behind the deployed code. */
export function isSchemaError(err: unknown): boolean {
  return classifyDbError(err)?.code === "schema_out_of_date";
}

/**
 * The body a route should send for a failed operation.
 *
 * Non-database failures keep their own message (those are written for editors and are
 * already safe). Database failures are replaced wholesale outside development, so no
 * SQLSTATE, table name or driver text reaches the browser beyond the deliberate
 * "missing:" hint above.
 */
export function toApiError(
  err: unknown,
  fallbackMessage: string,
): { status: number; body: { message: string; code?: string } } {
  const classified = classifyDbError(err);
  if (classified) {
    return {
      status: classified.status,
      body: {
        message:
          process.env.NODE_ENV === "production"
            ? classified.message
            : `${classified.message} [${classified.detail}]`,
        code: classified.code,
      },
    };
  }

  // Not a database error: these messages are written for editors (Strapi responses,
  // validation, integrity checks) and are deliberately left intact.
  const status = (err as any)?.status ?? (err as any)?.statusCode ?? 500;
  const code = (err as any)?.code;
  const message = rawMessage(err) || fallbackMessage;
  return {
    status: typeof status === "number" ? status : 500,
    body: typeof code === "string" && !/^\d/.test(code) ? { message, code } : { message },
  };
}
