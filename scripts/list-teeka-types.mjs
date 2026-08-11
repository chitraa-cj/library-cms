/** Read-only: list all Teeka types (documentId + name) from Strapi. */
import { config } from "dotenv";
config();
const U = process.env.STRAPI_URL;
const T = process.env.STRAPI_API_TOKEN;
if (!T) { console.error("STRAPI_API_TOKEN missing"); process.exit(1); }
const H = { Authorization: `Bearer ${T}` };

const r = await fetch(`${U}/api/teekas?pagination[pageSize]=200&fields[0]=TeekaName&fields[1]=documentId`, { headers: H });
if (!r.ok) { console.error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`); process.exit(1); }
const j = await r.json();
console.log(`Total teeka types: ${j.data.length}`);
for (const t of j.data) console.log(`  ${t.documentId}  ${t.TeekaName}`);
