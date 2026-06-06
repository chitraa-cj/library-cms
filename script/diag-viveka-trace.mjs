import { readFileSync } from "node:fs"; import { resolve } from "node:path"; import pg from "pg";
function loadEnv(){try{const raw=readFileSync(resolve(process.cwd(),".env"),"utf8");for(const l of raw.split("\n")){const m=l.match(/^([^#=]+)=(.*)$/);if(m)process.env[m[1].trim()]=m[2].trim();}}catch{}}
loadEnv();
const STRAPI=process.env.STRAPI_URL, TOKEN=process.env.STRAPI_API_TOKEN;
async function strapi(p){const r=await fetch(STRAPI+p,{headers:{Authorization:`Bearer ${TOKEN}`}});if(!r.ok)throw new Error(r.status+" "+p);return r.json();}
function txt(b){return (Array.isArray(b)?b:[]).flatMap(x=>(x?.children??[]).map(c=>c?.text??"")).join(" ").replace(/\s+/g," ").trim();}

const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
const dr=await c.query(`SELECT id,status,strapi_document_id,data FROM content_drafts WHERE title ILIKE '%vivekachudamani%' ORDER BY updated_at DESC LIMIT 1`);
const draft=dr.rows[0];
const gid=draft.strapi_document_id;
console.log(`DRAFT id=${draft.id} status=${draft.status} grantha=${gid}\n`);

let page=1,ms=[];
while(true){const r=await strapi(`/api/manthras?filters[Section][grantha][documentId][$eq]=${gid}&fields[0]=documentId&fields[1]=ShlokaManthraNumber&fields[2]=order&populate[ShlokaManthraEntry][fields][0]=SanskritTextEntry&populate[BhashyamEntry][fields][0]=SanskritTextEntry&sort[0]=order:asc&pagination[pageSize]=100&pagination[page]=${page}`);ms.push(...(r.data??[]));if(page>=(r.meta?.pagination?.pageCount??1))break;page++;}
const cmsById=new Map(ms.map(m=>[m.documentId,m]));
console.log(`CMS manthras under this grantha: ${ms.length}`);
console.log("\n=== CMS rows order 1-8 (live) ===");
for(const m of ms.slice(0,8)) console.log(`  [${m.documentId}] "${m.ShlokaManthraNumber}" ord=${m.order} sk="${txt(m.ShlokaManthraEntry?.SanskritTextEntry).slice(0,20)}" bh="${txt(m.BhashyamEntry?.SanskritTextEntry).slice(0,20)||'(none)'}"`);

const verses=[];
for(const a of draft.data.hierarchy??[])for(const k of a.khandas??[]){for(const m of k.manthras??[])verses.push(m);for(const p of k.padas??[])for(const m of p.manthras??[])verses.push(m);}
verses.sort((a,b)=>(a.order??0)-(b.order??0));
console.log(`\nDraft verses: ${verses.length}`);

const byDoc=new Map();
for(const m of verses){const d=m.strapiDocumentId;if(!d)continue;(byDoc.get(d)??byDoc.set(d,[]).get(d)).push(m);}
console.log("\n=== DUPLICATE strapiDocumentId in draft ===");
let dup=0;for(const[d,list] of byDoc){if(list.length<2)continue;dup++;console.log(`  ${d} (CMS "${cmsById.get(d)?.ShlokaManthraNumber??'?'}") x${list.length}: ${list.map(m=>`pos${m.order}"${m.title}"`).join(", ")}`);}
if(!dup)console.log("  (none)");

console.log("\n=== CONTENT MISLINK (draft verse text != linked CMS row text) ===");
let mis=0;for(const m of verses){const cms=cmsById.get(m.strapiDocumentId);if(!cms)continue;const a=txt(m.ShlokaManthraEntry?.SanskritTextEntry).slice(0,16),b=txt(cms.ShlokaManthraEntry?.SanskritTextEntry).slice(0,16);if(a&&b&&a!==b){mis++;console.log(`  pos${m.order} "${m.title}" -> ${m.strapiDocumentId} CMS"${cms.ShlokaManthraNumber}" draft="${a}" cms="${b}" draftBH="${txt(m.BhashyamForShlokaManthra?.SanskritTextEntry).slice(0,14)||'(none)'}"`);}}
if(!mis)console.log("  (none)");

// CMS-side: is any bhashyam duplicated across adjacent verses (graft signature)?
console.log("\n=== CMS adjacent rows with IDENTICAL bhashyam (graft signature) ===");
let g=0;for(let i=1;i<ms.length;i++){const a=txt(ms[i-1].BhashyamEntry?.SanskritTextEntry),b=txt(ms[i].BhashyamEntry?.SanskritTextEntry);if(a&&b&&a===b){g++;console.log(`  "${ms[i-1].ShlokaManthraNumber}" & "${ms[i].ShlokaManthraNumber}" share bhashyam "${a.slice(0,24)}"`);}}
if(!g)console.log("  (none)");
await c.end();
