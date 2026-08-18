import { config } from "dotenv"; config();
const U = process.env.STRAPI_URL, T = process.env.STRAPI_API_TOKEN;
const H = { Authorization: `Bearer ${T}` };
async function j(url){const r=await fetch(url,{headers:H});const b=await r.json();if(!r.ok)throw new Error(`HTTP ${r.status}`);return b;}
const GRANTHA="d1qot3ne769frkku15ncymvy";
const g = await j(`${U}/api/granthas/${GRANTHA}?populate[sections][fields][0]=title&populate[sections][fields][1]=order&populate[sections][populate][parent][fields][0]=documentId&pagination[pageSize]=100`);
const adhyayas=(g.data.sections||[]).filter(s=>!s.parent).sort((a,b)=>(a.order??0)-(b.order??0));
// editor view: all sections with grantha set, grouped by parent
let page=1,all=[];
while(true){const r=await j(`${U}/api/sections?filters[grantha][documentId][$eq]=${GRANTHA}&fields[0]=title&populate[parent][fields][0]=documentId&pagination[pageSize]=100&pagination[page]=${page}`);all.push(...r.data);if(page>=r.meta.pagination.pageCount)break;page++;}
const editorByParent=new Map();
for(const s of all){const p=s.parent?.documentId;if(!p)continue;editorByParent.set(p,(editorByParent.get(p)||0)+1);}
let allGood=true;
for(const a of adhyayas){
  const ad=await j(`${U}/api/sections/${a.documentId}?populate[sub_sections][fields][0]=id`);
  const trueCount=(ad.data.sub_sections||[]).length;
  const editorCount=editorByParent.get(a.documentId)||0;
  const mark=trueCount===editorCount?"OK":"MISMATCH";
  if(trueCount!==editorCount)allGood=false;
  console.log(`  [${mark}] ord${a.order} ${a.title}: true khandas=${trueCount}, editor-visible=${editorCount}`);
}
console.log(`\n${allGood?"ALL ADHYAYAS CONSISTENT ✓":"STILL MISMATCHED ✗"}`);
