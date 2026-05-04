/**
 * Sync Kathopanishad teeka content from Strapi into the portal draft (id=46)
 * so the portal shows it immediately without waiting for the async fetch.
 */
import pg from "pg";
import http from "node:http";

const STRAPI_HOST = "13.53.121.15";
const STRAPI_PORT = 1337;
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN;
const DRAFT_ID = 46;
const KATHO_DOC_ID = "t2d3crlf4ptuadp73lziogy5";

function strapiReq(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: STRAPI_HOST, port: STRAPI_PORT, path, method: "GET",
      headers: { "Authorization": `Bearer ${STRAPI_TOKEN}` },
    }, (res) => {
      let data = ""; res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    });
    req.on("error", reject);
    req.setTimeout(60000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

// Load draft
const { rows: draftRows } = await client.query("SELECT data FROM content_drafts WHERE id=$1", [DRAFT_ID]);
const rawData = draftRows[0].data;
const draftData = typeof rawData === "string" ? JSON.parse(rawData) : rawData;

// Fetch all Katho manthras from Strapi with full teeka content (2 pages)
const pop = [
  `filters[Section][grantha][documentId][$eq]=${KATHO_DOC_ID}`,
  "populate[Teekas][populate][teeka][fields][0]=documentId",
  "populate[Teekas][populate][teeka][fields][1]=TeekaName",
  "populate[Teekas][populate][teeka][fields][2]=TeekaAuthor",
  "populate[Teekas][populate][TeekaEntry][populate]=*",
  "fields[0]=documentId",
  "fields[1]=ShlokaManthraNumber",
  "pagination[pageSize]=100",
].join("&");

console.log("Fetching Katho manthras from Strapi...");
const [page1, page2] = await Promise.all([
  strapiReq(`/api/manthras?${pop}&pagination[page]=1`),
  strapiReq(`/api/manthras?${pop}&pagination[page]=2`),
]);
const strapiManthras = [...(page1.data || []), ...(page2.data || [])];
console.log(`Got ${strapiManthras.length} manthras from Strapi`);

// Build a map: strapiDocumentId → teeka content
const strapiTeekaMap = new Map();
let withContent = 0;
for (const m of strapiManthras) {
  const teekas = m.Teekas || [];
  const kathopanishadTeeka = teekas.find(t => t.teeka?.TeekaName?.toLowerCase().includes("kathopa"));
  if (kathopanishadTeeka?.TeekaEntry) {
    const te = kathopanishadTeeka.TeekaEntry;
    const hasSa = Array.isArray(te.SanskritTextEntry) && te.SanskritTextEntry.length > 0;
    const hasOT = Array.isArray(te.OtherTranslations) && te.OtherTranslations.length > 0;
    if (hasSa || hasOT) {
      strapiTeekaMap.set(m.documentId, {
        TeekaName: kathopanishadTeeka.teeka.TeekaName,
        TeekaAuthor: kathopanishadTeeka.teeka.TeekaAuthor || "Anandagiri",
        teekaDocId: kathopanishadTeeka.teeka.documentId,
        TeekaEntry: {
          SanskritTextEntry: te.SanskritTextEntry || [],
          EnglishTranslationText: te.EnglishTranslationText || [],
          IASTTransliteration: te.IASTTransliteration || null,
          OtherTranslations: (te.OtherTranslations || []).map(ot => ({
            LanguageOfTranslation: ot.LanguageOfTranslation || "",
            TranslationText: ot.TranslationText || [],
          })),
        },
      });
      withContent++;
    }
  }
}
console.log(`Strapi manthras with Kathopanishad teeka content: ${withContent}`);

// Update draft hierarchy
const hier = draftData.hierarchy || draftData.adhyayas || [];
let updated = 0, skipped = 0;

function updateManthra(m) {
  if (!m.strapiDocumentId) { skipped++; return m; }
  const stTeekaData = strapiTeekaMap.get(m.strapiDocumentId);
  if (!stTeekaData) { skipped++; return m; }
  
  // Keep existing teekas, update/add Kathopanishad entry
  const existingTeekas = Array.isArray(m.Teekas) ? m.Teekas : [];
  const otherTeekas = existingTeekas.filter(t =>
    !t.TeekaName?.toLowerCase().includes("kathopa")
  );
  
  updated++;
  return { ...m, Teekas: [stTeekaData, ...otherTeekas] };
}

const hierKey = draftData.hierarchy ? "hierarchy" : "adhyayas";
const updatedHier = hier.map(a => ({
  ...a,
  khandas: (a.khandas || []).map(k => ({
    ...k,
    manthras: (k.manthras || []).map(updateManthra),
    padas: (k.padas || []).map(p => ({
      ...p,
      manthras: (p.manthras || []).map(updateManthra),
    })),
  })),
}));

const updatedData = { ...draftData, [hierKey]: updatedHier };
await client.query(
  "UPDATE content_drafts SET data=$1, updated_at=NOW() WHERE id=$2",
  [JSON.stringify(updatedData), DRAFT_ID]
);
await client.end();

console.log(`\n✅ Draft updated: ${updated} manthras got Kathopanishad teeka content, ${skipped} had no Strapi data`);
