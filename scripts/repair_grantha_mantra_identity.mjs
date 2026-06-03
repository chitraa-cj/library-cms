/**
 * Repair mantra order + labels for all leaf sections of one grantha.
 *
 * Usage:
 *   STRAPI_API_TOKEN=... node scripts/repair_grantha_mantra_identity.mjs --grantha="Jeevan"
 *   STRAPI_API_TOKEN=... node scripts/repair_grantha_mantra_identity.mjs --grantha-doc=<documentId> --apply
 */
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const STRAPI_HOST = process.env.STRAPI_HOST || "13.53.121.15";
const STRAPI_PORT = Number(process.env.STRAPI_PORT || 1337);
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN;
const APPLY = process.argv.includes("--apply");

function arg(name) {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : "";
}

if (!STRAPI_TOKEN) {
  console.error("Set STRAPI_API_TOKEN");
  process.exit(1);
}

function strapiReq(method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: STRAPI_HOST,
        port: STRAPI_PORT,
        path: reqPath,
        method,
        headers: {
          Authorization: `Bearer ${STRAPI_TOKEN}`,
          "Content-Type": "application/json",
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: { _raw: data } });
          }
        });
      },
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function fetchGrantha(search) {
  const q = encodeURIComponent(search);
  const { body } = await strapiReq(
    "GET",
    `/api/granthas?filters[GranthaName][$containsi]=${q}&fields[0]=GranthaName&fields[1]=documentId&pagination[pageSize]=10`,
  );
  return body.data ?? [];
}

async function fetchSectionsForGrantha(granthaDocId) {
  const g = encodeURIComponent(granthaDocId);
  const all = [];
  let page = 1;
  while (true) {
    const { body } = await strapiReq(
      "GET",
      `/api/granthas?filters[documentId][$eq]=${g}&populate[sections][fields][0]=documentId&populate[sections][fields][1]=title&populate[sections][fields][2]=order&populate[sections][populate][parent][fields][0]=documentId&pagination[pageSize]=1`,
    );
    const grantha = body.data?.[0];
    if (!grantha) break;
    for (const s of grantha.sections ?? []) all.push(s);
    break;
  }
  if (all.length > 0) return all;

  let p = 1;
  while (true) {
    const { body } = await strapiReq(
      "GET",
      `/api/sections?filters[grantha][documentId][$eq]=${g}&fields[0]=documentId&fields[1]=title&fields[2]=order&populate[parent][fields][0]=documentId&sort=order:asc&pagination[page]=${p}&pagination[pageSize]=100`,
    );
    all.push(...(body.data ?? []));
    if (p >= (body.meta?.pagination?.pageCount ?? 1)) break;
    p++;
  }
  return all;
}

async function countMantrasInSection(sectionDocId) {
  const s = encodeURIComponent(sectionDocId);
  const { body } = await strapiReq(
    "GET",
    `/api/manthras?filters[Section][documentId][$eq]=${s}&pagination[pageSize]=1`,
  );
  return body.meta?.pagination?.total ?? 0;
}

async function main() {
  const granthaDoc = arg("grantha-doc");
  const granthaSearch = arg("grantha") || "Jeevan";
  let targetDocId = granthaDoc;

  if (!targetDocId) {
    const hits = await fetchGrantha(granthaSearch);
    if (!hits.length) {
      console.error(`No grantha matching "${granthaSearch}"`);
      process.exit(1);
    }
    console.log("Matching granthas:");
    for (const g of hits) console.log(`  ${g.GranthaName}  ${g.documentId}`);
    targetDocId = hits[0].documentId;
    console.log(`\nUsing: ${hits[0].GranthaName} (${targetDocId})\n`);
  }

  const sections = await fetchSectionsForGrantha(targetDocId);
  const parentIds = new Set(
    sections.map((s) => s.parent?.documentId).filter(Boolean),
  );
  const leafSections = sections.filter((s) => s.documentId && !parentIds.has(s.documentId));

  console.log(`Sections: ${sections.length}, leaf sections: ${leafSections.length}\n`);

  const repairScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "repair_section_mantra_identity.mjs");
  const withMantras = [];
  for (const sec of leafSections) {
    const n = await countMantrasInSection(sec.documentId);
    if (n > 0) withMantras.push({ ...sec, mantraCount: n });
  }

  if (withMantras.length === 0) {
    console.log("No leaf sections with mantras found.");
    return;
  }

  for (const sec of withMantras) {
    console.log(`\n=== ${sec.title} (${sec.documentId}) — ${sec.mantraCount} mantras ===`);
    const args = [
      repairScript,
      `--section=${sec.documentId}`,
      "--leaf=Mantra",
      "--suffix-prefix=1",
    ];
    if (APPLY) args.push("--apply");
    const r = spawnSync(process.execPath, args, {
      env: { ...process.env, STRAPI_API_TOKEN: STRAPI_TOKEN },
      stdio: "inherit",
    });
    if (r.status !== 0) {
      console.error(`Repair failed for section ${sec.documentId}`);
      process.exit(r.status ?? 1);
    }
  }

  console.log(`\nDone (${APPLY ? "applied" : "dry-run"}).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
