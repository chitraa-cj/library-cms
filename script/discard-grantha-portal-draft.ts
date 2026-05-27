/**
 * Remove a portal draft that hides a published Strapi grantha on the list page.
 *
 * Usage:
 *   npx tsx script/discard-grantha-portal-draft.ts --grantha "Ishavasya"
 *   npx tsx script/discard-grantha-portal-draft.ts --strapi-doc-id ngjdm2fcgp0ogp16jcey3vo1
 *   npx tsx script/discard-grantha-portal-draft.ts --grantha "Ishavasya" --dry-run
 *   npx tsx script/discard-grantha-portal-draft.ts --grantha "Ishavasya" --execute
 */
import "../server/env";
import pg from "pg";
import { discardDraftWithDependencies, getDraftDiscardPlan } from "../server/draft-discard";

function parseArgs() {
  const args = process.argv.slice(2);
  let granthaQuery = "Ishavasya";
  let strapiDocId: string | undefined;
  let dryRun = true;
  let execute = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--grantha" && args[i + 1]) granthaQuery = args[++i];
    else if (args[i] === "--strapi-doc-id" && args[i + 1]) strapiDocId = args[++i];
    else if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--execute") {
      execute = true;
      dryRun = false;
    }
  }
  if (execute) dryRun = false;
  return { granthaQuery, strapiDocId, dryRun };
}

async function main() {
  const { granthaQuery, strapiDocId, dryRun } = parseArgs();
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required");

  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    const like = `%${granthaQuery}%`;
    const res = await pool.query(
      `SELECT id, title, status, strapi_document_id
       FROM content_drafts
       WHERE content_type = 'granthas'
         AND status = 'draft'
         AND (
           ($1::text IS NOT NULL AND strapi_document_id = $1)
           OR title ILIKE $2
           OR (data->>'GranthaName') ILIKE $2
         )`,
      [strapiDocId ?? null, like],
    );

    if (res.rows.length === 0) {
      console.log(
        `No unpublished portal draft found for "${granthaQuery}"${strapiDocId ? ` (${strapiDocId})` : ""}.`,
      );
      console.log("If the UI still shows Draft, hard-refresh the browser or check you are on the same DATABASE_URL.");
      return;
    }

    for (const row of res.rows) {
      const plan = await getDraftDiscardPlan(row.id);
      console.log(
        `${dryRun ? "[DRY_RUN]" : "[EXECUTE]"} draft #${row.id} "${row.title}" — idempotency=${plan.idempotencyKeys} jobs=${plan.publishJobs} tasks=${plan.publishJobTasks}`,
      );
      const result = await discardDraftWithDependencies({ draftId: row.id, dryRun });
      if (!dryRun && result.deleted) {
        console.log(`Discarded draft #${row.id} (strapi=${row.strapi_document_id || "none"})`);
      }
    }
    if (dryRun) {
      console.log("No changes written. Re-run with --execute to discard.");
    } else {
      console.log("Done. Reload the Granthas list — the grantha should appear as Published.");
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
