/**
 * Local end-to-end harness for OCR Docs (dev machines only).
 * Mounts the real router on a bare Express app with a stubbed admin user and
 * drives the whole path: upload -> chunk -> Gemini -> poll -> merge -> download.
 *
 * Run: node --import tsx script/ocr-e2e-local.mts <file.pdf> [pagesPerRequest]
 */
import "../server/env";
import pg from "pg";

// Local Postgres has no TLS; server/db.ts pins ssl on for RDS. Patch only here.
if (process.env.OCR_E2E_NO_SSL === "1") {
  const Original = pg.Pool;
  // @ts-expect-error test-only shim
  pg.Pool = class extends Original {
    constructor(config: any) {
      super({ ...config, ssl: false });
    }
  };
}

const [, , filePath, chunkSizeArg] = process.argv;
if (!filePath) throw new Error("usage: ocr-e2e-local.mts <file.pdf>");

const express = (await import("express")).default;
const { readFile } = await import("node:fs/promises");
const ocrRouter = (await import("../server/ocr/routes")).default;
const { deleteJob } = await import("../server/ocr/store");

const app = express();
app.use((req: any, _res, next) => {
  req.user = { id: null, role: "admin", username: "e2e" };
  next();
});
app.use("/api/admin/ocr", ocrRouter);
const server = app.listen(0);
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}/api/admin/ocr`;

const bytes = await readFile(filePath);
const name = filePath.split("/").pop()!;

const cfg = await (await fetch(`${base}/config`)).json();
console.log("config:", JSON.stringify(cfg.limits), "configured:", cfg.configured, "models:", cfg.models);

const created = await fetch(
  `${base}/jobs?fileName=${encodeURIComponent(name)}&mimeType=application/pdf&quality=fast&chunkSize=${Number(chunkSizeArg) || 8}`,
  { method: "POST", headers: { "content-type": "application/pdf" }, body: bytes },
);
const { job, message } = await created.json();
if (!created.ok) throw new Error(`create failed: ${message}`);
console.log(`job ${job.id}: ${job.pageCount} pages, ${job.chunksTotal} chunks of ${job.chunkSize}, model ${job.model}`);

const TERMINAL = ["done", "partial", "failed", "cancelled"];
let detail: any;
const startedAt = Date.now();
while (Date.now() - startedAt < 600_000) {
  await new Promise((r) => setTimeout(r, 1500));
  detail = await (await fetch(`${base}/jobs/${job.id}`)).json();
  const d = detail.job;
  console.log(
    `  ${d.status}: ${d.chunksDone}/${d.chunksTotal} done, ${d.chunksFailed} failed, ` +
      `${d.requestCount} requests, ${d.inputTokens}+${d.outputTokens} tokens, ` +
      `usage ${detail.usage.inFlight} in flight / ${detail.usage.today} today`,
  );
  if (TERMINAL.includes(d.status)) break;
}

const doc = await (await fetch(`${base}/jobs/${job.id}/document`)).json();
console.log(`\npages merged: ${doc.pages.map((p: any) => p.page).join(", ")}`);
console.log(`missing ranges: ${JSON.stringify(doc.missingRanges)}`);
for (const page of doc.pages) {
  console.log(`\n────── page ${page.page} ──────\n${page.markdown.slice(0, 400)}`);
}

const md = await (await fetch(`${base}/jobs/${job.id}/download?format=md`)).text();
console.log(`\ndownload .md: ${md.length} chars`);
const src = await fetch(`${base}/jobs/${job.id}/source`);
console.log(`source file: ${src.status} ${src.headers.get("content-type")}`);

if (process.env.OCR_E2E_KEEP !== "1") {
  await deleteJob(job.id);
  console.log("cleaned up job + upload");
}
server.close();
process.exit(0);
