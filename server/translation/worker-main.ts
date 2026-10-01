/**
 * Translation worker process entry point.
 *
 *   dev   : npm run worker:translation
 *   prod  : pm2 start ecosystem.config.cjs --only cms-translation-worker
 *
 * Runs on its own, independent of the web server: starts with the box, survives
 * the admin closing their browser, and restarts automatically if it dies.
 */
import "../env";

import { pool } from "../db";
import { runWorker, workerLog } from "./worker";
import { translationConfig } from "./config";

const controller = new AbortController();
let shuttingDown = false;

/**
 * SIGTERM (pm2 restart/stop) aborts the loop. The item in flight is allowed to
 * finish its current field unit — killing Chrome mid-answer is how a half-written
 * translation happens — and anything still `processing` when the process goes is
 * recovered by its lease on the next boot.
 */
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  workerLog("WORKER RESTART", `${signal} received — finishing the current item, then exiting`);
  controller.abort();
  // Hard stop if the current item will not wind up in time; pm2's own kill
  // timeout should be set above this (see ecosystem.config.cjs).
  setTimeout(() => {
    workerLog("WORKER RESTART", "shutdown grace elapsed — exiting");
    process.exit(0);
  }, 30_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  // Never take the worker down for one bad promise: the loop already records
  // per-item failures, and pm2 restarting mid-mantra just costs a retry.
  workerLog("WORKER ERROR", `unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

async function main() {
  workerLog("JOB START", `starting worker ${translationConfig.workerId} (pid ${process.pid})`);
  try {
    await runWorker({ signal: controller.signal });
  } finally {
    await pool.end().catch(() => {});
    workerLog("WORKER RESTART", "worker stopped");
  }
}

void main();
