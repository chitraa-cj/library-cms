/** Read-only: list Teeka types whose grantha is Chandogya. */
import { config } from "dotenv";
config();
const U = process.env.STRAPI_URL;
const T = process.env.STRAPI_API_TOKEN;
const H = { Authorization: `Bearer ${T}` };

// find Chandogya grantha(s)
const gr = await fetch(`${U}/api/granthas?filters[GranthaName][$containsi]=chandogya&fields[0]=GranthaName&fields[1]=documentId`, { headers: H });
const gj = await gr.json();
console.log("Chandogya grantha(s):");
for (const g of gj.data) console.log(`  ${g.documentId}  ${g.GranthaName}`);

// list teekas with grantha populated, filter to chandogya
const r = await fetch(`${U}/api/teekas?pagination[pageSize]=200&fields[0]=TeekaName&fields[1]=documentId&populate[grantha][fields][0]=GranthaName&populate[grantha][fields][1]=documentId`, { headers: H });
const j = await r.json();
const chandogya = j.data.filter((t) => /chandogya/i.test(t.grantha?.GranthaName || ""));
console.log(`\nTeeka types under Chandogya (${chandogya.length}):`);
for (const t of chandogya) console.log(`  ${t.documentId}  ${t.TeekaName}   [grantha ${t.grantha?.documentId} ${t.grantha?.GranthaName}]`);
