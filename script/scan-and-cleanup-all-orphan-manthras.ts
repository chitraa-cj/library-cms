/**
 * Find and delete every Strapi manthra with blank ShlokaManthraNumber ("No number").
 *
 *   DRY_RUN=1 npx tsx script/scan-and-cleanup-all-orphan-manthras.ts
 *   DRY_RUN=0 npx tsx script/scan-and-cleanup-all-orphan-manthras.ts
 *
 * Loads STRAPI_URL / STRAPI_API_TOKEN from .env in project root when unset.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile() {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* no .env */
  }
}

loadEnvFile();

const STRAPI_URL = (process.env.STRAPI_URL || "http://13.53.121.15:1337").replace(/\/$/, "");
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN || "";
const dryRun = process.env.DRY_RUN !== "0";

async function strapiGet(path: string): Promise<any> {
  const res = await fetch(`${STRAPI_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${STRAPI_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

async function strapiDelete(path: string): Promise<void> {
  const res = await fetch(`${STRAPI_URL}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${STRAPI_TOKEN}` },
  });
  if (res.status === 204 || res.ok) return;
  if (res.status === 404) return;
  const text = await res.text();
  throw new Error(`DELETE ${path} → ${res.status}: ${text.slice(0, 200)}`);
}

function isOrphan(row: { ShlokaManthraNumber?: string | null }): boolean {
  return !(row.ShlokaManthraNumber ?? "").trim();
}

async function scanAllOrphans(): Promise<
  Map<string, { name: string; rows: Array<{ documentId: string; order: number; sectionTitle?: string }> }>
> {
  const byGrantha = new Map<
    string,
    { name: string; rows: Array<{ documentId: string; order: number; sectionTitle?: string }> }
  >();
  let page = 1;
  while (true) {
    const r = await strapiGet(
      `/api/manthras?fields[0]=documentId&fields[1]=order&fields[2]=ShlokaManthraNumber` +
        `&populate[Section][fields][0]=title` +
        `&populate[Section][populate][grantha][fields][0]=documentId&populate[Section][populate][grantha][fields][1]=GranthaName` +
        `&pagination[pageSize]=100&pagination[page]=${page}`,
    );
    for (const row of r.data ?? []) {
      if (!isOrphan(row)) continue;
      const gDoc: string | undefined = row.Section?.grantha?.documentId;
      const gName: string =
        row.Section?.grantha?.GranthaName?.trim() || gDoc || "Unknown grantha";
      const key = gDoc && gDoc.length >= 10 ? gDoc : gName;
      const bucket = byGrantha.get(key) ?? { name: gName, rows: [] };
      bucket.rows.push({
        documentId: row.documentId,
        order: typeof row.order === "number" ? row.order : 0,
        sectionTitle: row.Section?.title,
      });
      byGrantha.set(key, bucket);
    }
    if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  return byGrantha;
}

async function main() {
  if (!STRAPI_TOKEN) {
    console.error("STRAPI_API_TOKEN is required (set in .env)");
    process.exit(1);
  }

  console.log(`Scanning ${STRAPI_URL} for orphan mantras (DRY_RUN=${dryRun ? "1" : "0"})…\n`);

  const byGrantha = await scanAllOrphans();
  if (byGrantha.size === 0) {
    console.log("No orphan mantras found.");
    return;
  }

  let total = 0;
  for (const [, { name, rows }] of byGrantha) {
    total += rows.length;
    console.log(`${name}: ${rows.length} orphan(s)`);
    for (const o of rows.slice(0, 3)) {
      console.log(`  ${o.documentId} order=${o.order} section=${o.sectionTitle ?? "?"}`);
    }
    if (rows.length > 3) console.log(`  … +${rows.length - 3} more`);
  }
  console.log(`\nTotal orphan rows: ${total}`);

  if (dryRun) {
    console.log("\nDry run only. Run: DRY_RUN=0 npx tsx script/scan-and-cleanup-all-orphan-manthras.ts");
    return;
  }

  console.log("\nDeleting…\n");
  let deleted = 0;
  let failed = 0;
  for (const [, { name, rows }] of byGrantha) {
    for (const row of rows) {
      try {
        await strapiDelete(`/api/manthras/${row.documentId}`);
        deleted++;
      } catch (e) {
        failed++;
        console.error(`  FAIL ${row.documentId} (${name}):`, (e as Error).message);
      }
    }
    console.log(`  ${name}: removed ${rows.length} row(s)`);
  }

  console.log(`\nDeleted: ${deleted}, failed: ${failed}`);
  const after = await scanAllOrphans();
  const remaining = [...after.values()].reduce((s, g) => s + g.rows.length, 0);
  console.log(remaining === 0 ? "Verified: no orphans left." : `Warning: ${remaining} orphan(s) still remain.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
