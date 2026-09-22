#!/usr/bin/env node --import tsx
/**
 * OCR Docs pipeline - unit tests (no DB, no network by default).
 * ==============================================================
 * Locks in the rules the chunked transcription depends on:
 *   1. a document is split into contiguous, gapless, capped page ranges
 *   2. a page range slices out of the source PDF as its own small PDF
 *   3. page markers in the model answer map back to absolute page numbers,
 *      and a missing marker degrades to one block instead of losing text
 *   4. transcribed text is HTML-escaped before it is ever rendered as markup
 *
 * Run:        node --import tsx tests/ocr-pipeline.test.mjs
 * With live Gemini round-trip (spends ~1 request):
 *             node --import tsx tests/ocr-pipeline.test.mjs --live
 */

// dotenv first: server/ocr/config reads GEMINI_API_KEY at module load.
import "dotenv/config";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { PdfSlicer, planChunks, fitChunkSize, readPdfPageCount } from "../server/ocr/pdf.ts";
import { splitChunkPages, ocrChunkWithGemini } from "../server/ocr/gemini.ts";
import { renderOcrMarkdown, escapeHtml } from "../client/src/lib/ocr-markdown.ts";

let PASS = 0;
const FAILURES = [];

function check(name, condition, detail = "") {
  if (condition) {
    PASS++;
    console.log(`  ok  ${name}`);
  } else {
    FAILURES.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

async function makeSamplePdf(pageCount) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Sample page ${i}`, { x: 72, y: 700, size: 24, font, color: rgb(0, 0, 0) });
    page.drawText(`The quick brown fox on page ${i}.`, { x: 72, y: 660, size: 13, font });
  }
  return Buffer.from(await doc.save());
}

// ── 1. chunk planning ────────────────────────────────────────────────────────
console.log("\nchunk planning");
{
  const ranges = planChunks(100, 8);
  check("covers every page exactly once", ranges.length === 13 && ranges[0].startPage === 1 && ranges.at(-1).endPage === 100);
  const gapless = ranges.every((r, i) => (i === 0 ? r.startPage === 1 : r.startPage === ranges[i - 1].endPage + 1));
  check("ranges are contiguous with no gaps", gapless);
  check("no range exceeds the chunk size", ranges.every((r) => r.endPage - r.startPage + 1 <= 8));
  check("a single page yields one range", planChunks(1, 8).length === 1);
  check("a chunk size above the page count yields one range", planChunks(5, 50).length === 1);

  // A heavy scan must shrink pages-per-request so one request stays inline-able.
  const heavy = fitChunkSize(20, 300 * 1024 * 1024, 300); // 1MB/page
  check("heavy scans shrink the chunk size", heavy < 20 && heavy >= 1, `got ${heavy}`);
  const light = fitChunkSize(8, 2 * 1024 * 1024, 300); // ~7KB/page
  check("light documents keep the requested chunk size", light === 8, `got ${light}`);
}

// ── 2. PDF slicing ───────────────────────────────────────────────────────────
console.log("\npdf slicing");
{
  const bytes = await makeSamplePdf(12);
  check("page count is read from the file", (await readPdfPageCount(bytes)) === 12);

  const slicer = await PdfSlicer.load(bytes);
  const slice = await slicer.slice(5, 8);
  const sliced = await PDFDocument.load(slice);
  check("slice holds exactly the requested pages", sliced.getPageCount() === 4);
  check("slice is much smaller than the source", slice.byteLength < bytes.byteLength);

  const tail = await slicer.slice(11, 99); // clamped to the last page
  check("an over-long range clamps to the document end", (await PDFDocument.load(tail)).getPageCount() === 2);

  let rejected = false;
  try {
    await slicer.slice(50, 60);
  } catch {
    rejected = true;
  }
  check("a range past the end is rejected", rejected);
}

// ── 3. page marker parsing ───────────────────────────────────────────────────
console.log("\npage marker parsing");
{
  const answer = ["<<<PAGE:11>>>", "# Eleven", "body eleven", "", "<<<PAGE:12>>>", "body twelve"].join("\n");
  const pages = splitChunkPages(answer, 11, 12);
  check("one entry per marker", pages.length === 2);
  check("absolute page numbers are kept", pages[0].page === 11 && pages[1].page === 12);
  check("body text follows its marker", pages[0].markdown.includes("Eleven") && pages[1].markdown === "body twelve");

  const noMarkers = splitChunkPages("plain transcription with no markers", 7, 9);
  check("a missing marker keeps the text as one block", noMarkers.length === 1 && noMarkers[0].page === 7);
  check("no text is dropped when markers are missing", noMarkers[0].markdown.includes("plain transcription"));

  const wrongNumbers = splitChunkPages("<<<PAGE:1>>>\na\n<<<PAGE:2>>>\nb", 40, 41);
  check("out-of-range markers fall back to positional numbering", wrongNumbers[0].page === 40 && wrongNumbers[1].page === 41);
}

// ── 4. rendering is escape-first ─────────────────────────────────────────────
console.log("\nmarkdown rendering");
{
  const html = renderOcrMarkdown('A scan containing <script>alert("x")</script> text');
  check("angle brackets in transcribed text are escaped", !html.includes("<script>") && html.includes("&lt;script&gt;"));
  check("quotes are escaped", escapeHtml('"') === "&quot;");

  const structured = renderOcrMarkdown(
    ["# Heading", "", "Some **bold** and *italic*.", "", "- one", "- two", "", "| a | b |", "| - | - |", "| 1 | 2 |", "", "> quoted"].join("\n"),
  );
  check("headings render", structured.includes("<h1"));
  check("emphasis renders", structured.includes("<strong>bold</strong>") && structured.includes("<em>italic</em>"));
  check("lists render", structured.includes("<ul") && (structured.match(/<li>/g) || []).length === 2);
  check("tables render with a header row", structured.includes("<table") && structured.includes("<th"));
  check("block quotes render", structured.includes("<blockquote"));

  const devanagari = renderOcrMarkdown("ॐ असतो मा सद्गमय");
  check("Devanagari survives rendering unchanged", devanagari.includes("ॐ असतो मा सद्गमय"));
}

// ── 5. rate limiting ─────────────────────────────────────────────────────────
console.log("\nrate limiting");
{
  const { acquireOcrSlot, ocrUsageSnapshot } = await import("../server/ocr/limiter.ts");
  const { ocrConfig } = await import("../server/ocr/config.ts");
  const cap = ocrConfig.concurrency;

  const releases = [];
  for (let i = 0; i < cap; i++) releases.push(await acquireOcrSlot());
  check("slots are handed out up to the concurrency cap", ocrUsageSnapshot().inFlight === cap);

  let granted = false;
  const overflow = acquireOcrSlot().then((release) => {
    granted = true;
    return release;
  });
  await new Promise((r) => setTimeout(r, 150));
  check("a request over the cap waits instead of proceeding", granted === false && ocrUsageSnapshot().queued === 1);

  releases[0]();
  const overflowRelease = await overflow;
  check("releasing a slot wakes exactly one waiter", granted === true && ocrUsageSnapshot().queued === 0);

  overflowRelease();
  overflowRelease(); // releasing twice must not corrupt the count
  for (const release of releases.slice(1)) release();
  check("every slot is returned", ocrUsageSnapshot().inFlight === 0);
  check("the day counter tracked every grant", ocrUsageSnapshot().today >= cap + 1);
}

// ── 6. progress estimate ─────────────────────────────────────────────────────
console.log("\nprogress estimate");
{
  const { estimateJob } = await import("../server/ocr/estimate.ts");
  const now = 1_000_000;
  const base = { now, concurrency: 4, requestsPerMinute: 12, historicalMsPerPage: null, quality: "fast", startedAt: now - 90_000, running: true };
  const chunk = (i, start, end, status, durationMs = 0) => ({ chunkIndex: i, startPage: start, endPage: end, status, durationMs });

  // Nothing finished yet: a guess, clearly labelled, never null while running.
  const fresh = estimateJob({ ...base, live: {}, chunks: [chunk(0, 1, 8, "running"), chunk(1, 9, 16, "running"), chunk(2, 17, 17, "queued")] });
  check("pages are counted by state", fresh.pagesTotal === 17 && fresh.pagesDone === 0 && fresh.pagesRunning === 16 && fresh.pagesQueued === 1);
  check("elapsed comes from the job start", fresh.elapsedMs === 90_000);
  check("a running job always gets an ETA", typeof fresh.etaMs === "number" && fresh.etaMs > 0);
  check("with nothing measured the basis is a guess", fresh.basis === "guess");

  // Historical figure beats the guess.
  const hist = estimateJob({ ...base, historicalMsPerPage: 2_000, live: {}, chunks: [chunk(0, 1, 8, "running")] });
  check("earlier jobs' timing is used when this job has none", hist.basis === "historical" && hist.msPerPage === 2_000);

  // A finished range of this job beats both.
  const measured = estimateJob({ ...base, historicalMsPerPage: 2_000, live: {}, chunks: [chunk(0, 1, 8, "done", 40_000), chunk(1, 9, 16, "queued")] });
  check("this job's own ranges set the pace", measured.basis === "measured" && measured.msPerPage === 4_000, `got ${measured.msPerPage}`);
  check("remaining time follows the measured pace", measured.etaMs === 40_000, `got ${measured.etaMs}`);

  // A short finished range must not make long ranges look slow: 1 page in 31s
  // is mostly request overhead, not 31s of per-page work.
  const mixed = estimateJob({ ...base, live: {}, chunks: [chunk(0, 17, 17, "done", 31_000), chunk(1, 1, 8, "queued")] });
  check("a short finished range does not inflate the per-page pace", mixed.msPerPage <= 24_000, `got ${mixed.msPerPage}`);

  // A range sleeping out a 503 pushes the ETA out by its backoff and is counted as retrying.
  const backoff = estimateJob({
    ...base,
    historicalMsPerPage: 5_000,
    chunks: [chunk(0, 1, 8, "running")],
    live: { 0: { model: "m", attempt: 1, maxAttempts: 4, phase: "backoff", startedAt: now - 10_000, phaseStartedAt: now, nextAttemptAt: now + 30_000, lastError: "Gemini 503" } },
  });
  check("a backoff wait is added to the ETA", backoff.etaMs >= 30_000 + 8 * 5_000, `got ${backoff.etaMs}`);
  check("retrying ranges are counted", backoff.retrying === 1);

  // An in-flight request never claims to be almost done.
  const inflight = estimateJob({
    ...base,
    historicalMsPerPage: 5_000,
    chunks: [chunk(0, 1, 8, "running")],
    live: { 0: { model: "m", attempt: 1, maxAttempts: 4, phase: "request", startedAt: now - 200_000, phaseStartedAt: now - 200_000, nextAttemptAt: null, lastError: null } },
  });
  check("an overdue request keeps a floor on its remaining time", inflight.etaMs >= 0.25 * (8 * 5_000 + 8_000) - 1, `got ${inflight.etaMs}`);

  // Many queued ranges cannot start faster than the per-minute cap.
  const many = Array.from({ length: 60 }, (_, i) => chunk(i, i * 2 + 1, i * 2 + 2, "queued"));
  const capped = estimateJob({ ...base, historicalMsPerPage: 100, live: {}, chunks: many });
  check("the per-minute cap floors the ETA", capped.etaMs >= (60 / 12) * 60_000, `got ${capped.etaMs}`);

  // Finished: no ETA, elapsed kept.
  const finished = estimateJob({ ...base, running: false, endedAt: now - 30_000, live: {}, chunks: [chunk(0, 1, 8, "done", 40_000)] });
  check("a finished job has no ETA", finished.etaMs === null && finished.basis === null && finished.pagesDone === 8);
  check("a finished job's elapsed stops at its finish time", finished.elapsedMs === 60_000, `got ${finished.elapsedMs}`);
}

// ── 7. an overloaded model hands over instead of retrying four times ─────────
console.log("\n503 hand-over");
{
  const { ocrConfig } = await import("../server/ocr/config.ts");
  const { OcrGeminiError } = await import("../server/ocr/gemini.ts");
  const realFetch = globalThis.fetch;
  const realKey = ocrConfig.apiKey;
  const realBase = ocrConfig.retryBaseDelayMs;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: "This model is currently experiencing high demand." } }), {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "0" },
    });
  };
  // ocrConfig is frozen by `as const` at the type level only; set what the test needs.
  Object.assign(ocrConfig, { apiKey: realKey || "test-key", retryBaseDelayMs: 250 });
  try {
    const events = [];
    let thrown = null;
    try {
      await ocrChunkWithGemini({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "application/pdf",
        model: "busy-model",
        startPage: 1,
        endPage: 2,
        totalPages: 2,
        overloadAttempts: 2,
        onProgress: (e) => events.push(e),
      });
    } catch (err) {
      thrown = err;
    }
    check("the call fails after the overload cap", thrown instanceof OcrGeminiError, String(thrown));
    check("only two requests were spent on the busy model", calls === 2 && thrown?.attempts === 2, `calls=${calls} attempts=${thrown?.attempts}`);
    check("the error is flagged as overloaded so the worker can hand over", thrown?.overloaded === true && thrown?.retryable === true);
    check("progress reported each attempt and the backoff between them",
      events.filter((e) => e.kind === "attempt").length === 2 && events.some((e) => e.kind === "backoff" && /503/.test(e.error)));
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(ocrConfig, { apiKey: realKey, retryBaseDelayMs: realBase });
  }
}

// ── 8. optional live Gemini round-trip ───────────────────────────────────────
if (process.argv.includes("--live")) {
  console.log("\nlive gemini round-trip");
  const bytes = await makeSamplePdf(3);
  const slicer = await PdfSlicer.load(bytes);
  const slice = await slicer.slice(1, 3);
  const result = await ocrChunkWithGemini({
    bytes: slice,
    mimeType: "application/pdf",
    model: process.env.OCR_MODEL_FAST || "gemini-3.8-flash",
    startPage: 1,
    endPage: 3,
    totalPages: 3,
  });
  const pages = splitChunkPages(result.text, 1, 3);
  check("gemini returned text", result.text.trim().length > 0);
  check("gemini emitted one marker per page", pages.length === 3, `got ${pages.length}`);
  check("page 2 transcription mentions page 2", /page 2/i.test(pages[1]?.markdown ?? ""));
  check("usage is reported", result.inputTokens > 0 && result.outputTokens > 0);
  console.log(`  (used ${result.attempts} request, ${result.inputTokens} in / ${result.outputTokens} out tokens)`);
}

console.log(`\n${PASS} passed, ${FAILURES.length} failed`);
if (FAILURES.length > 0) {
  for (const f of FAILURES) console.error(` - ${f}`);
  process.exit(1);
}
