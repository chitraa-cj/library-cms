/**
 * Remove a portal draft that hides a published Strapi grantha on the list page.
 *
 * Usage:
 *   npx tsx script/discard-grantha-portal-draft.ts --grantha "Ishavasya"
 *   npx tsx script/discard-grantha-portal-draft.ts --strapi-doc-id ngjdm2fcgp0ogp16jcey3vo1
 */
import "../server/env";
import pg from "pg";

function parseArgs() {
  const args = process.argv.slice(2);
  let granthaQuery = "Ishavasya";
  let strapiDocId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--grantha" && args[i + 1]) granthaQuery = args[++i];
    else if (args[i] === "--strapi-doc-id" && args[i + 1]) strapiDocId = args[++i];
  }
  return { granthaQuery, strapiDocId };
}

async function main() {
  const { granthaQuery, strapiDocId } = parseArgs();
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
      await pool.query(`DELETE FROM content_drafts WHERE id = $1`, [row.id]);
      console.log(
        `Deleted draft #${row.id} "${row.title}" (strapi=${row.strapi_document_id || "none"}, was ${row.status})`,
      );
    }
    console.log("Done. Reload the Granthas list — Ishavasya should appear as Published.");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
