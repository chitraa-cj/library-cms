/** Read-only: drill adhyaya->khanda->manthras, inspect one manthra's Teekas. */
import { config } from "dotenv";
config();
const U = process.env.STRAPI_URL;
const T = process.env.STRAPI_API_TOKEN;
const H = { Authorization: `Bearer ${T}` };
async function j(url){const r=await fetch(url,{headers:H});const b=await r.json();if(!r.ok)throw new Error(`HTTP ${r.status} ${url}\n${JSON.stringify(b).slice(0,300)}`);return b;}

const ADHYAYA1 = "uanf07d1ehyhyjmx0pv9ej3e"; // Prathama Adhyaya
const a = await j(`${U}/api/sections/${ADHYAYA1}?populate[sub_sections][fields][0]=title&populate[sub_sections][fields][1]=order&populate[sub_sections][fields][2]=type`);
const khandas = (a.data.sub_sections||[]).sort((x,y)=>x.order-y.order);
console.log(`Adhyaya1 khandas: ${khandas.length}`);
for(const k of khandas) console.log(`  ord${k.order} ${k.documentId} ${k.title}`);

const K1 = khandas[0].documentId;
const k = await j(`${U}/api/sections/${K1}?populate=manthras`);
const manthras = k.data.manthras||[];
console.log(`\nKhanda1 (${khandas[0].title}) manthras: ${manthras.length}`);
if(manthras[0]) console.log("  manthra fields:", Object.keys(manthras[0]).join(","));
for(const mm of manthras) console.log(`  ${mm.documentId} | ${JSON.stringify(Object.fromEntries(Object.entries(mm).filter(([kk])=>/number|order|title|name/i.test(kk))))}`);

// inspect first manthra fully
const M = manthras[0].documentId;
const md = await j(`${U}/api/manthras/${M}?populate=*`);
console.log(`\nManthra[0] keys:`, Object.keys(md.data));
console.log(`  MantraNumber="${md.data.MantraNumber}"`);
for(const key of Object.keys(md.data)){const v=md.data[key];if(Array.isArray(v))console.log(`  ${key}: array[${v.length}]`+(v[0]?` keys=${Object.keys(v[0]).join(",")}`:""));else if(v&&typeof v==="object"&&v.documentId)console.log(`  ${key}: {doc=${v.documentId} ${v.title||v.TeekaName||""}}`);}

// deep populate Teekas
const mt = await j(`${U}/api/manthras/${M}?populate[Teekas][populate][TeekaEntry][populate]=*&populate[Teekas][populate][teeka][fields][0]=TeekaName&populate[Teekas][populate][teeka][fields][1]=documentId`);
const teekas = mt.data.Teekas||[];
console.log(`\nTeekas on manthra[0]: ${teekas.length}`);
for(const t of teekas) console.log(`  - ${t.teeka?.TeekaName} (${t.teeka?.documentId}) TeekaEntry keys=${Object.keys(t.TeekaEntry||{}).join(",")}`);
console.log("\nRaw first Teeka component:\n", JSON.stringify(teekas[0],null,1)?.slice(0,1500));
