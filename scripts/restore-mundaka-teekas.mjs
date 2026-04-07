/**
 * Restoration script: Mundaka Upanishad teeka content
 * 
 * Root cause: Backup 3 (April 6) shows Mundaka manthras had teeka content
 * with teeka: null (broken relation). A subsequent publish on April 6 sent
 * Teekas: [] and wiped all teeka content from Strapi.
 * 
 * This script restores the 49 manthras with TeekaEntry content from backup 3,
 * correctly linking them to Anandagiri Teeka (wgr6epzpp6mmxom14otyjyix).
 */

import pg from 'pg';

const { Client } = pg;

const STRAPI_URL = 'http://13.53.121.15:1337';
const ANANDAGIRI_TEEKA_DOC_ID = 'wgr6epzpp6mmxom14otyjyix';
const BACKUP_ID = 3;
const MUNDAKA_GRANTHA_DOC_ID = 'qcbxoj6pwo01pgnr0hxloiun';

const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN;
if (!STRAPI_TOKEN) {
  console.error('ERROR: STRAPI_API_TOKEN environment variable not set');
  process.exit(1);
}

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('ERROR: DATABASE_URL environment variable not set');
  process.exit(1);
}

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  console.log('Connected to database. Fetching backup data...');

  // Get all Mundaka manthras with teeka content from backup 3
  const { rows } = await client.query(`
    WITH manthras AS (
      SELECT jsonb_array_elements(data->'manthras') as mantra
      FROM grantha_backups WHERE id = $1
    )
    SELECT 
      mantra->>'documentId' as doc_id,
      mantra->>'ShlokaManthraNumber' as mantra_num,
      mantra->'Teekas'->0->'TeekaEntry' as teeka_entry
    FROM manthras
    WHERE mantra->'Section'->'grantha'->>'documentId' = $2
      AND (mantra->'Teekas'->0->'TeekaEntry') IS NOT NULL
      AND mantra->'Teekas'->0->'TeekaEntry' != 'null'::jsonb
    ORDER BY mantra->>'ShlokaManthraNumber'
  `, [BACKUP_ID, MUNDAKA_GRANTHA_DOC_ID]);

  await client.end();

  console.log(`Found ${rows.length} Mundaka manthras with teeka content to restore.`);

  let successCount = 0;
  let failCount = 0;
  const errors = [];

  for (const row of rows) {
    const { doc_id: docId, mantra_num: mantraNum, teeka_entry: teekaEntryRaw } = row;
    
    // Strip Strapi's internal id from TeekaEntry - let Strapi assign new ones
    const { id: _id, ...teekaEntry } = teekaEntryRaw;
    
    // Strip OtherTranslation internal ids too
    if (Array.isArray(teekaEntry.OtherTranslations)) {
      teekaEntry.OtherTranslations = teekaEntry.OtherTranslations.map(({ id: _tid, ...rest }) => rest);
    }

    const payload = {
      data: {
        Teekas: [{
          teeka: ANANDAGIRI_TEEKA_DOC_ID,
          TeekaEntry: teekaEntry,
        }]
      }
    };

    try {
      const res = await fetch(`${STRAPI_URL}/api/manthras/${docId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${STRAPI_TOKEN}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.substring(0, 200)}`);
      }

      successCount++;
      process.stdout.write(`✓ ${mantraNum} (${docId})\n`);
    } catch (err) {
      failCount++;
      const msg = `✗ ${mantraNum} (${docId}): ${err.message}`;
      errors.push(msg);
      console.error(msg);
    }

    // Small delay to avoid overwhelming Strapi
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\n=== Restoration Complete ===`);
  console.log(`Success: ${successCount}`);
  console.log(`Failed: ${failCount}`);
  
  if (errors.length > 0) {
    console.log('\nFailed manthras:');
    errors.forEach(e => console.log(e));
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
