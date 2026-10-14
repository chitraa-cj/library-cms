/**
 * Admin-only structure API, mounted at /api/admin/ocr/structure (so it inherits the
 * requireAuth + requireAdmin applied to the OCR mount in server/routes.ts).
 *
 * Everything the client can do is here: configure and start an analysis, poll it, read
 * the assembled structure, record review edits and answers, download the CSV, propose a
 * hierarchy mapping onto a destination grantha, and mark the import as applied.
 *
 * The one thing it will NOT do is write to the CMS. The generated CSV goes into the
 * existing grantha editor through the existing CSV import dialog, and the existing draft
 * Save / Save & Publish pipeline commits it — there is exactly one publishing mechanism
 * in this application and this feature does not add a second.
 */
import { Router } from "express";
import {
  normalizeHierarchyConfig,
  duplicateLevelNames,
  proposeHierarchyMapping,
  sectionLevelCount,
  STRUCTURE_MAX_DEPTH,
  formatUsd,
  type StructureHierarchyConfig,
  type StructureOverride,
} from "@shared/ocr-structure";
import { buildOcrDocument } from "../ocr/jobs";
import { getJob as getOcrJob } from "../ocr/store";
import { isStructureConfigured, sanitizeStructureError, structureConfig } from "./config";
import { structureSpend, structureUsageSnapshot } from "./limiter";
import {
  buildStructureResult,
  estimateStructureCostForPages,
  structureJobSpendUsd,
  cancelStructureJob,
  createStructureJob,
  isStructureJobActive,
  liveStructureChunk,
  pump,
  retryStructureJob,
} from "./jobs";
import {
  deleteStructureJob,
  ensureStructureSchema,
  getStructureJob,
  listStructureChunkStatuses,
  listStructureJobs,
  listStructureJobsForOcr,
  updateStructureJob,
} from "./store";

const router = Router();

function fail(res: any, status: number, message: string) {
  return res.status(status).json({ message });
}

/** Trim and bound the editor's instructions before they are stored or sent anywhere. */
function cleanInstructions(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  return trimmed ? trimmed.slice(0, structureConfig.maxInstructionChars) : null;
}

function parseConfig(body: any): { config: StructureHierarchyConfig } | { error: string } {
  const depth = Number(body?.depth);
  if (!Number.isFinite(depth) || depth < 1 || depth > STRUCTURE_MAX_DEPTH) {
    return { error: `Choose between 1 and ${STRUCTURE_MAX_DEPTH} hierarchy levels.` };
  }
  const names = Array.isArray(body?.levelNames) ? body.levelNames.map((n: unknown) => String(n ?? "").trim()) : [];
  if (names.length < depth || names.slice(0, depth).some((n: string) => !n)) {
    return { error: "Give every hierarchy level a name." };
  }
  if (names.some((n: string) => n.length > 60)) {
    return { error: "A hierarchy level name must be 60 characters or fewer." };
  }
  const config = normalizeHierarchyConfig({ depth: Math.floor(depth), levelNames: names });
  const dupes = duplicateLevelNames(config);
  if (dupes.length > 0) {
    return { error: `Two hierarchy levels are both called "${dupes[0]}". Give each level its own name.` };
  }
  return { config };
}

/** Only the override shapes `applyStructureOverrides` understands ever reach the row. */
function parseOverrides(input: unknown): StructureOverride[] | { error: string } {
  if (!Array.isArray(input)) return { error: "Expected an array of edits." };
  if (input.length > 20_000) return { error: "Too many edits in one request." };
  const out: StructureOverride[] = [];
  const allowedPatchKeys = new Set([
    "kind",
    "level",
    "number",
    "title",
    "text",
    "script",
    "teekaName",
    "language",
    "attachTo",
  ]);

  for (const raw of input) {
    if (!raw || typeof raw !== "object") return { error: "An edit was not an object." };
    const id = String((raw as any).id ?? "");
    if (!id || id.length > 120) return { error: "An edit has no valid item id." };
    const op = (raw as any).op;

    if (op === "delete") {
      out.push({ op: "delete", id });
    } else if (op === "merge") {
      out.push({ op: "merge", id });
    } else if (op === "split") {
      const at = Number((raw as any).at);
      if (!Number.isFinite(at) || at < 1) return { error: "A split edit has no valid offset." };
      out.push({ op: "split", id, at: Math.floor(at) });
    } else if (op === "move") {
      const after = (raw as any).after;
      out.push({ op: "move", id, after: after == null ? null : String(after).slice(0, 120) });
    } else if (op === "edit") {
      const patch = (raw as any).patch;
      if (!patch || typeof patch !== "object") return { error: "An edit has no patch." };
      const clean: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch)) {
        if (!allowedPatchKeys.has(key)) continue;
        if (key === "level") {
          const level = Number(value);
          if (Number.isFinite(level)) clean.level = Math.floor(level);
          continue;
        }
        if (typeof value === "string") clean[key] = value.slice(0, 200_000);
      }
      if (Object.keys(clean).length === 0) return { error: "An edit changes nothing." };
      out.push({ op: "edit", id, patch: clean as any });
    } else {
      return { error: `Unknown edit type "${String(op)}".` };
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────── config

router.get("/config", async (_req, res) => {
  // Force a fresh read: this is what the wizard shows next to the estimate, and a stale
  // "remaining budget" is worse than a slightly slower config call.
  const spend = await structureSpend(true).catch(() => ({ dayUsd: 0, monthUsd: 0 }));
  res.json({
    configured: isStructureConfigured(),
    model: structureConfig.model,
    effort: structureConfig.effort,
    limits: {
      maxDepth: STRUCTURE_MAX_DEPTH,
      maxPages: structureConfig.maxPages,
      pagesPerChunk: structureConfig.pagesPerChunk,
      maxInstructionChars: structureConfig.maxInstructionChars,
      confidenceThreshold: structureConfig.confidenceThreshold,
      maxRequestsPerJob: structureConfig.maxRequestsPerJob,
      maxSpendPerJobUsd: structureConfig.maxSpendPerJobUsd,
      maxSpendPerDayUsd: structureConfig.maxSpendPerDayUsd,
      maxSpendPerMonthUsd: structureConfig.maxSpendPerMonthUsd,
    },
    budget: {
      spentTodayUsd: spend.dayUsd,
      spentThisMonthUsd: spend.monthUsd,
      remainingTodayUsd: Math.max(0, structureConfig.maxSpendPerDayUsd - spend.dayUsd),
      remainingThisMonthUsd: Math.max(0, structureConfig.maxSpendPerMonthUsd - spend.monthUsd),
    },
    usage: structureUsageSnapshot(),
  });
});

/**
 * What analysing this OCR document would cost, before anything is started.
 *
 * The wizard shows this on the step before the Analyse button, with the remaining budget
 * beside it, so the decision to spend is made with the number in view rather than
 * discovered on an invoice.
 */
router.get("/estimate/:ocrJobId", async (req, res) => {
  const ocrJob = await getOcrJob(req.params.ocrJobId);
  if (!ocrJob) return fail(res, 404, "OCR job not found.");

  const { pages } = await buildOcrDocument(ocrJob.id);
  if (pages.length === 0) {
    return fail(res, 409, "This document has no transcribed pages yet.");
  }

  const estimate = estimateStructureCostForPages(pages);
  const spend = await structureSpend(true).catch(() => ({ dayUsd: 0, monthUsd: 0 }));
  const remainingToday = Math.max(0, structureConfig.maxSpendPerDayUsd - spend.dayUsd);
  const remainingMonth = Math.max(0, structureConfig.maxSpendPerMonthUsd - spend.monthUsd);

  const blockers: string[] = [];
  if (estimate.requests > structureConfig.maxRequestsPerJob) {
    blockers.push(
      `${estimate.requests} requests needed, over the per-document cap of ${structureConfig.maxRequestsPerJob}.`,
    );
  }
  if (structureConfig.maxSpendPerJobUsd > 0 && estimate.costUsd > structureConfig.maxSpendPerJobUsd) {
    blockers.push(
      `about ${formatUsd(estimate.costUsd)}, over the per-document cap of ${formatUsd(structureConfig.maxSpendPerJobUsd)}.`,
    );
  }
  if (structureConfig.maxSpendPerDayUsd > 0 && estimate.costUsd > remainingToday) {
    blockers.push(
      `about ${formatUsd(estimate.costUsd)}, over the ${formatUsd(remainingToday)} left in today's budget.`,
    );
  }
  if (structureConfig.maxSpendPerMonthUsd > 0 && estimate.costUsd > remainingMonth) {
    blockers.push(
      `about ${formatUsd(estimate.costUsd)}, over the ${formatUsd(remainingMonth)} left this month.`,
    );
  }

  res.json({
    pages: pages.length,
    estimate,
    model: structureConfig.model,
    budget: {
      spentTodayUsd: spend.dayUsd,
      spentThisMonthUsd: spend.monthUsd,
      remainingTodayUsd: remainingToday,
      remainingThisMonthUsd: remainingMonth,
      maxSpendPerJobUsd: structureConfig.maxSpendPerJobUsd,
    },
    withinBudget: blockers.length === 0,
    blockers,
  });
});

// ──────────────────────────────────────────────────────────────── job lifecycle

/** Analyses for one OCR document — the entry point the OCR page polls. */
router.get("/for-ocr/:ocrJobId", async (req, res) => {
  await ensureStructureSchema();
  const jobs = await listStructureJobsForOcr(req.params.ocrJobId);
  res.json({ jobs });
});

router.get("/jobs", async (_req, res) => {
  await ensureStructureSchema();
  const jobs = await listStructureJobs(40);
  res.json({ jobs, usage: structureUsageSnapshot() });
});

router.post("/jobs", async (req: any, res) => {
  if (!isStructureConfigured()) {
    return fail(
      res,
      503,
      "Claude is not configured on this server (ANTHROPIC_API_KEY is missing). Set it and restart.",
    );
  }
  const ocrJobId = String(req.body?.ocrJobId ?? "");
  if (!ocrJobId) return fail(res, 400, "Which OCR document? `ocrJobId` is required.");

  const ocrJob = await getOcrJob(ocrJobId);
  if (!ocrJob) return fail(res, 404, "OCR job not found.");
  if (ocrJob.chunksDone === 0) {
    return fail(res, 409, "This document has no transcribed pages yet. Wait for (or retry) the OCR run.");
  }

  const parsed = parseConfig(req.body);
  if ("error" in parsed) return fail(res, 400, parsed.error);

  try {
    const job = await createStructureJob({
      ocrJob,
      userId: req.user?.id ?? null,
      config: parsed.config,
      instructions: cleanInstructions(req.body?.instructions),
      voiceUsed: Boolean(req.body?.voiceUsed),
    });
    res.status(201).json({ job });
  } catch (err: any) {
    // A budget refusal is a 429 with the gate named, so the UI can say whether waiting
    // until tomorrow helps or an env var has to be raised.
    const status = err?.status || (err?.name === "StructureBudgetError" ? 429 : 500);
    res
      .status(status)
      .json({
        message: sanitizeStructureError(err) || "Could not start the analysis.",
        ...(err?.gate ? { code: err.gate } : {}),
      });
  }
});

/** Progress poll: job row, per-range status, and what the running range is doing. */
router.get("/jobs/:id", async (req, res) => {
  await ensureStructureSchema();
  const job = await getStructureJob(req.params.id);
  if (!job) return fail(res, 404, "Analysis not found.");
  const chunks = await listStructureChunkStatuses(job.id);
  res.json({
    job,
    chunks,
    active: isStructureJobActive(job.id),
    live: liveStructureChunk(job.id),
    spentUsd: structureJobSpendUsd(job),
    maxSpendPerJobUsd: structureConfig.maxSpendPerJobUsd,
    usage: structureUsageSnapshot(),
    serverNow: Date.now(),
  });
});

/**
 * The assembled structure: sections, verses, open questions, validation and the CSV
 * preview. Recomputed from the stored items on every call, so it always matches the
 * current edits.
 */
router.get("/jobs/:id/result", async (req, res) => {
  const job = await getStructureJob(req.params.id);
  if (!job) return fail(res, 404, "Analysis not found.");
  const result = await buildStructureResult(job);

  // `items` and the parked passages carry the whole transcription again, which is the
  // heaviest thing this API can send. The review needs them; a progress poll does not,
  // and shipping tens of MB every couple of seconds is exactly how a list endpoint has
  // stalled this event loop before. `?items=0` asks for the counts only.
  const includeItems = req.query.items !== "0";

  res.json({
    job: result.job,
    config: result.config,
    items: includeItems ? result.items : [],
    sections: result.structure.sections,
    verses: includeItems ? result.structure.verses : [],
    unassigned: includeItems ? result.structure.unassigned : [],
    ambiguities: result.structure.ambiguities,
    warnings: result.structure.warnings,
    teekaNames: result.structure.teekaNames,
    languages: result.structure.languages,
    stats: result.structure.stats,
    validation: result.validation,
    csv: { columns: result.csv.columns, rowCount: result.csv.rowCount, sectionLevels: result.csv.sectionLevels },
    workflowState: result.workflowState,
    missingRanges: result.missingRanges,
  });
});

/** Review edits and answered questions. Replaces the whole list (the client owns it). */
router.put("/jobs/:id/overrides", async (req, res) => {
  const job = await getStructureJob(req.params.id);
  if (!job) return fail(res, 404, "Analysis not found.");
  if (job.importStatus === "done") {
    return fail(res, 409, "This analysis has already been imported. Start a new one to change it.");
  }
  const parsed = parseOverrides(req.body?.overrides);
  if ("error" in parsed) return fail(res, 400, parsed.error);

  // Any edit re-opens the review: a structure that changed has not been approved.
  await updateStructureJob(job.id, { overrides: parsed, reviewedAt: null });
  const updated = await getStructureJob(job.id);
  const result = await buildStructureResult(updated!);
  res.json({
    job: result.job,
    items: result.items,
    sections: result.structure.sections,
    verses: result.structure.verses,
    unassigned: result.structure.unassigned,
    ambiguities: result.structure.ambiguities,
    stats: result.structure.stats,
    validation: result.validation,
    csv: { columns: result.csv.columns, rowCount: result.csv.rowCount, sectionLevels: result.csv.sectionLevels },
    workflowState: result.workflowState,
  });
});

/** "I have reviewed this" — the gate in front of export and import. */
router.post("/jobs/:id/review", async (req, res) => {
  const job = await getStructureJob(req.params.id);
  if (!job) return fail(res, 404, "Analysis not found.");
  const result = await buildStructureResult(job);
  if (!result.validation.ok) {
    return res.status(422).json({
      message: "The structure has errors that must be fixed before it can be exported.",
      validation: result.validation,
    });
  }
  await updateStructureJob(job.id, { reviewedAt: new Date() });
  const updated = await getStructureJob(job.id);
  res.json({ job: updated, workflowState: "ready_for_export" });
});

router.post("/jobs/:id/retry", async (req, res) => {
  const job = await getStructureJob(req.params.id);
  if (!job) return fail(res, 404, "Analysis not found.");
  if (isStructureJobActive(job.id)) return fail(res, 409, "This analysis is still running.");
  const requeued = await retryStructureJob(job.id);
  res.json({ requeued });
});

router.post("/jobs/:id/cancel", async (req, res) => {
  const job = await getStructureJob(req.params.id);
  if (!job) return fail(res, 404, "Analysis not found.");
  const wasActive = cancelStructureJob(job.id);
  if (!wasActive && job.status === "queued") {
    await updateStructureJob(job.id, { status: "cancelled", finishedAt: new Date() });
  }
  res.json({ cancelled: true, wasActive });
});

router.delete("/jobs/:id", async (req, res) => {
  const job = await getStructureJob(req.params.id);
  if (!job) return fail(res, 404, "Analysis not found.");
  cancelStructureJob(job.id);
  await deleteStructureJob(job.id);
  pump();
  res.json({ deleted: true });
});

// ────────────────────────────────────────────────────────────────── export leg

/** The CSV itself — the same bytes the direct upload hands to the import dialog. */
router.get("/jobs/:id/csv", async (req, res) => {
  const job = await getStructureJob(req.params.id);
  if (!job) return fail(res, 404, "Analysis not found.");
  const result = await buildStructureResult(job);
  if (!result.validation.ok) {
    return res.status(422).json({
      message: "The structure has errors that must be fixed before a CSV can be generated.",
      validation: result.validation,
    });
  }

  const ocrJob = await getOcrJob(job.ocrJobId);
  const stem = (ocrJob?.fileName ?? "grantha").replace(/\.[^.]+$/, "") || "grantha";

  if (req.query.download === "1") {
    // BOM so a double-click into Excel keeps Devanagari readable; parseCsv strips it.
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${encodeURIComponent(stem)}.csv"`);
    return res.send(`﻿${result.csv.csv}`);
  }

  res.json({
    csv: result.csv.csv,
    columns: result.csv.columns,
    rowCount: result.csv.rowCount,
    sectionLevels: result.csv.sectionLevels,
    fileName: `${stem}.csv`,
    config: result.config,
    validation: result.validation,
  });
});

/**
 * How the configured hierarchy maps onto a destination grantha's levels.
 *
 * The destination's structure comes from the client, which already holds it (the portal
 * keeps `structureConfig` in the draft, not in Strapi). Position decides the mapping,
 * never the name — see `proposeHierarchyMapping`.
 */
router.post("/jobs/:id/mapping", async (req, res) => {
  const job = await getStructureJob(req.params.id);
  if (!job) return fail(res, 404, "Analysis not found.");
  const result = await buildStructureResult(job);
  const target = req.body?.target ?? {};
  const proposal = proposeHierarchyMapping(result.config, {
    levelOneEnabled: target.levelOneEnabled,
    levelOneName: target.levelOneName,
    levelTwoEnabled: target.levelTwoEnabled,
    levelTwoName: target.levelTwoName,
    levelThreeEnabled: target.levelThreeEnabled,
    levelThreeName: target.levelThreeName,
    leafName: target.leafName,
  });

  // Teeka names in the document vs. the teekas configured on the destination grantha.
  const targetTeekas: Array<{ id: string; TeekaName?: string; TeekaAuthor?: string }> = Array.isArray(
    target.teekas,
  )
    ? target.teekas
    : [];
  const teekaMapping = result.structure.teekaNames.map((name) => {
    const match = targetTeekas.find(
      (t) =>
        (t.TeekaName ?? "").trim().toLowerCase() === name.toLowerCase() ||
        (t.TeekaAuthor ?? "").trim().toLowerCase() === name.toLowerCase(),
    );
    return {
      sourceName: name,
      targetId: match?.id ?? null,
      targetName: match?.TeekaName ?? null,
      exact: Boolean(match),
    };
  });

  res.json({
    mapping: proposal,
    teekas: teekaMapping,
    sectionLevels: sectionLevelCount(result.config),
    csvColumns: result.csv.columns,
    rowCount: result.csv.rowCount,
    alreadyImported:
      job.importStatus === "done"
        ? { granthaDocId: job.importGranthaDocId, at: job.importedAt, summary: job.importSummary }
        : null,
  });
});

/**
 * The editor reports what the import actually did.
 *
 * This is the idempotency guard for the direct-upload leg: a job that has already been
 * applied refuses a second report unless the caller passes `force` (the dialog asks the
 * user first), so a double-click or a re-opened tab cannot quietly import a document
 * twice. The CMS write itself is the existing draft Save / Save & Publish pipeline — the
 * state recorded here is a record of it, never a substitute for it.
 */
router.post("/jobs/:id/import", async (req, res) => {
  const job = await getStructureJob(req.params.id);
  if (!job) return fail(res, 404, "Analysis not found.");

  const status = String(req.body?.status ?? "");
  if (!["running", "done", "failed"].includes(status)) {
    return fail(res, 400, 'Status must be "running", "done" or "failed".');
  }
  if (job.importStatus === "done" && !req.body?.force) {
    return res.status(409).json({
      message: "This analysis has already been imported into a grantha.",
      importedAt: job.importedAt,
      granthaDocId: job.importGranthaDocId,
      summary: job.importSummary,
    });
  }
  if (status !== "running" && !job.reviewedAt) {
    return fail(res, 409, "Confirm the review before recording an import.");
  }

  const summary = req.body?.summary && typeof req.body.summary === "object" ? req.body.summary : null;
  await updateStructureJob(job.id, {
    importStatus: status as any,
    importGranthaDocId:
      typeof req.body?.granthaDocId === "string" ? req.body.granthaDocId.slice(0, 200) : job.importGranthaDocId,
    importSummary: summary,
    importedAt: status === "done" ? new Date() : job.importedAt,
    error: status === "failed" ? sanitizeStructureError(req.body?.error) || "Import failed." : job.error,
  });
  const updated = await getStructureJob(job.id);
  res.json({ job: updated });
});

export default router;
