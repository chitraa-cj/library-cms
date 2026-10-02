/**
 * Entry point for the `cms-publish-worker` pm2 app.
 *
 *   npm run worker:publish        (dev, tsx)
 *   node dist/publish-worker.cjs  (prod, built by script/build.ts)
 *
 * Nothing here serves HTTP. It claims grantha publish jobs from Postgres and runs them, so
 * the web process never spends minutes of event loop on a publish.
 */
import "../env"; // must be first: ./config reads process.env at module load
import { pool } from "../db";
import { publishConfig } from "./config";
import { releaseInFlight, runWorker, workerLog } from "./worker";

const controller = new AbortController();
let shuttingDown = false;

/**
 * A publish runs for many minutes, so unlike the translation worker we do NOT try to let
 * the current job finish. We hand it back unclaimed — without spending an attempt, since a
 * deploy is not a failure — and exit. The next boot re-claims it, and the per-mantra
 * resolution checkpoint means the work already done is not repeated.
 *
 * pm2's kill_timeout must stay above the grace period below.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  workerLog("WORKER RESTART", `${signal} received; releasing in-flight work`);
  controller.abort();
  try {
    await releaseInFlight(`Publish worker received ${signal}; requeued automatically.`);
  } catch (err: any) {
    workerLog("WORKER ERROR", `release on shutdown failed: ${err?.message ?? err}`);
  }
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// A rejected promise must never take the worker down — the loop has its own recovery.
process.on("unhandledRejection", (reason: any) => {
  workerLog("WORKER ERROR", `unhandled rejection: ${reason?.message ?? reason}`);
});

// Backstop: if the release above wedges, still exit rather than block the deploy.
setTimeout(() => {
  if (shuttingDown) process.exit(0);
}, 10_000).unref();

async function main(): Promise<void> {
  workerLog("WORKER START", `publish worker booting as ${publishConfig.workerId}`);
  try {
    await runWorker({ signal: controller.signal });
  } finally {
    await pool.end().catch(() => {});
  }
}

void main();
