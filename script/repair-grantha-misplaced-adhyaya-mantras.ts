/**
 * Remove mantras linked directly to an Adhyaya section when Khanda child sections exist.
 * Keeps mantras under Khanda (Adhyaya → Khanda → Mantra).
 *
 * Usage:
 *   npx tsx script/repair-grantha-misplaced-adhyaya-mantras.ts --grantha "Ishavasya"
 *   npx tsx script/repair-grantha-misplaced-adhyaya-mantras.ts --grantha "Ishavasya" --execute
 */
import { execFile } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSectionByDocIdMap,
  buildSectionAncestorPath,
  isMantraSectionMisplacedOnAdhyaya,
  mantraNumberSuffix,
  strapiGranthaHasKhandaSections,
} from "../client/src/lib/grantha-structure-sync.ts";

const STRAPI_URL = process.env.STRAPI_URL || "http://13.53.121.15:1337";
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN || "";

function parseArgs() {
  const args = process.argv.slice(2);
  let granthaQuery = "Ishavasya";
  let execute = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--grantha" && args[i + 1]) {
      granthaQuery = args[++i];
    } else if (args[i] === "--execute") {
      execute = true;
    } else if (args[i] === "--dry-run") {
      execute = false;
    }
  }
  return { granthaQuery, execute };
}

function curlRequest(path: string, method = "GET", body?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = `${STRAPI_URL}${path}`;
    const args = [
      "-g",
      "-s",
      "-k",
      "--max-time",
      "60",
      "-w",
      "|||HTTPSTATUS|||%{http_code}",
      "-X",
      method,
      "-H",
      `Authorization: Bearer ${STRAPI_TOKEN}`,
      "-H",
      "Content-Type: application/json",
    ];
    let tmp: string | undefined;
    if (body) {
      tmp = join(tmpdir(), `repair_${Date.now()}.json`);
      writeFileSync(tmp, body, "utf8");
      args.push("--data", `@${tmp}`);
    }
    args.push(url);
    execFile("curl", args, { timeout: 65000, maxBuffer: 30 * 1024 * 1024 }, (err, stdout) => {
      if (tmp) {
        try {
          unlinkSync(tmp);
        } catch {
          /* */
        }
      }
      if (err && !stdout) return reject(new Error(`curl: ${err.message}`));
      const sep = stdout.lastIndexOf("|||HTTPSTATUS|||");
      const status = parseInt(stdout.slice(sep + 16), 10);
      const bodyStr = stdout.slice(0, sep).trim();
      if (status === 204 || (status >= 200 && status < 300 && !bodyStr)) {
        resolve({});
        return;
      }
      let json: any;
      try {
        json = JSON.parse(bodyStr);
      } catch {
        return reject(new Error(`Non-JSON(${status}): ${bodyStr.slice(0, 200)}`));
      }
      if (status >= 400) {
        return reject(
          Object.assign(new Error(`HTTP ${status}: ${JSON.stringify(json).slice(0, 200)}`), { status }),
        );
      }
      resolve(json);
    });
  });
}

async function fetchAllPages(basePath: string): Promise<any[]> {
  const all: any[] = [];
  let page = 1;
  while (true) {
    const sep = basePath.includes("?") ? "&" : "?";
    const r = await curlRequest(`${basePath}${sep}pagination[page]=${page}`);
    all.push(...(r.data ?? []));
    const pageCount = r.meta?.pagination?.pageCount ?? 1;
    if (page >= pageCount) break;
    page++;
  }
  return all;
}

async function findGrantha(granthaQuery: string): Promise<{ documentId: string; GranthaName: string }> {
  const q = encodeURIComponent(granthaQuery);
  const r = await curlRequest(
    `/api/granthas?filters[GranthaName][$containsi]=${q}&fields[0]=documentId&fields[1]=GranthaName&pagination[pageSize]=25`,
  );
  const rows: any[] = r.data ?? [];
  if (rows.length === 0) {
    throw new Error(`No grantha matching "${granthaQuery}"`);
  }
  if (rows.length > 1) {
    console.log("Multiple granthas matched:");
    for (const g of rows) console.log(`  - ${g.GranthaName} (${g.documentId})`);
  }
  const pick =
    rows.find((g) => /ishavasya|isavasya/i.test(g.GranthaName || "")) ??
    rows.find((g) => new RegExp(granthaQuery, "i").test(g.GranthaName || "")) ??
    rows[0];
  return { documentId: pick.documentId, GranthaName: pick.GranthaName };
}

async function main() {
  const { granthaQuery, execute } = parseArgs();
  if (!STRAPI_TOKEN) {
    console.error("STRAPI_API_TOKEN is required in .env");
    process.exit(1);
  }

  const grantha = await findGrantha(granthaQuery);
  console.log(`Grantha: ${grantha.GranthaName} (${grantha.documentId})`);
  console.log(`Mode: ${execute ? "EXECUTE (will DELETE)" : "DRY RUN"}\n`);

  const g = encodeURIComponent(grantha.documentId);
  const sections = await fetchAllPages(
    `/api/sections?filters[grantha][documentId][$eq]=${g}&fields[0]=documentId&fields[1]=title&fields[2]=type&populate[parent][fields][0]=documentId&populate[parent][fields][1]=title&pagination[pageSize]=100`,
  );

  if (!strapiGranthaHasKhandaSections(sections)) {
    console.log("This grantha has no Khanda-level sections in Strapi — nothing to repair.");
    process.exit(0);
  }

  const byId = buildSectionByDocIdMap(sections);
  const topLevel = sections.filter((s) => {
    const pid = s.parent?.documentId;
    return !pid || !byId.has(pid);
  });

  console.log(`Sections: ${sections.length} (${topLevel.length} top-level)`);

  const manthras = await fetchAllPages(
    `/api/manthras?filters[Section][grantha][documentId][$eq]=${g}&fields[0]=documentId&fields[1]=ShlokaManthraNumber&fields[2]=order&populate[Section][fields][0]=documentId&populate[Section][fields][1]=title&sort[0]=order:asc&pagination[pageSize]=100`,
  );

  const khandaSuffixes = new Set<string>();
  for (const m of manthras) {
    const secId = m.Section?.documentId;
    if (!secId || isMantraSectionMisplacedOnAdhyaya(secId, sections)) continue;
    const suf = mantraNumberSuffix(String(m.ShlokaManthraNumber ?? ""));
    if (suf) khandaSuffixes.add(suf);
  }

  const toDelete: Array<{ documentId: string; label: string; path: string; reason: string }> = [];

  for (const m of manthras) {
    const secId = m.Section?.documentId;
    if (!secId || !isMantraSectionMisplacedOnAdhyaya(secId, sections)) continue;

    const path = sectionPathLabel(buildSectionAncestorPath(secId, byId));
    const label = String(m.ShlokaManthraNumber ?? "").trim() || m.documentId;
    const suf = mantraNumberSuffix(label);
    let reason = "linked to Adhyaya while Khanda sections exist";
    if (suf && khandaSuffixes.has(suf)) {
      reason += ` (duplicate of Khanda row suffix ${suf})`;
    }

    toDelete.push({ documentId: m.documentId, label, path, reason });
  }

  const keepCount = manthras.length - toDelete.length;
  console.log(`Mantras in grantha: ${manthras.length}`);
  console.log(`To delete (Adhyaya-level / misplaced): ${toDelete.length}`);
  console.log(`To keep (Khanda & other): ${keepCount}\n`);

  if (toDelete.length === 0) {
    console.log("No misplaced adhyaya mantras found.");
    process.exit(0);
  }

  for (const row of toDelete) {
    console.log(`  DELETE  ${row.label}`);
    console.log(`          ${row.path}`);
    console.log(`          ${row.reason}`);
  }

  if (!execute) {
    console.log(`\nRe-run with --execute to delete these ${toDelete.length} row(s).`);
    process.exit(0);
  }

  console.log("\nDeleting...");
  let ok = 0;
  let fail = 0;
  for (const row of toDelete) {
    try {
      await curlRequest(`/api/manthras/${row.documentId}`, "DELETE");
      console.log(`  OK  ${row.label}`);
      ok++;
    } catch (e: any) {
      if (e?.status === 404) {
        console.log(`  404 (already gone)  ${row.label}`);
        ok++;
      } else {
        console.log(`  FAIL  ${row.label}: ${e.message}`);
        fail++;
      }
    }
  }

  console.log(`\nDone. Deleted: ${ok}, failed: ${fail}, kept: ${keepCount}`);
}

function sectionPathLabel(path: { title?: string }[]): string {
  return path.map((s) => s.title?.trim() || "Section").join(" → ");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
