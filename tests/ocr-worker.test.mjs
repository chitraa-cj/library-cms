/**
 * cms-ocr-worker: OCR runs in its own process, never in the web app.
 * ===================================================================
 * Needs a THROWAWAY Postgres, exactly like test:ocr-structure-db (see its header):
 *
 *   TEST_DATABASE_URL=postgresql://test@127.0.0.1:55433/cmstest npm run test:ocr-worker
 *
 *   1. importing the OCR routes/jobs starts nothing (a child process exits on its own);
 *      only server/ocr/worker-main.ts starts the scheduler;
 *   2. in the web app: create, Retry and the maintenance purge only queue — nothing is
 *      claimed or sent;
 *   3. the worker finds a job by NOTIFY, and by polling when no NOTIFY arrives;
 *   4. two worker PROCESSES on one queue: every job is claimed exactly once;
 *   5. a dead run (stale heartbeat) is requeued and finished; retry limits hold;
 *   6. cancel from the web app stops the worker's run (NOTIFY) and fences it;
 *   7. SIGTERM: the worker stops claiming, hands its job back to the queue and exits;
 *      the real worker-main.ts boots, reports readiness and shuts down cleanly.
 *
 * The browser is a scripted session (setOcrSessionFactory); no Chrome, no Gemini.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = process.env.TEST_DATABASE_URL;
if (!target) {
  console.error("TEST_DATABASE_URL is not set — point it at a throwaway Postgres (see tests/ocr-structure-db.test.mjs).");
  process.exit(2);
}
const url = new URL(target);
if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || /ekatmadham|library|strapi/i.test(url.pathname)) {
  console.error(`Refusing to run against ${url.hostname}${url.pathname}: this suite writes and deletes rows.`);
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "ocr", "isha-scan.pdf");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-worker-"));
const PROFILE = path.join(tmp, "structure-profile");
fs.mkdirSync(PROFILE, { recursive: true });
fs.writeFileSync(path.join(PROFILE, ".setup_gemini"), "");

const ENV = {
  DATABASE_URL: target,
  DATABASE_SSL: "off",
  OCR_STORAGE_DIR: path.join(tmp, "store"),
  OCR_STALE_AFTER_MS: "15000",
  OCR_MAX_ATTEMPTS: "2",
  OCR_HERMEX_RETRY_BASE_MS: "250",
  HERMEX_STRUCTURE_CHROME_PROFILE: PROFILE,
  HERMEX_STRUCTURE_HEADLESS: "1",
  HERMEX_PYTHON: "python3",
};
Object.assign(process.env, ENV);
delete process.env.HERMEX_CHROME_PROFILE;
delete process.env.HERMEX_DIR;

const { pool } = await import("../server/db.ts");
const ocrJobs = await import("../server/ocr/jobs.ts");
const ocrStore = await import("../server/ocr/store.ts");

let PASS = 0;
const FAILURES = [];
function check(name, cond, detail = "") {
  if (cond) {
    PASS++;
    console.log(`  ok   ${name}`);
  } else {
    FAILURES.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (r) => r.rows ?? r;
async function until(fn, { timeoutMs = 30_000, every = 100 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}
const jobRow = async (id) => rows(await pool.query("select status, run_token, error from cms_ocr_jobs where id = $1", [id]))[0];
const chunkStates = async (id) => rows(await pool.query("select status, attempts from cms_ocr_job_chunks where job_id = $1 order by chunk_index", [id]));
const finished = (id) => until(async () => {
  const r = await jobRow(id);
  return r && ["done", "partial", "failed", "cancelled"].includes(r.status) ? r : null;
});
const newJob = (extra = {}) =>
  ocrJobs.createOcrJob({ userId: null, fileName: "worker-test.pdf", mimeType: "application/pdf", bytes: fs.readFileSync(FIXTURE), force: true, ...extra });

/** The scripted browser: answers in the marker format from the pages named in the prompt. */
let mode = "good";
let asks = 0;
let sessions = 0;
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new Error("cancelled"))), { once: true });
  });
}
ocrJobs.setOcrSessionFactory(async () => {
  sessions++;
  return {
    alive: true,
    async ask(prompt, opts) {
      asks++;
      const m = /pages? (\d+)(?:–(\d+))?/.exec(prompt);
      const start = Number(m[1]);
      if (mode === "unusable") return "I can't help with that.";
      const body = [];
      for (let p = start; p <= Number(m[2] ?? m[1]); p++) body.push(`=== PAGE ${p} ===`, `page ${p} text`);
      return "```text\n" + body.join("\n") + "\n=== END ===\n```";
    },
    async close() {},
  };
});

await ocrStore.ensureOcrSchema();
await pool.query("delete from cms_ocr_jobs where file_name = 'worker-test.pdf' or status in ('queued', 'running')");

// ── 1. import isolation ──────────────────────────────────────────────────────
console.log("\nimporting OCR code starts nothing");
{
  const probe = path.join(tmp, "import-probe.mts");
  fs.writeFileSync(
    probe,
    `const jobs = await import(${JSON.stringify(path.join(ROOT, "server/ocr/jobs.ts"))});
     await import(${JSON.stringify(path.join(ROOT, "server/ocr/routes.ts"))});
     await import(${JSON.stringify(path.join(ROOT, "server/structure/routes.ts"))});
     console.log("SCHEDULER=" + jobs.isOcrSchedulerRunning());`,
  );
  const started = Date.now();
  const out = await new Promise((resolve) => {
    // An unreachable database: anything that tried to claim would hang or fail loudly.
    const child = spawn(process.execPath, ["--import", "tsx", probe], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    child.stdout.on("data", (d) => (text += d));
    child.stderr.on("data", (d) => (text += d));
    const kill = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (code) => (clearTimeout(kill), resolve({ code, text })));
  });
  check("a process that imports the OCR routes and jobs exits on its own (no timer, no loop)", out.code === 0 && Date.now() - started < 20_000, out.text.slice(-300));
  check("…and its scheduler never started", /SCHEDULER=false/.test(out.text));
  check("…and it never touched the database", !/ECONNREFUSED|claim/i.test(out.text), out.text.slice(-300));

  const callers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ts$/.test(e.name) && /startOcrScheduler\(/.test(fs.readFileSync(p, "utf8"))) callers.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, "server"));
  check("only the worker entry point (and its definition) starts the scheduler", callers.sort().join() === "server/ocr/jobs.ts,server/ocr/worker-main.ts", callers.join());
  const routesTs = fs.readFileSync(path.join(ROOT, "server/routes.ts"), "utf8");
  check("the web app boot no longer reconciles or pumps OCR jobs", !/reconcileOcrJobsOnBoot|startOcrScheduler|ocr\/jobs";[\s\S]*pump\(/.test(routesTs) && /reconcileStructureJobsOnBoot\(\)/.test(routesTs));
  const ocrRoutes = fs.readFileSync(path.join(ROOT, "server/ocr/routes.ts"), "utf8");
  check("no OCR route calls pump()", !/\bpump\s*\(/.test(ocrRoutes));
}

// ── 2. the web app only queues ───────────────────────────────────────────────
console.log("\nthe web app only queues");
{
  asks = 0;
  sessions = 0;
  const { job } = await newJob();
  ocrJobs.pump(); // even an explicit pump is inert without the worker's scheduler
  await sleep(1_000);
  check("create: the job stays queued", (await jobRow(job.id)).status === "queued");
  await pool.query("update cms_ocr_jobs set status = 'partial' where id = $1", [job.id]);
  await pool.query("update cms_ocr_job_chunks set status = 'failed' where job_id = $1 and chunk_index = 1", [job.id]);
  const requeued = await ocrJobs.retryOcrJob(job.id);
  await sleep(1_000);
  check("Retry: requeues and stays queued", requeued === 3 && (await jobRow(job.id)).status === "queued", String(requeued));
  await ocrStore.purgeExpiredJobs();
  await sleep(500);
  check("purge: still queued", (await jobRow(job.id)).status === "queued");
  check("…no session opened, no page sent", sessions === 0 && asks === 0);
  await pool.query("delete from cms_ocr_jobs where id = $1", [job.id]);
}

// ── 3. discovery ─────────────────────────────────────────────────────────────
console.log("\nthe worker finds new jobs");
{
  // A poll far longer than the wait: only NOTIFY can wake it in time.
  await ocrJobs.startOcrScheduler({ pollMs: 120_000 });
  await sleep(300);
  const t0 = Date.now();
  const { job } = await newJob();
  const done = await finished(job.id);
  check("NOTIFY from job creation wakes the worker at once", done?.status === "done" && Date.now() - t0 < 10_000, `${done?.status} in ${Date.now() - t0}ms`);
  await ocrJobs.stopOcrScheduler({ graceMs: 1_000 });

  // No LISTEN at all: the poll alone must find a job queued behind its back.
  await ocrJobs.startOcrScheduler({ pollMs: 300, listen: false });
  const { job: polled } = await newJob();
  check("with NOTIFY unavailable, polling finds the job", (await finished(polled.id))?.status === "done");

  // Retry limits are unchanged: an answer that stays unusable costs OCR_MAX_ATTEMPTS requests.
  mode = "unusable";
  asks = 0;
  const { job: bad } = await newJob();
  const badDone = await finished(bad.id);
  mode = "good";
  const states = await chunkStates(bad.id);
  check("an always-unusable range fails after exactly OCR_MAX_ATTEMPTS (2) requests", badDone?.status === "failed" && states.every((c) => c.status === "failed" && c.attempts === 2) && asks === 6, `${badDone?.status} ${JSON.stringify(states)} asks=${asks}`);

  // A run that died (stale heartbeat, token still set) is requeued and finished.
  const { job: stale } = await newJob();
  await ocrJobs.stopOcrScheduler({ graceMs: 1_000 });
  await pool.query("update cms_ocr_jobs set status = 'done' where status = 'queued' and id <> $1", [stale.id]);
  await pool.query(
    "update cms_ocr_jobs set status = 'running', run_token = 'dead-run', heartbeat_at = now() - interval '1 hour' where id = $1",
    [stale.id],
  );
  await pool.query("update cms_ocr_job_chunks set status = 'running' where job_id = $1 and chunk_index = 0", [stale.id]);
  await ocrJobs.startOcrScheduler({ pollMs: 300, listen: false });
  const recovered = await finished(stale.id);
  check("a dead run's job is requeued by the stale sweep and finished", recovered?.status === "done" && recovered.run_token === null, JSON.stringify(recovered));
  await ocrJobs.stopOcrScheduler({ graceMs: 1_000 });

  // A job and its ranges commit together: a failure inserting a range leaves no job behind.
  const atomicId = "atomic-" + Date.now();
  let atomicErr = null;
  try {
    await ocrStore.insertJobWithChunks(
      { id: atomicId, userId: null, fileName: "worker-test.pdf", mimeType: "application/pdf", fileSize: 1, pageCount: 2, chunkSize: 1, quality: "fast", model: "t", status: "queued", chunksTotal: 2 },
      [0, 0].map((i) => ({ jobId: atomicId, chunkIndex: i, startPage: 1, endPage: 1, status: "queued" })), // duplicate index
    );
  } catch (e) {
    atomicErr = e;
  }
  check("job + ranges are one transaction: a failed range insert leaves no claimable job", atomicErr != null && (await jobRow(atomicId)) == null);

  // Belt and braces: a queued job with no ranges is never reported done.
  const emptyId = "empty-" + Date.now();
  await ocrStore.insertJob({ id: emptyId, userId: null, fileName: "worker-test.pdf", mimeType: "application/pdf", fileSize: 1, pageCount: 1, chunkSize: 1, quality: "fast", model: "t", status: "queued", chunksTotal: 1 });
  await ocrJobs.startOcrScheduler({ pollMs: 300, listen: false });
  const empty = await finished(emptyId);
  check("a claimed job with no ranges fails with a reason instead of finishing as done", empty?.status === "failed" && /no page ranges/.test(empty.error ?? ""), JSON.stringify(empty));
  await ocrJobs.stopOcrScheduler({ graceMs: 1_000 });

  // After stop, nothing more is claimed.
  const { job: after } = await newJob();
  await sleep(1_200);
  check("a stopped scheduler claims nothing", (await jobRow(after.id)).status === "queued");
  await pool.query("delete from cms_ocr_jobs where id = $1", [after.id]);
}

// ── worker processes ─────────────────────────────────────────────────────────
const CHILD = path.join(tmp, "child-worker.mts");
fs.writeFileSync(
  CHILD,
  `const jobs = await import(${JSON.stringify(path.join(ROOT, "server/ocr/jobs.ts"))});
   const { pool } = await import(${JSON.stringify(path.join(ROOT, "server/db.ts"))});
   const delay = Number(process.env.CHILD_DELAY_MS || 0);
   jobs.setOcrSessionFactory(async () => ({
     alive: true,
     async ask(prompt, opts) {
       const m = /pages? (\\d+)(?:–(\\d+))?/.exec(prompt);
       console.log("ASK " + m[1]);
       await new Promise((resolve, reject) => {
         const t = setTimeout(resolve, delay);
         opts.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("cancelled")); }, { once: true });
       });
       return "\`\`\`text\\n=== PAGE " + m[1] + " ===\\npage " + m[1] + " text\\n=== END ===\\n\`\`\`";
     },
     async close() {},
   }));
   process.on("SIGTERM", async () => {
     const r = await jobs.stopOcrScheduler({ graceMs: 5000 });
     console.log("STOPPED " + JSON.stringify(r));
     await pool.end();
     process.exit(0);
   });
   await jobs.startOcrScheduler({ pollMs: Number(process.env.CHILD_POLL_MS || 200) });
   console.log("READY");`,
);
function startChild(env = {}, script = CHILD) {
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: ROOT,
    env: { ...process.env, ...ENV, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.out = "";
  child.stdout.on("data", (d) => (child.out += d));
  child.stderr.on("data", (d) => (child.out += d));
  child.exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  return child;
}

// ── 4. two worker processes, one queue ───────────────────────────────────────
console.log("\ntwo worker processes on one queue");
{
  const a = startChild({ CHILD_DELAY_MS: "50" });
  const b = startChild({ CHILD_DELAY_MS: "50" });
  await until(async () => /READY/.test(a.out) && /READY/.test(b.out));
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push((await newJob()).job.id);
  const all = await until(async () => {
    const r = rows(await pool.query("select count(*)::int as n from cms_ocr_jobs where id = any($1) and status = 'done'", [ids]));
    return r[0].n === ids.length;
  }, { timeoutMs: 60_000 });
  check("both workers drain the queue", !!all);
  const claims = (a.out + b.out).match(/claimed job [0-9a-f-]+/g) ?? [];
  const perJob = ids.map((id) => claims.filter((c) => c.endsWith(id)).length);
  check("every job was claimed exactly once across the two processes", perJob.every((n) => n === 1), perJob.join());
  check("…and both processes did work", /claimed job/.test(a.out) && /claimed job/.test(b.out));
  a.kill("SIGTERM");
  b.kill("SIGTERM");
  check("both exit cleanly on SIGTERM", (await a.exited) === 0 && (await b.exited) === 0);
}

// ── 5. cancel from the web app ───────────────────────────────────────────────
console.log("\ncancel from the web app reaches the worker");
{
  const w = startChild({ CHILD_DELAY_MS: "20000" });
  await until(async () => /READY/.test(w.out));
  const { job } = await newJob();
  await until(async () => /ASK 1/.test(w.out));
  const t0 = Date.now();
  check("cancel (as the route calls it) succeeds", await ocrJobs.cancelOcrJob(job.id));
  const stopped = await until(async () => /cancelled from the web app/.test(w.out), { timeoutMs: 10_000 });
  check("the worker stops the run promptly via NOTIFY, not at its next heartbeat", !!stopped && Date.now() - t0 < 5_000, `${Date.now() - t0}ms`);
  await sleep(500);
  const row = await jobRow(job.id);
  const states = await chunkStates(job.id);
  check("the job stays cancelled with its token void", row.status === "cancelled" && row.run_token === null, JSON.stringify(row));
  check("no page was stored or left running by the stopped run", states.every((c) => c.status === "queued"), JSON.stringify(states));
  w.kill("SIGTERM");
  await w.exited;
  await pool.query("delete from cms_ocr_jobs where id = $1", [job.id]);
}

// ── 6. graceful shutdown ─────────────────────────────────────────────────────
console.log("\nSIGTERM hands the job back");
{
  const w = startChild({ CHILD_DELAY_MS: "20000" });
  await until(async () => /READY/.test(w.out));
  const { job } = await newJob();
  await until(async () => /ASK 1/.test(w.out));
  const t0 = Date.now();
  w.kill("SIGTERM");
  const code = await w.exited;
  check("the worker exits 0 well inside pm2's kill_timeout", code === 0 && Date.now() - t0 < 15_000, `code ${code} after ${Date.now() - t0}ms`);
  check("it reports the job it handed back", new RegExp(`STOPPED .*${job.id}`).test(w.out), w.out.slice(-300));
  const row = await jobRow(job.id);
  const states = await chunkStates(job.id);
  check("the job is queued again with no owner — the next boot resumes it at once", row.status === "queued" && row.run_token === null, JSON.stringify(row));
  check("…and no page is left 'running'", states.every((c) => c.status === "queued"), JSON.stringify(states));

  // The real entry point: boots, reports readiness and shuts down cleanly. It has no
  // scripted session, so nothing may be queued for it (it would launch a real browser).
  await ocrJobs.cancelOcrJob(job.id);
  const real = startChild({ OCR_WORKER_POLL_MS: "500" }, path.join(ROOT, "server/ocr/worker-main.ts"));
  const ready = await until(async () => /WORKER READY/.test(real.out), { timeoutMs: 20_000 });
  check("worker-main.ts starts and reports Hermex readiness", !!ready && /Hermex (ready|not ready)/.test(real.out), real.out.slice(-400));
  real.kill("SIGTERM");
  const realCode = await real.exited;
  check("worker-main.ts exits 0 on SIGTERM after stopping its scheduler", realCode === 0 && /WORKER STOP.*stopped/s.test(real.out), real.out.slice(-400));
  check("…it never served HTTP", !/listening|serving on port/i.test(real.out));
  await pool.query("delete from cms_ocr_jobs where file_name = 'worker-test.pdf'");
}

ocrJobs.setOcrSessionFactory(null);
await pool.end();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${PASS} passed, ${FAILURES.length} failed`);
if (FAILURES.length > 0) {
  for (const f of FAILURES) console.error(` - ${f}`);
  process.exit(1);
}
process.exit(0);
