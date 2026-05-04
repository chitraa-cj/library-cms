/**
 * COMPLETE force-restore of Katho Upanishad from backup #210.
 * Processes manthras in parallel (CONCURRENCY at a time) for speed.
 */
import pg from "pg";
import { gunzipSync } from "node:zlib";
import http from "node:http";

const STRAPI_HOST = "13.53.121.15";
const STRAPI_PORT = 1337;
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN;
const KATHO_DOC_ID = "t2d3crlf4ptuadp73lziogy5";
const BACKUP_ID    = 210;
const OT_BATCH     = 15;   // OtherTranslations per batch
const CONCURRENCY  = 6;    // manthras processed simultaneously

if (!STRAPI_TOKEN) { console.error("No STRAPI_API_TOKEN"); process.exit(1); }

function strapiReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: STRAPI_HOST, port: STRAPI_PORT, path, method,
      headers: {
        "Authorization": `Bearer ${STRAPI_TOKEN}`,
        "Content-Type": "application/json",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ _raw: data.slice(0, 100), status: res.statusCode }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(90000, () => req.destroy(new Error("HTTP timeout")));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const strapiGet = (p)       => strapiReq("GET", p, null);
const strapiPut = (p, data) => strapiReq("PUT", p, { data });

function decompress(raw) {
  return raw?._compressed
    ? JSON.parse(gunzipSync(Buffer.from(raw.data, "base64")).toString("utf8"))
    : raw;
}

function cleanBlocks(b) {
  return Array.isArray(b) ? b.filter(x => x && typeof x === "object") : [];
}

function normalizeEntry(entry) {
  if (!entry) return null;
  return {
    SanskritTextEntry:      cleanBlocks(entry.SanskritTextEntry),
    EnglishTranslationText: cleanBlocks(entry.EnglishTranslationText),
    OtherTranslations: (entry.OtherTranslations ?? [])
      .filter(o => o?.LanguageOfTranslation && cleanBlocks(o.TranslationText).length > 0)
      .map(o => ({ LanguageOfTranslation: o.LanguageOfTranslation, TranslationText: cleanBlocks(o.TranslationText) })),
  };
}

function hasContent(e) {
  return !!(e && (e.SanskritTextEntry?.length || e.EnglishTranslationText?.length || e.OtherTranslations?.length));
}

/** Send one text field in chunks: core first, then OT in batches. */
async function putTextField(endpoint, fieldKey, norm) {
  const core = { SanskritTextEntry: norm.SanskritTextEntry, EnglishTranslationText: norm.EnglishTranslationText, OtherTranslations: [] };
  const r1 = await strapiPut(endpoint, { [fieldKey]: core });
  if (r1?.error) throw new Error(JSON.stringify(r1.error).slice(0, 150));

  const allOT = norm.OtherTranslations ?? [];
  let sent = [];
  for (let i = 0; i < allOT.length; i += OT_BATCH) {
    sent = [...sent, ...allOT.slice(i, i + OT_BATCH)];
    const r2 = await strapiPut(endpoint, { [fieldKey]: { ...core, OtherTranslations: sent } });
    if (r2?.error) throw new Error(`OT[${i}–${i+OT_BATCH}]: ${JSON.stringify(r2.error).slice(0, 150)}`);
  }
}

/** Send one teeka in chunks. */
async function putTeeka(endpoint, teekaDocId, norm) {
  const core = { SanskritTextEntry: norm.SanskritTextEntry, EnglishTranslationText: norm.EnglishTranslationText, OtherTranslations: [] };
  const r1 = await strapiPut(endpoint, { Teekas: [{ teeka: teekaDocId, TeekaEntry: core }] });
  if (r1?.error) throw new Error(JSON.stringify(r1.error).slice(0, 150));

  const allOT = norm.OtherTranslations ?? [];
  let sent = [];
  for (let i = 0; i < allOT.length; i += OT_BATCH) {
    sent = [...sent, ...allOT.slice(i, i + OT_BATCH)];
    const r2 = await strapiPut(endpoint, { Teekas: [{ teeka: teekaDocId, TeekaEntry: { ...core, OtherTranslations: sent } }] });
    if (r2?.error) throw new Error(`teekaOT[${i}–${i+OT_BATCH}]: ${JSON.stringify(r2.error).slice(0, 150)}`);
  }
}

async function restoreMantra(bm, teekaMap) {
  const docId   = bm.documentId;
  const label   = bm.ShlokaManthraNumber ?? docId;
  const endpoint = `/api/manthras/${docId}`;
  const parts = [], errs = [];

  const normShloka   = normalizeEntry(bm.ShlokaManthraEntry);
  const normBhashyam = normalizeEntry(bm.BhashyamEntry);

  if (hasContent(normShloka)) {
    try { await putTextField(endpoint, "ShlokaManthraEntry", normShloka); parts.push(`shloka(OT=${normShloka.OtherTranslations.length})`); }
    catch(e) { errs.push(`shloka: ${e.message.slice(0,80)}`); }
  }

  if (hasContent(normBhashyam)) {
    try { await putTextField(endpoint, "BhashyamEntry", normBhashyam); parts.push(`bhashyam(OT=${normBhashyam.OtherTranslations.length})`); }
    catch(e) { errs.push(`bhashyam: ${e.message.slice(0,80)}`); }
  }

  for (const t of (bm.Teekas ?? [])) {
    const tName  = t.teeka?.TeekaName || t.TeekaName || "";
    const tBackId = t.teeka?.documentId || t.teekaDocId;
    const sId = (tBackId && teekaMap.has(tBackId) ? teekaMap.get(tBackId) : null)
             ?? (tName ? teekaMap.get(tName.toLowerCase().trim()) : null);
    if (!sId) continue;
    const norm = normalizeEntry(t.TeekaEntry);
    if (!hasContent(norm)) continue;
    try { await putTeeka(endpoint, sId, norm); parts.push(`teeka(OT=${norm.OtherTranslations.length})`); }
    catch(e) { errs.push(`teeka: ${e.message.slice(0,80)}`); }
  }

  const status = errs.length > 0
    ? `  ⚠️  ${label}: ${parts.join(" + ")} | ERR: ${errs.join("; ")}`
    : `  ✅  ${label}: ${parts.join(" + ")}`;
  console.log(status);
  return { label, ok: errs.length === 0, parts, errs };
}

// Pool-based concurrency
async function runWithConcurrency(tasks, limit) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
console.log(`\n=== COMPLETE Force-Restore Katho Upanishad — backup #${BACKUP_ID} ===\n`);

const { rows } = await client.query("SELECT data FROM grantha_backups WHERE id = $1", [BACKUP_ID]);
if (!rows.length) { console.error("Backup not found"); process.exit(1); }
const bData = decompress(rows[0].data);
await client.end();

const kathoSecIds = new Set(
  (bData.sections ?? []).filter(s => s.grantha?.documentId === KATHO_DOC_ID).map(s => s.documentId)
);
const kathoManthras = (bData.manthras ?? []).filter(m => kathoSecIds.has(m.Section?.documentId ?? ""));
console.log(`Katho manthras in backup: ${kathoManthras.length}`);

const teekaMap = new Map();
const tRes = await strapiGet(`/api/teekas?filters[grantha][documentId][$eq]=${KATHO_DOC_ID}&pagination[pageSize]=50`);
for (const t of tRes?.data ?? []) {
  teekaMap.set(t.documentId, t.documentId);
  teekaMap.set((t.TeekaName ?? "").toLowerCase().trim(), t.documentId);
  console.log(`  Teeka "${t.TeekaName}" → ${t.documentId}`);
}
console.log();

const tasks = kathoManthras.map(bm => () => restoreMantra(bm, teekaMap));
const results = await runWithConcurrency(tasks, CONCURRENCY);

const ok  = results.filter(r => r?.ok).length;
const bad = results.filter(r => r && !r.ok).length;
console.log(`\n=== Done: ${ok} OK, ${bad} with errors, ${kathoManthras.length - results.length} unprocessed ===`);
