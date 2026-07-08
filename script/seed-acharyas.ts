/**
 * Seed / re-seed the acharya_profiles table from
 * shared/data/acharya-profiles.seed.json.
 *
 *   npm run seed:acharyas
 *
 * Idempotent (upsert by slug). Editor-managed fields (nameDisplay, avatarUrl)
 * are preserved on re-seed.
 */
import "dotenv/config";
import { seedAcharyas } from "../server/acharyas";
import { pool } from "../server/db";

async function main() {
  const n = await seedAcharyas();
  console.log(`Seeded ${n} acharya profiles.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
