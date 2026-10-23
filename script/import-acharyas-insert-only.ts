/**
 * Add acharyas from a seed-format file WITHOUT touching any existing profile.
 *
 *   npm run import:acharyas-insert-only -- <records.json>           # dry run
 *   npm run import:acharyas-insert-only -- <records.json> --apply
 *
 * Unlike seed:acharyas (an upsert that rewrites name/bio/works on every slug it
 * already has), a record is only ever INSERTed, and is skipped when its slug,
 * source_ref, or normalized Devanagari name/alias is already in the table.
 * After applying, every pre-existing row is re-read and compared field by field;
 * any difference fails the run loudly.
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { isDeepStrictEqual } from "util";
import { pool } from "../server/db";

const file = process.argv[2];
const apply = process.argv.includes("--apply");

/** Same comparison key as scripts/scrape_acharya_profiles.py `norm`. */
const norm = (s: string) =>
  (s ?? "").trim().normalize("NFC").replace(/[<>ः]/g, "").replace(/\s+/g, "");

async function main() {
  if (!file) throw new Error("usage: import-acharyas-insert-only <records.json> [--apply]");
  const records: any[] = JSON.parse(readFileSync(file, "utf-8")).acharyas;

  const before = (await pool.query("select * from acharya_profiles order by id")).rows;
  const slugs = new Set(before.map((r) => r.slug));
  const refs = new Set(before.map((r) => r.source_ref).filter(Boolean));
  const names = new Set(
    before.flatMap((r) => [r.name_devanagari, ...(r.aliases ?? [])]).map(norm),
  );

  const toInsert: any[] = [];
  for (const rec of records) {
    const clash = slugs.has(rec.slug)
      ? `slug ${rec.slug}`
      : rec.sourceRef && refs.has(rec.sourceRef)
        ? `source_ref ${rec.sourceRef}`
        : names.has(norm(rec.nameDevanagari))
          ? `name ${rec.nameDevanagari}`
          : null;
    if (clash) {
      console.log(`SKIP  ${rec.nameDevanagari} — already have ${clash}`);
      continue;
    }
    toInsert.push(rec);
    slugs.add(rec.slug);
    names.add(norm(rec.nameDevanagari));
  }
  console.log(`${before.length} existing, ${records.length} in file, ${toInsert.length} to insert`);
  if (!apply) {
    for (const r of toInsert) console.log(`  + ${r.slug}  ${r.nameDevanagari}  ${r.dates ?? ""}`);
    console.log("dry run — pass --apply to insert");
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const r of toInsert) {
      const res = await client.query(
        `insert into acharya_profiles
           (slug, source_ref, source_url, name_devanagari, name_iast, name_display, aliases,
            dates, lineage_order, guru_devanagari, category, biography, works_list, bio_status)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14)
         on conflict (slug) do nothing`,
        [
          r.slug, r.sourceRef, r.sourceUrl, r.nameDevanagari, r.nameIast, r.nameDisplay,
          JSON.stringify(r.aliases ?? []), r.dates, r.lineageOrder, r.guruDevanagari,
          r.category, JSON.stringify(r.biography ?? []), JSON.stringify(r.worksList ?? []),
          r.bioStatus ?? "empty",
        ],
      );
      if (res.rowCount !== 1) throw new Error(`insert of ${r.slug} did not insert — aborting`);
    }

    const after = (
      await client.query("select * from acharya_profiles where id = any($1) order by id", [
        before.map((r) => r.id),
      ])
    ).rows;
    const changed = before.filter((b, i) => !isDeepStrictEqual(b, after[i]));
    if (after.length !== before.length || changed.length) {
      throw new Error(`existing rows changed: ${changed.map((r) => r.slug).join(", ")} — rolled back`);
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
  const total = (await pool.query("select count(*)::int n from acharya_profiles")).rows[0].n;
  console.log(`Inserted ${toInsert.length}; ${before.length} existing rows verified unchanged; table now ${total}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
