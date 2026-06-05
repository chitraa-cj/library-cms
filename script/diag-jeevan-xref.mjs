import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
function loadEnv(){try{const raw=readFileSync(resolve(process.cwd(),".env"),"utf8");for(const l of raw.split("\n")){const m=l.match(/^([^#=]+)=(.*)$/);if(m)process.env[m[1].trim()]=m[2].trim();}}catch{}}
loadEnv();
const STRAPI=process.env.STRAPI_URL, TOKEN=process.env.STRAPI_API_TOKEN;
async function strapi(p){const r=await fetch(STRAPI+p,{headers:{Authorization:`Bearer ${TOKEN}`}});if(!r.ok)throw new Error(r.status+" "+p);return r.json();}
const gid="h9ufwo46igckmsbhjttuc02q";
let page=1,cms=[];
while(true){const r=await strapi(`/api/manthras?filters[Section][grantha][documentId][$eq]=${gid}&fields[0]=documentId&fields[1]=ShlokaManthraNumber&fields[2]=order&pagination[pageSize]=100&pagination[page]=${page}`);cms.push(...(r.data??[]));if(page>=(r.meta?.pagination?.pageCount??1))break;page++;}
const cmsById=new Map(cms.map(m=>[m.documentId,m]));

const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
const dr=await c.query(`SELECT data FROM content_drafts WHERE id=10`);
const data=dr.rows[0].data;
const verses=[];
for(const a of data.hierarchy??[])for(const k of a.khandas??[]){for(const m of k.manthras??[])verses.push(m);for(const p of k.padas??[])for(const m of p.manthras??[])verses.push(m);}
verses.sort((a,b)=>(a.order??0)-(b.order??0));
console.log("DRAFT verse  ->  CMS row");
for(const m of verses){
  const sk=(m.ShlokaManthraEntry?.SanskritTextEntry??[]).flatMap(b=>(b.children??[]).map(c=>c.text??"")).join(" ").trim().slice(0,30);
  const cmsRow=cmsById.get(m.strapiDocumentId);
  const status = cmsRow ? `CMS="${cmsRow.ShlokaManthraNumber}" order=${cmsRow.order}` : ">>> ORPHAN (not in CMS) <<<";
  console.log(`  pos ${String(m.order).padStart(2)} "${m.title}" [${m.strapiDocumentId}]  ${status}   sk="${sk}"`);
}
console.log("\nCMS rows NOT linked by any draft verse:");
const draftIds=new Set(verses.map(v=>v.strapiDocumentId));
for(const m of cms) if(!draftIds.has(m.documentId)) console.log(`  [${m.documentId}] "${m.ShlokaManthraNumber}" order=${m.order}`);
await c.end();
