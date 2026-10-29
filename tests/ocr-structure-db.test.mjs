/**
 * OCR + OCR → Grantha against a REAL Postgres — job reliability and end to end.
 * =============================================================================
 * Needs a THROWAWAY database (it creates, updates and deletes rows):
 *
 *   initdb -D /tmp/pgdata -U test -A trust
 *   pg_ctl -D /tmp/pgdata -o "-p 55433 -k '' -c listen_addresses=127.0.0.1" start
 *   createdb -h 127.0.0.1 -p 55433 -U test cmstest
 *   DATABASE_URL=postgresql://test@127.0.0.1:55433/cmstest npx drizzle-kit push --force
 *   TEST_DATABASE_URL=postgresql://test@127.0.0.1:55433/cmstest npm run test:ocr-structure-db
 *
 * It refuses any database that is not on localhost, or whose name is a real one.
 *
 *   1. migrations: the new migration applies twice;
 *   2. ownership: concurrent claims, fenced writes from a stale run, stale-heartbeat
 *      recovery, release by a run that lost its job;
 *   3. OCR through the real router + the REAL local engine (skipped when Tesseract is
 *      not installed): text PDF uses no OCR; duplicate upload is reused; scanned PDF;
 *      persistence across reads; resume re-runs only the failed page; cancel; raw vs
 *      normalized downloads; bad uploads refused;
 *   4. OCR → Grantha through the real router with a SCRIPTED analyzer in place of Hermex
 *      (no browser, no account): estimate, run, duplicate submission, review edits with
 *      optimistic concurrency, approval gate, CSV fidelity, a malformed range retried
 *      without duplicating items, a setup failure that stops the job and resumes;
 *   5. translation's tables are untouched throughout.
 *
 * The real Hermex → Gemini leg is NOT exercised here (that needs a logged-in dedicated
 * profile); see docs/OCR-TO-GRANTHA.md, "Verifying on a server".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = process.env.TEST_DATABASE_URL;
if (!target) {
  console.error("TEST_DATABASE_URL is not set — point it at a throwaway Postgres (see the header).");
  process.exit(2);
}
const url = new URL(target);
if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || /ekatmadham|library|strapi/i.test(url.pathname)) {
  console.error(`Refusing to run against ${url.hostname}${url.pathname}: this suite writes and deletes rows.`);
  process.exit(2);
}
process.env.DATABASE_URL = target;
process.env.DATABASE_SSL = "off";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "ocr");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-db-"));
process.env.OCR_STORAGE_DIR = path.join(tmp, "store");
process.env.OCR_STALE_AFTER_MS = "15000";
// One page per structure range, so one range can fail on its own.
process.env.STRUCTURE_PAGES_PER_CHUNK = "1";
// A structure profile that passes the filesystem readiness check; the scripted
// analyzer below replaces the browser, so it is never opened.
const PROFILE = path.join(tmp, "structure-profile");
fs.mkdirSync(PROFILE, { recursive: true });
fs.writeFileSync(path.join(PROFILE, ".setup_gemini"), "");
process.env.HERMEX_STRUCTURE_CHROME_PROFILE = PROFILE;
process.env.HERMEX_STRUCTURE_HEADLESS = "1";
process.env.HERMEX_PYTHON = "python3";
delete process.env.HERMEX_CHROME_PROFILE;
delete process.env.HERMEX_DIR;

const { sql } = await import("drizzle-orm");
const { db, pool } = await import("../server/db.ts");
const lease = await import("../server/lib/job-lease.ts");
const ocrStore = await import("../server/ocr/store.ts");
const ocrJobs = await import("../server/ocr/jobs.ts");
const { ocrEngineAvailability } = await import("../server/ocr/availability.ts");
const structureStore = await import("../server/structure/store.ts");
const structureJobs = await import("../server/structure/jobs.ts");
const { StructureAnalysisError } = await import("../server/structure/analyzer.ts");
const { resolveLineAnswer, numberSourceLines } = await import("../shared/ocr-structure-lines.ts");
const express = (await import("express")).default;
const ocrRouter = (await import("../server/ocr/routes.ts")).default;
const structureRouter = (await import("../server/structure/routes.ts")).default;

let PASS = 0;
let SKIP = 0;
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
const skip = (name, why) => (SKIP++, console.log(`  SKIP ${name} — ${why}`));
const rows = (r) => r.rows ?? r;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeoutMs = 60_000, every = 150 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

// ── app, exactly as mounted in server/routes.ts (auth stubbed as an admin) ───
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use((req, _res, next) => {
  req.user = { id: null, role: "admin", username: "test" };
  next();
});
app.use("/api/admin/ocr/structure", structureRouter);
app.use("/api/admin/ocr", ocrRouter);
const server = app.listen(0);
const BASE = `http://127.0.0.1:${server.address().port}/api/admin/ocr`;
async function api(method, p, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body instanceof Buffer) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  const res = await fetch(`${BASE}${p}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}
const upload = (file, params = {}) =>
  api("POST", `/jobs?${new URLSearchParams({ fileName: path.basename(file), mimeType: "application/pdf", ...params })}`, fs.readFileSync(file));

// ── 1. migrations ────────────────────────────────────────────────────────────
console.log("\nmigrations");
await ocrStore.ensureOcrSchema();
// Leftovers from an earlier run of this suite (throwaway DB, but re-runnable).
await db.execute(sql`delete from cms_ocr_jobs where file_name in ('isha-text.pdf', 'isha-scan.pdf', 'x.pdf')`);
await structureStore.ensureStructureSchema();
const translationBefore = rows(await db.execute(sql`select (select count(*) from cms_translation_jobs)::int as j, (select count(*) from cms_translation_items)::int as i`))[0];
const migration = fs.readFileSync(path.join(ROOT, "script/migrations/20261029_local_ocr_and_job_leases.sql"), "utf8");
await pool.query(migration);
await pool.query(migration);
check("the local-OCR + lease migration applies, and applies again", true);
const cols = new Set(rows(await pool.query(`select table_name||'.'||column_name as c from information_schema.columns where table_name like 'cms_%_job%'`)).map((r) => r.c));
for (const c of ["cms_ocr_job_chunks.raw_text", "cms_ocr_job_chunks.pages_meta", "cms_ocr_jobs.text_mode", "cms_ocr_jobs.run_token", "cms_ocr_jobs.heartbeat_at", "cms_structure_jobs.run_token", "cms_structure_jobs.heartbeat_at"]) {
  check(`column ${c}`, cols.has(c));
}

// ── 2. ownership ─────────────────────────────────────────────────────────────
console.log("\njob ownership");
{
  await pool.query("delete from cms_ocr_jobs where id like 'lease-%'");
  await ocrStore.insertJob({ id: "lease-1", userId: null, fileName: "x.pdf", mimeType: "application/pdf", fileSize: 1, pageCount: 1, chunkSize: 1, quality: "fast", model: "t", status: "queued", chunksTotal: 1 });
  await ocrStore.insertChunks([{ jobId: "lease-1", chunkIndex: 0, startPage: 1, endPage: 1, status: "queued" }]);
  // Hold the other queued jobs (from nothing yet) out: claim only sees 'queued'.
  const claims = await Promise.all(Array.from({ length: 10 }, () => lease.claimNextJob(lease.OCR_TABLES)));
  const winners = claims.filter(Boolean);
  check("ten concurrent claims on one queued job: exactly one wins", winners.length === 1, String(winners.length));
  const token = winners[0].token;
  check("the winner can write its chunk", await ocrStore.markChunkRunning("lease-1", 0, token));
  check("a run with another token cannot", !(await ocrStore.markChunkRunning("lease-1", 0, "stale-token")));
  check("a live heartbeat keeps the job", await lease.heartbeat(lease.OCR_TABLES, "lease-1", token));
  check("a fresh heartbeat is not swept", !(await lease.requeueStaleJobs(lease.OCR_TABLES, 60_000)).includes("lease-1"));
  await pool.query("update cms_ocr_jobs set heartbeat_at = now() - interval '1 hour' where id = 'lease-1'");
  const swept = await lease.requeueStaleJobs(lease.OCR_TABLES, 60_000);
  check("a dead run's job is requeued", swept.includes("lease-1"));
  const after = rows(await pool.query("select j.status, j.run_token, c.status as chunk from cms_ocr_jobs j join cms_ocr_job_chunks c on c.job_id = j.id where j.id = 'lease-1'"))[0];
  check("…its in-flight chunk goes back to the queue and its token is void", after.status === "queued" && after.run_token === null && after.chunk === "queued", JSON.stringify(after));
  check("the dead run can no longer write anything", !(await ocrStore.writeChunkResult("lease-1", 0, token, { status: "done", markdown: "late", rawText: "late", pagesMeta: [], model: "x", attempts: 1, durationMs: 1 })));
  check("…nor release the job", !(await lease.releaseJob(lease.OCR_TABLES, "lease-1", token, sql`status = 'done'`)));
  check("…and its heartbeat reports the loss", !(await lease.heartbeat(lease.OCR_TABLES, "lease-1", token)));
  await pool.query("delete from cms_ocr_jobs where id = 'lease-1'");
}

// ── 3. OCR end to end ────────────────────────────────────────────────────────
console.log("\nOCR through the router, real engine");
const engine = await ocrEngineAvailability(true);
let textJobId = null;
if (!engine.ok) {
  skip("OCR end to end", engine.problems.join(" "));
} else {
  const health = await api("GET", "/health");
  check("health reports the local engine ready", health.status === 200 && health.json.ok);
  const cfg = await api("GET", "/config");
  check("config names the local engine, no provider model", cfg.json.configured && /tesseract/.test(cfg.json.engine.name) && !("models" in cfg.json));

  check("HEIC is refused (no local decoder)", (await api("POST", "/jobs?fileName=a.heic&mimeType=image/heic", Buffer.from("x"))).status === 415);
  check("an empty upload is refused", (await api("POST", "/jobs?fileName=a.pdf&mimeType=application/pdf", Buffer.alloc(0))).status === 400);
  const corrupt = await api("POST", "/jobs?fileName=bad.pdf&mimeType=application/pdf", Buffer.from("%PDF-1.4 garbage"));
  check("a corrupt PDF is refused with a clear 400", corrupt.status === 400 && /Could not read this PDF/.test(corrupt.json?.message ?? ""));

  const waitDone = (id) => until(async () => {
    const r = await api("GET", `/jobs/${id}`);
    return ["done", "partial", "failed", "cancelled"].includes(r.json?.job?.status) ? r.json : null;
  });

  // Text-layer PDF.
  const created = await upload(path.join(FIXTURES, "isha-text.pdf"));
  check("upload creates a job", created.status === 201 && created.json.reused === false);
  textJobId = created.json.job.id;
  const done = await waitDone(textJobId);
  check("the text PDF finishes", done?.job.status === "done", done?.job.status);
  const doc = (await api("GET", `/jobs/${textJobId}/document`)).json;
  check("three pages, in order", doc.pages.map((p) => p.page).join() === "1,2,3");
  check("all of them from the PDF's own text layer (no OCR)", doc.pages.every((p) => p.meta?.source === "embedded"));
  check("the original upload is stored unchanged", fs.readFileSync(path.join(process.env.OCR_STORAGE_DIR, textJobId, "source.pdf")).equals(fs.readFileSync(path.join(FIXTURES, "isha-text.pdf"))));

  const again = await upload(path.join(FIXTURES, "isha-text.pdf"));
  check("the same upload again returns the existing job (no duplicate work)", again.status === 200 && again.json.reused === true && again.json.job.id === textJobId);
  const count = rows(await pool.query("select count(*)::int as n from cms_ocr_jobs where file_name = 'isha-text.pdf'"))[0].n;
  check("…and no second job row exists", count === 1, String(count));

  // Scanned PDF.
  const scan = await upload(path.join(FIXTURES, "isha-scan.pdf"), { quality: "accurate" });
  const scanId = scan.json.job.id;
  const scanDone = await waitDone(scanId);
  check("the scanned PDF finishes", scanDone?.job.status === "done", scanDone?.job?.error ?? scanDone?.job?.status);
  const scanDoc = (await api("GET", `/jobs/${scanId}/document`)).json;
  check("every scanned page went through OCR, in order", scanDoc.pages.map((p) => `${p.page}:${p.meta?.source}`).join() === "1:ocr,2:ocr,3:ocr");
  check("pages carry confidence and review flags", scanDoc.pages.every((p) => typeof p.meta.confidence === "number" && Array.isArray(p.meta.flags)));
  const raw = (await api("GET", `/jobs/${scanId}/download?format=raw`)).text;
  const txt = (await api("GET", `/jobs/${scanId}/download?format=txt`)).text;
  check("the raw download keeps Tesseract's own output (ZWNJ included)", /‌/.test(raw));
  check("the normalized download drops only the word-final ZWNJ", !/्‌(\s|$)/.test(txt) && /॥/.test(txt));
  const reread = (await api("GET", `/jobs/${scanId}/document`)).json;
  check("the transcription reads back identically (persisted, not in memory)", JSON.stringify(reread.pages) === JSON.stringify(scanDoc.pages));

  // Resume: fail page 2 only, then Retry.
  const before = rows(await pool.query(`select chunk_index, updated_at, attempts from cms_ocr_job_chunks where job_id = $1 order by chunk_index`, [scanId]));
  await pool.query(`update cms_ocr_job_chunks set status = 'failed', markdown = null, error = 'simulated' where job_id = $1 and chunk_index = 1`, [scanId]);
  await pool.query(`update cms_ocr_jobs set status = 'partial' where id = $1`, [scanId]);
  const retry = await api("POST", `/jobs/${scanId}/retry`);
  check("Retry requeues only the failed page", retry.json?.requeued === 1, JSON.stringify(retry.json));
  const resumed = await waitDone(scanId);
  check("the job completes again", resumed?.job.status === "done");
  const afterRows = rows(await pool.query(`select chunk_index, updated_at, attempts, status from cms_ocr_job_chunks where job_id = $1 order by chunk_index`, [scanId]));
  check("pages that had succeeded were NOT redone",
    afterRows[0].updated_at.getTime() === before[0].updated_at.getTime() && afterRows[2].updated_at.getTime() === before[2].updated_at.getTime());
  check("the failed page was", afterRows[1].status === "done");
  const second = await api("POST", `/jobs/${scanId}/retry`);
  check("Retry on a finished job queues nothing", second.json?.requeued === 0);

  // A retry must not race a queued/running job.
  await pool.query(`update cms_ocr_jobs set status = 'queued' where id = $1`, [scanId]);
  check("Retry refuses a job that is already queued", (await ocrStore.requeueJobForRetry(scanId)) === null);
  await pool.query(`update cms_ocr_jobs set status = 'done' where id = $1`, [scanId]);

  // Cancel mid-run; finished pages are kept.
  const big = await upload(path.join(FIXTURES, "isha-scan.pdf"), { force: "1", textMode: "ocr" });
  const bigId = big.json.job.id;
  await until(async () => (await api("GET", `/jobs/${bigId}`)).json?.job.status === "running", { timeoutMs: 10_000, every: 20 });
  const cancel = await api("POST", `/jobs/${bigId}/cancel`);
  check("cancel answers", cancel.status === 200 && cancel.json.cancelled === true);
  await sleep(2_500);
  const cancelled = rows(await pool.query(`select status, run_token from cms_ocr_jobs where id = $1`, [bigId]))[0];
  const chunkStates = rows(await pool.query(`select status from cms_ocr_job_chunks where job_id = $1`, [bigId])).map((r) => r.status);
  check("the job is cancelled with its token void", cancelled.status === "cancelled" && cancelled.run_token === null);
  check("no page is left 'running'", !chunkStates.includes("running"), chunkStates.join());
  const resumeCancelled = await api("POST", `/jobs/${bigId}/retry`);
  check("a cancelled job resumes with only its unfinished pages", resumeCancelled.json.requeued === chunkStates.filter((s) => s !== "done").length);
  check("…and finishes", (await waitDone(bigId))?.job.status === "done");
  await api("DELETE", `/jobs/${bigId}`);
  check("delete removes rows and the stored upload", !fs.existsSync(path.join(process.env.OCR_STORAGE_DIR, bigId)));

  // A job whose stored upload has gone (purged) is never reused, and fails clearly.
  fs.rmSync(path.join(process.env.OCR_STORAGE_DIR, scanId), { recursive: true, force: true });
  const fresh = await upload(path.join(FIXTURES, "isha-scan.pdf"), { quality: "accurate" });
  check("an upload whose earlier job lost its file starts a new job", fresh.status === 201 && fresh.json.job.id !== scanId);
  await waitDone(fresh.json.job.id);
  await pool.query(`update cms_ocr_job_chunks set status = 'failed' where job_id = $1 and chunk_index = 0`, [scanId]);
  await pool.query(`update cms_ocr_jobs set status = 'partial' where id = $1`, [scanId]);
  await api("POST", `/jobs/${scanId}/retry`);
  const gone = await waitDone(scanId);
  check("retrying a job whose upload is gone fails with that reason, once", gone?.job.status !== "running" && /no longer stored/.test(gone?.job.error ?? ""), gone?.job.error);
}

// ── 4. OCR → Grantha ─────────────────────────────────────────────────────────
console.log("\nOCR → Grantha through the router, scripted analyzer");
/**
 * A deterministic stand-in for the model: line 1 of the first range is the chapter
 * heading; a run of lines ending in "॥ n ॥" is verse n; anything else is left
 * unclassified. It answers in the same line-span format Gemini is asked for and goes
 * through the same resolveLineAnswer as production.
 */
const calls = [];
let mode = "good";
function scriptedAnswer(lines, chunkIndex) {
  const items = [];
  let start = 1;
  lines.forEach((l, i) => {
    const n = i + 1;
    if (chunkIndex === 0 && n === 1) {
      items.push({ kind: "section", from: 1, to: 1, level: 1, number: "1", confidence: 0.9 });
      start = 2;
      return;
    }
    const m = /॥\s*([०-९0-9]+)\s*॥\s*$/.exec(l.text);
    if (m) {
      items.push({ kind: "verse", from: start, to: n, number: m[1], script: "devanagari", confidence: 0.95 });
      start = n + 1;
    } else if (/॥\s*$/.test(l.text)) {
      // An un-numbered stanza (the shanti mantra) is not an entry.
      items.push({ kind: "prose", from: start, to: n, confidence: 0.8 });
      start = n + 1;
    }
  });
  return "```json\n" + JSON.stringify({ items, warnings: [], openPath: [{ level: 1, number: "1", title: "Isha" }] }) + "\n```";
}
structureJobs.setStructureAnalyzerFactory(
  () => ({
    label: "scripted",
    async analyse(req) {
      calls.push(req.chunkIndex);
      if (mode === "fatal") throw new StructureAnalysisError("The dedicated Gemini profile is not logged in.", { fatal: true });
      if (mode === "malformed-1" && req.chunkIndex === 1) throw new StructureAnalysisError("Pages 2–2: the answer could not be used", { attempts: 3 });
      const lines = numberSourceLines(req.pages);
      const r = resolveLineAnswer(scriptedAnswer(lines, req.chunkIndex), { chunkIndex: req.chunkIndex, lines, knownTeekaNames: req.knownTeekaNames });
      return { ...r, attempts: 1, model: "scripted" };
    },
    async close() {},
  }),
  () => true,
);

if (!textJobId) {
  skip("OCR → Grantha end to end", "needs the OCR leg above (local engine not installed)");
} else {
  const waitStructure = (id) => until(async () => {
    const r = await api("GET", `/structure/jobs/${id}`);
    return ["done", "partial", "failed", "cancelled"].includes(r.json?.job?.status) ? r.json : null;
  });
  const cfg = await api("GET", "/structure/config");
  check("config reports the Hermex runtime, no price or token budget", cfg.json.configured === true && !/Usd|token/i.test(JSON.stringify(cfg.json)) && /Hermex/.test(cfg.json.runtime.name));
  const est = await api("GET", `/structure/estimate/${textJobId}`);
  check("the estimate is in requests, not money", est.json.estimate.requests >= 1 && !("costUsd" in est.json.estimate));

  const body = { ocrJobId: textJobId, depth: 2, levelNames: ["Adhyaya", "Mantra"], instructions: "Verses end with ॥ n ॥", pageFrom: 1, pageTo: 2 };
  mode = "malformed-1";
  // One page per range, so range 1 (page 2) can fail on its own.
  const created = await api("POST", "/structure/jobs", body);
  const dup = await api("POST", "/structure/jobs", body);
  check("starting the same analysis twice returns the first one", created.status === 201 && dup.status === 200 && dup.json.reused && dup.json.job.id === created.json.job.id);
  const jobId = created.json.job.id;
  let finished = await waitStructure(jobId);
  const chunkCount = finished.chunks.length;
  if (chunkCount < 2) {
    skip("malformed-range retry", `pages fit one range (${chunkCount}); set STRUCTURE_PAGES_PER_CHUNK=1 to exercise it`);
  } else {
    check("a range whose answer stayed unusable fails on its own", finished.job.status === "partial" && finished.chunks[1].status === "failed");
    const failedItems = rows(await pool.query(`select items from cms_structure_job_chunks where job_id = $1 and chunk_index = 1`, [jobId]))[0].items;
    check("…and stores no partial items", failedItems == null);
    mode = "good";
    calls.length = 0;
    check("Retry failed ranges requeues just that range", (await api("POST", `/structure/jobs/${jobId}/retry`)).json.requeued === 1);
    finished = await waitStructure(jobId);
    check("only the failed range was analysed again", calls.join() === "1", calls.join());
  }
  mode = "good";
  check("the analysis completes", finished.job.status === "done", finished.job.status + " " + finished.job.error);

  let result = (await api("GET", `/structure/jobs/${jobId}/result`)).json;
  check("pages 1–2 give verses 1.1, 1.2, 1.3 — once each, no duplicates from the retry", result.verses.map((v) => v.csvNumber).join() === "1.1,1.2,1.3", result.verses.map((v) => v.csvNumber).join());
  const sourcePages = (await api("GET", `/jobs/${textJobId}/document`)).json.pages;
  const firstVerseSource = sourcePages[0].markdown.split("\n").filter((l) => l.trim()).slice(3, 5).join("\n");
  check("verse text is exactly the transcription's lines", result.verses[0].shloka.sanskrit === firstVerseSource, JSON.stringify([result.verses[0].shloka.sanskrit, firstVerseSource]));
  check("numbers are recorded as printed, not inferred", result.items.filter((i) => i.kind === "verse").every((i) => i.numberSource === "printed"));

  // Review edits: optimistic concurrency.
  const proseId = result.items.find((i) => i.kind === "prose").id;
  const edit1 = [{ op: "edit", id: proseId, patch: { kind: "footnote" } }];
  const saved = await api("PUT", `/structure/jobs/${jobId}/overrides`, { overrides: edit1 });
  check("a review edit saves", saved.status === 200);
  const otherReviewer = await api("PUT", `/structure/jobs/${jobId}/overrides`, { overrides: [{ op: "delete", id: proseId }] });
  check("a save that would erase someone else's edit is refused (409)", otherReviewer.status === 409, String(otherReviewer.status));
  const appended = await api("PUT", `/structure/jobs/${jobId}/overrides`, { overrides: [...edit1, { op: "edit", id: proseId, patch: { kind: "prose" } }] });
  check("a save that builds on the stored edits is accepted", appended.status === 200);

  // Approval gate.
  const notReviewed = await api("POST", `/structure/jobs/${jobId}/import`, { granthaDocId: "g1", status: "done" });
  check("an unreviewed analysis cannot be marked imported", notReviewed.status >= 400, String(notReviewed.status));
  check("the review can be confirmed", (await api("POST", `/structure/jobs/${jobId}/review`)).status === 200);
  const csv = (await api("GET", `/structure/jobs/${jobId}/csv`)).text;
  check("the CSV carries the transcription byte for byte", csv.includes(firstVerseSource.split("\n")[0]));

  // A setup failure stops the job and keeps the ranges for later.
  mode = "fatal";
  const stopped = await api("POST", "/structure/jobs", { ...body, instructions: "second run" });
  const stoppedDone = await waitStructure(stopped.json.job.id);
  check("a setup failure stops the job with the reason", stoppedDone.job.status === "failed" && /not logged in/.test(stoppedDone.job.error));
  check("…leaving its ranges queued, not failed", stoppedDone.chunks.every((c) => c.status === "queued"), stoppedDone.chunks.map((c) => c.status).join());
  mode = "good";
  await api("POST", `/structure/jobs/${stopped.json.job.id}/retry`);
  check("once fixed, Retry finishes it", (await waitStructure(stopped.json.job.id))?.job.status === "done");

  // Ported store checks.
  const teeka = await structureStore.distinctTeekaNames(jobId);
  check("distinctTeekaNames runs against jsonb (none here)", Array.isArray(teeka));
  const prev = await structureStore.previousDoneChunk(jobId, chunkCount);
  check("previousDoneChunk returns the last analysed range", prev?.endPage >= 1);
  await api("DELETE", `/jobs/${textJobId}`);
  const left = rows(await pool.query(`select count(*)::int as n from cms_structure_jobs where ocr_job_id = $1`, [textJobId]))[0].n;
  check("deleting the OCR document cascades to its analyses", left === 0);
}

// ── 5. translation untouched ─────────────────────────────────────────────────
console.log("\ntranslation");
{
  const after = rows(await db.execute(sql`select (select count(*) from cms_translation_jobs)::int as j, (select count(*) from cms_translation_items)::int as i`))[0];
  check("translation's job and item tables were not touched", after.j === translationBefore.j && after.i === translationBefore.i);
}

structureJobs.setStructureAnalyzerFactory(null);
server.close();
await pool.end();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${PASS} passed, ${FAILURES.length} failed${SKIP ? `, ${SKIP} skipped` : ""}`);
if (FAILURES.length > 0) {
  for (const f of FAILURES) console.error(` - ${f}`);
  process.exit(1);
}
process.exit(0);
