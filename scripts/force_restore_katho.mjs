/**
 * FORCE restore Katho Upanishad from backup #210.
 * Overwrites Strapi with backup content for every mantra that has data.
 * Correctly reads teeka name from t.teeka.TeekaName (nested structure).
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
  try { return JSON.parse(out); }
  catch(e) { console.error("Bad JSON from:", url.slice(0,100), out.slice(0,200)); throw e; }
}

const strapiGet  = (p)       => curlJSON(STRAPI_URL + p);
const strapiPut  = (p, data) => curlJSON(STRAPI_URL + p, "PUT",  JSON.stringify({ data }));

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
  const result = {
    SanskritTextEntry:      cleanBlocks(entry.SanskritTextEntry),
    EnglishTranslationText: cleanBlocks(entry.EnglishTranslationText),
    OtherTranslations: (entry.OtherTranslations ?? []).map(o => ({
      Language: o.Language,
      Translation: cleanBlocks(o.Translation),
    })).filter(o => o.Language || cleanBlocks(o.Translation).length > 0),
  };
  return result;
}

function hasContent(entry) {
  if (!entry) return false;
  return (entry.SanskritTextEntry?.length > 0) ||
         (entry.EnglishTranslationText?.length > 0) ||
         (entry.OtherTranslations?.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

console.log(`\n=== Force-Restore Katho Upanishad from backup #${BACKUP_ID} ===\n`);

const { rows } = await client.query("SELECT data FROM grantha_backups WHERE id = $1", [BACKUP_ID]);
if (!rows.length) { console.error("Backup not found"); process.exit(1); }
const bData = decompressBackup(rows[0].data);
await client.end();

// ── Backup sections & manthras ────────────────────────────────────────────────
const kathoSections = (bData.sections ?? []).filter(s => s.grantha?.documentId === KATHO_DOC_ID);
const kathoSecIds   = new Set(kathoSections.map(s => s.documentId));
const kathoManthras = (bData.manthras ?? []).filter(m => kathoSecIds.has(m.Section?.documentId ?? ""));

console.log(`Katho sections in backup: ${kathoSections.length}`);
kathoSections.forEach(s => console.log(`  [${s.type}] "${s.title}" → ${s.documentId}`));
console.log(`Katho manthras in backup: ${kathoManthras.length}`);

// ── Resolve Strapi teeka docIds ───────────────────────────────────────────────
console.log("\nResolving Strapi teeka documentIds for Katho…");
const teekaNameToDocId = new Map();      // lowercase name → Strapi docId
const teekaDocIdToDocId = new Map();     // backup docId → Strapi docId (usually same)

const tRes = strapiGet(
  `/api/teekas?filters[grantha][documentId][$eq]=${KATHO_DOC_ID}&pagination[pageSize]=50`
);
for (const t of tRes?.data ?? []) {
  const name = (t.TeekaName ?? "").toLowerCase().trim();
  teekaNameToDocId.set(name, t.documentId);
  teekaDocIdToDocId.set(t.documentId, t.documentId);
  console.log(`  "${t.TeekaName}" → ${t.documentId}`);
}

// ── Process each mantra ───────────────────────────────────────────────────────
console.log("\n--- Restoring manthras ---");
let restored = 0, skipped = 0, errors = 0;
const errorList = [];

for (const bm of kathoManthras) {
  const docId = bm.documentId;
  const label = bm.ShlokaManthraNumber ?? docId;

  const hasBhashyam  = hasContent(bm.BhashyamEntry);
  const backupTeekas = (bm.Teekas ?? []);

  // Build resolved teekas: use t.teeka?.documentId first, then name lookup
  const resolvedTeekas = [];
  for (const t of backupTeekas) {
    // CORRECT name lookup: backup stores as { teeka: { TeekaName, documentId }, TeekaEntry }
    const TeekaName = t.teeka?.TeekaName || t.TeekaName || "";
    const backupTeekaDocId = t.teeka?.documentId || t.teekaDocId || undefined;
    
    // Resolve Strapi docId for this teeka
    let strapiTeekaDocId = backupTeekaDocId && teekaDocIdToDocId.has(backupTeekaDocId)
      ? teekaDocIdToDocId.get(backupTeekaDocId)
      : TeekaName ? teekaNameToDocId.get(TeekaName.toLowerCase().trim()) : undefined;

    if (!strapiTeekaDocId) {
      console.log(`  [WARN] ${label}: cannot resolve Strapi teeka for "${TeekaName}" (backup docId=${backupTeekaDocId}) — skipping`);
      continue;
    }

    if (!hasContent(t.TeekaEntry)) {
      // No content to restore for this teeka entry
      continue;
    }

    const norm = normalizeEntry(t.TeekaEntry);
    if (!hasContent(norm)) continue;

    resolvedTeekas.push({ teeka: strapiTeekaDocId, TeekaEntry: norm });
  }

  const hasTeeka = resolvedTeekas.length > 0;

  // Skip if nothing to restore
  if (!hasBhashyam && !hasTeeka) {
    skipped++;
    continue;
  }

  // Build the PUT payload
  const putData = {};
  if (hasBhashyam) {
    putData.BhashyamEntry = normalizeEntry(bm.BhashyamEntry);
  }
  if (hasTeeka) {
    putData.Teekas = resolvedTeekas;
  }

  try {
    const result = strapiPut(`/api/manthras/${docId}`, putData);
    if (result?.error) {
      throw new Error(JSON.stringify(result.error).slice(0, 200));
    }
    const parts = [];
    if (hasBhashyam) parts.push(`bhashyam(S=${bm.BhashyamEntry?.SanskritTextEntry?.length??0} E=${bm.BhashyamEntry?.EnglishTranslationText?.length??0})`);
    if (hasTeeka)   parts.push(`${resolvedTeekas.length} teeka(s)`);
    console.log(`  ✅ ${label}: restored ${parts.join(" + ")}`);
    restored++;
  } catch(e) {
    console.log(`  ❌ ${label}: ${e.message.slice(0, 150)}`);
    errorList.push({ label, error: e.message });
    errors++;
  }
}

console.log(`\n=== Summary ===`);
console.log(`Total backup manthras:   ${kathoManthras.length}`);
console.log(`Restored:                ${restored}`);
console.log(`Skipped (no content):    ${skipped}`);
console.log(`Errors:                  ${errors}`);
if (errorList.length > 0) {
  console.log("\nErrors:");
  errorList.forEach(e => console.log(`  ${e.label}: ${e.error.slice(0,200)}`));
}
