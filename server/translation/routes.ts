/**
 * Admin-only translation queue API, mounted at /api/translation-jobs.
 *
 * Authorisation is applied at the mount point in server/routes.ts
 * (`requireAuth, requireAdmin`) — the same pair every other admin surface uses,
 * so there is no second login system and no route here can be reached by an
 * editor even if the UI were bypassed. 401 for anonymous, 403 for non-admin,
 * both decided on the server.
 *
 * Nothing in this file talks to Gemini: creating a job writes rows and returns.
 * The worker process does the work.
 */
import { Router } from "express";
import { z } from "zod";
import { otherTranslationLanguages, type TranslationItemStatus } from "@shared/schema";
import {
  listMantrasForGrantha,
  resolveGranthaByName,
} from "../../script/lib/hermex-grantha-sync";
import { hermexEnabled } from "../hermex-translate";
import { translationConfig } from "./config";
import {
  cancelTranslationJob,
  countItemsByStatus,
  createTranslationJob,
  ensureTranslationSchema,
  getTranslationJob,
  listProcessingItems,
  listRecentFailedItems,
  listTranslationItems,
  listTranslationJobs,
  listUpcomingItems,
  refreshJobProgress,
  resetAttemptsForJob,
  retryFailedItems,
  translationSummary,
  type NewTranslationItem,
} from "./store";

const router = Router();

function fail(res: any, status: number, message: string) {
  return res.status(status).json({ message });
}

/** Strapi documentIds are opaque alphanumeric ids — anything else is rejected
 *  before it can be interpolated into a CMS query string. */
const DOC_ID = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid documentId");

const ALLOWED_LANGUAGES = new Set<string>(otherTranslationLanguages as readonly string[]);

const createJobSchema = z
  .object({
    granthaDocId: DOC_ID.optional(),
    granthaName: z.string().trim().min(1).max(200).optional(),
    /** Empty/omitted = every language still missing on each mantra. */
    targetLanguages: z
      .array(z.string().trim())
      .max(ALLOWED_LANGUAGES.size)
      .optional()
      .default([]),
    /** Explicit list, when the caller already knows which mantras to translate. */
    items: z
      .array(
        z.object({
          mantraDocId: DOC_ID,
          mantraLabel: z.string().trim().max(200).optional(),
          originalText: z.string().max(100_000).optional(),
        }),
      )
      .max(translationConfig.maxItemsPerJob)
      .optional(),
  })
  .refine((v) => Boolean(v.granthaDocId || v.granthaName || v.items?.length), {
    message: "Provide a granthaDocId, a granthaName, or an explicit items array.",
  });

const itemStatuses: TranslationItemStatus[] = ["queued", "processing", "completed", "failed"];

/** The shape the admin UI renders for a job row. */
function jobView(job: any) {
  const total = job.totalItems || 0;
  const progress = total > 0 ? Number(((job.completedItems / total) * 100).toFixed(2)) : 0;
  return {
    id: job.id,
    job_id: job.id,
    status: job.status,
    grantha_name: job.granthaName,
    grantha_doc_id: job.granthaDocId,
    created_by: job.createdBy,
    target_languages: job.targetLanguages ?? [],
    total: total,
    completed: job.completedItems,
    processing: job.processingItems,
    queued: job.queuedItems,
    failed: job.failedItems,
    retry_count: job.retryCount,
    progress,
    error: job.error,
    created_at: job.createdAt,
    started_at: job.startedAt,
    last_activity_at: job.lastActivityAt,
    completed_at: job.completedAt,
  };
}

function itemView(item: any) {
  return {
    id: item.id,
    job_id: item.jobId,
    sequence_number: item.sequenceNumber,
    mantra_doc_id: item.mantraDocId,
    mantra_label: item.mantraLabel,
    status: item.status,
    attempts: item.attempts,
    error: item.error,
    translated_text: item.translatedText,
    created_at: item.createdAt,
    started_at: item.startedAt,
    completed_at: item.completedAt,
    last_attempt_at: item.lastAttemptAt,
    lease_expires_at: item.leaseExpiresAt,
  };
}

// ────────────────────────────────────────────────────────────── create a job
router.post("/", async (req: any, res) => {
  const parsed = createJobSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return fail(res, 400, parsed.error.issues[0]?.message || "Invalid request body.");
  }
  const body = parsed.data;

  const unknownLanguages = body.targetLanguages.filter((l) => !ALLOWED_LANGUAGES.has(l));
  if (unknownLanguages.length > 0) {
    return fail(res, 400, `Unsupported language(s): ${unknownLanguages.slice(0, 5).join(", ")}`);
  }

  try {
    await ensureTranslationSchema();

    let granthaDocId = body.granthaDocId ?? null;
    let granthaName = body.granthaName ?? null;
    let items: NewTranslationItem[];

    if (body.items?.length) {
      items = body.items.map((i) => ({
        mantraDocId: i.mantraDocId,
        mantraLabel: i.mantraLabel ?? i.mantraDocId,
        originalText: i.originalText ?? null,
      }));
    } else {
      // Resolve the grantha, then page its mantra list. This is a handful of
      // cheap list calls (100 ids per page, no deep populate) — the per-mantra
      // content is read by the worker at claim time, never here.
      if (!granthaDocId) {
        const resolved = await resolveGranthaByName(granthaName!);
        granthaDocId = resolved.documentId;
        granthaName = resolved.GranthaName;
      }
      const mantras = await listMantrasForGrantha(granthaDocId!);
      if (mantras.length === 0) {
        return fail(res, 404, `No mantras found for grantha ${granthaName ?? granthaDocId}.`);
      }
      if (mantras.length > translationConfig.maxItemsPerJob) {
        return fail(
          res,
          400,
          `This grantha has ${mantras.length} mantras; the per-job limit is ${translationConfig.maxItemsPerJob}.`,
        );
      }
      items = mantras.map((m) => ({ mantraDocId: m.documentId, mantraLabel: m.label }));
    }

    const job = await createTranslationJob({
      createdBy: req.user?.id ?? null,
      granthaDocId,
      granthaName,
      targetLanguages: body.targetLanguages,
      inputRef: granthaDocId ? `strapi:grantha/${granthaDocId}` : "explicit-items",
      items,
    });

    return res.status(201).json({
      job_id: job.id,
      status: job.status,
      total_items: job.totalItems,
      queued_items: job.queuedItems,
      worker_enabled: hermexEnabled(),
      job: jobView(job),
    });
  } catch (err: any) {
    return fail(res, err?.status || 500, err?.message || "Could not create the translation job.");
  }
});

// ─────────────────────────────────────────────────────────────────── listing
router.get("/", async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const page = Math.max(1, Number(req.query.page) || 1);
    const jobs = await listTranslationJobs(limit, (page - 1) * limit);
    const summary = await translationSummary();
    res.json({
      jobs: jobs.map(jobView),
      summary,
      page,
      limit,
      worker_enabled: hermexEnabled(),
    });
  } catch (err: any) {
    fail(res, 500, err?.message || "Could not list translation jobs.");
  }
});

/**
 * The queue across all jobs: what is running now, what is next, what failed.
 * Registered before `/:id` so "queue" is never read as a job id.
 */
router.get("/queue/overview", async (_req, res) => {
  try {
    const [processing, upcoming, failed, summary] = await Promise.all([
      listProcessingItems(10),
      listUpcomingItems(20),
      listRecentFailedItems(20),
      translationSummary(),
    ]);
    res.json({
      processing: processing.map(itemView),
      upcoming: upcoming.map(itemView),
      failed: failed.map(itemView),
      summary,
      worker_enabled: hermexEnabled(),
      server_now: new Date().toISOString(),
    });
  } catch (err: any) {
    fail(res, 500, err?.message || "Could not read the queue.");
  }
});

router.get("/:id", async (req, res) => {
  try {
    // Recount from the rows so a page refresh always shows the truth, even if
    // the worker died between its last write and now.
    const job = (await refreshJobProgress(req.params.id)) ?? (await getTranslationJob(req.params.id));
    if (!job) return fail(res, 404, "Translation job not found.");

    const counts = await countItemsByStatus(job.id);
    const [current] = await listProcessingItems(5);
    const failed = await listRecentFailedItems(10, job.id);

    res.json({
      ...jobView(job),
      counts,
      current_item: current && current.jobId === job.id ? itemView(current) : null,
      recent_errors: failed.map((f) => ({
        item: f.sequenceNumber,
        mantra: f.mantraLabel,
        attempts: f.attempts,
        error: f.error,
        last_attempt_at: f.lastAttemptAt,
      })),
      worker_enabled: hermexEnabled(),
      server_now: new Date().toISOString(),
    });
  } catch (err: any) {
    fail(res, 500, err?.message || "Could not read the translation job.");
  }
});

router.get("/:id/items", async (req, res) => {
  try {
    const job = await getTranslationJob(req.params.id);
    if (!job) return fail(res, 404, "Translation job not found.");

    const statusRaw = typeof req.query.status === "string" ? req.query.status : "";
    if (statusRaw && !itemStatuses.includes(statusRaw as TranslationItemStatus)) {
      return fail(res, 400, `status must be one of: ${itemStatuses.join(", ")}`);
    }

    const { items, page, limit, total } = await listTranslationItems(job.id, {
      status: (statusRaw || undefined) as TranslationItemStatus | undefined,
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 50,
    });

    res.json({
      items: items.map(itemView),
      page,
      limit,
      total,
      page_count: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err: any) {
    fail(res, 500, err?.message || "Could not list the job's items.");
  }
});

// ──────────────────────────────────────────────────────────────── operations
router.post("/:id/cancel", async (req, res) => {
  try {
    const job = await getTranslationJob(req.params.id);
    if (!job) return fail(res, 404, "Translation job not found.");
    if (job.status === "cancelled") return res.json({ cancelled: true, cancelledItems: 0 });

    const { cancelledItems } = await cancelTranslationJob(job.id);
    res.json({
      cancelled: true,
      cancelledItems,
      note: "Queued items were stopped. An item already in flight finishes first — Chrome is never killed mid-answer.",
    });
  } catch (err: any) {
    fail(res, 500, err?.message || "Could not cancel the job.");
  }
});

/** Retry every failed item of a job (optionally just one, via ?itemId=). */
async function handleRetry(req: any, res: any) {
  try {
    const job = await getTranslationJob(req.params.id);
    if (!job) return fail(res, 404, "Translation job not found.");

    const itemIdRaw = req.body?.itemId ?? req.query.itemId;
    const itemId = itemIdRaw == null || itemIdRaw === "" ? undefined : Number(itemIdRaw);
    if (itemId !== undefined && !Number.isInteger(itemId)) {
      return fail(res, 400, "itemId must be an integer.");
    }

    const { requeued } = await retryFailedItems(job.id, itemId);
    // An explicit admin retry buys a fresh attempt budget; without this an item
    // already at MAX_TRANSLATION_RETRIES would fail again on its first error.
    if (requeued > 0) await resetAttemptsForJob(job.id);
    const refreshed = await refreshJobProgress(job.id);
    res.json({ requeued, job: refreshed ? jobView(refreshed) : null });
  } catch (err: any) {
    fail(res, 500, err?.message || "Could not retry the failed items.");
  }
}

router.post("/:id/retry", handleRetry);
router.post("/:id/retry-failed", handleRetry);

export default router;
