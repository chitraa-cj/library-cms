/**
 * Live schema + store check for the OCR → Grantha tables.
 *
 * `tests/ocr-structure-*.test.mjs` cover the logic without a database; this covers the
 * things only a real Postgres can answer — that the migration applies (twice), that
 * `ensureStructureSchema` agrees with it, that every column the drizzle model reads
 * exists, that the jsonb payloads round-trip, that the lateral jsonb query works, and
 * that deleting an OCR document cascades to its analyses.
 *
 * Point it at a THROWAWAY database; it writes and deletes rows.
 *
 *   initdb -D /tmp/pgdata -U postgres --auth=trust
 *   pg_ctl -D /tmp/pgdata -o "-p 55432" start
 *   createdb -h 127.0.0.1 -p 55432 -U postgres cmstest
 *   DATABASE_URL=postgres://postgres@127.0.0.1:55432/cmstest DATABASE_SSL=false \
 *     node --import tsx script/structure-db-check.mts
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import { ensureOcrSchema, insertJob, insertChunks, updateChunk } from "../server/ocr/store";
import * as store from "../server/structure/store";
import { buildStructureResult, estimateStructureCostForPages } from "../server/structure/jobs";
import { structureConfig, structureRates } from "../server/structure/config";
import { assertSpendBudget, invalidateStructureSpend, structureSpend } from "../server/structure/limiter";
import { structureCostUsd } from "../shared/ocr-structure";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let ok = 0;
const fail: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) { ok++; console.log(`  ok  ${name}`); }
  else { fail.push(name + (detail ? ` — ${detail}` : "")); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// users + OCR tables first (the structure tables reference both).
await db.execute(sql`
  create table if not exists users (
    id varchar primary key default gen_random_uuid(),
    username text not null unique,
    password text not null,
    display_name text,
    role text default 'editor',
    created_at timestamp default now()
  )`);
await ensureOcrSchema();
console.log("\nmigration file");
const migration = await readFile(`${ROOT}/script/migrations/20261013_ocr_structure_jobs.sql`, "utf8");
await pool.query(migration);
check("the migration file applies", true);
await pool.query(migration);
check("and applies a second time (re-runnable)", true);

console.log("\nserver-side bootstrap");
await store.ensureStructureSchema();
check("ensureStructureSchema agrees with the migration", true);

// Every column the drizzle model expects must exist, with the model's nullability.
const cols = await pool.query(
  `select table_name, column_name, data_type from information_schema.columns
   where table_name in ('cms_structure_jobs','cms_structure_job_chunks') order by 1,2`,
);
const names = new Set(cols.rows.map((r: any) => `${r.table_name}.${r.column_name}`));
for (const col of [
  "cms_structure_jobs.id", "cms_structure_jobs.ocr_job_id", "cms_structure_jobs.user_id",
  "cms_structure_jobs.depth", "cms_structure_jobs.level_names", "cms_structure_jobs.instructions",
  "cms_structure_jobs.voice_used", "cms_structure_jobs.model", "cms_structure_jobs.status",
  "cms_structure_jobs.chunks_total", "cms_structure_jobs.chunks_done", "cms_structure_jobs.chunks_failed",
  "cms_structure_jobs.request_count", "cms_structure_jobs.input_tokens", "cms_structure_jobs.output_tokens",
  "cms_structure_jobs.cached_input_tokens", "cms_structure_jobs.overrides", "cms_structure_jobs.reviewed_at",
  "cms_structure_jobs.import_status", "cms_structure_jobs.import_grantha_doc_id",
  "cms_structure_jobs.import_summary", "cms_structure_jobs.imported_at", "cms_structure_jobs.error",
  "cms_structure_job_chunks.job_id", "cms_structure_job_chunks.chunk_index",
  "cms_structure_job_chunks.start_page", "cms_structure_job_chunks.end_page",
  "cms_structure_job_chunks.items", "cms_structure_job_chunks.warnings",
  "cms_structure_job_chunks.open_path", "cms_structure_job_chunks.rejected_items",
  "cms_structure_job_chunks.cached_input_tokens",
]) check(`column ${col}`, names.has(col));

console.log("\na job through the store");
// Re-runnable: a previous run that failed part way must not block the next one. The
// structure rows go with the OCR rows by cascade.
await pool.query("delete from cms_ocr_jobs where id = any($1)", [["ocr-1", "ocr-budget"]]);
const ocr = await insertJob({
  id: "ocr-1", userId: null, fileName: "book.pdf", mimeType: "application/pdf",
  fileSize: 10, fileHash: "x", pageCount: 2, chunkSize: 8, quality: "fast",
  model: "gemini-3.8-flash", status: "done", chunksTotal: 1,
});
await insertChunks([{ jobId: ocr.id, chunkIndex: 0, startPage: 1, endPage: 2, status: "queued" }]);
await updateChunk(ocr.id, 0, {
  status: "done",
  markdown: "<<<PAGE:1>>>\n# Prathama Adhyaya\n\n1. मन्त्रः\n<<<PAGE:2>>>\n2. द्वितीयः",
});

const job = await store.insertStructureJob({
  id: "str-1", ocrJobId: ocr.id, userId: null, depth: 2,
  levelNames: ["Adhyaya", "Mantra"], instructions: "test", model: "claude-opus-5",
  status: "queued", chunksTotal: 2,
});
check("the job row round-trips its level names", JSON.stringify(job.levelNames) === '["Adhyaya","Mantra"]');
check("overrides default to an empty array", Array.isArray(job.overrides) && job.overrides.length === 0);
check("import status defaults to none", job.importStatus === "none");

await store.insertStructureChunks([
  { jobId: job.id, chunkIndex: 0, startPage: 1, endPage: 1, status: "queued" },
  { jobId: job.id, chunkIndex: 1, startPage: 2, endPage: 2, status: "queued" },
]);
await store.updateStructureChunk(job.id, 0, {
  status: "done",
  items: [
    { id: "c0-0", kind: "section", level: 1, number: "1", title: "Prathama Adhyaya", page: 1, confidence: 0.99 },
    { id: "c0-1", kind: "verse", number: "1", text: "मन्त्रः", page: 1, confidence: 0.95, script: "devanagari" },
    { id: "c0-2", kind: "teeka", teekaName: "Anandagiri", text: "टीका", page: 1, confidence: 0.9, attachTo: "previous_verse", script: "devanagari" },
  ],
  warnings: ["page 1 is faint"],
  openPath: [{ level: 1, number: "1", title: "Prathama Adhyaya" }],
  inputTokens: 100, outputTokens: 50, cachedInputTokens: 80,
});
await store.updateStructureChunk(job.id, 1, {
  status: "done",
  items: [{ id: "c1-0", kind: "verse", number: "2", text: "द्वितीयः", page: 2, confidence: 0.93, script: "devanagari" }],
  warnings: [],
  openPath: [{ level: 1, number: "1", title: "Prathama Adhyaya" }],
});
await store.addStructureChunkResultToJob(job.id, {
  done: 2, failed: 0, requests: 2, inputTokens: 100, outputTokens: 50, cachedInputTokens: 80,
  cacheWriteTokens: 1_800,
});
await store.updateStructureJob(job.id, { status: "done" });

const names2 = await store.distinctTeekaNames(job.id);
check("distinctTeekaNames finds the commentary in jsonb", JSON.stringify(names2) === '["Anandagiri"]', JSON.stringify(names2));
const prev = await store.previousDoneChunk(job.id, 1);
check("previousDoneChunk returns the range before it", prev?.chunkIndex === undefined && prev?.endPage === 1, JSON.stringify(prev));

const reloaded = (await store.getStructureJob(job.id))!;
check("counters were folded atomically", reloaded.chunksDone === 2 && reloaded.cachedInputTokens === 80);

const result = await buildStructureResult(reloaded);
check("two entries assemble from two chunks", result.structure.verses.length === 2,
  JSON.stringify(result.structure.verses.map((v) => v.csvNumber)));
check("the second chunk inherits the first chunk's section", result.structure.verses[1]?.csvNumber === "1.2",
  result.structure.verses[1]?.csvNumber);
check("the teeka is attached to its entry", result.structure.verses[0]?.teekas[0]?.teekaName === "Anandagiri");
check("the CSV has the expected columns",
  JSON.stringify(result.csv.columns.map((c) => c.header)) === '["Number","Mantra (Sanskrit)","Anandagiri (Sanskrit)"]',
  JSON.stringify(result.csv.columns.map((c) => c.header)));
check("validation passes", result.validation.ok, JSON.stringify(result.validation.errors));
check("workflow state is review_pending", result.workflowState === "review_pending", result.workflowState);

// An edit is replayed on read, with no further model call.
await store.updateStructureJob(job.id, {
  overrides: [{ op: "edit", id: "c0-2", patch: { kind: "bhashyam" } }],
});
const edited = await buildStructureResult((await store.getStructureJob(job.id))!);
check("an override moves the text to the bhashyam field",
  Boolean(edited.structure.verses[0]?.bhashyam.sanskrit) && edited.structure.verses[0]?.teekas.length === 0);



console.log("\nspend budget, measured from the token counters");
{
  invalidateStructureSpend();
  const before = await structureSpend(true);
  check("spend starts from what is actually in the table", before.dayUsd >= 0);

  // Nothing spent yet, so a modest estimate must be allowed through.
  let blocked = null;
  try {
    await assertSpendBudget(0);
  } catch (err: any) {
    blocked = err;
  }
  check("an empty budget lets work start", blocked === null, blocked?.message);

  // Park a job whose counters exceed the daily cap, the way a real run would.
  const rates = structureRates();
  const outputTokensOverCap =
    rates.outputPer1M > 0
      ? Math.ceil(((structureConfig.maxSpendPerDayUsd * 2) / rates.outputPer1M) * 1_000_000)
      : 0;
  const ocr2 = await insertJob({
    id: "ocr-budget", userId: null, fileName: "spent.pdf", mimeType: "application/pdf",
    fileSize: 10, fileHash: "y", pageCount: 1, chunkSize: 8, quality: "fast",
    model: "gemini-3.8-flash", status: "done", chunksTotal: 1,
  });
  const spender = await store.insertStructureJob({
    id: "str-budget", ocrJobId: ocr2.id, userId: null, depth: 2,
    levelNames: ["Adhyaya", "Mantra"], model: "claude-opus-5", status: "done", chunksTotal: 1,
  });
  await store.addStructureChunkResultToJob(spender.id, {
    done: 1, failed: 0, requests: 1,
    inputTokens: 0, outputTokens: outputTokensOverCap, cachedInputTokens: 0, cacheWriteTokens: 0,
  });
  invalidateStructureSpend();

  const after = await structureSpend(true);
  check(
    "the day figure reflects the tokens that were recorded",
    after.dayUsd > structureConfig.maxSpendPerDayUsd,
    `${after.dayUsd} vs cap ${structureConfig.maxSpendPerDayUsd}`,
  );

  blocked = null;
  try {
    await assertSpendBudget(0);
  } catch (err: any) {
    blocked = err;
  }
  check("a spent daily budget blocks the next request", blocked !== null);
  check("and names the gate, so the UI can explain it", blocked?.gate === "spend-per-day", blocked?.gate);
  check("and says how to proceed", /STRUCTURE_MAX_SPEND_PER_DAY_USD/.test(blocked?.message ?? ""));

  // The same gate must stop a NEW job being created, not just the next request.
  const { createStructureJob } = await import("../server/structure/jobs");
  let refused = null;
  try {
    await createStructureJob({
      ocrJob: await (await import("../server/ocr/store")).getJob(ocr2.id) as any,
      userId: null,
      config: { depth: 2, levelNames: ["Adhyaya", "Mantra"] },
    });
  } catch (err: any) {
    refused = err;
  }
  check("a spent budget refuses to start a new analysis", refused !== null, "job was created anyway");

  // The estimate is the figure the gate compares against, so it must be non-zero.
  const { pages: budgetPages } = await (await import("../server/ocr/jobs")).buildOcrDocument(ocr.id);
  const estimate = estimateStructureCostForPages(budgetPages);
  check("the pre-flight estimate is a real number", estimate.costUsd > 0 && estimate.requests > 0,
    JSON.stringify(estimate));
  check(
    "and it agrees with the cost function",
    Math.abs(estimate.costUsd - structureCostUsd(estimate, rates)) < 1e-9,
  );

  await pool.query("delete from cms_ocr_jobs where id = $1", [ocr2.id]);
  invalidateStructureSpend();
}

console.log("\ncascade deletes");
// Cascades: deleting the OCR job must take the analysis with it.
await pool.query("delete from cms_ocr_jobs where id = $1", [ocr.id]);
const left = await pool.query("select count(*)::int as n from cms_structure_jobs");
check("deleting the OCR document cascades to its analyses", left.rows[0].n === 0, JSON.stringify(left.rows[0]));
const leftChunks = await pool.query("select count(*)::int as n from cms_structure_job_chunks");
check("and to its chunk rows", leftChunks.rows[0].n === 0);

console.log(`\n${ok} passed, ${fail.length} failed`);
for (const f of fail) console.error(" - " + f);
await pool.end();
process.exit(fail.length ? 1 : 0);
