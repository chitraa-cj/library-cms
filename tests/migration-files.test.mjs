/**
 * The migration ladder, checked without a database.
 * =================================================
 * `script/migrate.ts` records what it has applied and never re-runs it. On the production
 * box the ledger starts EMPTY while the migrations have long been applied by hand, so the
 * first `npm run migrate` re-runs every file against a live database. That is only safe
 * because each file is re-runnable — which is a property of the SQL, not of the runner,
 * and therefore has to be enforced here.
 *
 * Also asserts that everything `server/schema-guard.ts` demands before accepting a publish
 * is actually created by a file in this directory. Those two lists drifting apart is what
 * produced `Publish failed — column "kind" does not exist`.
 *
 * Run:  npm run test:migration-files      (no DATABASE_URL needed)
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { loadMigrations, planMigrations, stripSqlComments } = await import(
  "../script/migrate.ts"
);
const { PUBLISH_REQUIRED_SCHEMA } = await import("../server/schema-guard.ts");

let PASS = 0;
const FAILURES = [];
function check(name, cond, detail) {
  if (cond) {
    PASS++;
    console.log(`  ok  ${name}`);
  } else {
    FAILURES.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const files = await loadMigrations(path.join(ROOT, "script", "migrations"));

// ── every file is re-runnable ────────────────────────────────────────────────────
console.log("\nmigration files are re-runnable");
check("there is at least one migration", files.length > 0);

for (const file of files) {
  const sql = stripSqlComments(file.sql).toLowerCase();
  if (!sql) continue; // comment-only notebooks are recorded, never executed

  const creates = [...sql.matchAll(/create\s+(?:unique\s+)?(table|index)\s+([^\s(]+)/g)];
  for (const [, kind, next] of creates) {
    check(
      `${file.version}: create ${kind} guarded by IF NOT EXISTS`,
      next.startsWith("if"),
      `found \`create ${kind} ${next}\``,
    );
  }

  const adds = [...sql.matchAll(/add\s+column\s+([^\s(]+)/g)];
  for (const [, next] of adds) {
    check(
      `${file.version}: add column guarded by IF NOT EXISTS`,
      next.startsWith("if"),
      `found \`add column ${next}\``,
    );
  }

  // `ADD CONSTRAINT` is not idempotent on its own; it needs a DROP ... IF EXISTS first.
  const addsConstraint = /add\s+constraint\s+([a-z0-9_]+)/g;
  for (const [, name] of sql.matchAll(addsConstraint)) {
    check(
      `${file.version}: constraint ${name} dropped before it is added`,
      new RegExp(`drop\\s+constraint\\s+if\\s+exists\\s+${name}\\b`).test(sql),
      "a re-run would fail with 42710 duplicate_object",
    );
  }

  // A bare DROP/TRUNCATE/DELETE would make a re-run destructive.
  check(
    `${file.version}: no destructive statements`,
    !/\b(drop\s+(table|column|database)|truncate|delete\s+from)\b/.test(sql),
    "migrations must never remove data",
  );
}

// ── filenames sort in apply order ────────────────────────────────────────────────
console.log("\nfilenames order the ladder");
const versions = files.map((f) => f.version);
check(
  "filenames are datestamped (or the 00000000 baseline)",
  versions.every((v) => /^\d{8}_[a-z0-9_]+\.sql$/.test(v)),
  versions.filter((v) => !/^\d{8}_[a-z0-9_]+\.sql$/.test(v)).join(", "),
);
check(
  "loadMigrations returns them sorted",
  versions.join() === [...versions].sort().join(),
);
check(
  "the baseline that creates cms_publish_jobs sorts first",
  versions[0] === "00000000_baseline_publish_tables.sql",
  versions[0],
);

// ── the ledger decides what runs ─────────────────────────────────────────────────
console.log("\nplanMigrations");
{
  const { pending, changed } = planMigrations(files, []);
  check("an empty ledger means everything is pending", pending.length === files.length);
  check("…and nothing is reported as changed", changed.length === 0);
}
{
  const applied = files.map((f) => ({ version: f.version, checksum: f.checksum }));
  const { pending, changed } = planMigrations(files, applied);
  check("a full ledger means nothing is pending", pending.length === 0);
  check("…and nothing has drifted", changed.length === 0);
}
{
  // The exact production shape: migrations applied by hand before the runner existed.
  const applied = files
    .slice(0, files.length - 1)
    .map((f) => ({ version: f.version, checksum: f.checksum }));
  const { pending } = planMigrations(files, applied);
  check("only the un-recorded tail is pending", pending.length === 1);
  check("…and it is the newest file", pending[0].version === files[files.length - 1].version);
}
{
  const applied = files.map((f) => ({ version: f.version, checksum: "deadbeef" }));
  const { pending, changed } = planMigrations(files, applied);
  check("an edited applied migration is reported", changed.length === files.length);
  check("…and is NOT silently re-run", pending.length === 0);
}

// ── the schema guard and the SQL agree ───────────────────────────────────────────
// Every column the publish path refuses to run without must be created somewhere in this
// directory, or the guard would report a problem no migration can fix.
console.log("\nschema guard is backed by SQL");
const allSql = files.map((f) => f.sql.toLowerCase()).join("\n");
for (const relation of PUBLISH_REQUIRED_SCHEMA) {
  check(
    `${relation.table} is created by a migration`,
    new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+${relation.table}\\b`).test(allSql),
  );
  for (const column of relation.columns) {
    check(
      `${relation.table}.${column} appears in a migration`,
      new RegExp(`\\b${column}\\b`).test(allSql),
    );
  }
}

// The regression that started this: the queue columns must be in 20261003.
console.log("\nthe publish queue migration");
{
  const queue = files.find((f) => f.version === "20261003_publish_job_queue.sql");
  check("20261003_publish_job_queue.sql is present", !!queue);
  const sql = (queue?.sql ?? "").toLowerCase();
  for (const column of ["kind", "attempts", "max_attempts", "lease_owner", "publish_options"]) {
    check(
      `it adds cms_publish_jobs.${column}`,
      new RegExp(`add\\s+column\\s+if\\s+not\\s+exists\\s+${column}\\b`).test(sql),
    );
  }
}

// ── the runner itself ────────────────────────────────────────────────────────────
console.log("\nstripSqlComments");
check("line comments are removed", stripSqlComments("-- hello\nselect 1;") === "select 1;");
check("block comments are removed", stripSqlComments("/* x */ select 1;") === "select 1;");
check("a comment-only file is empty", stripSqlComments("-- only\n-- comments\n") === "");
check(
  "the diagnostics notebook is marked empty, not executed",
  files.find((f) => f.version.includes("diagnostics"))?.empty === true,
);

// ── report ───────────────────────────────────────────────────────────────────────
console.log(`\n${PASS} passed, ${FAILURES.length} failed`);
if (FAILURES.length) {
  for (const name of FAILURES) console.log(`  - ${name}`);
  process.exit(1);
}
