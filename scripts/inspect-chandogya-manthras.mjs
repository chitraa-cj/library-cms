/** Read-only: inspect Chandogya manthra structure + one manthra's Teeka components. */
import { config } from "dotenv";
config();
const U = process.env.STRAPI_URL;
const T = process.env.STRAPI_API_TOKEN;
const H = { Authorization: `Bearer ${T}` };
const GRANTHA = "d1qot3ne769frkku15ncymvy";

// How are manthras organized? Grantha -> Sections -> Manthras?  Inspect grantha structure.
const gr = await fetch(`${U}/api/granthas/${GRANTHA}?populate[Sections][fields][0]=SectionName&populate[Sections][fields][1]=documentId&populate[Sections][populate][Manthras][fields][0]=MantraNumber&populate[Sections][populate][Manthras][fields][1]=documentId`, { headers: H });
const gj = await gr.json();
if (!gr.ok) { console.log("grantha populate err", gr.status, JSON.stringify(gj).slice(0,300)); }
const secs = gj.data?.Sections || [];
console.log(`Chandogya sections: ${secs.length}`);
let sampleManthraDoc = null, sampleLabel = null;
for (const s of secs.slice(0, 6)) {
  const ms = s.Manthras || [];
  console.log(`  [${s.documentId}] ${s.SectionName}  -> ${ms.length} manthras: ${ms.slice(0,8).map(m=>m.MantraNumber).join(", ")}${ms.length>8?" …":""}`);
  if (!sampleManthraDoc && ms.length) { sampleManthraDoc = ms[0].documentId; sampleLabel = `${s.SectionName} / ${ms[0].MantraNumber}`; }
}

if (sampleManthraDoc) {
  console.log(`\n=== Sample manthra ${sampleLabel} (${sampleManthraDoc}) Teekas ===`);
  const q = `${U}/api/manthras/${sampleManthraDoc}?populate[Teekas][populate][TeekaEntry][populate]=*&populate[Teekas][populate][teeka][fields][0]=TeekaName&populate[Teekas][populate][teeka][fields][1]=documentId`;
  const r = await fetch(q, { headers: H });
  const j = await r.json();
  const teekas = j.data?.Teekas || [];
  console.log(`Teekas count: ${teekas.length}`);
  for (const t of teekas) {
    const entryKeys = Object.keys(t.TeekaEntry || {});
    console.log(`  - ${t.teeka?.TeekaName} (${t.teeka?.documentId})  TeekaEntry keys: ${entryKeys.join(", ")}`);
  }
  // dump raw structure of first teeka entry for exact field shape
  console.log("\nRaw first Teeka component:");
  console.log(JSON.stringify(teekas[0], null, 1)?.slice(0, 1200));
}
