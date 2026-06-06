// Repair the single grafted bhashyam: inserted verse "durlabham" (1.1.3) wrongly carries
// verse 1.1.2's bhashyam. Clears it on the CMS row AND the draft node. DRY RUN unless APPLY=1.
import { readFileSync } from "node:fs"; import { resolve } from "node:path"; import pg from "pg";
function loadEnv(){try{const raw=readFileSync(resolve(process.cwd(),".env"),"utf8");for(const l of raw.split("\n")){const m=l.match(/^([^#=]+)=(.*)$/);if(m)process.env[m[1].trim()]=m[2].trim();}}catch{}}
loadEnv();
const APPLY = process.env.APPLY === "1";
const STRAPI=process.env.STRAPI_URL, TOKEN=process.env.STRAPI_API_TOKEN;
async function strapi(p,opts){const r=await fetch(STRAPI+p,{...opts,headers:{Authorization:`Bearer ${TOKEN}`,"Content-Type":"application/json",...(opts?.headers||{})}});if(!r.ok)throw new Error(r.status+" "+p+" "+await r.text());return r.json();}
function txt(b){return (Array.isArray(b)?b:[]).flatMap(x=>(x?.children??[]).map(c=>c?.text??"")).join(" ").replace(/\s+/g," ").trim();}

const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
const dr=await c.query(`SELECT id,strapi_document_id,data FROM content_drafts WHERE title ILIKE '%vivekachudamani%' ORDER BY updated_at DESC LIMIT 1`);
const draft=dr.rows[0]; const gid=draft.strapi_document_id;

// 1) Find the CMS verse whose bhashyam is byte-identical to the PREVIOUS verse's (graft signature).
let page=1,ms=[];
while(true){const r=await strapi(`/api/manthras?filters[Section][grantha][documentId][$eq]=${gid}&fields[0]=documentId&fields[1]=ShlokaManthraNumber&fields[2]=order&populate[ShlokaManthraEntry][fields][0]=SanskritTextEntry&populate[BhashyamEntry][fields][0]=SanskritTextEntry&sort[0]=order:asc&pagination[pageSize]=100&pagination[page]=${page}`);ms.push(...(r.data??[]));if(page>=(r.meta?.pagination?.pageCount??1))break;page++;}
const grafts=[];
for(let i=1;i<ms.length;i++){const a=txt(ms[i-1].BhashyamEntry?.SanskritTextEntry),b=txt(ms[i].BhashyamEntry?.SanskritTextEntry);if(a&&b&&a===b)grafts.push({prev:ms[i-1],row:ms[i],bh:b});}
console.log(`Grafts detected (verse sharing previous verse's bhashyam): ${grafts.length}`);
for(const g of grafts) console.log(`  CLEAR bhashyam on "${g.row.ShlokaManthraNumber}" [${g.row.documentId}] (copy of "${g.prev.ShlokaManthraNumber}"): "${g.bh.slice(0,30)}"`);

// 2) Map to draft nodes (by strapiDocumentId) so we clear the draft too.
const verses=[];
for(const a of draft.data.hierarchy??[])for(const k of a.khandas??[]){for(const m of k.manthras??[])verses.push(m);for(const p of k.padas??[])for(const m of p.manthras??[])verses.push(m);}
const draftByDoc=new Map(verses.map(m=>[m.strapiDocumentId,m]));

if(!APPLY){ console.log("\nDRY RUN — set APPLY=1 to write. Nothing changed."); await c.end(); process.exit(0); }

// 3a) Clear CMS BhashyamEntry on each grafted row.
for(const g of grafts){
  await strapi(`/api/manthras/${g.row.documentId}`,{method:"PUT",body:JSON.stringify({data:{BhashyamEntry:null}})});
  console.log(`  CMS cleared: ${g.row.documentId}`);
}
// 3b) Clear the matching draft node's bhashyam (and stamp _bhashyamEdited so any future publish keeps it cleared).
let mutated=false;
for(const g of grafts){
  const node=draftByDoc.get(g.row.documentId);
  if(node){ delete node.BhashyamForShlokaManthra; node._bhashyamEdited=true; mutated=true; console.log(`  draft node cleared: pos${node.order} "${node.title}"`); }
}
if(mutated){ await c.query(`UPDATE content_drafts SET data=$1 WHERE id=$2`,[draft.data,draft.id]); console.log(`  draft id=${draft.id} updated`); }
console.log("\nAPPLIED.");
await c.end();
