/**
 * The ONE place the queue touches Hermex.
 *
 * Everything Gemini-shaped stays behind `translateMantra()`. The worker knows
 * nothing about Chrome, chunk sizes or Strapi merges — it claims a row, calls
 * this, and records what came back. Swapping the translation backend later means
 * replacing this file and nothing else.
 *
 * No new Gemini integration is created here: this delegates to the existing
 * pipeline in script/lib/hermex-grantha-sync.ts, the same code the local
 * `npm run hermex:grantha` CLI has always used (fetch the mantra, work out which
 * languages are missing, drive Gemini through Hermex, merge-safe write-back to
 * Strapi). The only thing the server replaces is the *driver*: a Postgres queue
 * instead of a checkpoint file and a human watching a terminal.
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildJobsForMantra,
  fetchMantraFull,
  loadCheckpoint,
  saveCheckpoint,
  translateJobIncremental,
  type CheckpointFile,
  type RunOptions,
  type TranslateJob,
} from "../../script/lib/hermex-grantha-sync";
import { hermexEnabled } from "../hermex-translate";
import { translationConfig } from "./config";

export interface TranslateMantraInput {
  jobId: string;
  mantraDocId: string;
  mantraLabel: string;
  granthaName: string;
  /** Empty = every language still missing on the mantra. */
  targetLanguages: string[];
  /** Aborts between field units; a unit already in flight is allowed to finish. */
  signal?: AbortSignal;
}

export interface TranslateMantraResult {
  /** Language-writes that landed. */
  ok: number;
  /** Language-writes that did not. */
  failed: number;
  /** One line per field unit, stored on the item for the admin UI. */
  summary: string;
  /** Field units the mantra was expanded into (Shloka / Bhashyam / each Teeka). */
  units: number;
}

/** Where a job's inner (field × language-group) resume state lives. */
function checkpointPathForJob(jobId: string): string {
  const dir = path.join(process.cwd(), "logs", "hermex-checkpoints");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `job-${jobId}.json`);
}

function runOptionsForJob(jobId: string): RunOptions {
  return {
    headless: translationConfig.headless,
    chunkSize: translationConfig.chunkSize,
    chunkDelayMs: translationConfig.chunkDelayMs,
    maxRetries: translationConfig.hermexMaxRetries,
    dryRun: false,
    checkpointPath: checkpointPathForJob(jobId),
    resetCheckpoint: false,
  };
}

function loadJobCheckpoint(jobId: string, granthaDocId: string, granthaName: string): CheckpointFile {
  const file = checkpointPathForJob(jobId);
  const existing = loadCheckpoint(file);
  if (existing) return existing;
  return {
    granthaDocumentId: granthaDocId,
    granthaName,
    updatedAt: new Date().toISOString(),
    completedChunks: [],
    failedChunks: {},
    stats: { ok: 0, fail: 0, mantrasDone: 0 },
  };
}

/** Keep only the languages this job asked for (empty request = all missing). */
function narrowToRequested(job: TranslateJob, requested: string[]): TranslateJob {
  if (!requested.length) return job;
  const wanted = new Set(requested);
  return { ...job, targetLanguages: job.targetLanguages.filter((l) => wanted.has(l)) };
}

export class TranslationDisabledError extends Error {
  constructor() {
    super("Hermex is disabled on this server (HERMEX_ENABLED=0).");
    this.name = "TranslationDisabledError";
  }
}

/**
 * Translate ONE mantra: every field (Shloka, Bhashyam, each Teeka) that still has
 * languages missing, written straight back to Strapi as each one lands.
 *
 * Idempotent by construction. `translateJobIncremental` re-reads Strapi before
 * every language group (`filterLangsStillMissing`), so a mantra that was half
 * finished when the worker died resumes at the first language that is genuinely
 * absent — a re-run after a crash costs nothing for work already done.
 */
export async function translateMantra(input: TranslateMantraInput): Promise<TranslateMantraResult> {
  if (!hermexEnabled()) throw new TranslationDisabledError();

  const mantra = await fetchMantraFull(input.mantraDocId);
  if (!mantra) {
    throw new Error(`Mantra ${input.mantraDocId} was not found in the CMS.`);
  }

  const units = buildJobsForMantra(mantra, input.mantraLabel, input.granthaName)
    .map((unit) => narrowToRequested(unit, input.targetLanguages))
    .filter((unit) => unit.targetLanguages.length > 0);

  if (units.length === 0) {
    return { ok: 0, failed: 0, units: 0, summary: "Nothing missing — every requested language was already present." };
  }

  const opts = runOptionsForJob(input.jobId);
  const checkpoint = loadJobCheckpoint(input.jobId, mantra.documentId ?? "", input.granthaName);

  let ok = 0;
  let failed = 0;
  const lines: string[] = [];

  for (const unit of units) {
    if (input.signal?.aborted) {
      lines.push(`${unit.context}: skipped (worker shutting down)`);
      break;
    }
    const result = await translateJobIncremental(unit, opts, checkpoint);
    ok += result.ok;
    failed += result.fail;
    lines.push(
      `${unit.context}: ${result.ok} language(s) written` +
        (result.fail ? `, ${result.fail} failed` : ""),
    );
    saveCheckpoint(opts.checkpointPath, checkpoint);
  }

  if (failed > 0) {
    // Surfaces to the worker as a retryable failure; the languages that DID land
    // are already in Strapi and will be skipped on the next attempt.
    const err: any = new Error(
      `${failed} language(s) failed for ${input.mantraLabel}. ${lines.join(" | ")}`,
    );
    err.partial = { ok, failed, units: units.length, summary: lines.join("\n") };
    throw err;
  }

  return { ok, failed, units: units.length, summary: lines.join("\n") };
}
