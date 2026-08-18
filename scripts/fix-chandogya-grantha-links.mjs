/** Restore the grantha relation on all Chandogya khandas that lost it (both draft+published). */
import { config } from "dotenv"; config();
const U = process.env.STRAPI_URL, T = process.env.STRAPI_API_TOKEN;
const H = { Authorization: `Bearer ${T}`, "Content-Type":"application/json" };
const GRANTHA="d1qot3ne769frkku15ncymvy";
async function j(url,opt={}){const r=await fetch(url,{headers:H,...opt});const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(`HTTP ${r.status} ${url}\n${JSON.stringify(b).slice(0,300)}`);return b;}

// Re-derive the broken set live (do not trust stale file)
const g = await j(`${U}/api/granthas/${GRANTHA}?populate[sections][fields][0]=title&populate[sections][populate][parent][fields][0]=documentId&pagination[pageSize]=100`);
const adhSet = new Set((g.data.sections||[]).filter(s=>!s.parent).map(a=>a.documentId));
let page=1, all=[];
while(true){const r=await j(`${U}/api/sections?status=draft&fields[0]=title&fields[1]=order&populate[grantha][fields][0]=documentId&populate[parent][fields][0]=documentId&pagination[pageSize]=100&pagination[page]=${page}`);all.push(...r.data);if(page>=r.meta.pagination.pageCount)break;page++;}
const broken = all.filter(s=>s.parent && adhSet.has(s.parent.documentId) && !s.grantha?.documentId);
console.log(`Broken Chandogya khandas to fix: ${broken.length}`);

let ok=0, fail=0;
for(const s of broken){
  try{
    await j(`${U}/api/sections/${s.documentId}`,{method:"PUT",body:JSON.stringify({data:{grantha:{connect:[{documentId:GRANTHA}]}}})});
    // verify both versions
    const v=await j(`${U}/api/sections/${s.documentId}?status=draft&populate[grantha][fields][0]=documentId&populate[manthras][fields][0]=id`);
    const vp=await j(`${U}/api/sections/${s.documentId}?status=published&populate[grantha][fields][0]=documentId&populate[manthras][fields][0]=id`);
    const dOk=v.data.grantha?.documentId===GRANTHA, pOk=vp.data.grantha?.documentId===GRANTHA;
    if(dOk&&pOk){ok++;} else {fail++;console.log(`  ! ${s.documentId} ${s.title}: draft=${dOk} pub=${pOk}`);}
  }catch(e){fail++;console.log(`  ! FAIL ${s.documentId} ${s.title}: ${e.message.slice(0,120)}`);}
}
console.log(`\nDone. fixed+verified=${ok}, failed=${fail}`);
