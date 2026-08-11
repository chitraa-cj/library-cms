/** Read-only: map Chandogya sections + manthras + manthra Teeka component shape. */
import { config } from "dotenv";
config();
const U = process.env.STRAPI_URL;
const T = process.env.STRAPI_API_TOKEN;
const H = { Authorization: `Bearer ${T}` };
const GRANTHA = "d1qot3ne769frkku15ncymvy";

async function j(url) {
  const r = await fetch(url, { headers: H });
  const body = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}\n${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

// 1) sections list
const g = await j(`${U}/api/granthas/${GRANTHA}?populate[sections][fields][0]=title&populate[sections][fields][1]=type&populate[sections][fields][2]=order`);
const sections = g.data.sections;
console.log(`Sections: ${sections.length}`);
for (const s of sections.slice(0, 15)) console.log(`  ${s.documentId} | type=${s.type} | order=${s.order} | ${s.title}`);

// 2) inspect one section's relations
const s0 = sections[0].documentId;
const sd = await j(`${U}/api/sections/${s0}?populate=*`);
console.log(`\nSection[0] ${sections[0].title} keys:`, Object.keys(sd.data));
for (const k of Object.keys(sd.data)) {
  const v = sd.data[k];
  if (Array.isArray(v)) console.log(`  ${k}: array[${v.length}]` + (v[0] ? ` keys=${Object.keys(v[0]).join(",")}` : ""));
  else if (v && typeof v === "object" && v.documentId) console.log(`  ${k}: {documentId=${v.documentId}}`);
}

// 3) manthras collection: how many under chandogya + numbering. Try filter by section->grantha
const m = await j(`${U}/api/manthras?filters[section][grantha][documentId][$eq]=${GRANTHA}&fields[0]=MantraNumber&populate[section][fields][0]=title&pagination[pageSize]=25&sort[0]=id:asc`);
console.log(`\nManthras page(25) total meta:`, JSON.stringify(m.meta?.pagination));
for (const mm of m.data.slice(0, 25)) console.log(`  ${mm.documentId} | Mantra ${mm.MantraNumber} | section=${mm.section?.title}`);
