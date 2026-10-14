#!/usr/bin/env node --import tsx
/**
 * A database that is unreachable at BOOT must not take a worker out of service.
 * ============================================================================
 * The incident this locks in (cms-publish-worker, 08:30 on 2026-10-14):
 *
 *   Error: connect ECONNREFUSED 172.31.8.189:5432
 *       at async requeueOwnedJobs (dist/publish-worker.cjs)
 *       at async reconcileOnBoot (dist/publish-worker.cjs)
 *
 * `reconcileOnBoot` was awaited OUTSIDE the worker loop, so that rejection escaped
 * `runWorker`, the `finally` in `main()` closed the pool, and the process-level
 * unhandledRejection handler kept the process alive. pm2 reported `online` while
 * nothing claimed, heartbeat or reaped — and because the API refuses to enqueue without a
 * recent heartbeat, every Save & Publish answered "the publish worker is not running"
 * until a human restarted it.
 *
 * No database is needed to prove it: DATABASE_URL points at a closed port, which is the
 * same ECONNREFUSED the RDS address gave.
 *
 * Run: node --import tsx tests/worker-boot-resilience.test.mjs
 */

// Must be set before server/db.ts is imported — it reads DATABASE_URL at module load.
process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:59999/nothing";
process.env.DATABASE_SSL = "false";
process.env.PUBLISH_POLL_INTERVAL = "1000";
process.env.WORKER_POLL_INTERVAL = "1000";

let PASS = 0;
const FAILURES = [];
function check(name, cond, detail = "") {
  if (cond) {
    PASS++;
    console.log(`  ok  ${name}`);
  } else {
    FAILURES.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Collect what the worker logged, so we can assert it SAID why it is waiting. */
function captureLogs() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.join(" "));
  };
  return {
    lines,
    restore() {
      console.log = original;
    },
  };
}

const { runWorker: runPublishWorker } = await import("../server/publish/worker.ts");
const { runWorker: runTranslationWorker } = await import("../server/translation/worker.ts");

// ── 1. the publish worker ───────────────────────────────────────────────────
console.log("\npublish worker, database refusing connections");
{
  const capture = captureLogs();
  let rejected = null;
  try {
    // exitWhenIdle makes the loop return after one pass instead of polling forever.
    await runPublishWorker({ workerId: "test-worker", exitWhenIdle: true });
  } catch (err) {
    rejected = err;
  } finally {
    capture.restore();
  }

  check(
    "runWorker resolves instead of rejecting out of the process",
    rejected === null,
    rejected ? `threw ${rejected?.message}` : "",
  );
  check(
    "the reason is logged, not swallowed",
    capture.lines.some((l) => /WORKER ERROR/.test(l) && /ECONNREFUSED/i.test(l)),
    capture.lines.join(" | ").slice(0, 200),
  );
  check(
    'it does NOT claim to be "ready" when it never reconciled',
    !capture.lines.some((l) => /ready \(poll/.test(l)),
  );
}

// ── 2. it keeps trying, and the loop survives ───────────────────────────────
console.log("\npublish worker, polling while the database stays down");
{
  const capture = captureLogs();
  const controller = new AbortController();
  // Long enough for several poll cycles, then abort — a live loop ends on the signal.
  const timer = setTimeout(() => controller.abort(), 2_500);
  let rejected = null;
  try {
    await runPublishWorker({ workerId: "test-worker", signal: controller.signal });
  } catch (err) {
    rejected = err;
  } finally {
    clearTimeout(timer);
    capture.restore();
  }

  const attempts = capture.lines.filter((l) => /WORKER ERROR/.test(l)).length;
  check("the loop survives a database that never comes back", rejected === null);
  check("and retries rather than giving up after the first failure", attempts >= 2, `${attempts} attempt(s)`);
  check("it stops when the signal aborts", controller.signal.aborted);
}

// ── 3. the translation worker has the same shape ────────────────────────────
console.log("\ntranslation worker, database refusing connections");
{
  const capture = captureLogs();
  let rejected = null;
  try {
    await runTranslationWorker({ workerId: "test-worker", exitWhenIdle: true });
  } catch (err) {
    rejected = err;
  } finally {
    capture.restore();
  }

  check(
    "runWorker resolves instead of rejecting out of the process",
    rejected === null,
    rejected ? `threw ${rejected?.message}` : "",
  );
  check(
    "the reason is logged",
    capture.lines.some((l) => /WORKER ERROR/.test(l)),
    capture.lines.join(" | ").slice(0, 200),
  );
}

console.log(`\n${PASS} passed, ${FAILURES.length} failed`);
if (FAILURES.length > 0) {
  for (const failure of FAILURES) console.error(` - ${failure}`);
  process.exit(1);
}
process.exit(0);
