/**
 * One-time migration: split combined Vivekachudamani manthras into individual per-verse entries.
 * Run with: npx tsx script/run-vivekachudamani-migration.ts
 *
 * Strategy:
 *  Phase 1 – fetch manthra stubs (IDs, sections, no rich-text) — fast, small payload
 *  Phase 2 – fetch full content in parallel batches of 10, up to CONCURRENCY at a time
 *  Phase 3 – delete originals in parallel, then create new entries in parallel
 *
 * Progress is appended to PROGRESS_FILE so you can tail -f it.
 */

import { execFile } from "node:child_process";
import { writeFileSync, appendFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STRAPI_URL = process.env.STRAPI_URL || "http://13.53.121.15:1337";
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN || "";
const PROGRESS_FILE = "/tmp/mig_progress.log";
const CONCURRENCY = 8; // parallel requests

if (!STRAPI_TOKEN) { console.error("ERROR: STRAPI_API_TOKEN not set"); process.exit(1); }

// ── helpers ──────────────────────────────────────────────────────────────────

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(PROGRESS_FILE, line + "\n");
}

function curlRequest(path: string, method = "GET", body?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = `${STRAPI_URL}${path}`;
    const args = [
      "-g", "-s", "-k", "--max-time", "45",
      "-w", "|||HTTPSTATUS|||%{http_code}",
      "-X", method,
      "-H", `Authorization: Bearer ${STRAPI_TOKEN}`,
      "-H", "Content-Type: application/json",
    ];
    let tmp: string | undefined;
    if (body) {
      tmp = join(tmpdir(), `mig_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(tmp, body, "utf8");
      args.push("--data", `@${tmp}`);
    }
    args.push(url);
    execFile("curl", args, { timeout: 50000, maxBuffer: 30 * 1024 * 1024 }, (err, stdout) => {
      if (tmp) { try { unlinkSync(tmp); } catch { /* */ } }
      if (err && !stdout) return reject(new Error(`curl: ${err.message}`));
      const sep = stdout.lastIndexOf("|||HTTPSTATUS|||");
      const status = parseInt(stdout.slice(sep + 16), 10);
      const bodyStr = stdout.slice(0, sep).trim();
      // 204 No Content is success with empty body (common for DELETE)
      if (status === 204 || (status >= 200 && status < 300 && !bodyStr)) { resolve({}); return; }
      let json: any;
      try { json = JSON.parse(bodyStr); } catch { return reject(new Error(`Non-JSON(${status}): ${bodyStr.slice(0, 120)}`)); }
      if (status >= 400) return reject(Object.assign(new Error(`HTTP ${status}: ${JSON.stringify(json).slice(0, 120)}`), { status }));
      resolve(json);
    });
  });
}

// Run up to `limit` promises at a time, calling fn(item, index)
async function pmap<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>, limit = CONCURRENCY): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── verse parsing ────────────────────────────────────────────────────────────

const devaToArabic = (s: string) =>
  parseInt(s.replace(/[\u0966-\u096F]/g, (c) => String(c.charCodeAt(0) - 0x0966)), 10);

type Block = Record<string, any>;

function extractVerses(blocks: Block[] | null | undefined): Map<number, Block[]> {
  const m = new Map<number, Block[]>();
  if (!Array.isArray(blocks) || !blocks.length) return m;
  let cur: Block[] = [];
  for (const block of blocks) {
    const txt = (block.children || []).map((c: any) => c.text || "").join("");
    if (!txt.trim() && !cur.length) continue;
    cur.push(block);
    const deva = txt.match(/॥\s*([\d\u0966-\u096F]+)\s*॥/);
    if (deva) { m.set(devaToArabic(deva[1]), cur); cur = []; continue; }
    const ascii = txt.match(/\|\|\s*(\d+)\s*\|\|/);
    if (ascii) { m.set(parseInt(ascii[1], 10), cur); cur = []; }
  }
  return m;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (existsSync(PROGRESS_FILE)) unlinkSync(PROGRESS_FILE);
  log("=== Vivekachudamani verse-split migration START ===");

  // 1. Find grantha
  const gResp = await curlRequest(
    "/api/granthas?filters[GranthaName][$containsi]=vivekachudamani" +
    "&fields[0]=documentId&fields[1]=GranthaName&pagination[pageSize]=5"
  );
  const g = gResp.data?.[0];
  if (!g) { log("ERROR: grantha not found"); process.exit(1); }
  const granthaDocId: string = g.documentId;
  log(`Grantha: ${g.GranthaName} (${granthaDocId})`);

  // 2. Fetch all stubs (no content)
  const STUB_Q = [
    `filters[Section][grantha][documentId][$eq]=${granthaDocId}`,
    "populate[Section][fields][0]=documentId",
    "populate[Section][fields][1]=title",
    "populate[Section][fields][2]=order",
    "populate[Section][populate][parent][fields][0]=order",
    "fields[0]=documentId",
    "fields[1]=ShlokaManthraNumber",
    "fields[2]=order",
    "pagination[pageSize]=100",
  ].join("&");

  let stubs: any[] = [];
  let page = 1;
  while (true) {
    const r = await curlRequest(`/api/manthras?${STUB_Q}&pagination[page]=${page}`);
    stubs.push(...(r.data || []));
    log(`Stubs page ${page}/${r.meta?.pagination?.pageCount ?? 1}: ${r.data?.length ?? 0} items`);
    if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  log(`Total stubs: ${stubs.length}`);

  // 3. Group by section
  const bySec = new Map<string, { section: any; stubs: any[] }>();
  for (const m of stubs) {
    const sec = m.Section;
    if (!sec?.documentId) continue;
    if (!bySec.has(sec.documentId)) bySec.set(sec.documentId, { section: sec, stubs: [] });
    bySec.get(sec.documentId)!.stubs.push(m);
  }
  log(`Sections: ${bySec.size}`);

  // 4. Process each section
  let totalDeleted = 0, totalCreated = 0;

  for (const [secDocId, { section, stubs: ss }] of bySec) {
    ss.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    log(`\n=== Section "${section.title}" (${secDocId}): ${ss.length} stubs ===`);

    // Phase 2: fetch full content in parallel batches
    const BATCH = 10;
    const allFull: any[] = [];
    const batches: any[][] = [];
    for (let i = 0; i < ss.length; i += BATCH) batches.push(ss.slice(i, i + BATCH));

    let batchDone = 0;
    await pmap(batches, async (batch) => {
      const ids = batch.map((s: any) => s.documentId);
      const filterParts = ids.map((id: string, i: number) => `filters[$or][${i}][documentId][$eq]=${id}`).join("&");
      const q = [
        filterParts,
        "populate[ShlokaManthraEntry][populate]=*",
        "fields[0]=documentId",
        "fields[1]=ShlokaManthraNumber",
        "fields[2]=order",
        `pagination[pageSize]=${ids.length}`,
      ].join("&");
      const r = await curlRequest(`/api/manthras?${q}`);
      const items = r.data || [];
      const orderMap = new Map(ss.map((s: any) => [s.documentId, s.order]));
      for (const m of items) m.order = orderMap.get(m.documentId) ?? m.order;
      allFull.push(...items);
      batchDone++;
      if (batchDone % 5 === 0 || batchDone === batches.length) {
        log(`  Fetched ${batchDone}/${batches.length} batches (${allFull.length} manthras)`);
      }
    }, CONCURRENCY);

    allFull.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    log(`Full content fetched: ${allFull.length} manthras`);

    // Build per-verse map
    const verseData = new Map<number, { skt?: Block[]; iast?: Block[]; eng?: Block[] }>();
    for (const m of allFull) {
      const e = m.ShlokaManthraEntry;
      if (!e) continue;
      for (const [n, bl] of extractVerses(e.SanskritTextEntry)) {
        if (!verseData.has(n)) verseData.set(n, {});
        verseData.get(n)!.skt = bl;
      }
      for (const [n, bl] of extractVerses(e.IASTTransliteration)) {
        if (!verseData.has(n)) verseData.set(n, {});
        verseData.get(n)!.iast = bl;
      }
      for (const [n, bl] of extractVerses(e.EnglishTranslationText)) {
        if (!verseData.has(n)) verseData.set(n, {});
        verseData.get(n)!.eng = bl;
      }
    }

    const sortedNums = [...verseData.keys()].sort((a, b) => a - b);
    if (!sortedNums.length) { log("SKIP: no verse markers"); continue; }
    log(`Verse numbers: ${sortedNums[0]}–${sortedNums[sortedNums.length - 1]} (${sortedNums.length} total)`);

    // Title prefix
    const ft: string = ss[0]?.ShlokaManthraNumber ?? "";
    const pm = ft.match(/^(.+?)\s+([\d.]+)\.\d+$/);
    const titlePfx = pm?.[1] ?? "Shloka";
    const secNums = pm?.[2] ?? `${(section.parent as any)?.order ?? 1}.${section.order ?? 1}`;
    log(`Title prefix: "${titlePfx} ${secNums}.<N>"`);

    // Phase 3a: delete originals in parallel
    log(`Deleting ${ss.length} original manthras...`);
    let delDone = 0;
    await pmap(ss, async (m: any) => {
      try {
        await curlRequest(`/api/manthras/${m.documentId}`, "DELETE");
        totalDeleted++;
      } catch (e: any) {
        log(`  WARN delete ${m.ShlokaManthraNumber}: ${e.message}`);
      }
      delDone++;
      if (delDone % 50 === 0 || delDone === ss.length) log(`  Deleted ${delDone}/${ss.length}`);
    }, CONCURRENCY);
    log(`Deleted: ${totalDeleted} total`);

    // Phase 3b: create individual verse entries in parallel
    log(`Creating ${sortedNums.length} verse entries...`);
    let createDone = 0;
    await pmap(sortedNums, async (verseNum, i) => {
      const vd = verseData.get(verseNum)!;
      const order = (i as number) + 1;
      const title = `${titlePfx} ${secNums}.${order}`;
      const payload = {
        data: {
          ShlokaManthraNumber: title,
          order,
          Section: secDocId,
          ShlokaManthraEntry: {
            SanskritTextEntry: vd.skt ?? null,
            IASTTransliteration: vd.iast ?? null,
            EnglishTranslationText: vd.eng ?? null,
          },
        },
      };
      try {
        const created = await curlRequest("/api/manthras", "POST", JSON.stringify(payload));
        const fields = [vd.skt ? "skt" : "", vd.iast ? "iast" : "", vd.eng ? "eng" : ""].filter(Boolean).join(",");
        log(`  Created "${title}" (verse ${verseNum}) [${fields}] → ${created.data?.documentId}`);
        totalCreated++;
      } catch (e: any) {
        log(`  ERROR "${title}": ${e.message}`);
      }
      createDone++;
      if (createDone % 50 === 0) log(`  Created ${createDone}/${sortedNums.length}`);
    }, CONCURRENCY);
    log(`Created: ${totalCreated} total`);
  }

  log(`\n=== DONE: ${totalDeleted} deleted, ${totalCreated} created ===`);
}

main().catch((e) => { log(`Fatal: ${e.message}`); process.exit(1); });
