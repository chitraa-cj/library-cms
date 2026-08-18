/** Classify every draft-grantha-null section; reconcile safely. Dry-run unless APPLY=1. */
import { config } from "dotenv"; config();
const U = process.env.STRAPI_URL, T = process.env.STRAPI_API_TOKEN;
const H = { Authorization: `Bearer ${T}`, "Content-Type":"application/json" };
const APPLY = process.env.APPLY === "1";
async function j(url,opt={}){const r=await fetch(url,{headers:H,...opt});const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(`HTTP ${r.status} ${JSON.stringify(b).slice(0,120)}`);return b;}
async function all(path){let page=1,out=[];while(true){const r=await j(`${U}${path}${path.includes("?")?"&":"?"}pagination[pageSize]=100&pagination[page]=${page}`);out.push(...r.data);const tp=r.meta?.pagination?.pageCount||1;if(page>=tp)break;page++;}return out;}
const secs = await all(`/api/sections?status=draft&fields[0]=title&populate[grantha][fields][0]=documentId&populate[parent][fields][0]=documentId`);
const byId=new Map(secs.map(s=>[s.documentId,s]));
const mans = await all(`/api/manthras?status=draft&fields[0]=id&populate[Section][fields][0]=documentId`);
const mCount=new Map();for(const m of mans){const s=m.Section?.documentId;if(s)mCount.set(s,(mCount.get(s)||0)+1);}
function chainG(s,d=0){if(d>25)return null;if(s.grantha?.documentId)return s.grantha.documentId;const p=s.parent?.documentId?byId.get(s.parent.documentId):null;return p?chainG(p,d+1):null;}
const flagged = secs.filter(s=>!s.grantha?.documentId);
const buckets={latent:[],activeResolvable:[],activeUnresolvable:[]};
for(const s of flagged){
  const pub = await j(`${U}/api/sections/${s.documentId}?status=published&populate[grantha][fields][0]=documentId`);
  const pubG = pub.data?.grantha?.documentId || null;
  const target = pubG || chainG(s);
  const hasContent = (mCount.get(s.documentId)||0)>0;
  const rec={id:s.documentId,title:s.title,m:mCount.get(s.documentId)||0,target,source:pubG?'published':'chain'};
  if(pubG) buckets.latent.push(rec);
  else if(target) buckets.activeResolvable.push(rec);
  else buckets.activeUnresolvable.push({...rec,hasContent});
}
const sum=a=>a.reduce((n,x)=>n+x.m,0);
console.log(`FLAGGED (draft grantha null): ${flagged.length}`);
console.log(`  LATENT (published-linked, draft-null → safe reconcile): ${buckets.latent.length} sections, ${sum(buckets.latent)} manthras`);
console.log(`  ACTIVE but resolvable via parent-chain: ${buckets.activeResolvable.length} sections, ${sum(buckets.activeResolvable)} manthras`);
console.log(`  ACTIVE unresolvable (both versions null, no chain): ${buckets.activeUnresolvable.length} sections, ${sum(buckets.activeUnresolvable)} manthras`);
const unresWithContent=buckets.activeUnresolvable.filter(x=>x.hasContent);
console.log(`     of which with manthras: ${unresWithContent.length}`);
for(const x of unresWithContent.slice(0,10)) console.log(`       ${x.id} "${x.title}" m=${x.m}`);
if(!APPLY){console.log(`\nDRY-RUN. APPLY=1 to reconcile LATENT + ACTIVE-resolvable (both fully safe, target grantha is known).`);process.exit(0);}
const toFix=[...buckets.latent,...buckets.activeResolvable];
let ok=0,fail=0;
for(const x of toFix){try{await j(`${U}/api/sections/${x.id}`,{method:"PUT",body:JSON.stringify({data:{grantha:{connect:[{documentId:x.target}]}}})});const v=await j(`${U}/api/sections/${x.id}?status=draft&populate[grantha][fields][0]=documentId`);v.data.grantha?.documentId===x.target?ok++:fail++;}catch(e){fail++;console.log(`  ! ${x.id} ${x.title}: ${e.message.slice(0,80)}`);}}
console.log(`\nReconciled. ok=${ok} fail=${fail} (unresolvable left untouched: ${buckets.activeUnresolvable.length})`);
