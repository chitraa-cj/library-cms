/** Read-only: for the 267 CSV targets, report which already have an Anandagiri teeka
 *  and whether that teeka has non-empty IAST/English/OtherTranslations (would need merge). */
import { config } from "dotenv";
import fs from "node:fs";
import { parseCSV } from "./lib-csv.mjs";
config();
const U = process.env.STRAPI_URL, T = process.env.STRAPI_API_TOKEN;
const H = { Authorization: `Bearer ${T}` };
const GRANTHA = "d1qot3ne769frkku15ncymvy";
const ANANDAGIRI = "thyunbfuwin9ltj12on892yy";
async function j(url){const r=await fetch(url,{headers:H});const b=await r.json();if(!r.ok)throw new Error(`HTTP ${r.status} ${url}\n${JSON.stringify(b).slice(0,200)}`);return b;}
const nonEmpty=(v)=> Array.isArray(v)? v.length>0 : (typeof v==="string"? v.trim()!=="" : v!=null);

// map
const num2doc={}; let page=1,total=0;
while(true){const b=await j(`${U}/api/manthras?filters[Section][grantha][documentId][$eq]=${GRANTHA}&fields[0]=ShlokaManthraNumber&pagination[page]=${page}&pagination[pageSize]=100`);for(const m of b.data)num2doc[(m.ShlokaManthraNumber||"").replace(/^Mantra\s*/i,"").trim()]=m.documentId;total=b.meta.pagination.total;if(page*100>=total)break;page++;}

const rows=parseCSV(fs.readFileSync("Chandogya-Anandagiri Teeka v1.0.csv","utf8"));
const verses=rows.slice(1).filter(r=>(r[0]||"").trim()).map(r=>r[0].trim());

let hasAna=0, anaWithExtra=[], teekaCounts={};
for(const v of verses){
  const doc=num2doc[v];
  const q=`${U}/api/manthras/${doc}?populate[Teekas][populate][TeekaEntry][populate]=*&populate[Teekas][populate][teeka][fields][0]=documentId`;
  const m=(await j(q)).data;
  const teekas=m.Teekas||[];
  teekaCounts[teekas.length]=(teekaCounts[teekas.length]||0)+1;
  const ana=teekas.find(t=>t.teeka?.documentId===ANANDAGIRI);
  if(ana){
    hasAna++;
    const te=ana.TeekaEntry||{};
    const extra=[];
    if(nonEmpty(te.IASTTransliteration))extra.push("IAST");
    if(nonEmpty(te.EnglishTranslationText))extra.push("English");
    if(nonEmpty(te.OtherTranslations))extra.push("Other");
    if(extra.length)anaWithExtra.push(`${v}: ${extra.join(",")}`);
  }
}
console.log(`Targets: ${verses.length}`);
console.log(`Already have an Anandagiri teeka: ${hasAna}`);
console.log(`Distribution of #teekas per target manthra:`, teekaCounts);
console.log(`\nExisting Anandagiri entries with non-empty IAST/English/Other (need field-merge): ${anaWithExtra.length}`);
anaWithExtra.slice(0,60).forEach(x=>console.log("  "+x));
