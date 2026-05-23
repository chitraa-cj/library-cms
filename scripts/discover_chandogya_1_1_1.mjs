/**
 * Discover Chandogya Upanishad mantra 1.1.1 in Strapi.
 */
import { config } from "dotenv";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
config({ path: path.join(root, ".env") });

const STRAPI_URL = process.env.STRAPI_URL || "http://13.53.121.15:1337";
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN;
if (!STRAPI_TOKEN) {
  console.error("STRAPI_API_TOKEN required in .env");
  process.exit(1);
}

function curlJSON(url, method, body) {
  const args = ["-sg", "--globoff", "--max-time", "120", "-H", "Content-Type: application/json", "-H", `Authorization: Bearer ${STRAPI_TOKEN}`];
  if (method) args.push("-X", method);
  if (body) args.push("-d", body);
  args.push(url);
  const out = execFileSync("curl", args, { encoding: "utf8", maxBuffer: 80 * 1024 * 1024 });
  return JSON.parse(out);
}

const get = (p) => curlJSON(`${STRAPI_URL}${p}`);

const CHANDOGYA_DOC = "ms4s02bun5nw9an4ds594aoe";

const sections = get(
  `/api/sections?filters[grantha][documentId][$eq]=${CHANDOGYA_DOC}&pagination[pageSize]=100&fields[0]=documentId&fields[1]=title&fields[2]=type&fields[3]=order`,
)?.data ?? [];
console.log(`Sections (${sections.length}):`);
for (const s of sections.slice(0, 15)) {
  console.log(`  [${s.type}] order=${s.order} "${s.title}" ${s.documentId}`);
}

const MANTRA_Q =
  "&populate[Teekas][populate][TeekaEntry][populate]=*" +
  "&populate[Teekas][populate][teeka][fields][0]=TeekaName" +
  "&populate[ShlokaManthraEntry][populate]=*" +
  "&populate[BhashyamEntry][populate]=*" +
  "&populate[Section][fields][0]=title&populate[Section][fields][1]=documentId";

const all = [];
for (const sec of sections) {
  for (let page = 1; page <= 5; page++) {
    const r = get(
      `/api/manthras?filters[Section][documentId][$eq]=${sec.documentId}&pagination[page]=${page}&pagination[pageSize]=50&fields[0]=documentId&fields[1]=ShlokaManthraNumber&fields[2]=order${MANTRA_Q}`,
    );
    for (const m of r?.data ?? []) all.push(m);
    if ((r?.meta?.pagination?.page ?? 1) >= (r?.meta?.pagination?.pageCount ?? 1)) break;
  }
}

console.log(`\nManthras in Chandogya (${all.length}):`);
const matches = all.filter(
  (m) =>
    String(m.ShlokaManthraNumber ?? "").includes("1.1.1") ||
    String(m.ShlokaManthraNumber ?? "").includes("1-1-1"),
);
for (const m of all.slice(0, 20)) {
  console.log(`  ${m.ShlokaManthraNumber} order=${m.order} sec=${m.Section?.title} ${m.documentId}`);
}
console.log("\nMatches for 1.1.1:", matches.length);
for (const m of matches) {
  console.log(JSON.stringify({ docId: m.documentId, num: m.ShlokaManthraNumber, sec: m.Section?.title }, null, 2));
}
