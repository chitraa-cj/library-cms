/**
 * Entry point for the `cms-ocr-worker` pm2 app.
 *
 *   npm run worker:ocr          (dev, tsx)
 *   node dist/ocr-worker.cjs    (prod, built by script/build.ts)
 *
 * Nothing here serves HTTP. It claims OCR jobs from Postgres and transcribes them
 * through Hermex on the dedicated document profile (HERMEX_STRUCTURE_CHROME_PROFILE,
 * on HERMEX_STRUCTURE_DISPLAY), so a long OCR job never shares a process with the
 * web app. The web app queues jobs and NOTIFYs; this process LISTENs and also polls.
 */
import "../env"; // must be first: ./config reads process.env at module load
import { pool } from "../db";
import { ocrEngineAvailability } from "./availability";
import { ocrConfig } from "./config";
import { startOcrScheduler, stopOcrScheduler } from "./jobs";

function workerLog(tag: string, message: string): void {
  console.log(`[ocr-worker] ${tag}: ${message}`);
}

let shuttingDown = false;

/**
 * An OCR job can run for hours, so it is not waited out. The range in flight is
 * aborted (its browser closed), the job is handed back to the queue fenced on its
 * run token, and the next boot resumes it — finished pages are never redone.
 *
 * pm2's kill_timeout must stay above GRACE_MS plus the backstop below.
 */
const GRACE_MS = 20_000;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  workerLog("WORKER STOP", `${signal} received; no new claims, handing in-flight work back`);
  // Backstop: if the release wedges, still exit rather than block the deploy.
  setTimeout(() => {
    workerLog("WORKER STOP", "shutdown backstop elapsed — exiting");
    process.exit(0);
  }, GRACE_MS + 10_000).unref();
  try {
    await stopOcrScheduler({ graceMs: GRACE_MS });
  } catch (err: any) {
    workerLog("WORKER ERROR", `stop failed: ${err?.message ?? err}`);
  }
  await pool.end().catch(() => {});
  workerLog("WORKER STOP", "stopped");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// A rejected promise must never take the worker down — the scheduler has its own recovery.
process.on("unhandledRejection", (reason: any) => {
  workerLog("WORKER ERROR", `unhandled rejection: ${reason?.message ?? reason}`);
});

async function main(): Promise<void> {
  workerLog("WORKER START", `pid ${process.pid}, poll ${ocrConfig.pollMs}ms, stale after ${ocrConfig.staleAfterMs}ms`);
  const engine = await ocrEngineAvailability(true);
  if (engine.ok) workerLog("WORKER START", `Hermex ready (${engine.engineLabel})`);
  else {
    // Not fatal: jobs stay queued and the scheduler re-checks on every poll, so fixing
    // the profile or the display does not need a restart.
    workerLog("WORKER WARN", `Hermex not ready — jobs stay queued until it is: ${engine.problems.join(" ")}`);
  }
  for (const warning of engine.warnings) workerLog("WORKER WARN", warning);
  await startOcrScheduler();
  workerLog("WORKER READY", "waiting for OCR jobs");
}

/**
 * If startup fails (database down, schema not installable), exit non-zero so pm2
 * restarts the app on its own backoff instead of leaving an `online` process with
 * no scheduler running.
 */
void main().catch(async (err: any) => {
  workerLog("WORKER ERROR", `startup failed: ${err?.message ?? err}`);
  await stopOcrScheduler({ graceMs: 0 }).catch(() => undefined);
  await pool.end().catch(() => {});
  process.exit(1);
});
