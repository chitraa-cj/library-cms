/**
 * Apply every SQL file in `script/migrations/`, once, in filename order.
 *
 * Why this exists
 * ---------------
 * Each migration already had its own npm script (`migrate:publish-queue`,
 * `migrate:backup-bytea`, …) and the deploy ran none of them — it ran `drizzle-kit push`
 * and did not check whether it succeeded. So a release could ship code that reads
 * `cms_publish_jobs.kind` to a database that has no such column, and the only symptom was
 * `Publish failed — column "kind" does not exist` in the editor.
 *
 * This runner keeps the project's convention (hand-written, reviewable SQL, newest file
 * last) and adds the two things it was missing: a record of what has been applied, and a
 * non-zero exit code when something has not.
 *
 * Contract for a migration file
 * -----------------------------
 * It must be RE-RUNNABLE. Every file in the directory already is (`IF NOT EXISTS`,
 * `DROP CONSTRAINT IF EXISTS` before `ADD`), which is what makes adopting this runner safe
 * on the production database, where these were applied by hand and the ledger starts
 * empty. `tests/migration-files.test.mjs` enforces the rule for new files.
 *
 * Usage
 * -----
 *   npm run migrate           apply everything pending
 *   npm run migrate:check     report pending migrations, exit 1 if any (no writes)
 *   npm run migrate -- --only 20261003_publish_job_queue.sql
 *   npm run migrate -- --all        re-apply every file, ignoring the ledger (repair)
 *   npm run migrate -- --baseline   record all files as applied WITHOUT running them
 */
import "../server/env";

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool } from "pg";

/**
 * Resolved on first use, never at import time: the pure helpers below are imported by
 * `tests/migration-files.test.mjs`, which has no database and must not need one
 * (`server/db.ts` throws on a missing DATABASE_URL the moment it is loaded).
 */
let poolPromise: Promise<Pool> | null = null;
function getPool(): Promise<Pool> {
  if (!poolPromise) poolPromise = import("../server/db").then((m) => m.pool as unknown as Pool);
  return poolPromise;
}

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

const LEDGER = "cms_schema_migrations";

export interface MigrationFile {
  version: string;
  filePath: string;
  sql: string;
  checksum: string;
  /** A file of nothing but comments (the diagnostics notebooks) is recorded, not executed. */
  empty: boolean;
}

export interface LedgerRow {
  version: string;
  checksum: string;
}

/** Strip comments to decide whether a file has any statement in it. */
export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .trim();
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort();
  const files: MigrationFile[] = [];
  for (const version of names) {
    const filePath = path.join(dir, version);
    const sql = await readFile(filePath, "utf8");
    files.push({
      version,
      filePath,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16),
      empty: stripSqlComments(sql).length === 0,
    });
  }
  return files;
}

/**
 * Split the loaded files into what still has to run and what has drifted.
 *
 * A checksum mismatch is reported but never re-applied: these files are re-runnable, so
 * a hand edit to an applied one is a review question, not something to silently redo.
 */
export function planMigrations(
  files: MigrationFile[],
  applied: LedgerRow[],
): { pending: MigrationFile[]; changed: MigrationFile[] } {
  const byVersion = new Map(applied.map((r) => [r.version, r.checksum]));
  const pending: MigrationFile[] = [];
  const changed: MigrationFile[] = [];
  for (const file of files) {
    const recorded = byVersion.get(file.version);
    if (recorded === undefined) pending.push(file);
    else if (recorded !== file.checksum) changed.push(file);
  }
  return { pending, changed };
}

async function ensureLedger(): Promise<void> {
  await (await getPool()).query(`
    create table if not exists ${LEDGER} (
      version     text primary key,
      checksum    text not null,
      applied_at  timestamp not null default now(),
      duration_ms integer not null default 0
    )
  `);
}

async function ledgerExists(): Promise<boolean> {
  const { rows } = await (await getPool()).query(`select to_regclass($1) as oid`, [LEDGER]);
  return rows[0]?.oid != null;
}

async function readLedger(): Promise<LedgerRow[]> {
  if (!(await ledgerExists())) return [];
  const { rows } = await (await getPool()).query(`select version, checksum from ${LEDGER}`);
  return rows as LedgerRow[];
}

async function record(file: MigrationFile, durationMs: number): Promise<void> {
  await (await getPool()).query(
    `insert into ${LEDGER} (version, checksum, applied_at, duration_ms)
     values ($1, $2, now(), $3)
     on conflict (version) do update
        set checksum = excluded.checksum,
            applied_at = excluded.applied_at,
            duration_ms = excluded.duration_ms`,
    [file.version, file.checksum, Math.round(durationMs)],
  );
}

/**
 * Run one file.
 *
 * The whole file goes to the server as a single simple query, which Postgres wraps in one
 * implicit transaction — so a file WITHOUT its own `BEGIN` is all-or-nothing, and a file
 * WITH one (several here have one, and 20261003 deliberately puts its index creation after
 * `COMMIT`) keeps exactly the boundaries its author wrote. Splitting on semicolons here
 * would break both, and `CREATE INDEX CONCURRENTLY` later would be impossible.
 */
async function apply(file: MigrationFile): Promise<number> {
  const started = Date.now();
  if (!file.empty) await (await getPool()).query(file.sql);
  return Date.now() - started;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const baseline = args.includes("--baseline");
  // Re-apply everything regardless of the ledger. The files are re-runnable, so this is
  // the repair path when the database and the ledger disagree — a column dropped by hand,
  // a restored dump, a ledger baselined against the wrong database.
  const all = args.includes("--all");
  const onlyIndex = args.indexOf("--only");
  const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;

  const files = await loadMigrations();
  const applied = all ? [] : await readLedger();
  let { pending, changed } = planMigrations(files, applied);

  if (only) {
    const target = files.find((f) => f.version === only || f.version === `${only}.sql`);
    if (!target) {
      console.error(`[migrate] no such migration: ${only}`);
      process.exitCode = 1;
      return;
    }
    pending = [target];
    changed = [];
  }

  for (const file of changed) {
    console.warn(
      `[migrate] WARNING ${file.version} has changed since it was applied (checksum ${file.checksum}). ` +
        "It was NOT re-run — review the edit and apply it as a new migration.",
    );
  }

  if (checkOnly) {
    if (pending.length === 0) {
      console.log(`[migrate] database is up to date (${files.length} migration(s) recorded)`);
      return;
    }
    console.error(`[migrate] ${pending.length} migration(s) PENDING:`);
    for (const file of pending) console.error(`  - ${file.version}`);
    console.error("[migrate] run `npm run migrate` to apply them");
    process.exitCode = 1;
    return;
  }

  await ensureLedger();

  if (baseline) {
    for (const file of pending) {
      await record(file, 0);
      console.log(`[migrate] baselined ${file.version} (not executed)`);
    }
    return;
  }

  if (pending.length === 0) {
    console.log(`[migrate] nothing to do (${files.length} migration(s) recorded)`);
    return;
  }

  console.log(`[migrate] applying ${pending.length} migration(s)…`);
  for (const file of pending) {
    process.stdout.write(`[migrate] ${file.version} … `);
    try {
      const ms = await apply(file);
      await record(file, ms);
      console.log(file.empty ? "recorded (no statements)" : `ok (${ms}ms)`);
    } catch (err: any) {
      console.log("FAILED");
      console.error(`[migrate] ${file.version} failed: ${err?.message ?? err}`);
      if (err?.detail) console.error(`[migrate]   detail: ${err.detail}`);
      if (err?.hint) console.error(`[migrate]   hint: ${err.hint}`);
      // Stop here. Later migrations may depend on this one, and a half-applied ladder is
      // far easier to reason about than one with a hole in the middle.
      process.exitCode = 1;
      return;
    }
  }
  console.log("[migrate] done");
}

// Importable by the tests (which only exercise the pure helpers) without connecting.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  main()
    .catch((err) => {
      console.error("[migrate] fatal:", err?.message ?? err);
      process.exitCode = 1;
    })
    .finally(() => void getPool().then((p) => p.end()).catch(() => {}));
}
