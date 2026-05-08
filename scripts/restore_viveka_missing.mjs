/**
 * Restore 9 missing Vivekachudamani shlokas from backup #208.
 * These records were deleted from Strapi at some point after April 24.
 * Each has real content: Sanskrit text, English translation, Bhashyam.
 *
 * Usage: node scripts/restore_viveka_missing.mjs
 */
import http from "node:http";
import pg from "pg";
import { gunzipSync } from "node:zlib";

const STRAPI_HOST = "13.53.121.15";
const STRAPI_PORT = 1337;
const TOKEN       = process.env.STRAPI_API_TOKEN;
const SECTION_DOC = "g7wjis56amxgmrnk1w4i9ucr"; // Prathama Khanda
const BACKUP_ID   = 208;
const GAPS        = [23, 96, 179, 180, 191, 192, 208, 209, 210];

if (!TOKEN) { console.error("No STRAPI_API_TOKEN"); process.exit(1); }

function strapiReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: STRAPI_HOST, port: STRAPI_PORT, path, method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
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
    req.setTimeout(60_000, () => req.destroy(new Error("Timeout")));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Convert backup TextAndTranslation block format to Strapi format
// Backup stores SanskritTextEntry as Strapi blocks already
function cleanTT(tt) {
  if (!tt) return null;
  const result = {};
  if (Array.isArray(tt.SanskritTextEntry) && tt.SanskritTextEntry.length > 0) {
    result.SanskritTextEntry = tt.SanskritTextEntry;
  }
  if (Array.isArray(tt.EnglishTranslationText) && tt.EnglishTranslationText.length > 0) {
    result.EnglishTranslationText = tt.EnglishTranslationText;
  }
  if (Array.isArray(tt.IASTTransliteration) && tt.IASTTransliteration.length > 0) {
    result.IASTTransliteration = tt.IASTTransliteration;
  }
  if (Array.isArray(tt.OtherTranslations) && tt.OtherTranslations.length > 0) {
    result.OtherTranslations = tt.OtherTranslations.map(ot => ({
      LanguageOfTranslation: ot.LanguageOfTranslation,
      TranslationText: ot.TranslationText ?? [],
      ...(ot.isAiTranslated !== undefined ? { isAiTranslated: ot.isAiTranslated } : {}),
    }));
  }
  return Object.keys(result).length > 0 ? result : null;
}

async function main() {
  // Load backup
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query("SELECT data FROM grantha_backups WHERE id=$1", [BACKUP_ID]);
  await pool.end();

  const raw = rows[0].data;
  const data = raw?._compressed
    ? JSON.parse(gunzipSync(Buffer.from(raw.data, "base64")).toString("utf8"))
    : raw;

  const manthras = (data.manthras ?? []).filter(m => m.Section?.documentId === SECTION_DOC);
  console.log(`Loaded backup #${BACKUP_ID}: ${manthras.length} Prathama Khanda mantras\n`);

  let created = 0, failed = 0;

  for (const gap of GAPS) {
    const sloka = `Shloka 1.1.${gap}`;
    const m = manthras.find(x => x.ShlokaManthraNumber === sloka);
    if (!m) {
      console.log(`[SKIP] ${sloka} — not found in backup`);
      continue;
    }

    const payload = {
      ShlokaManthraNumber: m.ShlokaManthraNumber,
      order: m.order ?? gap,
      Section: SECTION_DOC,
    };

    const shlokaTT = cleanTT(m.ShlokaManthraEntry);
    if (shlokaTT) payload.ShlokaManthraEntry = shlokaTT;

    const bhashyamTT = cleanTT(m.BhashyamEntry);
    if (bhashyamTT) payload.BhashyamEntry = bhashyamTT;

    if (Array.isArray(m.wordMeanings) && m.wordMeanings.length > 0) {
      payload.wordMeanings = m.wordMeanings;
    }

    const r = await strapiReq("POST", "/api/manthras", { data: payload });
    if (r.status === 200 || r.status === 201) {
      const newDocId = r.body?.data?.documentId;
      console.log(`[OK] ${sloka} → created (order ${gap}) | newDocId: ${newDocId}`);
      created++;
    } else {
      console.log(`[FAIL] ${sloka} → HTTP ${r.status}:`, JSON.stringify(r.body).slice(0, 150));
      failed++;
    }
  }

  console.log(`\nDone: ${created} created, ${failed} failed`);

  // Quick verification
  if (created > 0) {
    console.log("\nVerifying restored shlokas in Strapi…");
    for (const gap of GAPS) {
      const name = encodeURIComponent(`Shloka 1.1.${gap}`);
      const r = await strapiReq("GET", `/api/manthras?filters[ShlokaManthraNumber][$eq]=${name}&fields[0]=ShlokaManthraNumber&fields[1]=order&fields[2]=documentId&populate[Section][fields][0]=title`, null);
      const items = r.body?.data ?? [];
      if (items.length === 0) {
        console.log(`  Shloka 1.1.${gap} → STILL MISSING`);
      } else {
        items.forEach(it => console.log(`  Shloka 1.1.${gap} → OK | section: ${it.Section?.title ?? "NO SECTION"} | order: ${it.order}`));
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
