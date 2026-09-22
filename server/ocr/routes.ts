/**
 * Admin-only OCR API, mounted at /api/admin/ocr. Every route sits behind
 * requireAuth + requireAdmin (applied at the mount point in server/routes.ts).
 *
 * Uploads come in as a raw body rather than multipart/base64 JSON: a 300-page
 * scan is ~80MB and base64 would inflate it by a third for no benefit.
 */
import { Router, raw } from "express";
import { createReadStream } from "node:fs";
import path from "node:path";
import { OCR_SUPPORTED_MIME, isOcrConfigured, ocrConfig } from "./config";
import { ocrUsageSnapshot } from "./limiter";
import { estimateJob } from "./estimate";
import { liveChunks } from "./progress";
import {
  buildOcrDocument,
  cancelOcrJob,
  createOcrJob,
  isJobActive,
  pump,
  retryOcrJob,
} from "./jobs";
import {
  deleteJob,
  ensureOcrSchema,
  getJob,
  historicalMsPerPage,
  jobDir,
  listChunkStatuses,
  listJobs,
  purgeExpiredJobs,
  updateJob,
} from "./store";

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

router.get("/config", (_req, res) => {
  res.json({
    configured: isOcrConfigured(),
    models: ocrConfig.models,
    limits: {
      maxUploadMb: Math.round(ocrConfig.maxUploadBytes / 1024 / 1024),
      maxPages: ocrConfig.maxPages,
      defaultChunkSize: ocrConfig.defaultChunkSize,
      maxChunkSize: ocrConfig.maxChunkSize,
      retentionDays: ocrConfig.retentionDays,
    },
    usage: ocrUsageSnapshot(),
  });
});

router.get("/jobs", async (_req, res) => {
  await ensureOcrSchema();
  const jobs = await listJobs(40);
  res.json({ jobs, usage: ocrUsageSnapshot() });
});

router.post(
  "/jobs",
  raw({ type: () => true, limit: ocrConfig.maxUploadBytes }),
  async (req: any, res) => {
    if (!isOcrConfigured()) {
      return fail(res, 503, "Gemini is not configured on this server (GEMINI_API_KEY is missing).");
    }
    const mimeType = String(req.query.mimeType || req.get("content-type") || "")
      .split(";")[0]
      .trim();
    if (!OCR_SUPPORTED_MIME.has(mimeType)) {
      return fail(res, 415, `Unsupported file type "${mimeType || "unknown"}". Upload a PDF, PNG, JPEG or WebP.`);
    }
    const bytes: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (bytes.byteLength === 0) return fail(res, 400, "Empty upload.");
    if (bytes.byteLength > ocrConfig.maxUploadBytes) {
      return fail(res, 413, `File is larger than the ${Math.round(ocrConfig.maxUploadBytes / 1024 / 1024)}MB limit.`);
    }

    const chunkSize = Number(req.query.chunkSize);
    try {
      const job = await createOcrJob({
        userId: req.user?.id ?? null,
        fileName: safeName(req.query.fileName),
        mimeType,
        bytes,
        chunkSize: Number.isFinite(chunkSize) ? chunkSize : undefined,
        quality: req.query.quality === "accurate" ? "accurate" : "fast",
        instructions: typeof req.query.instructions === "string" ? req.query.instructions.slice(0, 2000) : null,
      });
      res.status(201).json({ job });
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
  const live = liveChunks(job.id);
  const running = job.status === "running" || job.status === "queued";
  const now = Date.now();
  const progress = estimateJob({
    chunks,
    live,
    now,
    concurrency: ocrConfig.concurrency,
    requestsPerMinute: ocrConfig.requestsPerMinute,
    historicalMsPerPage: running ? await historicalMsPerPage(job.model) : null,
    quality: job.quality,
    startedAt: job.startedAt ? new Date(job.startedAt).getTime() : null,
    endedAt: job.finishedAt ? new Date(job.finishedAt).getTime() : null,
    running,
  });
  res.json({
    job,
    chunks: chunks.map((c) => ({ ...c, live: live[c.chunkIndex] ?? null })),
    active: isJobActive(job.id),
    usage: ocrUsageSnapshot(),
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
  if (isJobActive(job.id)) return fail(res, 409, "This job is still running.");
  const requeued = await retryOcrJob(job.id);
  res.json({ requeued });
});

router.post("/jobs/:id/cancel", async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return fail(res, 404, "OCR job not found.");
  const wasActive = cancelOcrJob(job.id);
  if (!wasActive && job.status === "queued") {
    await updateJob(job.id, { status: "cancelled", finishedAt: new Date() });
  }
  res.json({ cancelled: true, wasActive });
});

router.delete("/jobs/:id", async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return fail(res, 404, "OCR job not found.");
  cancelOcrJob(job.id);
  await deleteJob(job.id);
  res.json({ deleted: true });
});

router.post("/maintenance/purge", async (_req, res) => {
  const purged = await purgeExpiredJobs();
  pump();
  res.json({ purged });
});

export default router;
