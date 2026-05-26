/**
 * Restore missing ShlokaManthraEntry (and optionally BhashyamEntry) OtherTranslations
 * from an admin snapshot into live Strapi — merge-only (never overwrites existing langs).
 *
 * Use when Hermex warns "checkpoint marked done but Strapi still missing" while a snapshot
 * still has full translations (portal Restore only covers Teekas/Bhashyam by default).
 *
 * Usage:
 *   npx tsx script/restore-shloka-ot-from-backup.ts --backup-id 7 --grantha "Chandogya Upanishad" --suffix 1.1.7
 *   npx tsx script/restore-shloka-ot-from-backup.ts --backup-id 7 --grantha "Chandogya" --suffix 1.1.7 --execute
 *   npx tsx script/restore-shloka-ot-from-backup.ts --backup-id 7 --grantha "Chandogya" --min-backup-ot 35 --execute
 */
import "../server/env";
import { gunzipSync } from "node:zlib";
import { storage } from "../server/storage";
import { strapiRequest } from "../server/strapi";
import {
  filledLangs,
  MANTRA_FULL_QUERY,
  mergeTeekaEntry,
  stripEntryForPut,
} from "./lib/hermex-grantha-sync";
import {
  mantraSuffix,
  mergeMissingOtFromBackup,
  normalizeOtRows,
} from "./lib/restore-other-translations";

function decompressBackupData(raw: any): any {
  if (raw && raw._compressed === true && typeof raw.data === "string") {
    const buf = Buffer.from(raw.data, "base64");
    return JSON.parse(gunzipSync(buf).toString("utf8"));
  }
  if (raw?.data?.granthas) return raw.data;
  return raw;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let backupId = 0;
  let granthaQuery = "Chandogya Upanishad";
  let suffixFilter: string | undefined;
  let documentId: string | undefined;
  let execute = false;
  let minBackupOt = 30;
  let field: "shloka" | "bhashyam" | "both" = "shloka";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--backup-id" && args[i + 1]) backupId = parseInt(args[++i], 10);
    else if (args[i] === "--grantha" && args[i + 1]) granthaQuery = args[++i];
    else if (args[i] === "--suffix" && args[i + 1]) suffixFilter = args[++i];
    else if (args[i] === "--document-id" && args[i + 1]) documentId = args[++i];
    else if (args[i] === "--min-backup-ot" && args[i + 1]) minBackupOt = parseInt(args[++i], 10);
    else if (args[i] === "--field" && args[i + 1]) {
      const f = args[++i];
      if (f === "bhashyam" || f === "both" || f === "shloka") field = f;
    } else if (args[i] === "--execute") execute = true;
  }

  if (!backupId || Number.isNaN(backupId)) {
    console.error(
      "Usage: npx tsx script/restore-shloka-ot-from-backup.ts --backup-id <n> --grantha \"<name>\" [--suffix 1.1.7] [--execute]",
    );
    process.exit(1);
  }
  return { backupId, granthaQuery, suffixFilter, documentId, execute, minBackupOt, field };
}

async function fetchLiveMantra(docId: string): Promise<any> {
  const res = await strapiRequest(`/api/manthras/${docId}${MANTRA_FULL_QUERY}`);
  return res?.data ?? null;
}

async function listLiveMantrasForGrantha(granthaDocId: string): Promise<any[]> {
  const all: any[] = [];
  let page = 1;
  while (true) {
    const res = await strapiRequest(
      `/api/manthras?filters[Section][grantha][documentId][$eq]=${encodeURIComponent(granthaDocId)}` +
        `&fields[0]=documentId&fields[1]=ShlokaManthraNumber&pagination[pageSize]=100&pagination[page]=${page}`,
    );
    all.push(...(res?.data ?? []));
    if (page >= (res?.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  return all;
}

function findGranthaInBackup(granthas: any[], query: string) {
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const hits = granthas.filter((g) => re.test(g.GranthaName || ""));
  if (hits.length === 0) throw new Error(`No grantha matching "${query}" in backup`);
  return hits[0];
}

async function putMergedField(docId: string, fieldKey: "ShlokaManthraEntry" | "BhashyamEntry", merged: any) {
  const stripped = stripEntryForPut(merged);
  if (!stripped) return;
  await strapiRequest(`/api/manthras/${docId}`, {
    method: "PUT",
    body: JSON.stringify({ data: { [fieldKey]: stripped } }),
  });
}

async function main() {
  const { backupId, granthaQuery, suffixFilter, documentId, execute, minBackupOt, field } = parseArgs();

  const backup = await storage.getBackup(backupId);
  if (!backup) {
    console.error(`Backup #${backupId} not found in DATABASE_URL`);
    process.exit(1);
  }

  const bData = decompressBackupData(backup.data);
  const grantha = findGranthaInBackup(bData.granthas ?? [], granthaQuery);
  const gDocId = grantha.documentId as string;

  const sectionIds = new Set(
    (bData.sections ?? [])
      .filter((s: any) => s.grantha?.documentId === gDocId)
      .map((s: any) => s.documentId as string),
  );

  let backupMantras: any[] = (bData.manthras ?? []).filter((m: any) =>
    sectionIds.has(m.Section?.documentId ?? m.section?.documentId ?? ""),
  );

  if (documentId) {
    backupMantras = backupMantras.filter((m) => m.documentId === documentId);
  } else if (suffixFilter) {
    backupMantras = backupMantras.filter((m) => mantraSuffix(m.ShlokaManthraNumber) === suffixFilter);
  }

  console.log(`\n=== Restore OtherTranslations from snapshot #${backupId} ===`);
  console.log(`Grantha: ${grantha.GranthaName} (${gDocId})`);
  console.log(`Backup mantras in scope: ${backupMantras.length}`);
  console.log(`Field: ${field} | execute=${execute}\n`);

  const liveIndex = new Map(
    (await listLiveMantrasForGrantha(gDocId)).map((m) => [m.documentId, m]),
  );

  let wouldRestore = 0;
  let restored = 0;
  let skipped = 0;

  for (const bm of backupMantras) {
    const docId = bm.documentId as string;
    const label = bm.ShlokaManthraNumber || docId;
    const liveRef = liveIndex.get(docId);
    if (!liveRef) {
      console.log(`[skip] ${label} — not in live Strapi`);
      skipped++;
      continue;
    }

    const live = await fetchLiveMantra(docId);
    if (!live) {
      console.log(`[skip] ${label} — could not load live mantra`);
      skipped++;
      continue;
    }

    const plans: Array<{ key: "ShlokaManthraEntry" | "BhashyamEntry"; backupEntry: any; liveEntry: any }> = [];
    if (field === "shloka" || field === "both") {
      plans.push({
        key: "ShlokaManthraEntry",
        backupEntry: bm.ShlokaManthraEntry,
        liveEntry: live.ShlokaManthraEntry,
      });
    }
    if (field === "bhashyam" || field === "both") {
      plans.push({
        key: "BhashyamEntry",
        backupEntry: bm.BhashyamEntry,
        liveEntry: live.BhashyamEntry,
      });
    }

    for (const p of plans) {
      const backupOt = normalizeOtRows(p.backupEntry);
      if (backupOt.length < minBackupOt) continue;

      const liveCount = filledLangs(p.liveEntry).size;
      const backupCount = backupOt.length;
      const { merged, addedLangs } = mergeMissingOtFromBackup(p.liveEntry, p.backupEntry);

      if (addedLangs.length === 0) {
        console.log(
          `  ${label} ${p.key}: live ${liveCount}/43, backup ${backupCount} — no missing langs to merge`,
        );
        continue;
      }

      wouldRestore++;
      console.log(
        `[plan] ${label} ${p.key}: live ${liveCount}/43, backup ${backupCount} — would add: ${addedLangs.join(", ")}`,
      );

      if (!execute) continue;

      try {
        const payload =
          p.key === "ShlokaManthraEntry"
            ? mergeTeekaEntry(live.ShlokaManthraEntry ?? {}, merged)
            : mergeTeekaEntry(live.BhashyamEntry ?? {}, merged);
        await putMergedField(docId, p.key, payload);
        const after = await fetchLiveMantra(docId);
        const afterCount = filledLangs(after?.[p.key]).size;
        console.log(`  [ok] ${label} ${p.key}: ${liveCount} → ${afterCount} filled langs`);
        restored++;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`  [fail] ${label} ${p.key}: ${msg}`);
      }
    }
  }

  console.log(`\nDone. Planned: ${wouldRestore}, restored: ${restored}, skipped mantras: ${skipped}`);
  if (!execute && wouldRestore > 0) {
    console.log("Re-run with --execute to apply merges to Strapi.");
  }
  if (execute && restored > 0) {
    console.log(
      "Tip: clear the Hermex checkpoint chunk for this mantra or re-run hermex — Strapi should now skip re-translate for restored langs.",
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
