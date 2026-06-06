import { readFileSync } from "node:fs"; import { resolve } from "node:path"; import pg from "pg";
function loadEnv(){try{const raw=readFileSync(resolve(process.cwd(),".env"),"utf8");for(const l of raw.split("\n")){const m=l.match(/^([^#=]+)=(.*)$/);if(m)process.env[m[1].trim()]=m[2].trim();}}catch{}}
loadEnv();
const STRAPI=process.env.STRAPI_URL, TOKEN=process.env.STRAPI_API_TOKEN;
async function strapi(p){const r=await fetch(STRAPI+p,{headers:{Authorization:`Bearer ${TOKEN}`}});if(!r.ok)throw new Error(r.status);return r.json();}
function txt(b){return (Array.isArray(b)?b:[]).flatMap(x=>(x?.children??[]).map(c=>c?.text??"")).join("").replace(/\s+/g,"").replace(/[।॥]/g,"").trim();}
function sh(d){return d?String(d).slice(0,6):"——";}
const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
let prev="";
for(let tick=0;tick<500;tick++){
  let out="";
  try{
    // live grantha by NAME (docId rotates on republish)
    const gs=await strapi(`/api/granthas?filters[GranthaName][$containsi]=viveka&fields[0]=documentId&fields[1]=updatedAt&pagination[pageSize]=10`);
    const gid=(gs.data||[]).sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt))[0]?.documentId;
    const dr=await c.query(`SELECT id,status,strapi_document_id,data,updated_at FROM content_drafts WHERE title ILIKE '%vivekachudamani%' ORDER BY updated_at DESC LIMIT 1`);
    const draft=dr.rows[0];
    const verses=[];for(const a of draft.data.hierarchy??[])for(const k of a.khandas??[]){for(const m of k.manthras??[])verses.push(m);for(const p of k.padas??[])for(const m of p.manthras??[])verses.push(m);}
    verses.sort((a,b)=>(a.order??0)-(b.order??0));
    const r=await strapi(`/api/manthras?filters[Section][grantha][documentId][$eq]=${gid}&fields[0]=documentId&fields[1]=ShlokaManthraNumber&fields[2]=order&populate[ShlokaManthraEntry][fields][0]=SanskritTextEntry&populate[BhashyamEntry][fields][0]=SanskritTextEntry&sort[0]=order:asc&pagination[pageSize]=6`);
    const cms=(r.data??[]).slice(0,5);
    out+=`DRAFT id=${draft.id}/${draft.status} draftGrantha=${sh(draft.strapi_document_id)} liveGrantha=${sh(gid)} verses=${verses.length}\n`;
    for(const m of verses.slice(0,5)) out+=`  D pos${m.order} "${m.title}" new=${m._isNewLocal?'Y':'n'} doc=${sh(m.strapiDocumentId)} sk=${txt(m.ShlokaManthraEntry?.SanskritTextEntry).length} bh=${txt(m.BhashyamForShlokaManthra?.SanskritTextEntry).length}\n`;
    for(const m of cms) out+=`  C "${m.ShlokaManthraNumber}" ord=${m.order} doc=${sh(m.documentId)} sk="${txt(m.ShlokaManthraEntry?.SanskritTextEntry).slice(0,9)}" bh="${txt(m.BhashyamEntry?.SanskritTextEntry).slice(0,9)||'·'}"`+"\n";
    const flags=[];
    const docs=verses.map(v=>v.strapiDocumentId).filter(Boolean);
    const dup=[...new Set(docs.filter((d,i)=>docs.indexOf(d)!==i))];
    if(dup.length) flags.push(`DUP-DOCID:${dup.map(sh).join(",")}`);
    for(let i=1;i<cms.length;i++){const a=txt(cms[i-1].BhashyamEntry?.SanskritTextEntry),b=txt(cms[i].BhashyamEntry?.SanskritTextEntry);if(a&&b&&a===b)flags.push(`CMS-GRAFT:${cms[i-1].ShlokaManthraNumber}=${cms[i].ShlokaManthraNumber}`);}
    if(flags.length) out+=`  >>> FLAGS: ${flags.join("  ")}\n`;
  }catch(e){out=`(poll error: ${e.message})\n`;}
  if(out!==prev){ const t=new Date().toLocaleTimeString(); console.log(`──── tick ${tick} @ ${t} ────`); process.stdout.write(out); prev=out; }
  await new Promise(r=>setTimeout(r,3000));
}
await c.end();
