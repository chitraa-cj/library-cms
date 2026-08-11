/** Read-only: are existing Anandagiri SanskritTextEntry populated for the 267 targets?
 *  Compare existing vs CSV text for a few samples. */
import { config } from "dotenv";
import fs from "node:fs";
import { parseCSV } from "./lib-csv.mjs";
config();
const U = process.env.STRAPI_URL, T = process.env.STRAPI_API_TOKEN;
const H = { Authorization: `Bearer ${T}` };
const GRANTHA = "d1qot3ne769frkku15ncymvy", ANANDAGIRI = "thyunbfuwin9ltj12on892yy";
async function j(url){const r=await fetch(url,{headers:H});const b=await r.json();if(!r.ok)throw new Error(`HTTP ${r.status}`);return b;}
function blocksToText(blocks){if(!Array.isArray(blocks))return "";return blocks.map(b=>(b.children||[]).map(c=>c.text||"").join("")).join("\n");}

const num2doc={}; let page=1,total=0;
while(true){const b=await j(`${U}/api/manthras?filters[Section][grantha][documentId][$eq]=${GRANTHA}&fields[0]=ShlokaManthraNumber&pagination[page]=${page}&pagination[pageSize]=100`);for(const m of b.data)num2doc[(m.ShlokaManthraNumber||"").replace(/^Mantra\s*/i,"").trim()]=m.documentId;total=b.meta.pagination.total;if(page*100>=total)break;page++;}

const rows=parseCSV(fs.readFileSync("Chandogya-Anandagiri Teeka v1.0.csv","utf8"));
const data=rows.slice(1).filter(r=>(r[0]||"").trim());
const csvMap=Object.fromEntries(data.map(r=>[r[0].trim(),r[1]]));
const verses=data.map(r=>r[0].trim());

let existingPopulated=0, existingEmpty=0, noAna=0;
const samples=[];
for(const v of verses){
  const doc=num2doc[v];
  const m=(await j(`${U}/api/manthras/${doc}?populate[Teekas][populate][TeekaEntry][populate]=*&populate[Teekas][populate][teeka][fields][0]=documentId`)).data;
  const ana=(m.Teekas||[]).find(t=>t.teeka?.documentId===ANANDAGIRI);
  if(!ana){noAna++;continue;}
  const txt=blocksToText(ana.TeekaEntry?.SanskritTextEntry);
  if(txt.trim()){existingPopulated++; if(samples.length<3)samples.push({v,existing:txt});}
  else existingEmpty++;
}
console.log(`Targets: ${verses.length}`);
console.log(`  existing Anandagiri w/ populated Sanskrit: ${existingPopulated}`);
console.log(`  existing Anandagiri EMPTY Sanskrit:        ${existingEmpty}`);
console.log(`  no Anandagiri teeka at all:                ${noAna}`);
for(const s of samples){
  console.log(`\n===== ${s.v} =====`);
  console.log("EXISTING (first 300):", JSON.stringify(s.existing.slice(0,300)));
  console.log("CSV      (first 300):", JSON.stringify((csvMap[s.v]||"").slice(0,300)));
  console.log("identical?", s.existing.trim()===(csvMap[s.v]||"").trim());
}
