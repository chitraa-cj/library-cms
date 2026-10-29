/**
 * Admin-only OCR API, mounted at /api/admin/ocr. Every route sits behind
 * requireAuth + requireAdmin (applied at the mount point in server/routes.ts).
 *
 * Uploads come in as a raw body rather than multipart/base64 JSON: a 300-page
 * scan is ~80MB and base64 would inflate it by a third for no benefit.
 *
 * These routes only read and write job rows. Transcription happens in the
 * cms-ocr-worker process (server/ocr/worker-main.ts): uploads and Retry queue work
 * and notify it, cancel and delete mark the row, and live progress is read back
 * from what the worker wrote.
 */
import { Router, raw } from "express";
import { createReadStream } from "node:fs";
import path from "node:path";
import { ocrEngineAvailability } from "./availability";
import { OCR_SUPPORTED_MIME, ocrConfig } from "./config";
import { estimateJob } from "./estimate";
import { buildOcrDocument, cancelOcrJob, createOcrJob, retryOcrJob } from "./jobs";
import {
  deleteJob,
  ensureOcrSchema,
  getJob,
  historicalMsPerPage,
  jobDir,
  listChunkLive,
  listChunkRawTexts,
  listChunkStatuses,
  listJobs,
  ocrQueueUsage,
  purgeExpiredJobs,
} from "./store";
import { splitChunkPages } from "./pages";

const router = Router();

function fail(res: any, status: number, message: string) {
  return res.status(status).json({ message });
}

/** Trim a user-supplied filename to something safe to echo back and store. */
function safeName(input: unknown): string {
  const base = path
    .basename(String(input || "document"))
    .split("")
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join("");
  return base.slice(0, 200) || "document";
}

router.get("/config", async (_req, res) => {
  const engine = await ocrEngineAvailability();
  res.json({
    configured: engine.ok,
    engine: {
      name: engine.engineLabel,
      problems: engine.problems,
      warnings: engine.warnings,
    },
    limits: {
      maxUploadMb: Math.round(ocrConfig.maxUploadBytes / 1024 / 1024),
      maxPages: ocrConfig.maxPages,
      defaultChunkSize: ocrConfig.defaultChunkSize,
      maxChunkSize: ocrConfig.maxChunkSize,
      retentionDays: ocrConfig.retentionDays,
    },
    usage: await ocrQueueUsage(ocrConfig.concurrency),
  });
});

/** Readiness of Hermex on the document profile — filesystem checks only, never a prompt. */
router.get("/health", async (req, res) => {
  const engine = await ocrEngineAvailability(req.query.force === "1");
  res.status(engine.ok ? 200 : 503).json(engine);
});

router.get("/jobs", async (_req, res) => {
  await ensureOcrSchema();
  const jobs = await listJobs(40);
  res.json({ jobs, usage: await ocrQueueUsage(ocrConfig.concurrency) });
});

router.post(
  "/jobs",
  raw({ type: () => true, limit: ocrConfig.maxUploadBytes }),
  async (req: any, res) => {
    const engine = await ocrEngineAvailability();
    if (!engine.ok) {
      return fail(res, 503, `OCR through Hermex is not ready on this server: ${engine.problems.join(" ")}`);
    }
    const mimeType = String(req.query.mimeType || req.get("content-type") || "")
      .split(";")[0]
      .trim();
    if (!OCR_SUPPORTED_MIME.has(mimeType)) {
      return fail(
        res,
        415,
        `Unsupported file type "${mimeType || "unknown"}". Upload a PDF, PNG, JPEG or WebP (convert TIFF/HEIC first — Gemini's upload does not take them).`,
      );
    }
    const bytes: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (bytes.byteLength === 0) return fail(res, 400, "Empty upload.");
    if (bytes.byteLength > ocrConfig.maxUploadBytes) {
      return fail(res, 413, `File is larger than the ${Math.round(ocrConfig.maxUploadBytes / 1024 / 1024)}MB limit.`);
    }

    const chunkSize = Number(req.query.chunkSize);
    try {
      const { job, reused } = await createOcrJob({
        userId: req.user?.id ?? null,
        fileName: safeName(req.query.fileName),
        mimeType,
        bytes,
        chunkSize: Number.isFinite(chunkSize) ? chunkSize : undefined,
        instructions: typeof req.query.instructions === "string" ? req.query.instructions.slice(0, 2000) : null,
        force: req.query.force === "1",
      });
      res.status(reused ? 200 : 201).json({ job, reused });
    } catch (err: any) {
      fail(res, err?.status || 500, err?.message || "Could not start the OCR job.");
    }
  },
);

router.get("/jobs/:id", async (req, res) => {
  await ensureOcrSchema();
  const job = await getJob(req.params.id);
  if (!job) return fail(res, 404, "OCR job not found.");
  const chunks = await listChunkStatuses(job.id);
  // Written by the worker while it runs the job; stale rows from a stopped run are ignored.
  const live = job.status === "running" ? await listChunkLive(job.id) : {};
  const running = job.status === "running" || job.status === "queued";
  const now = Date.now();
  const progress = estimateJob({
    chunks,
    live,
    now,
    concurrency: ocrConfig.concurrency,
    requestsPerMinute: 0,
    // NOT measured: no real Gemini OCR request has run yet. A placeholder until this
    // host's own finished ranges replace it (basis "measured"/"historical").
    guessMsPerPage: { fast: 45_000, accurate: 45_000 },
    rangeOverheadMs: 15_000,
    historicalMsPerPage: running ? await historicalMsPerPage(job.model) : null,
    quality: job.quality,
    startedAt: job.startedAt ? new Date(job.startedAt).getTime() : null,
    endedAt: job.finishedAt ? new Date(job.finishedAt).getTime() : null,
    running,
  });
  res.json({
    job,
    chunks: chunks.map((c) => ({ ...c, live: live[c.chunkIndex] ?? null })),
    active: job.status === "running",
    usage: await ocrQueueUsage(ocrConfig.concurrency),
    progress,
    // Lets the client turn absolute `nextAttemptAt` stamps into countdowns
    // without trusting its own clock to match the server's.
    serverNow: now,
  });
});

router.get("/jobs/:id/document", async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return fail(res, 404, "OCR job not found.");
  const doc = await buildOcrDocument(job.id);
  res.json({ job, ...doc });
});

router.get("/jobs/:id/download", async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return fail(res, 404, "OCR job not found.");
  const { markdown, pages } = await buildOcrDocument(job.id);
  const stem = job.fileName.replace(/\.[^.]+$/, "") || "ocr";

  if (req.query.format === "raw") {
    // The engine's untouched output beside nothing else — for comparing against the
    // normalized text. Ranges from before the raw column existed have no raw copy.
    const rows = await listChunkRawTexts(job.id);
    const parts: string[] = [];
    for (const row of rows) {
      if (row.status !== "done") continue;
      const source = row.rawText ?? row.markdown ?? "";
      for (const page of splitChunkPages(source, row.startPage, row.endPage, { exact: row.rawText != null })) {
        parts.push(`--- Page ${page.page}${row.rawText == null ? " (no raw copy: transcribed before raw copies were kept)" : ""} ---\n\n${page.markdown}`);
      }
    }
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${encodeURIComponent(stem)}.raw.txt"`);
    return res.send(parts.join("\n\n"));
  }
  if (req.query.format === "txt") {
    const text = pages.map((p) => `--- Page ${p.page} ---\n\n${p.markdown}`).join("\n\n");
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${encodeURIComponent(stem)}.txt"`);
    return res.send(text);
  }
  res.setHeader("content-type", "text/markdown; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="${encodeURIComponent(stem)}.md"`);
  res.send(`# ${job.fileName}\n\n${markdown}\n`);
});

/** The original upload, for side-by-side comparison in the viewer. */
router.get("/jobs/:id/source", async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return fail(res, 404, "OCR job not found.");
  const ext = job.mimeType === "application/pdf" ? "pdf" : job.mimeType.split("/")[1] || "bin";
  const file = path.join(jobDir(job.id), `source.${ext}`);
  res.setHeader("content-type", job.mimeType);
  res.setHeader("content-disposition", `inline; filename="${encodeURIComponent(job.fileName)}"`);
  createReadStream(file)
    .on("error", () => {
      if (!res.headersSent) fail(res, 404, "The uploaded file is no longer stored on the server.");
      else res.end();
    })
    .pipe(res);
});

router.post("/jobs/:id/retry", async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return fail(res, 404, "OCR job not found.");
  // requeueJobForRetry refuses a queued/running job under a row lock (409 below).
  const requeued = await retryOcrJob(job.id);
  if (requeued == null) return fail(res, 409, "This job is already queued or running.");
  res.json({ requeued });
});

router.post("/jobs/:id/cancel", async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return fail(res, 404, "OCR job not found.");
  const wasActive = job.status === "running";
  const cancelled = await cancelOcrJob(job.id);
  res.json({ cancelled, wasActive });
});

router.delete("/jobs/:id", async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return fail(res, 404, "OCR job not found.");
  await cancelOcrJob(job.id);
  await deleteJob(job.id);
  res.json({ deleted: true });
});

router.post("/maintenance/purge", async (_req, res) => {
  const purged = await purgeExpiredJobs();
  res.json({ purged });
});

export default router;
