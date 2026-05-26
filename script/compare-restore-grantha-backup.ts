/**
 * Compare live Strapi mantras for a grantha against a portal backup snapshot.
 * Optionally restore rows where live content diverges from backup (by documentId).
 *
 * Usage:
 *   npx tsx script/compare-restore-grantha-backup.ts --grantha "Sarva Vedanta" --backup-id 1
 *   npx tsx script/compare-restore-grantha-backup.ts --grantha "Sarva Vedanta" --backup-id 1 --execute
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const STRAPI_URL = process.env.STRAPI_URL || "http://13.53.121.15:1337";
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

function parseArgs() {
  const args = process.argv.slice(2);
  let granthaQuery = "Sarva Vedanta";
  let backupId = 1;
  let execute = false;
  let suffixFilter: string | undefined;
  const documentIds: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--grantha" && args[i + 1]) granthaQuery = args[++i];
    else if (args[i] === "--backup-id" && args[i + 1]) backupId = parseInt(args[++i], 10);
    else if (args[i] === "--suffix" && args[i + 1]) suffixFilter = args[++i];
    else if (args[i] === "--document-id" && args[i + 1]) documentIds.push(args[++i]);
    else if (args[i] === "--execute") execute = true;
  }
  return { granthaQuery, backupId, execute, suffixFilter, documentIds };
}

function curl(path: string, method = "GET", body?: unknown): any {
  const args = [
    "-gsk",
    "--max-time",
    "120",
    "-H",
    `Authorization: Bearer ${STRAPI_TOKEN}`,
    "-H",
    "Content-Type: application/json",
    "-X",
    method,
  ];
  let tmp: string | undefined;
  if (body) {
    tmp = join(tmpdir(), `curl_${Date.now()}.json`);
    writeFileSync(tmp, JSON.stringify(body));
    args.push("--data", `@${tmp}`);
  }
  const out = execFileSync("curl", args.concat([`${STRAPI_URL}${path}`]), {
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024,
  });
  if (tmp) {
    try {
      unlinkSync(tmp);
    } catch {
      /* */
    }
  }
  return JSON.parse(out);
}

function blocksText(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  return (v as any[])
    .map((b) => ((b.children ?? []) as any[]).map((c) => c.text || "").join(""))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

function textToBlocks(text: string): unknown[] {
  if (!text.trim()) return [];
  return text.split("\n").map((line) => ({
    type: "paragraph",
    children: [{ type: "text", text: line }],
  }));
}

function mantraSuffix(label: string | undefined): string | null {
  const m = String(label ?? "")
    .trim()
    .match(/([\d]+(?:\.[\d]+)*)\s*$/);
  return m ? m[1] : null;
}

async function loadBackup(backupId: number): Promise<{ granthas: any[]; sections: any[]; manthras: any[] }> {
  if (!DATABASE_URL) throw new Error("DATABASE_URL required to load backup from Postgres");
  const { storage } = await import("../server/storage.ts");
  const row = await storage.getBackup(backupId);
  if (!row?.data) throw new Error(`Backup id ${backupId} not found`);

  let raw: any = row.data;
  if (typeof raw === "string") raw = JSON.parse(raw);
  if (raw?._compressed && typeof raw.data === "string") {
    const buf = Buffer.from(raw.data, "base64");
    raw = JSON.parse(gunzipSync(buf).toString("utf8"));
  }
  if (raw?.data && raw.granthas) raw = raw.data;
  return {
    granthas: raw.granthas ?? [],
    sections: raw.sections ?? [],
    manthras: raw.manthras ?? [],
  };
}

async function fetchLiveMantras(granthaDocId: string): Promise<any[]> {
  const all: any[] = [];
  let page = 1;
  while (true) {
    const r = curl(
      `/api/manthras?filters[Section][grantha][documentId][$eq]=${encodeURIComponent(granthaDocId)}` +
        `&populate[ShlokaManthraEntry][populate]=*&fields[0]=documentId&fields[1]=ShlokaManthraNumber&fields[2]=updatedAt&pagination[pageSize]=100&pagination[page]=${page}`,
    );
    all.push(...(r.data ?? []));
    if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  return all;
}

function findGrantha(data: { granthas: any[] }, query: string) {
  const hits = data.granthas.filter((g) =>
    new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(g.GranthaName || ""),
  );
  if (hits.length === 0) throw new Error(`No grantha matching "${query}" in backup`);
  return hits[0];
}

type DiffRow = {
  kind: "content_differs" | "extra_in_live" | "missing_in_live";
  label: string;
  documentId?: string;
  backupSk: string;
  liveSk: string;
  backupEn: string;
  liveEn: string;
  backupMantra?: any;
};

function compareRow(backupM: any | undefined, liveM: any | undefined): DiffRow | null {
  const label =
    liveM?.ShlokaManthraNumber || backupM?.ShlokaManthraNumber || backupM?.documentId || "?";
  if (!backupM && liveM) {
    return {
      kind: "extra_in_live",
      label,
      documentId: liveM.documentId,
      backupSk: "",
      liveSk: blocksText(liveM.ShlokaManthraEntry?.SanskritTextEntry),
      backupEn: "",
      liveEn: blocksText(liveM.ShlokaManthraEntry?.EnglishTranslationText),
    };
  }
  if (backupM && !liveM) {
    return {
      kind: "missing_in_live",
      label,
      documentId: backupM.documentId,
      backupSk: blocksText(backupM.ShlokaManthraEntry?.SanskritTextEntry),
      liveSk: "",
      backupEn: blocksText(backupM.ShlokaManthraEntry?.EnglishTranslationText),
      liveEn: "",
      backupMantra: backupM,
    };
  }
  if (!backupM || !liveM) return null;

  const backupSk = blocksText(backupM.ShlokaManthraEntry?.SanskritTextEntry);
  const liveSk = blocksText(liveM.ShlokaManthraEntry?.SanskritTextEntry);
  const backupEn = blocksText(backupM.ShlokaManthraEntry?.EnglishTranslationText);
  const liveEn = blocksText(liveM.ShlokaManthraEntry?.EnglishTranslationText);

  if (backupSk !== liveSk || backupEn !== liveEn) {
    return {
      kind: "content_differs",
      label,
      documentId: liveM.documentId,
      backupSk,
      liveSk,
      backupEn,
      liveEn,
      backupMantra: backupM,
    };
  }
  return null;
}

async function restoreFromBackup(liveDocId: string, backupM: any): Promise<void> {
  const entry = backupM.ShlokaManthraEntry;
  const payload = {
    data: {
      ShlokaManthraNumber: backupM.ShlokaManthraNumber,
      ShlokaManthraEntry: entry
        ? {
            SanskritTextEntry: entry.SanskritTextEntry ?? textToBlocks(blocksText(entry.SanskritTextEntry)),
            EnglishTranslationText:
              entry.EnglishTranslationText ?? textToBlocks(blocksText(entry.EnglishTranslationText)),
            OtherTranslations: entry.OtherTranslations ?? [],
          }
        : undefined,
    },
  };
  curl(`/api/manthras/${liveDocId}`, "PUT", payload);
}

async function main() {
  const { granthaQuery, backupId, execute, suffixFilter, documentIds } = parseArgs();
  if (!STRAPI_TOKEN) {
    console.error("STRAPI_API_TOKEN required");
    process.exit(1);
  }

  const backup = await loadBackup(backupId);
  const grantha = findGrantha(backup, granthaQuery);
  const gDocId = grantha.documentId as string;
  console.log(`Backup #${backupId}: ${grantha.GranthaName} (${gDocId})`);

  const sectionIds = new Set(
    backup.sections.filter((s) => s.grantha?.documentId === gDocId).map((s) => s.documentId as string),
  );
  const backupMantras = backup.manthras.filter((m) =>
    sectionIds.has(m.Section?.documentId ?? m.section?.documentId ?? ""),
  );
  const liveMantras = await fetchLiveMantras(gDocId);
  console.log(`Backup mantras: ${backupMantras.length}, Live mantras: ${liveMantras.length}\n`);

  const backupByDocId = new Map(backupMantras.map((m) => [m.documentId, m]));
  const backupBySuffix = new Map<string, any>();
  for (const m of backupMantras) {
    const s = mantraSuffix(m.ShlokaManthraNumber);
    if (s) backupBySuffix.set(s, m);
  }

  const liveByDocId = new Map(liveMantras.map((m) => [m.documentId, m]));
  const diffs: DiffRow[] = [];

  for (const live of liveMantras) {
    const suf = mantraSuffix(live.ShlokaManthraNumber);
    if (suffixFilter && suf !== suffixFilter) continue;
    const backupM = backupByDocId.get(live.documentId) ?? (suf ? backupBySuffix.get(suf) : undefined);
    const d = compareRow(backupM, live);
    if (d) diffs.push(d);
  }

  for (const backupM of backupMantras) {
    const suf = mantraSuffix(backupM.ShlokaManthraNumber);
    if (suffixFilter && suf !== suffixFilter) continue;
    if (!liveByDocId.has(backupM.documentId)) {
      const d = compareRow(backupM, undefined);
      if (d) diffs.push(d);
    }
  }

  const contentDiffers = diffs.filter((d) => d.kind === "content_differs");
  const extra = diffs.filter((d) => d.kind === "extra_in_live");
  const missing = diffs.filter((d) => d.kind === "missing_in_live");

  console.log(`Content differs: ${contentDiffers.length}`);
  console.log(`Extra in live (not in backup): ${extra.length}`);
  console.log(`Missing in live (only in backup): ${missing.length}\n`);

  for (const d of [...contentDiffers, ...extra].slice(0, 40)) {
    console.log(`--- ${d.label} [${d.kind}] ${d.documentId ?? ""} ---`);
    if (d.kind === "content_differs") {
      if (d.backupSk !== d.liveSk) {
        console.log("  SK backup:", d.backupSk.slice(0, 120));
        console.log("  SK live:  ", d.liveSk.slice(0, 120));
      }
      if (d.backupEn !== d.liveEn) {
        console.log("  EN backup:", d.backupEn.slice(0, 120));
        console.log("  EN live:  ", d.liveEn.slice(0, 120));
      }
    } else if (d.kind === "extra_in_live") {
      console.log("  SK:", d.liveSk.slice(0, 120));
      console.log("  EN:", d.liveEn.slice(0, 120));
    }
  }

  if (suffixFilter) {
    const one = contentDiffers.find((d) => mantraSuffix(d.label) === suffixFilter);
    if (one) {
      console.log("\nDetailed 1.11-style row:");
      console.log(JSON.stringify(one, null, 2));
    }
  }

  if (documentIds.length > 0 && execute) {
    console.log("\nRestoring by --document-id from backup...");
    let ok = 0;
    let fail = 0;
    for (const docId of documentIds) {
      const backupM = backupByDocId.get(docId);
      if (!backupM) {
        console.log(`  SKIP ${docId}: not in backup`);
        fail++;
        continue;
      }
      try {
        await restoreFromBackup(docId, backupM);
        console.log(`  OK  ${backupM.ShlokaManthraNumber} (${docId})`);
        ok++;
      } catch (e: unknown) {
        console.log(`  FAIL ${docId}:`, e instanceof Error ? e.message : e);
        fail++;
      }
    }
    console.log(`\nRestored: ${ok}, failed: ${fail}`);
    return;
  }

  if (!execute) {
    console.log(`\nRe-run with --execute to restore ${contentDiffers.length} content_differs row(s) from backup (by documentId).`);
    if (documentIds.length > 0) {
      console.log(`Or: --document-id <id> --execute to restore specific row(s) (e.g. relabel Mantra → Shloka).`);
    }
    return;
  }

  console.log("\nRestoring content_differs rows from backup...");
  let ok = 0;
  let fail = 0;
  for (const d of contentDiffers) {
    if (!d.documentId || !d.backupMantra) continue;
    try {
      await restoreFromBackup(d.documentId, d.backupMantra);
      console.log(`  OK  ${d.label}`);
      ok++;
    } catch (e: unknown) {
      console.log(`  FAIL ${d.label}:`, e instanceof Error ? e.message : e);
      fail++;
    }
  }
  console.log(`\nRestored: ${ok}, failed: ${fail}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
