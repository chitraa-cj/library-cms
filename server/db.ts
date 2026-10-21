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
 *   1. DATABASE_SSL — a boolean, or an sslmode word (explicit override)
 *   2. sslmode=disable / sslmode=require in the connection string
 *   3. off for localhost / 127.0.0.1 / ::1, on for everything else
 *
 * Note for (2): do NOT put `sslmode=require` in DATABASE_URL to reach RDS. pg 8.16
 * parses it itself and verifies the certificate chain regardless of the `ssl` object
 * below, which RDS's chain fails with "self-signed certificate in certificate chain".
 * Use DATABASE_SSL instead — that is what this function is for.
 */
function resolveSsl(connectionString: string): false | { rejectUnauthorized: false } {
  const override = process.env.DATABASE_SSL?.trim().toLowerCase();
  if (override) {
    // Anything but an explicit "off" means TLS. A value we did not recognise used to
    // fall through to the host rule, which on a localhost host (an SSH tunnel to RDS)
    // silently dropped TLS — and RDS, with rds.force_ssl=1, then refuses the connection
    // with the thoroughly unhelpful `no pg_hba.conf entry for host … no encryption`.
    // `require` and `no-verify` are TLS without CA verification, which is exactly what
    // this pool does; `verify-ca`/`verify-full` cannot be honoured here (no CA bundle is
    // configured) and are treated as plain TLS rather than as a refusal to start.
    const off = ["false", "0", "off", "no", "none", "disable", "disabled"];
    return off.includes(override) ? false : { rejectUnauthorized: false };
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
