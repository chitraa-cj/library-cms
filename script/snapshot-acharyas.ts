/**
 * File the acharya profiles as their own snapshot in the portal's Snapshots page,
 * without the full Strapi fetch a library snapshot does. Use it before any bulk
 * acharya change.
 *
 *   npm run snapshot:acharyas -- --label "Before X"            # the live table
 *   npm run snapshot:acharyas -- --from export.json --label …  # a saved export
 *
 * `--from` takes `{ rows: [...] }` straight out of `select * from acharya_profiles`
 * (snake_case); rows are stored in the same camelCase shape a full snapshot uses.
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { pool } from "../server/db";
import { storage } from "../server/storage";
import { listAcharyas } from "../server/acharyas";
import { buildBackupSummaryPayload, compressBackupData } from "../server/backup-payload";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const camel = (k: string) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

async function main() {
  const from = arg("from");
  const acharyas: any[] = from
    ? JSON.parse(readFileSync(from, "utf-8")).rows.map((r: any) =>
        Object.fromEntries(Object.entries(r).map(([k, v]) => [camel(k), v])),
      )
    : await listAcharyas();
  if (!acharyas.length) throw new Error("no acharya rows — refusing to file an empty snapshot");

  const label = `Acharyas — ${acharyas.length} profiles` + (arg("label") ? ` (${arg("label")})` : "");
  const snapshot = {
    timestamp: new Date().toISOString(),
    granthaCount: 0,
    sectionCount: 0,
    manthraCount: 0,
    acharyaCount: acharyas.length,
    granthas: [],
    sections: [],
    manthras: [],
    acharyas,
  };
  const backup = await storage.createBackup(
    label,
    compressBackupData(snapshot),
    0,
    0,
    0,
    buildBackupSummaryPayload(snapshot),
    acharyas.length,
  );
  console.log(`Saved snapshot #${backup.id}: ${label}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
