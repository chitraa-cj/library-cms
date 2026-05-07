/**
 * Restore OtherTranslations for Mandukya Upanishad mantras wiped on 2026-05-07.
 *
 * Root cause: broken populate in the portal returned null OtherTranslations →
 * local state had no translations → publish sent OtherTranslations:[Tamil] →
 * Strapi replaced all 43 with just 1.
 *
 * This script:
 *   1. Loads backup #210 (2026-05-02) which has the correct 43 translations.
 *   2. Scans Strapi for all Mandukya mantras with OT < 40.
 *   3. For each affected mantra:
 *      a. Fetches current Strapi ShlokaManthraEntry + BhashyamEntry (to preserve today's legitimate Sanskrit/Bhashyam edits).
 *      b. Finds the mantra in the backup and extracts OtherTranslations.
 *      c. PUTs: current Sanskrit/English + restored backup OtherTranslations.
 *
 * Usage:  node scripts/restore_mandukya_ot.mjs
 */
import pg       from "pg";
import { gunzipSync } from "node:zlib";
import http     from "node:http";

const STRAPI_HOST  = "13.53.121.15";
const STRAPI_PORT  = 1337;
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN;
const MANDUKYA_DOC = "sdhg4ecqcn6k4fi6hqfca8oe";
const BACKUP_ID    = 210;
const CONCURRENCY  = 4;    // parallel PUT requests

if (!STRAPI_TOKEN) { console.error("STRAPI_API_TOKEN not set"); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set"); process.exit(1); }

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function strapiReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: STRAPI_HOST, port: STRAPI_PORT, path, method,
      headers: {
        Authorization: `Bearer ${STRAPI_TOKEN}`,
        "Content-Type": "application/json",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: { _raw: d.slice(0, 200) } }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(90_000, () => req.destroy(new Error("Timeout")));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
const strapiGet = (p)       => strapiReq("GET",  p, null);
const strapiPut = (p, data) => strapiReq("PUT",  p, { data });

// ── Decompression ─────────────────────────────────────────────────────────────
function decompress(raw) {
  return raw?._compressed
    ? JSON.parse(gunzipSync(Buffer.from(raw.data, "base64")).toString("utf8"))
    : raw;
}

// ── Block / entry helpers ──────────────────────────────────────────────────────
function cleanBlocks(b) {
  return Array.isArray(b) ? b.filter(x => x && typeof x === "object") : [];
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    SanskritTextEntry:      cleanBlocks(entry.SanskritTextEntry),
    IASTTransliteration:    cleanBlocks(entry.IASTTransliteration),
    EnglishTranslationText: cleanBlocks(entry.EnglishTranslationText),
    OtherTranslations:      (entry.OtherTranslations ?? []).map(ot => ({
      LanguageOfTranslation: ot.LanguageOfTranslation,
      TranslationText:       cleanBlocks(ot.TranslationText),
      isAiTranslated:        ot.isAiTranslated ?? false,
    })).filter(ot => ot.LanguageOfTranslation),
  };
}

// ── Strapi paginated fetch ─────────────────────────────────────────────────────
async function fetchAllMandukya() {
  const populate =
    `populate[ShlokaManthraEntry][populate][OtherTranslations]=*` +
    `&populate[BhashyamEntry][populate][OtherTranslations]=*` +
    `&populate[Section][fields][0]=documentId`;
  const items = [];
  let page = 1;
  while (true) {
    const url =
      `/api/manthras?filters[Section][grantha][documentId][$eq]=${MANDUKYA_DOC}` +
      `&fields[0]=ShlokaManthraNumber&fields[1]=documentId&fields[2]=updatedAt` +
      `&${populate}&pagination[page]=${page}&pagination[pageSize]=50&sort=order:asc`;
    const r = await strapiGet(url);
    const data = r.body?.data ?? [];
    items.push(...data);
    const totalPages = r.body?.meta?.pagination?.pageCount ?? 1;
    if (page >= totalPages) break;
    page++;
  }
  return items;
}

// ── Fetch current full content for a single mantra ──────────────────────────
async function fetchCurrentContent(docId) {
  const url =
    `/api/manthras/${docId}` +
    `?populate[ShlokaManthraEntry][populate][OtherTranslations]=*` +
    `&populate[BhashyamEntry][populate][OtherTranslations]=*`;
  const r = await strapiGet(url);
  return r.body?.data ?? null;
}

// ── Run restore ───────────────────────────────────────────────────────────────
async function main() {
  // 1. Load and decompress backup #210
  console.log("Loading backup #210 from database…");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query("SELECT data FROM grantha_backups WHERE id=$1", [BACKUP_ID]);
  if (!rows.length) { console.error("Backup #210 not found"); process.exit(1); }
  const backupData = decompress(rows[0].data);
  await pool.end();

  const backupManthras = backupData.manthras ?? [];
  console.log(`Backup has ${backupManthras.length} total manthras`);

  // Build quick lookup by documentId
  const backupByDocId = new Map();
  for (const m of backupManthras) {
    if (m.documentId) backupByDocId.set(m.documentId, m);
  }

  // 2. Scan Strapi for affected Mandukya mantras (OT < 40)
  console.log("Scanning Strapi for affected Mandukya mantras…");
  const all = await fetchAllMandukya();
  console.log(`Total Mandukya mantras in Strapi: ${all.length}`);

  const affected = all.filter(m => {
    const slOT = m.ShlokaManthraEntry?.OtherTranslations?.length ?? 0;
    const bhOT = m.BhashyamEntry?.OtherTranslations?.length ?? 0;
    return slOT < 40 || bhOT < 40;
  });
  console.log(`Affected (OT < 40): ${affected.length}\n`);

  if (affected.length === 0) {
    console.log("Nothing to restore. All mantras look good.");
    return;
  }

  // 3. Restore each affected mantra
  let done = 0, success = 0, skipped = 0, failed = 0;

  async function restoreOne(m) {
    const docId   = m.documentId;
    const name    = m.ShlokaManthraNumber;
    const backup  = backupByDocId.get(docId);

    if (!backup) {
      console.log(`  [SKIP] ${name} (${docId}) — not in backup`);
      skipped++;
      return;
    }

    const backupSL = normalizeEntry(backup.ShlokaManthraEntry);
    const backupBH = normalizeEntry(backup.BhashyamEntry);
    const backupSlOT = backupSL?.OtherTranslations ?? [];
    const backupBhOT = backupBH?.OtherTranslations ?? [];

    if (backupSlOT.length < 40 && backupBhOT.length < 40) {
      console.log(`  [SKIP] ${name} — backup also has few translations (slOT=${backupSlOT.length} bhOT=${backupBhOT.length}), skipping to avoid overwriting with worse data`);
      skipped++;
      return;
    }

    // Fetch current Strapi content to preserve today's legitimate Sanskrit/Bhashyam edits
    const current = await fetchCurrentContent(docId);
    if (!current) {
      console.log(`  [FAIL] ${name} — could not fetch current Strapi content`);
      failed++;
      return;
    }

    const curSlOT = current.ShlokaManthraEntry?.OtherTranslations?.length ?? 0;
    const curBhOT = current.BhashyamEntry?.OtherTranslations?.length ?? 0;

    // Build restored payload:
    // Keep current Sanskrit/English (preserves legitimate edits made today)
    // Replace OtherTranslations with backup values if backup has more
    const payload = {};

    if (current.ShlokaManthraEntry && typeof current.ShlokaManthraEntry === "object") {
      const restoreSlOT = backupSlOT.length > curSlOT ? backupSlOT : null;
      if (restoreSlOT) {
        payload.ShlokaManthraEntry = {
          SanskritTextEntry:      cleanBlocks(current.ShlokaManthraEntry.SanskritTextEntry),
          IASTTransliteration:    cleanBlocks(current.ShlokaManthraEntry.IASTTransliteration),
          EnglishTranslationText: cleanBlocks(current.ShlokaManthraEntry.EnglishTranslationText),
          OtherTranslations:      restoreSlOT,
        };
      }
    }

    if (current.BhashyamEntry && typeof current.BhashyamEntry === "object") {
      const restoreBhOT = backupBhOT.length > curBhOT ? backupBhOT : null;
      if (restoreBhOT) {
        payload.BhashyamEntry = {
          SanskritTextEntry:      cleanBlocks(current.BhashyamEntry.SanskritTextEntry),
          IASTTransliteration:    cleanBlocks(current.BhashyamEntry.IASTTransliteration),
          EnglishTranslationText: cleanBlocks(current.BhashyamEntry.EnglishTranslationText),
          OtherTranslations:      restoreBhOT,
        };
      }
    }

    if (!payload.ShlokaManthraEntry && !payload.BhashyamEntry) {
      console.log(`  [SKIP] ${name} — nothing to restore (current already has >= backup OT)`);
      skipped++;
      return;
    }

    const r = await strapiPut(`/api/manthras/${docId}`, payload);
    if (r.status === 200) {
      const newSlOT = r.body?.data?.ShlokaManthraEntry?.OtherTranslations?.length ?? "?";
      const newBhOT = r.body?.data?.BhashyamEntry?.OtherTranslations?.length ?? "?";
      console.log(`  [OK]   ${name} — restored slOT: ${curSlOT}→${newSlOT}, bhOT: ${curBhOT}→${newBhOT}`);
      success++;
    } else {
      console.log(`  [FAIL] ${name} — HTTP ${r.status}:`, JSON.stringify(r.body).slice(0, 200));
      failed++;
    }
    done++;
  }

  // Process in batches of CONCURRENCY
  for (let i = 0; i < affected.length; i += CONCURRENCY) {
    const batch = affected.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(restoreOne));
    console.log(`Progress: ${Math.min(i + CONCURRENCY, affected.length)}/${affected.length}`);
  }

  console.log(`\nDone: ${success} restored, ${skipped} skipped, ${failed} failed`);
}

main().catch(e => { console.error(e); process.exit(1); });
