/**
 * Ask the DATABASE — not the migration ledger — whether publishing can work.
 *
 * `migrate:check` compares files against `cms_schema_migrations`, which answers "has this
 * migration been run?". That is not the same question as "does the column exist?": a
 * ledger baselined against the wrong database, a restored dump, or a column dropped by
 * hand all pass the ledger check and still break every publish with
 * `column "kind" does not exist`.
 *
 * This reads `information_schema` through the same guard the running server uses
 * (`server/schema-guard.ts`), so a green result here means the server will accept a
 * publish. It is the last gate in the deploy, after the migrations and before pm2 is
 * pointed at the new build.
 *
 *   npm run schema:check
 *
 * Exits 0 when the publish path is ready, 1 otherwise. Read-only: it writes nothing.
 */
import "../server/env";

import { checkPublishSchema } from "../server/schema-guard";

async function main(): Promise<void> {
  const result = await checkPublishSchema(true);

  // An UNKNOWN verdict must never read as a pass: the guard fails open so the running
  // server keeps serving, but a deploy gate has the opposite duty.
  if (result.error) {
    console.error(`[schema:check] could not inspect the database: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  if (result.ok) {
    console.log("[schema:check] publish schema OK — every required relation and column is present");
    return;
  }

  console.error("[schema:check] the database is BEHIND this build. Missing:");
  for (const item of result.missing) console.error(`  - ${item}`);
  console.error("");
  console.error("  Publishing will be refused until this is fixed. Apply the SQL:");
  console.error("    npm run migrate");
  console.error("");
  console.error("  If that reports 'nothing to do', the ledger and the database disagree —");
  console.error("  re-apply every migration (they are all re-runnable):");
  console.error("    npm run migrate -- --all");
  process.exitCode = 1;
}

main()
  .catch((err) => {
    // A database that cannot be reached is not a schema verdict; say so plainly rather
    // than sending someone to run migrations that would fail for the same reason.
    console.error("[schema:check] could not inspect the database:", err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { pool } = await import("../server/db");
    await pool.end().catch(() => {});
  });
