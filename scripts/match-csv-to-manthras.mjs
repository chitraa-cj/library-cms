/** Read-only: build Chandogya ShlokaManthraNumber->docId map, verify all CSV verses match. */
import { config } from "dotenv";
import fs from "node:fs";
import { parseCSV } from "./lib-csv.mjs";
config();
const U = process.env.STRAPI_URL;
const T = process.env.STRAPI_API_TOKEN;
const H = { Authorization: `Bearer ${T}` };
const GRANTHA = "d1qot3ne769frkku15ncymvy";
async function j(url){const r=await fetch(url,{headers:H});const b=await r.json();if(!r.ok)throw new Error(`HTTP ${r.status} ${url}\n${JSON.stringify(b).slice(0,300)}`);return b;}

// paginate ALL manthras under Chandogya (relation field is capital "Section")
const num2doc = {}; let page = 1, total = 0;
while (true) {
  const b = await j(`${U}/api/manthras?filters[Section][grantha][documentId][$eq]=${GRANTHA}&fields[0]=ShlokaManthraNumber&pagination[page]=${page}&pagination[pageSize]=100`);
  for (const m of b.data) {
    const num = (m.ShlokaManthraNumber || "").replace(/^Mantra\s*/i, "").trim();
    if (num2doc[num]) console.log(`  !! duplicate manthra number in Strapi: ${num} (${num2doc[num]} & ${m.documentId})`);
    num2doc[num] = m.documentId;
  }
  total = b.meta.pagination.total;
  if (page * 100 >= total) break;
  page++;
}
console.log(`Chandogya manthras in Strapi: ${total}, unique numbers mapped: ${Object.keys(num2doc).length}`);

// load CSV
const rows = parseCSV(fs.readFileSync("Chandogya-Anandagiri Teeka v1.0.csv", "utf8"));
const data = rows.slice(1).filter((r) => (r[0]||"").trim());
const verses = data.map((r) => r[0].trim());

const missing = verses.filter((v) => !num2doc[v]);
console.log(`\nCSV verses: ${verses.length}  matched: ${verses.length - missing.length}  MISSING: ${missing.length}`);
if (missing.length) console.log("  Missing (no manthra in Strapi):", missing);

// which matched manthras ALREADY have an Anandagiri teeka? (sample-check first, full check optional)
console.log(`\nStrapi has ${total} Chandogya manthras; CSV covers chapters 4-8. Sample matched docIds:`);
console.log(verses.slice(0,3).map(v=>`${v}->${num2doc[v]}`).join("  "));
