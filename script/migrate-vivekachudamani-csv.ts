/**
 * Vivekachudamani CSV-based migration.
 *
 * Reads the CSV mapping file which defines EXACTLY how each existing CMS entry
 * (1.1.1 – 1.1.548) maps to the final Advaitasharada-numbered output entries
 * (1.1.1 – 1.1.581).  For entries with multiple output refs the Sanskrit/IAST/
 * English text is split at verse-end markers (॥N॥ / ||N||).
 *
 * Usage:
 *   npx tsx script/migrate-vivekachudamani-csv.ts
 *
 * Dry-run (no writes to Strapi):
 *   DRY_RUN=1 npx tsx script/migrate-vivekachudamani-csv.ts
 */

import { execFile } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ── config ────────────────────────────────────────────────────────────────────

const STRAPI_URL    = process.env.STRAPI_URL        || "http://13.53.121.15:1337";
const STRAPI_TOKEN  = process.env.STRAPI_API_TOKEN   || "";
const SECTION_DOC   = "g7wjis56amxgmrnk1w4i9ucr";   // Prathama Khanda doc ID
const GRANTHA_DOC   = "d65kii2nmwdmo9ob61cka59y";
const CONCURRENCY   = 6;
const DRY_RUN       = process.env.DRY_RUN === "1";
const LOG_FILE      = "/tmp/migration_csv_progress.log";
const CSV_PATH      = resolve("attached_assets/Vivekachudamani_Numbering_Issue_23042026_KSS1_1777022526995.csv");

if (!STRAPI_TOKEN) { console.error("STRAPI_API_TOKEN not set"); process.exit(1); }

// ── logging ───────────────────────────────────────────────────────────────────

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch { /* */ }
}

// ── curl helper ───────────────────────────────────────────────────────────────

function curlReq(path: string, method = "GET", body?: string): Promise<any> {
  return new Promise((resolve2, reject) => {
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
    args.push(`${STRAPI_URL}${path}`);
    execFile("curl", args, { timeout: 50000, maxBuffer: 30 * 1024 * 1024 }, (err, stdout) => {
      if (tmp) { try { unlinkSync(tmp); } catch { /* */ } }
      if (err && !stdout) return reject(new Error(`curl: ${err.message}`));
      const sep = stdout.lastIndexOf("|||HTTPSTATUS|||");
      const status = parseInt(stdout.slice(sep + 16), 10);
      const body2 = stdout.slice(0, sep).trim();
      if (status === 204 || (!body2 && status < 300)) { resolve2({}); return; }
      let json: any;
      try { json = JSON.parse(body2); } catch { return reject(new Error(`Non-JSON(${status}): ${body2.slice(0, 200)}`)); }
      if (status >= 400) return reject(Object.assign(new Error(`HTTP ${status}: ${JSON.stringify(json).slice(0, 200)}`), { status }));
      resolve2(json);
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

// ── CSV parser ────────────────────────────────────────────────────────────────

interface CsvGroup {
  cmsRef: string;           // e.g. "1.1.1"
  advaitaRef: string;       // e.g. "1, 2"  (informational only)
  outputRefs: string[];     // e.g. ["1.1.1", "1.1.2"]
}

function parseCsv(csvText: string): CsvGroup[] {
  const lines = csvText.split(/\r?\n/);
  const groups: CsvGroup[] = [];
  let current: CsvGroup | null = null;

  for (const raw of lines) {
    // Very simple CSV parse: split on comma but respect quoted fields
    const cols = splitCsvLine(raw);
    const cmsRef      = cols[0]?.trim() || "";
    const advaitaRef  = cols[1]?.trim() || "";
    const updateSeq   = cols[3]?.trim() || "";
    const insertSeq   = cols[4]?.trim() || "";

    // Skip header rows
    if (cmsRef === "EXISTING" || cmsRef === "CMS Reference") continue;

    if (cmsRef) {
      // New CMS entry
      current = { cmsRef, advaitaRef, outputRefs: [] };
      if (updateSeq) current.outputRefs.push(updateSeq);
      if (insertSeq) current.outputRefs.push(insertSeq);
      groups.push(current);
    } else if (insertSeq && current) {
      // Additional verse for the same CMS entry
      current.outputRefs.push(insertSeq);
    }
  }

  return groups;
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuote = !inQuote;
    } else if (c === "," && !inQuote) {
      result.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

// ── Strapi fetch helpers ──────────────────────────────────────────────────────

async function fetchAllManthras(): Promise<any[]> {
  const all: any[] = [];
  let page = 1;
  const pageSize = 100;
  // Filter by the grantha relation → only Vivekachudamani manthras
  const baseQ = [
    `filters[Section][grantha][documentId][$eq]=${GRANTHA_DOC}`,
    `pagination[pageSize]=${pageSize}`,
    "sort=order:asc",
    "populate[ShlokaManthraEntry]=true",
    "populate[BhashyamEntry]=true",
    "populate[Teekas]=true",
    "populate[Section][fields][0]=documentId",
  ].join("&");

  while (true) {
    const res = await curlReq(`/api/manthras?${baseQ}&pagination[page]=${page}`);
    const data: any[] = res.data || [];
    all.push(...data);
    const pageCount = res.meta?.pagination?.pageCount ?? 1;
    if (page >= pageCount) break;
    page++;
  }
  return all;
}

// ── verse-level text splitter ─────────────────────────────────────────────────

type Block = {
  type: string;
  children: { type: string; text: string; [k: string]: any }[];
  [k: string]: any;
};

const VERSE_END_RE = /॥\s*[\d\u0966-\u096F]+\s*॥|\|\|\s*[\d\u0966-\u096F]+\s*\|\|/;

function devaToNum(s: string): number {
  return parseInt(s.replace(/[\u0966-\u096F]/g, (c) => String(c.charCodeAt(0) - 0x0966)), 10);
}

/** Extract the verse-end number from the last line of a verse block. */
function verseNumOf(blocks: Block[]): number | null {
  if (!blocks.length) return null;
  const last = blocks[blocks.length - 1];
  const txt = (last.children || []).map((c) => c.text || "").join("");
  const d = txt.match(/॥\s*([\d\u0966-\u096F]+)\s*॥/);
  if (d) return devaToNum(d[1]);
  const a = txt.match(/\|\|\s*(\d+)\s*\|\|/);
  if (a) return parseInt(a[1], 10);
  return null;
}

/**
 * Split a Strapi blocks array into individual verse arrays.
 * Returns a Map<verseNumber, Block[]>.
 * If no markers found, returns a single entry with key=null.
 */
function splitByVerseMarkers(blocks: any): Map<number | null, Block[]> {
  const result = new Map<number | null, Block[]>();
  if (!Array.isArray(blocks) || !blocks.length) return result;

  const verses: Block[][] = [];
  let current: Block[] = [];

  for (const block of blocks as Block[]) {
    const lineText = (block.children || []).map((c) => c.text || "").join("");
    if (lineText.trim() === "" && current.length === 0) continue; // skip leading blanks
    current.push(block);
    if (VERSE_END_RE.test(lineText)) {
      verses.push(current);
      current = [];
    }
  }
  if (current.length > 0) verses.push(current);

  if (verses.length === 0) return result;

  // Map by verse number, sorted ascending
  const sorted = [...verses].sort((a, b) => {
    const na = verseNumOf(a) ?? 0;
    const nb = verseNumOf(b) ?? 0;
    return na - nb;
  });

  for (const v of sorted) {
    const n = verseNumOf(v);
    result.set(n ?? null, v);
  }
  return result;
}

/**
 * Given a source entry and N expected outputs, produce N content objects
 * by splitting the Sanskrit/IAST/English text at verse markers.
 *
 * Rules:
 *  - If the source has exactly N verse markers → assign one verse block to each output.
 *  - If count doesn't match or markers are absent → put all content in output[0], leave rest blank.
 *  - BhashyamEntry and Teekas only go to output[0]; extra outputs get blank.
 */
function splitContent(source: any, outputCount: number): any[] {
  const entry = source.ShlokaManthraEntry || {};
  const bhashyam = source.BhashyamEntry;
  const teekas: any[] = source.Teekas || [];

  if (outputCount === 1) {
    return [source];
  }

  // Split each field
  const sktMap = splitByVerseMarkers(entry.SanskritTextEntry);
  const iastMap = splitByVerseMarkers(entry.IASTTransliteration);
  const engMap = splitByVerseMarkers(entry.EnglishTranslationText);

  // Gather all verse numbers found across all fields
  const allNums = new Set<number | null>();
  for (const k of [...sktMap.keys(), ...iastMap.keys(), ...engMap.keys()]) allNums.add(k);
  const sortedNums = [...allNums].sort((a, b) => (a ?? 0) - (b ?? 0));

  const hasEnoughVerses = sortedNums.length >= outputCount;

  if (!hasEnoughVerses) {
    // Can't split cleanly — put everything in output[0], blank for rest
    const outputs: any[] = [source];
    for (let i = 1; i < outputCount; i++) {
      outputs.push({
        ShlokaManthraEntry: {},
        BhashyamEntry: null,
        Teekas: teekas.map((t) => ({ TeekaName: t.TeekaName, TeekaAuthor: t.TeekaAuthor })),
      });
    }
    return outputs;
  }

  // We have enough verse blocks — assign them
  const outputs: any[] = [];
  for (let i = 0; i < outputCount; i++) {
    const vNum = sortedNums[i];
    const sktBlocks = sktMap.get(vNum) ?? sktMap.get(null);
    const iastBlocks = iastMap.get(vNum) ?? iastMap.get(null);
    const engBlocks = engMap.get(vNum) ?? engMap.get(null);

    outputs.push({
      ShlokaManthraEntry: {
        ...entry,
        SanskritTextEntry: sktBlocks || (i === 0 ? entry.SanskritTextEntry : undefined),
        IASTTransliteration: iastBlocks || (i === 0 ? entry.IASTTransliteration : undefined),
        EnglishTranslationText: engBlocks || (i === 0 ? entry.EnglishTranslationText : undefined),
        ShlokaManthraNumber: undefined, // will be set from outputRef below
      },
      // BhashyamEntry and Teekas only on the first output
      BhashyamEntry: i === 0 ? bhashyam : null,
      Teekas: i === 0
        ? teekas
        : teekas.map((t) => ({ TeekaName: t.TeekaName, TeekaAuthor: t.TeekaAuthor })),
    });
  }
  return outputs;
}

// ── build Strapi payload ──────────────────────────────────────────────────────

const STRAPI_INTERNAL = new Set(["id", "_id", "__component", "createdAt", "updatedAt", "publishedAt", "documentId", "locale"]);

function stripInternalKeys(obj: any): any {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripInternalKeys);
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!STRAPI_INTERNAL.has(k)) out[k] = stripInternalKeys(v);
  }
  return out;
}

function buildPayload(
  outputRef: string,   // e.g. "1.1.5"
  order: number,
  content: any,
  sectionDocId: string,
) {
  const entry = content.ShlokaManthraEntry || {};

  // ShlokaManthraNumber is a TOP-LEVEL field — never put it inside ShlokaManthraEntry
  const shloka = stripInternalKeys({ ...entry });
  // Remove ShlokaManthraNumber from the component (it lives on the top-level manthra)
  delete shloka.ShlokaManthraNumber;
  // Strip null/undefined fields from shloka
  for (const k of Object.keys(shloka)) {
    if (shloka[k] === null || shloka[k] === undefined) delete shloka[k];
  }

  const payload: any = {
    ShlokaManthraNumber: outputRef,
    order,
    Section: sectionDocId,
  };

  if (Object.keys(shloka).length > 0) {
    payload.ShlokaManthraEntry = shloka;
  }

  if (content.BhashyamEntry) {
    payload.BhashyamEntry = stripInternalKeys(content.BhashyamEntry);
  }

  if (content.Teekas?.length) {
    payload.Teekas = content.Teekas.map((t: any) => {
      const teekaDocId = t.teeka?.documentId ?? t.teeka ?? null;
      const clean: any = {};
      if (teekaDocId) clean.teeka = teekaDocId;
      if (t.TeekaEntry) clean.TeekaEntry = stripInternalKeys(t.TeekaEntry);
      return clean;
    }).filter((t: any) => Object.keys(t).length > 0);
  }

  return payload;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Clear log
  try { writeFileSync(LOG_FILE, ""); } catch { /* */ }

  log(`=== Vivekachudamani CSV migration${DRY_RUN ? " [DRY RUN]" : ""} ===`);

  // 1. Parse CSV
  log("Parsing CSV...");
  const csvText = readFileSync(CSV_PATH, "utf8");
  const groups = parseCsv(csvText);
  log(`CSV groups parsed: ${groups.length} CMS entries → ${groups.reduce((s, g) => s + g.outputRefs.length, 0)} output entries`);

  // Verify expected counts
  const multiVerseGroups = groups.filter((g) => g.outputRefs.length > 1);
  log(`Multi-verse entries: ${multiVerseGroups.length}`);
  if (groups.length !== 548) {
    log(`WARNING: expected 548 CMS entries, got ${groups.length}. Continuing anyway.`);
  }

  // 2. Fetch all current manthras from Strapi
  log("Fetching all Vivekachudamani manthras from Strapi (with content)...");
  const liveManthras = await fetchAllManthras();
  log(`Fetched ${liveManthras.length} live manthras`);

  if (liveManthras.length !== groups.length) {
    log(`WARNING: Strapi has ${liveManthras.length} manthras but CSV has ${groups.length} groups.`);
    log("Proceeding by matching by sequential position (Strapi order vs CSV row order).");
  }

  // 3. Build the full set of output entries
  log("Building output entries from CSV mapping + content splitting...");
  const outputEntries: { title: string; outputRef: string; order: number; content: any }[] = [];
  let cannotSplitCount = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const strapi = liveManthras[gi];

    if (!strapi) {
      log(`WARNING: No Strapi entry for CSV row ${gi + 1} (${group.cmsRef}), skipping`);
      continue;
    }

    const outputCount = group.outputRefs.length;
    let contentParts: any[];

    if (outputCount === 1) {
      contentParts = [strapi];
    } else {
      contentParts = splitContent(strapi, outputCount);
      // Check if splitting was successful
      const allBlank = contentParts.slice(1).every((c) => !c.ShlokaManthraEntry?.SanskritTextEntry?.length);
      if (allBlank) {
        cannotSplitCount++;
        log(`  WARN: CMS ${group.cmsRef} → could not auto-split into ${outputCount} parts (${group.advaitaRef}). All content in first output.`);
      }
    }

    for (let oi = 0; oi < group.outputRefs.length; oi++) {
      const ref = group.outputRefs[oi];
      const title = `Shloka ${ref}`;
      const order = outputEntries.length + 1;
      outputEntries.push({ title, outputRef: ref, order, content: contentParts[oi] || contentParts[0] });
    }
  }

  log(`Output entries built: ${outputEntries.length}`);
  log(`Entries where auto-split could not be done: ${cannotSplitCount}`);

  if (DRY_RUN) {
    log("DRY RUN: first 10 output entries:");
    for (const e of outputEntries.slice(0, 10)) {
      log(`  [${e.order}] ${e.title}`);
    }
    log("DRY RUN complete — no changes made to Strapi.");
    return;
  }

  // 4. Delete all current Strapi manthras
  log(`Deleting ${liveManthras.length} current Strapi manthras...`);
  let deleted = 0;
  await pmap(liveManthras, async (m) => {
    await curlReq(`/api/manthras/${m.documentId}`, "DELETE");
    deleted++;
    if (deleted % 50 === 0) log(`  Deleted ${deleted}/${liveManthras.length}`);
  });
  log(`Deleted ${deleted} manthras`);

  // 5. Create all output entries
  log(`Creating ${outputEntries.length} new manthras...`);
  let created = 0;
  let errors = 0;

  await pmap(outputEntries, async ({ title, outputRef, order, content }) => {
    try {
      const payload = buildPayload(outputRef, order, content, SECTION_DOC);
      await curlReq("/api/manthras", "POST", JSON.stringify({ data: payload }));
      created++;
      if (created % 50 === 0) log(`  Created ${created}/${outputEntries.length}`);
    } catch (e: any) {
      errors++;
      log(`  ERROR creating ${title}: ${e.message}`);
    }
  });

  log(`\n=== DONE: deleted ${deleted}, created ${created}, errors ${errors} ===`);
  if (cannotSplitCount > 0) {
    log(`NOTE: ${cannotSplitCount} multi-verse entries could not be auto-split. Their full text is in the first output entry; remaining entries are blank. These need manual editing.`);
  }
}

main().catch((e) => { log(`FATAL: ${e.message}`); process.exit(1); });
