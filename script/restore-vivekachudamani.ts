/**
 * Restore Vivekachudamani manthras from a local portal backup snapshot.
 *
 * Usage: BACKUP_ID=208 npx tsx script/restore-vivekachudamani.ts
 *
 * What it does:
 *  1. Load the compressed backup from the portal's PostgreSQL database.
 *  2. Extract all manthras that belong to the Vivekachudamani grantha.
 *  3. Delete every current Vivekachudamani manthra from Strapi.
 *  4. Re-create each manthra from the backup (preserving full ShlokaManthraEntry,
 *     BhashyamEntry, Teekas, wordMeanings and order / ShlokaManthraNumber).
 *
 * Parallelism: up to CONCURRENCY requests run at the same time to keep it fast.
 */

import { execFile } from "node:child_process";
import { writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import pg from "pg";

const STRAPI_URL  = process.env.STRAPI_URL       || "http://13.53.121.15:1337";
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN || "";
const DB_URL       = process.env.DATABASE_URL     || "";
const BACKUP_ID    = parseInt(process.env.BACKUP_ID ?? "208", 10);
const CONCURRENCY  = 8;
const PROGRESS_FILE = "/tmp/restore_progress.log";

if (!STRAPI_TOKEN) { console.error("STRAPI_API_TOKEN not set"); process.exit(1); }
if (!DB_URL)       { console.error("DATABASE_URL not set");     process.exit(1); }

// ── logging ──────────────────────────────────────────────────────────────────

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(PROGRESS_FILE, line + "\n"); } catch { /* */ }
}

// ── curl helper ──────────────────────────────────────────────────────────────

function curlReq(path: string, method = "GET", body?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const args = [
      "-g", "-s", "-k", "--max-time", "45",
      "-w", "|||HTTPSTATUS|||%{http_code}",
      "-X", method,
      "-H", `Authorization: Bearer ${STRAPI_TOKEN}`,
      "-H", "Content-Type: application/json",
    ];
    let tmp: string | undefined;
    if (body) {
      tmp = join(tmpdir(), `rst_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(tmp, body, "utf8");
      args.push("--data", `@${tmp}`);
    }
    args.push(`${STRAPI_URL}${path}`);
    execFile("curl", args, { timeout: 50000, maxBuffer: 30 * 1024 * 1024 }, (err, stdout) => {
      if (tmp) { try { unlinkSync(tmp); } catch { /* */ } }
      if (err && !stdout) return reject(new Error(`curl: ${err.message}`));
      const sep = stdout.lastIndexOf("|||HTTPSTATUS|||");
      const status = parseInt(stdout.slice(sep + 16), 10);
      const body2 = stdout.slice(0, sep).trim();
      if (status === 204 || (!body2 && status < 300)) { resolve({}); return; }
      let json: any;
      try { json = JSON.parse(body2); } catch { return reject(new Error(`Non-JSON(${status}): ${body2.slice(0, 120)}`)); }
      if (status >= 400) return reject(Object.assign(new Error(`HTTP ${status}: ${JSON.stringify(json).slice(0, 120)}`), { status }));
      resolve(json);
    });
  });
}

// ── concurrency helper ────────────────────────────────────────────────────────

async function pmap<T, R>(items: T[], fn: (item: T, i: number) => Promise<R>, limit = CONCURRENCY): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) { const i = idx++; results[i] = await fn(items[i], i); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── decompress backup ─────────────────────────────────────────────────────────

function decompressBackup(raw: any): any {
  // pg returns JSONB as a parsed JS object already
  if (raw && raw._compressed === true && typeof raw.data === "string") {
    const buf = Buffer.from(raw.data, "base64");
    return JSON.parse(gunzipSync(buf).toString("utf8"));
  }
  return raw; // legacy uncompressed backups
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  try { unlinkSync(PROGRESS_FILE); } catch { /* */ }
  log(`=== Restore Vivekachudamani from backup #${BACKUP_ID} ===`);

  // 1. Load backup from portal DB
  log("Loading backup from portal database...");
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  const result = await client.query("SELECT id, label, data FROM grantha_backups WHERE id = $1", [BACKUP_ID]);
  await client.end();
  if (!result.rows.length) { log(`ERROR: backup #${BACKUP_ID} not found`); process.exit(1); }
  const row = result.rows[0];
  log(`Backup found: "${row.label}"`);

  const bData = decompressBackup(row.data);
  const allSections: any[] = bData.sections ?? [];
  const allManthras: any[] = bData.manthras ?? [];
  log(`Backup contains: ${allSections.length} sections, ${allManthras.length} manthras`);

  // 2. Find Vivekachudamani grantha doc id from Strapi
  const gResp = await curlReq(
    "/api/granthas?filters[GranthaName][$containsi]=vivekachudamani" +
    "&fields[0]=documentId&fields[1]=GranthaName&pagination[pageSize]=5"
  );
  const g = gResp.data?.[0];
  if (!g) { log("ERROR: Vivekachudamani grantha not found in Strapi"); process.exit(1); }
  const granthaDocId: string = g.documentId;
  log(`Grantha: ${g.GranthaName} (${granthaDocId})`);

  // 3. Extract Vivekachudamani sections and manthras from backup
  const vSections = new Set(
    allSections
      .filter((s: any) => (s.grantha?.documentId ?? s.grantha) === granthaDocId)
      .map((s: any) => s.documentId as string)
  );
  log(`Vivekachudamani sections in backup: ${vSections.size}`);

  const backupManthras = allManthras.filter((m: any) => {
    const secDocId = m.Section?.documentId ?? m.section?.documentId ?? m.Section ?? m.section ?? "";
    return vSections.has(secDocId);
  });
  log(`Vivekachudamani manthras in backup: ${backupManthras.length}`);

  if (!backupManthras.length) { log("ERROR: no manthras found for this grantha in backup"); process.exit(1); }

  // 4. Fetch current live manthras for Vivekachudamani from Strapi (stubs only)
  log("Fetching current live manthras from Strapi...");
  const STUB_Q = [
    `filters[Section][grantha][documentId][$eq]=${granthaDocId}`,
    "fields[0]=documentId",
    "fields[1]=ShlokaManthraNumber",
    "pagination[pageSize]=100",
  ].join("&");
  let liveStubs: any[] = [];
  let page = 1;
  while (true) {
    const r = await curlReq(`/api/manthras?${STUB_Q}&pagination[page]=${page}`);
    liveStubs.push(...(r.data ?? []));
    if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  log(`Live manthras to delete: ${liveStubs.length}`);

  // 5. Delete all current live manthras in parallel
  log("Deleting current manthras...");
  let delCount = 0;
  await pmap(liveStubs, async (m: any) => {
    try {
      await curlReq(`/api/manthras/${m.documentId}`, "DELETE");
      delCount++;
    } catch (e: any) {
      log(`  WARN delete ${m.documentId}: ${e.message}`);
    }
    if (delCount % 50 === 0) log(`  Deleted ${delCount}/${liveStubs.length}`);
  });
  log(`Deleted ${delCount} manthras`);

  // 6. Re-create manthras from backup in parallel
  log(`Re-creating ${backupManthras.length} manthras from backup...`);
  let createCount = 0, errCount = 0;
  await pmap(backupManthras, async (m: any) => {
    // Build the payload from backup fields
    const secDocId = m.Section?.documentId ?? m.section?.documentId ?? m.Section ?? m.section ?? "";

    const payload: Record<string, any> = {
      ShlokaManthraNumber: m.ShlokaManthraNumber,
      order: m.order,
      Section: secDocId,
    };

    if (m.ShlokaManthraEntry) payload.ShlokaManthraEntry = m.ShlokaManthraEntry;
    if (m.BhashyamEntry)      payload.BhashyamEntry      = m.BhashyamEntry;
    if (m.wordMeanings?.length) payload.wordMeanings      = m.wordMeanings;

    // Teekas: include teeka ref + TeekaEntry content
    if (Array.isArray(m.Teekas) && m.Teekas.length > 0) {
      payload.Teekas = m.Teekas.map((t: any) => ({
        teeka: t.teeka?.documentId ?? t.teeka,
        TeekaEntry: t.TeekaEntry,
      }));
    }

    try {
      await curlReq("/api/manthras", "POST", JSON.stringify({ data: payload }));
      createCount++;
      if (createCount % 50 === 0) log(`  Created ${createCount}/${backupManthras.length}`);
    } catch (e: any) {
      errCount++;
      log(`  ERROR creating ${m.ShlokaManthraNumber}: ${e.message}`);
    }
  });

  log(`\n=== DONE: deleted ${delCount}, created ${createCount}, errors ${errCount} ===`);
}

main().catch((e) => { log(`Fatal: ${e.message}`); process.exit(1); });
