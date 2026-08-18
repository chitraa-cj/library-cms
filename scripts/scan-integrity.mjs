/** READ-ONLY: scan ALL granthas for relation-integrity drops (grantha/parent/Section). */
import { config } from "dotenv"; config();
const U = process.env.STRAPI_URL, T = process.env.STRAPI_API_TOKEN;
const H = { Authorization: `Bearer ${T}` };
async function j(url){const r=await fetch(url,{headers:H});const b=await r.json();if(!r.ok)throw new Error(`HTTP ${r.status} ${url}\n${JSON.stringify(b).slice(0,200)}`);return b;}
async function all(path){let page=1,out=[];while(true){const r=await j(`${U}${path}${path.includes("?")?"&":"?"}pagination[pageSize]=100&pagination[page]=${page}`);out.push(...r.data);const tp=r.meta?.pagination?.pageCount||1;if(page>=tp)break;page++;}return out;}

// 1) granthas + their section docIds
const granthas = await all(`/api/granthas?fields[0]=GranthaName`);
const gById = new Map(granthas.map(g=>[g.documentId,g.GranthaName]));
console.log(`Granthas: ${granthas.length}`);

// 2) ALL sections (draft status = returns all) with grantha + parent
const secs = await all(`/api/sections?status=draft&fields[0]=title&fields[1]=order&populate[grantha][fields][0]=documentId&populate[parent][fields][0]=documentId&populate[parent][fields][1]=title`);
const secById = new Map(secs.map(s=>[s.documentId,s]));
console.log(`Sections (all): ${secs.length}`);

// A section is "in a grantha tree" if it has grantha OR its parent chain leads to one with grantha
function rootGrantha(s,depth=0){if(depth>20)return null;if(s.grantha?.documentId)return s.grantha.documentId;const p=s.parent?.documentId?secById.get(s.parent.documentId):null;return p?rootGrantha(p,depth+1):null;}

// GAP A: sections whose parent is a real section but grantha is null (detached from grantha filter)
const nullGranthaWithParent = secs.filter(s=>!s.grantha?.documentId && s.parent?.documentId && secById.has(s.parent.documentId));
// GAP B: sections with NO grantha and NO parent (fully orphaned / root but unlinked)
const nullBoth = secs.filter(s=>!s.grantha?.documentId && !s.parent?.documentId);
// group A by inferred root grantha
const byG=new Map();
for(const s of nullGranthaWithParent){const rg=rootGrantha(s)||"(unknown)";if(!byG.has(rg))byG.set(rg,0);byG.set(rg,byG.get(rg)+1);}
console.log(`\n=== GAP A: sections missing grantha but nested under a parent: ${nullGranthaWithParent.length} ===`);
for(const [g,n] of [...byG.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  ${n.toString().padStart(4)}  ${gById.get(g)||g}`);
console.log(`\n=== GAP B: sections with neither grantha nor parent (root-detached): ${nullBoth.length} ===`);

// 3) manthras: orphans (null Section) + Section with null grantha
const mans = await all(`/api/manthras?status=draft&fields[0]=ShlokaManthraNumber&populate[Section][fields][0]=documentId&populate[Section][populate][grantha][fields][0]=documentId`);
console.log(`\nManthras (all): ${mans.length}`);
const orphanM = mans.filter(m=>!m.Section?.documentId);
const mSecNullG = mans.filter(m=>m.Section?.documentId && !m.Section?.grantha?.documentId);
console.log(`=== GAP C: manthras with NULL Section (orphans): ${orphanM.length} ===`);
console.log(`=== GAP D: manthras whose Section has NULL grantha: ${mSecNullG.length} ===`);
