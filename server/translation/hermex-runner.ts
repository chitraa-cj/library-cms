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
  fetchMantraFull,
  loadCheckpoint,
  saveCheckpoint,
  translateMantraPasses,
  type CheckpointFile,
  type RunOptions,
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
  /** Field units translated across both passes (Shloka / Bhashyam / each Teeka). */
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
 * Two passes, both inside this one item (see `translateMantraPasses`): a field
 * with no English first gets its Sanskrit original translated to English, and
 * only then is that English fanned out to the other languages. A field with
 * neither English nor Sanskrit has no source and is skipped.
 *
 * Idempotent by construction. `translateJobIncremental` re-reads Strapi before
 * every language group (`filterLangsStillMissing`), so a mantra that was half
 * finished when the worker died resumes at the first language that is genuinely
 * absent — a re-run after a crash costs nothing for work already done, and the
 * English pass becomes a no-op as soon as its English is in the CMS.
 */
export async function translateMantra(input: TranslateMantraInput): Promise<TranslateMantraResult> {
  if (!hermexEnabled()) throw new TranslationDisabledError();

  const mantra = await fetchMantraFull(input.mantraDocId);
  if (!mantra) {
    throw new Error(`Mantra ${input.mantraDocId} was not found in the CMS.`);
  }

  const opts = runOptionsForJob(input.jobId);
  const checkpoint = loadJobCheckpoint(input.jobId, mantra.documentId ?? "", input.granthaName);

  const result = await translateMantraPasses(
    mantra,
    input.mantraLabel,
    input.granthaName,
    opts,
    checkpoint,
    {
      requestedLanguages: input.targetLanguages,
      englishFirstPass: translationConfig.englishFirstPass,
      signal: input.signal,
    },
  );
  saveCheckpoint(opts.checkpointPath, checkpoint);

  const units = result.englishUnits + result.otherUnits;
  if (units === 0) {
    return { ok: 0, failed: 0, units: 0, summary: "Nothing missing — every requested language was already present." };
  }

  if (result.fail > 0) {
    // Surfaces to the worker as a retryable failure; the languages that DID land
    // are already in Strapi and will be skipped on the next attempt.
    const err: any = new Error(
      `${result.fail} language(s) failed for ${input.mantraLabel}. ${result.lines.join(" | ")}`,
    );
    err.partial = { ok: result.ok, failed: result.fail, units, summary: result.lines.join("\n") };
    throw err;
  }

  return { ok: result.ok, failed: result.fail, units, summary: result.lines.join("\n") };
}
