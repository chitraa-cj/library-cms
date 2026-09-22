import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

/**
 * Decide whether to negotiate TLS with Postgres.
 *
 * Production (RDS) needs TLS; a local `localhost` Postgres refuses it with
 * "The server does not support SSL connections". Precedence:
 *   1. DATABASE_SSL=true|false (explicit override)
 *   2. sslmode=disable / sslmode=require in the connection string
 *   3. off for localhost / 127.0.0.1 / ::1, on for everything else
 */
function resolveSsl(connectionString: string): false | { rejectUnauthorized: false } {
  const override = process.env.DATABASE_SSL?.trim().toLowerCase();
  if (override === "false" || override === "0" || override === "off") return false;
  if (override === "true" || override === "1" || override === "on") {
    return { rejectUnauthorized: false };
  }

  let host = "";
  let sslmode = "";
  try {
    const url = new URL(connectionString);
    host = url.hostname;
    sslmode = url.searchParams.get("sslmode") ?? "";
  } catch {
    // Fall through: unparsable URL keeps the historical always-on behaviour.
  }

  if (sslmode === "disable") return false;
  if (sslmode && sslmode !== "prefer" && sslmode !== "allow") {
    return { rejectUnauthorized: false };
  }

  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  return local ? false : { rejectUnauthorized: false };
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveSsl(process.env.DATABASE_URL),
});

pool.on("error", (err) => {
  console.error("[db] Idle pool client error (non-fatal):", err.message);
});

export const db = drizzle(pool, { schema });
