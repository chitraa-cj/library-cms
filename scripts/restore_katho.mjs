/**
 * Restore Katho Upanishad manthras (teekas + bhashyam) from backup #210.
 * Does a DEEP check: hasTeekas only counts if TeekaEntry actually has content.
 */
import pg from "pg";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";

const STRAPI_URL = process.env.STRAPI_URL || "http://13.53.121.15:1337";
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN;
const KATHO_DOC_ID = "t2d3crlf4ptuadp73lziogy5";
const BACKUP_ID = 210;

if (!STRAPI_TOKEN) { console.error("No STRAPI_API_TOKEN"); process.exit(1); }

function curlJSON(url, method, body) {
  const args = ["-sg", "--globoff", "--max-time", "60",
    "-H", "Content-Type: application/json",
    "-H", `Authorization: Bearer ${STRAPI_TOKEN}`];
  if (method) args.push("-X", method);
  if (body)   args.push("-d", body);
  args.push(url);
  const out = execFileSync("curl", args, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  return JSON.parse(out);
}

const strapiGet  = (path)       => curlJSON(STRAPI_URL + path);
const strapiPut  = (path, data) => curlJSON(STRAPI_URL + path, "PUT",  JSON.stringify({ data }));

function decompressBackup(raw) {
  if (raw?._compressed === true && typeof raw.data === "string") {
    return JSON.parse(gunzipSync(Buffer.from(raw.data, "base64")).toString("utf8"));
  }
  return raw;
}

function cleanBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.filter(b => b && typeof b === "object");
}

function normalizeEntry(entry) {
  if (!entry) return null;
  return {
    SanskritTextEntry:      cleanBlocks(entry.SanskritTextEntry),
    EnglishTranslationText: cleanBlocks(entry.EnglishTranslationText),
    OtherTranslations: (entry.OtherTranslations ?? []).map(o => ({
      Language: o.Language,
      Translation: cleanBlocks(o.Translation),
    })),
  };
}

function hasRealContent(teekaEntry) {
  if (!teekaEntry) return false;
  return (teekaEntry.SanskritTextEntry?.length > 0) ||
         (teekaEntry.EnglishTranslationText?.length > 0) ||
         (teekaEntry.OtherTranslations?.length > 0);
}

// ── Connect to DB ────────────────────────────────────────────────────────────
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

console.log(`\n=== Katho Upanishad Restore from backup #${BACKUP_ID} ===\n`);

const { rows } = await client.query("SELECT data FROM grantha_backups WHERE id = $1", [BACKUP_ID]);
if (!rows.length) { console.error("Backup not found"); process.exit(1); }
const bData = decompressBackup(rows[0].data);
await client.end();

// ── Filter backup data for Katho ─────────────────────────────────────────────
const allSections = bData.sections ?? [];
const kathoSections = allSections.filter(s => s.grantha?.documentId === KATHO_DOC_ID);
const kathoSectionIds = new Set(kathoSections.map(s => s.documentId));
console.log(`Katho sections in backup: ${kathoSections.length}`);
kathoSections.forEach(s => console.log(`  [${s.type}] "${s.title}" docId=${s.documentId}`));

const allManthras = bData.manthras ?? [];
const kathoManthras = allManthras.filter(m => {
  const secDocId = m.Section?.documentId ?? m.section?.documentId ?? "";
  return kathoSectionIds.has(secDocId);
});
console.log(`\nKatho manthras in backup: ${kathoManthras.length}`);

// ── Resolve teeka name → docId for Katho grantha ─────────────────────────────
console.log("\nResolving teeka docIds for Katho...");
const teekaNameToDocId = new Map();
const teekaRes = strapiGet(
  `/api/teekas?filters[grantha][documentId][$eq]=${KATHO_DOC_ID}&pagination[pageSize]=50`
);
for (const t of teekaRes?.data ?? []) {
  teekaNameToDocId.set((t.TeekaName ?? "").toLowerCase().trim(), t.documentId);
  console.log(`  "${t.TeekaName}" → ${t.documentId}`);
}

// ── Fetch ALL live Katho manthras with DEEP populate ─────────────────────────
console.log("\nFetching live manthras from Strapi (with TeekaEntry content)...");
const liveManthraMap = new Map();

for (const sec of kathoSections) {
  let page = 1;
  while (true) {
    const r = strapiGet(
      `/api/manthras?filters[Section][documentId][$eq]=${sec.documentId}` +
      `&fields[0]=documentId&fields[1]=ShlokaManthraNumber&fields[2]=order` +
      `&populate[Teekas][populate][TeekaEntry][populate]=*` +
      `&populate[BhashyamEntry][populate]=*` +
      `&pagination[page]=${page}&pagination[pageSize]=50`
    );
    const items = r?.data ?? [];
    for (const item of items) {
      const teekas = item.Teekas ?? [];
      const hasRealTeekaContent = teekas.some(t => hasRealContent(t.TeekaEntry));
      const hasBhashyam = hasRealContent(item.BhashyamEntry);
      liveManthraMap.set(item.documentId, {
        label: item.ShlokaManthraNumber,
        hasRealTeekaContent,
        hasBhashyam,
        teekas,
      });
    }
    console.log(`  Section "${sec.title}" page ${page}: ${items.length} manthras`);
    if (items.length < 50) break;
    page++;
  }
}

console.log(`\nLive manthras in Strapi: ${liveManthraMap.size}`);
const liveWithContent  = [...liveManthraMap.values()].filter(m => m.hasRealTeekaContent).length;
const liveMissingContent = [...liveManthraMap.values()].filter(m => !m.hasRealTeekaContent).length;
console.log(`  With real teeka content: ${liveWithContent}`);
console.log(`  Missing teeka content:   ${liveMissingContent}`);

// ── Restore ──────────────────────────────────────────────────────────────────
console.log("\n--- Restoring missing content ---");
let restored = 0, skipped = 0, errors = 0, notFound = 0;
const errorList = [];

for (const bm of kathoManthras) {
  const docId = bm.documentId;
  const label = bm.ShlokaManthraNumber ?? docId;
  const live = liveManthraMap.get(docId);

  if (!live) {
    notFound++;
    continue;
  }

  // ── Restore teekas ──
  const backupHasTeekaContent = (bm.Teekas ?? []).some(t => hasRealContent(t.TeekaEntry));

  if (backupHasTeekaContent && !live.hasRealTeekaContent) {
    const resolved = [];
    for (const t of (bm.Teekas ?? [])) {
      if (!hasRealContent(t.TeekaEntry)) continue;
      const name = (t.TeekaName ?? "").toLowerCase().trim();
      const tDocId = teekaNameToDocId.get(name);
      if (!tDocId) {
        console.log(`  [WARN] No Strapi teeka for "${t.TeekaName}" on ${label}`);
        continue;
      }
      resolved.push({ documentId: tDocId, TeekaEntry: normalizeEntry(t.TeekaEntry) });
    }
    if (resolved.length > 0) {
      try {
        strapiPut(`/api/manthras/${docId}`, { Teekas: resolved });
        console.log(`  ✅ ${label}: restored ${resolved.length} teeka(s)`);
        restored++;
      } catch(e) {
        console.log(`  ❌ ${label}: ${e.message.slice(0,120)}`);
        errorList.push({ label, error: e.message });
        errors++;
      }
    }
  } else if (live.hasRealTeekaContent) {
    skipped++;
  }

  // ── Restore bhashyam ──
  const backupHasBhashyam = hasRealContent(bm.BhashyamEntry);
  if (backupHasBhashyam && !live.hasBhashyam) {
    try {
      strapiPut(`/api/manthras/${docId}`, { BhashyamEntry: normalizeEntry(bm.BhashyamEntry) });
      console.log(`  ✅ ${label}: restored BhashyamEntry`);
      restored++;
    } catch(e) {
      console.log(`  ❌ ${label}: bhashyam: ${e.message.slice(0,120)}`);
      errorList.push({ label, error: "bhashyam: " + e.message });
      errors++;
    }
  }
}

console.log(`\n=== Summary ===`);
console.log(`Backup manthras:         ${kathoManthras.length}`);
console.log(`Live in Strapi:          ${liveManthraMap.size}`);
console.log(`Not found in Strapi:     ${notFound}`);
console.log(`Restored:                ${restored}`);
console.log(`Already had content:     ${skipped}`);
console.log(`Errors:                  ${errors}`);
if (errorList.length) {
  console.log("\nError details:");
  errorList.forEach(e => console.log(`  - ${e.label}: ${e.error.slice(0,200)}`));
}
