/**
 * Hermex (headless) → translate missing OtherTranslations for ALL mantras in a grantha.
 * Resumable via checkpoint file; retries on Chrome/Gemini failures.
 *
 * Usage:
 *   HERMEX_PYTHON=.venv-hermex/bin/python3 npm run hermex:grantha -- "Chandogya Upanishad"
 *   npm run hermex:grantha -- "Chandogya" --mantra "1.1.1"
 *   npm run hermex:grantha -- "Chandogya Upanishad" --dry-run
 *   npm run hermex:grantha -- "Chandogya Upanishad" --reset-checkpoint
 *   npm run hermex:grantha -- "Chandogya Upanishad" --headed
 */
import "../server/env";
import path from "node:path";
import {
  buildJobsForMantra,
  fetchMantraFull,
  listMantrasForGrantha,
  loadCheckpoint,
  printMantraSummary,
  resolveGranthaByName,
  saveCheckpoint,
  slugify,
  translateJobIncremental,
  type CheckpointFile,
  type RunOptions,
} from "./lib/hermex-grantha-sync";

function parseArgs(argv: string[]): {
  granthaName: string;
  mantraFilter?: string;
  dryRun: boolean;
  headed: boolean;
  resetCheckpoint: boolean;
} {
  const args = argv.filter((a) => !a.startsWith("-"));
  const flags = new Set(argv.filter((a) => a.startsWith("-")));
  let granthaName = "";
  let mantraFilter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--grantha" && args[i + 1]) {
      granthaName = args[++i];
    } else if (args[i] === "--mantra" && args[i + 1]) {
      mantraFilter = args[++i];
    } else if (!granthaName && !args[i].startsWith("--")) {
      granthaName = args[i];
    }
  }
  if (!granthaName) {
    granthaName = process.env.HERMEX_GRANTHA_NAME?.trim() || "";
  }
  if (!granthaName) {
    console.error(
      "Usage: npm run hermex:grantha -- \"<Grantha Name>\" [--mantra 1.1.1] [--dry-run] [--headed] [--reset-checkpoint]",
    );
    process.exit(1);
  }
  return {
    granthaName,
    mantraFilter,
    dryRun: flags.has("--dry-run"),
    headed: flags.has("--headed"),
    resetCheckpoint: flags.has("--reset-checkpoint"),
  };
}

async function main() {
  const { granthaName, mantraFilter, dryRun, headed, resetCheckpoint } = parseArgs(process.argv.slice(2));

  const grantha = await resolveGranthaByName(granthaName);
  const checkpointPath = path.join(
    process.cwd(),
    "logs",
    "hermex-checkpoints",
    `${slugify(grantha.GranthaName)}.json`,
  );

  const opts: RunOptions = {
    headless: !headed,
    chunkSize: parseInt(process.env.HERMEX_CHUNK_SIZE || "3", 10) || 3,
    chunkDelayMs: parseInt(process.env.HERMEX_CHUNK_DELAY_MS || "8000", 10) || 8000,
    maxRetries: parseInt(process.env.HERMEX_MAX_RETRIES || "3", 10) || 3,
    dryRun,
    checkpointPath,
    resetCheckpoint,
  };

  let checkpoint: CheckpointFile = {
    granthaDocumentId: grantha.documentId,
    granthaName: grantha.GranthaName,
    updatedAt: new Date().toISOString(),
    completedChunks: [],
    failedChunks: {},
    stats: { ok: 0, fail: 0, mantrasDone: 0 },
  };

  if (!resetCheckpoint) {
    const existing = loadCheckpoint(checkpointPath);
    if (existing && existing.granthaDocumentId === grantha.documentId) {
      checkpoint = existing;
      console.log(`[checkpoint] Resuming from ${checkpointPath} (${checkpoint.completedChunks.length} chunks done)`);
    }
  } else {
    console.log(`[checkpoint] Reset ${checkpointPath}`);
  }

  console.log(`\n=== Hermex grantha translate → Strapi ===`);
  console.log(`Grantha: ${grantha.GranthaName} (${grantha.documentId})`);
  console.log(`Checkpoint: ${checkpointPath}`);
  console.log(`headless=${opts.headless} chunk=${opts.chunkSize} delay=${opts.chunkDelayMs}ms retries=${opts.maxRetries}\n`);

  let mantras = await listMantrasForGrantha(grantha.documentId);
  console.log(`[plan] ${mantras.length} mantras in Strapi`);

  if (mantraFilter) {
    const f = mantraFilter.toLowerCase();
    mantras = mantras.filter(
      (m) =>
        m.label.toLowerCase().includes(f) ||
        m.documentId === mantraFilter,
    );
    console.log(`[plan] Filter --mantra "${mantraFilter}" → ${mantras.length} mantras`);
    if (!mantras.length) {
      console.error("No mantras match filter");
      process.exit(1);
    }
  }

  if (dryRun) {
    let totalJobs = 0;
    for (const m of mantras.slice(0, 5)) {
      const full = await fetchMantraFull(m.documentId);
      const jobs = buildJobsForMantra(full, m.label, grantha.GranthaName);
      totalJobs += jobs.length;
      console.log(`[dry-run] ${m.label}: ${jobs.length} job(s)`);
    }
    if (mantras.length > 5) {
      console.log(`[dry-run] ... and ${mantras.length - 5} more mantras`);
    }
    return;
  }

  saveCheckpoint(checkpointPath, checkpoint);

  for (let mi = 0; mi < mantras.length; mi++) {
    const m = mantras[mi];
    console.log(`\n[mantra ${mi + 1}/${mantras.length}] ${m.label} (${m.documentId})`);

    let mantra: any;
    try {
      mantra = await fetchMantraFull(m.documentId);
    } catch (e: unknown) {
      console.error(`[skip] Could not fetch mantra: ${e instanceof Error ? e.message : e}`);
      continue;
    }

    const jobs = buildJobsForMantra(mantra, m.label, grantha.GranthaName);
    if (!jobs.length) {
      console.log(`[skip] No missing translations (or no English source)`);
      checkpoint.stats.mantrasDone++;
      saveCheckpoint(checkpointPath, checkpoint);
      continue;
    }

    console.log(`[plan] ${jobs.length} translation job(s) for this mantra`);

    for (const job of jobs) {
      const { ok, fail } = await translateJobIncremental(job, opts, checkpoint);
      checkpoint.stats.ok += ok;
      checkpoint.stats.fail += fail;
      saveCheckpoint(checkpointPath, checkpoint);
    }

    try {
      const verify = await fetchMantraFull(m.documentId);
      printMantraSummary(verify, m.label);
    } catch (e: unknown) {
      console.warn(`[strapi] Could not verify mantra ${m.label}: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
    }
    checkpoint.stats.mantrasDone++;
    saveCheckpoint(checkpointPath, checkpoint);
  }

  console.log("\n=== Grantha complete ===");
  console.log(`Mantras processed: ${checkpoint.stats.mantrasDone}/${mantras.length}`);
  console.log(`Translations OK: ${checkpoint.stats.ok}, failed: ${checkpoint.stats.fail}`);
  console.log(`Checkpoint chunks done: ${checkpoint.completedChunks.length}`);
  const failedKeys = Object.keys(checkpoint.failedChunks);
  if (failedKeys.length) {
    console.log(`Failed chunks (${failedKeys.length}) — re-run to retry:`);
    for (const k of failedKeys.slice(0, 10)) {
      console.log(`  ${k}: ${checkpoint.failedChunks[k].slice(0, 80)}`);
    }
    if (failedKeys.length > 10) console.log(`  ... +${failedKeys.length - 10} more`);
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
