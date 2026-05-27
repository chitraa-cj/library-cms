/**
 * Dry-run / execute portal draft discard with dependency cleanup.
 *
 *   npx tsx script/discard-draft-dependencies.ts --draft-id 6
 *   npx tsx script/discard-draft-dependencies.ts --all --dry-run
 *   npx tsx script/discard-draft-dependencies.ts --draft-id 6 --execute
 */
import "../server/env";
import pg from "pg";
import { discardDraftWithDependencies, getDraftDiscardPlan } from "../server/draft-discard";

function parseArgs() {
  const args = process.argv.slice(2);
  let draftId: number | undefined;
  let all = false;
  let dryRun = true;
  let execute = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--draft-id" && args[i + 1]) draftId = parseInt(args[++i], 10);
    else if (args[i] === "--all") all = true;
    else if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--execute") {
      execute = true;
      dryRun = false;
    }
  }
  if (execute) dryRun = false;
  return { draftId, all, dryRun };
}

async function sqlDiagnostics(pool: pg.Pool, draftId: number) {
  const draft = await pool.query(`SELECT * FROM content_drafts WHERE id = $1`, [draftId]);
  const idem = await pool.query(`SELECT * FROM cms_idempotency_keys WHERE draft_id = $1`, [draftId]);
  console.log("\n--- content_drafts ---");
  console.log(draft.rows[0] ?? "(not found)");
  console.log(`\n--- cms_idempotency_keys (${idem.rows.length} rows) ---`);
  for (const row of idem.rows.slice(0, 5)) {
    console.log({
      key: row.key,
      route: row.route,
      expires_at: row.expires_at,
      created_at: row.created_at,
    });
  }
  if (idem.rows.length > 5) console.log(`… and ${idem.rows.length - 5} more`);
}

async function main() {
  const { draftId, all, dryRun } = parseArgs();
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required");

  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    if (all) {
      const dangling = await pool.query(`
        SELECT draft_id, COUNT(*)::int AS key_count
        FROM cms_idempotency_keys
        WHERE draft_id IS NOT NULL
        GROUP BY draft_id
        ORDER BY key_count DESC
      `);
      console.log("=== Dangling idempotency by draft_id ===");
      console.table(dangling.rows);

      const blocked = await pool.query(`
        SELECT d.id, d.title, d.status, d.strapi_document_id,
          (SELECT COUNT(*)::int FROM cms_idempotency_keys k WHERE k.draft_id = d.id) AS idem_keys,
          (SELECT COUNT(*)::int FROM cms_publish_jobs j WHERE j.draft_id = d.id) AS publish_jobs,
          (SELECT COUNT(*)::int FROM cms_publish_job_tasks t WHERE t.draft_id = d.id) AS publish_tasks
        FROM content_drafts d
        WHERE EXISTS (SELECT 1 FROM cms_idempotency_keys k WHERE k.draft_id = d.id)
           OR EXISTS (SELECT 1 FROM cms_publish_jobs j WHERE j.draft_id = d.id)
        ORDER BY idem_keys DESC
      `);
      console.log("\n=== Drafts with dependents (would need cleanup before DELETE) ===");
      console.table(blocked.rows);

      const expired = await pool.query(`
        SELECT COUNT(*)::int AS expired_still_in_db
        FROM cms_idempotency_keys
        WHERE expires_at < NOW()
      `);
      console.log("\nExpired idempotency rows still in DB:", expired.rows[0]?.expired_still_in_db);

      if (dryRun) {
        console.log("\n[DRY_RUN] No mutations. Pass --execute with --draft-id to discard one draft.");
        return;
      }
      console.log("\n--execute with --all is not supported; use --draft-id per draft.");
      return;
    }

    if (!draftId || Number.isNaN(draftId)) {
      console.error("Provide --draft-id <n> or --all --dry-run");
      process.exit(1);
    }

    await sqlDiagnostics(pool, draftId);
    const plan = await getDraftDiscardPlan(draftId);
    console.log("\n=== Discard plan ===");
    console.log(JSON.stringify(plan, null, 2));

    const result = await discardDraftWithDependencies({ draftId, dryRun });
    console.log("\n=== Result ===");
    console.log(JSON.stringify(result, null, 2));

    if (!dryRun && result.deleted) {
      const verify = await pool.query(
        `SELECT COUNT(*)::int AS remaining FROM cms_idempotency_keys WHERE draft_id = $1`,
        [draftId],
      );
      console.log("Post-delete idempotency rows for draft:", verify.rows[0]?.remaining);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
