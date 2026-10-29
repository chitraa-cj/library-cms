/**
 * OCR Docs — the local engine. No database, no network, no AI provider.
 * =====================================================================
 *   1. quality rules: normalization keeps every meaningful code point, the text-layer
 *      check, review flags;
 *   2. Tesseract output parsing (TSV, OSD) and per-page language choice;
 *   3. the page decision with FAKE engines: a usable text layer means no OCR call at
 *      all, "Always OCR" forces it, a bad layer falls through and is flagged;
 *   4. a range: page order, markers, bounded retry of transient failures, permanent
 *      failures, a missing engine stops the job, cancellation;
 *   5. rendering is escape-first and never interprets OCR text as Markdown;
 *   6. the ETA estimator and the CPU-lane semaphore;
 *   7. REAL poppler + Tesseract on fixtures in tests/fixtures/ocr (skipped, loudly, when
 *      the engine is not installed): text PDF → no OCR; scanned PDF → OCR with page
 *      order kept and a measured character error rate; corrupt input fails safely.
 *
 * Run:  npm run test:ocr-local-engine
 *       (macOS/Homebrew: OCR_TESSERACT_BIN=/opt/homebrew/bin/tesseract and an
 *        OCR_TESSDATA_DIR holding san + script/Latin + osd)
 */
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "ocr");

const quality = await import("../shared/ocr-quality.ts");
const { parseTesseractTsv, parseOsdScript } = await import("../server/ocr/local-engine.ts");
const { languageCandidates, recognizeBest, processPage } = await import("../server/ocr/engine.ts");
const { transcribeRange, OcrTranscribeError, classifyOcrFailure } = await import("../server/ocr/transcribe.ts");
const { splitChunkPages, formatPageMarker } = await import("../server/ocr/pages.ts");
const { planChunks, readPdfPageCount } = await import("../server/ocr/pdf.ts");
const { ProcessError } = await import("../server/lib/run-process.ts");
const { renderOcrPlainText, renderOcrMarkdown } = await import("../client/src/lib/ocr-markdown.ts");

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
const skip = (name, why) => {
  SKIP++;
  console.log(`  SKIP ${name} — ${why}`);
};

const SETTINGS = {
  languages: { devanagari: "san", latin: "script/Latin", fallback: "san+script/Latin" },
  acceptConfidence: 60,
  lowPageConfidence: 55,
  lowWordConfidence: 30,
};

// ── 1. quality rules ─────────────────────────────────────────────────────────
console.log("\nnormalization keeps meaning, drops only engine artefacts");
{
  const ZWNJ = "‌";
  const raw = `जगत्${ZWNJ} ।\r\nतेन त्यक्तेन   \n\n\n\nक${"्"}${ZWNJ}ष\f`;
  const out = quality.normalizeOcrText(raw);
  check("a word-final virama+ZWNJ loses the ZWNJ", out.startsWith("जगत् ।"), JSON.stringify(out));
  check("a ZWNJ between consonants (blocks a conjunct) is kept", out.includes(`क${"्"}${ZWNJ}ष`));
  check("CRLF, trailing spaces, form feeds and blank runs are tidied", !/\r|\f| +\n|\n{3}/.test(out));
  const vedic = "इदꣳ सर्वं ॐ ऽ ॥ १ ॥ kiñca gṛdhaḥ";
  check("Vedic signs, avagraha, dandas, Devanagari digits and IAST survive untouched", quality.normalizeOcrText(vedic) === vedic);
  const decomposed = "é"; // e + combining acute: NFC would compose it
  check("no Unicode normalization form is applied", quality.normalizeOcrText(decomposed) === decomposed);
}

console.log("\nthe PDF text-layer check");
{
  const good = "ईशा वास्यमिदꣳ सर्वं यत्किञ्च जगत्यां जगत् । तेन त्यक्तेन भुञ्जीथा मा गृधः";
  check("a real Devanagari layer is usable", quality.assessEmbeddedText(good).usable);
  check("a folio-only layer on a scan is not", !quality.assessEmbeddedText("  ४२ \n").usable);
  check("private-use code points (unmapped font) are rejected", !quality.assessEmbeddedText(good + "").usable);
  check("replacement characters are rejected", !quality.assessEmbeddedText(good + "�".repeat(5)).usable);
}

console.log("\nreview flags");
{
  const t = { lowPageConfidence: 55 };
  check("an empty page is flagged empty", quality.assessPage({ text: "", confidence: null, lowConfidenceWords: 0, wordCount: 0, thresholds: t }).includes("empty"));
  check("a low-confidence page is flagged", quality.assessPage({ text: "x".repeat(80), confidence: 30, lowConfidenceWords: 5, wordCount: 10, thresholds: t }).includes("low_confidence"));
  check("low-confidence words alone get their own flag", quality.assessPage({ text: "x".repeat(80), confidence: 80, lowConfidenceWords: 2, wordCount: 10, thresholds: t }).join() === "low_confidence_words");
  const loop = Array(5).fill("ॐ पूर्णमदः पूर्णमिदं").join("\n");
  check("a recognition loop (repeated lines) is flagged", quality.hasRepeatedLines(loop));
  check("ordinary refrains are not", !quality.hasRepeatedLines("॥ १ ॥\nपूर्णस्य पूर्णमादाय\n॥ २ ॥\nईशा वास्यमिदं"));
  check("invalid Unicode is flagged", quality.assessPage({ text: "ok text here \uD800 more", confidence: 90, lowConfidenceWords: 0, wordCount: 3, thresholds: t }).includes("invalid_unicode"));
}

// ── 2. Tesseract output ───────────────────────────────────────────────────────
console.log("\nTesseract TSV and OSD parsing");
{
  const H = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";
  const row = (b, p, l, w, conf, text) => `5\t1\t${b}\t${p}\t${l}\t${w}\t0\t0\t0\t0\t${conf}\t${text}`;
  const tsv = [H, "1\t1\t0\t0\t0\t0\t0\t0\t0\t0\t-1\t", row(1, 1, 1, 1, 90, "ईशा"), row(1, 1, 1, 2, 10, "वास्यमिदाबि"), row(1, 1, 2, 1, 80, "तेन"), row(2, 1, 1, 1, 70, "॥")].join("\n");
  const r = parseTesseractTsv(tsv, 30);
  check("words join into lines, lines into paragraphs", r.text === "ईशा वास्यमिदाबि\nतेन\n\n॥", JSON.stringify(r.text));
  check("low-confidence words are listed", r.lowConfidenceWords.join() === "वास्यमिदाबि");
  check("confidence is weighted by word length", r.confidence > 10 && r.confidence < 90 && r.wordCount === 4);
  check("an empty TSV is an empty page, not an error", parseTesseractTsv(H, 30).text === "" && parseTesseractTsv(H, 30).confidence === null);
  check("OSD script is read", parseOsdScript("Page number: 0\nScript: Devanagari\nScript confidence: 2.2") === "Devanagari");
  check("no script line → null", parseOsdScript("Too few characters") === null);
}

console.log("\nlanguage choice");
{
  check("Devanagari pages try san first", languageCandidates("Devanagari", SETTINGS.languages)[0] === "san");
  check("Latin pages try script/Latin first", languageCandidates("Latin", SETTINGS.languages)[0] === "script/Latin");
  check("unknown script tries the combined set first", languageCandidates(null, SETTINGS.languages)[0] === "san+script/Latin");
  check("every set stays available, once each", languageCandidates("Latin", SETTINGS.languages).length === 3);

  const calls = [];
  const fake = (scores) => ({
    label: "fake",
    detectScript: async () => null,
    recognize: async (_img, langs) => {
      calls.push(langs);
      return { text: langs, confidence: scores[langs], wordCount: 1, lowConfidenceWords: [] };
    },
  });
  const first = await recognizeBest(fake({ a: 80, b: 90 }), "x", ["a", "b"], 60);
  check("a confident first set is accepted without trying more", first.languages === "a" && calls.length === 1);
  calls.length = 0;
  const best = await recognizeBest(fake({ a: 20, b: 50, c: 40 }), "x", ["a", "b", "c"], 60);
  check("otherwise the most confident of all sets wins", best.languages === "b" && calls.length === 3);
}

// ── 3. the page decision ──────────────────────────────────────────────────────
console.log("\npage decision (fake engines)");
function fakeDeps({ layer = "", ocrText = "OCR TEXT", conf = 80, script = "Devanagari", failRender } = {}) {
  const log = { extract: 0, render: 0, recognize: 0 };
  return {
    log,
    deps: {
      embedded: { extractPageText: async () => (log.extract++, layer) },
      rasterizer: {
        renderPage: async (_p, page) => {
          log.render++;
          const failure = failRender?.(page);
          if (failure) throw failure;
          return `/tmp/page-${page}.png`;
        },
      },
      recognizer: {
        label: "tesseract-fake",
        detectScript: async () => script,
        recognize: async () => (log.recognize++, { text: ocrText, confidence: conf, wordCount: 3, lowConfidenceWords: [] }),
      },
    },
  };
}
const GOOD_LAYER = "ईशा वास्यमिदꣳ सर्वं यत्किञ्च जगत्यां जगत् । तेन त्यक्तेन भुञ्जीथा";
{
  const a = fakeDeps({ layer: GOOD_LAYER });
  const out = await processPage({ kind: "pdf", path: "x.pdf", page: 3 }, { textMode: "auto", dpi: 200, workDir: "/tmp" }, a.deps, SETTINGS);
  check("a usable text layer is used as is", out.meta.source === "embedded" && out.text === GOOD_LAYER);
  check("…and NO page is rendered or recognised", a.log.render === 0 && a.log.recognize === 0);

  const b = fakeDeps({ layer: GOOD_LAYER });
  const forced = await processPage({ kind: "pdf", path: "x.pdf", page: 3 }, { textMode: "ocr", dpi: 200, workDir: "/tmp" }, b.deps, SETTINGS);
  check("'Always OCR' skips the text layer entirely", forced.meta.source === "ocr" && b.log.extract === 0 && b.log.recognize === 1);

  const c = fakeDeps({ layer: GOOD_LAYER + "".repeat(10) });
  const rejected = await processPage({ kind: "pdf", path: "x.pdf", page: 1 }, { textMode: "auto", dpi: 200, workDir: "/tmp" }, c.deps, SETTINGS);
  check("an unusable layer falls through to OCR", rejected.meta.source === "ocr");
  check("…and the page says why", rejected.meta.flags.includes("embedded_text_rejected"));

  const d = fakeDeps({});
  const image = await processPage({ kind: "image", path: "scan.png", page: 1 }, { textMode: "auto", dpi: 200, workDir: "/tmp" }, d.deps, SETTINGS);
  check("an image is recognised directly (no render, no text layer)", image.meta.source === "ocr" && d.log.render === 0 && d.log.extract === 0);
  check("the page records which engine and language set read it", image.meta.engine === "tesseract-fake (san)");
}

// ── 4. a page range ──────────────────────────────────────────────────────────
console.log("\npage ranges");
const range = (deps, extra = {}) =>
  transcribeRange({
    sourcePath: "x.pdf",
    mimeType: "application/pdf",
    startPage: 4,
    endPage: 6,
    textMode: "ocr",
    dpi: 200,
    workDir: path.join(os.tmpdir(), `ocr-unit-${process.pid}-${Math.random()}`),
    deps,
    settings: SETTINGS,
    maxAttempts: 3,
    retryBaseDelayMs: 5,
    ...extra,
  });
{
  const pageText = (n) => `page body ${n} ॥ ${n} ॥`;
  const deps = fakeDeps().deps;
  deps.recognizer.recognize = async (img) => {
    const n = Number(/page-(\d+)/.exec(img)[1]);
    return { text: pageText(n), confidence: 85, wordCount: 4, lowConfidenceWords: [] };
  };
  const out = await range(deps);
  const pages = splitChunkPages(out.markdown, 4, 6);
  check("every page of the range is present, in order, once", pages.map((p) => p.page).join() === "4,5,6");
  check("each page carries its own text", pages.every((p) => p.markdown === pageText(p.page)));
  check("raw output is kept beside the normalized text", splitChunkPages(out.raw, 4, 6).length === 3);
  check("per-page metadata matches the pages", out.pages.map((m) => m.page).join() === "4,5,6");
  check("markers are the established format", out.markdown.startsWith(formatPageMarker(4)));

  // Transient failure on page 5, twice, then success.
  let flaky = 0;
  const transientDeps = fakeDeps({
    failRender: (page) => (page === 5 && flaky++ < 2 ? new ProcessError("killed", "pdftoppm was killed by SIGKILL.") : null),
  }).deps;
  const recovered = await range(transientDeps);
  check("a transient failure is retried and the range still completes", recovered.pages.length === 3 && flaky === 3, `flaky=${flaky}`);

  // A corrupt page: permanent, no retry.
  let corruptCalls = 0;
  const corrupt = fakeDeps({ failRender: () => (corruptCalls++, new ProcessError("exit", "pdftoppm exited 1: Syntax Error")) });
  let caught = null;
  try {
    await range(corrupt.deps);
  } catch (err) {
    caught = err;
  }
  check("a bad page fails the range as bad input", caught instanceof OcrTranscribeError && caught.kind === "bad_input" && caught.page === 4);
  check("…without retrying a permanent error", corruptCalls === 1, `calls=${corruptCalls}`);

  const missing = fakeDeps({ failRender: () => new ProcessError("missing", "pdftoppm is not installed or not on PATH.") });
  try {
    await range(missing.deps);
  } catch (err) {
    caught = err;
  }
  check("a missing engine is fatal for the job (every page would fail)", caught?.fatal === true);
  check("a missing language pack is configuration, not input",
    classifyOcrFailure(new ProcessError("exit", "tesseract exited 1", { stderr: "Failed loading language 'san'" })) === "engine_unavailable");

  const controller = new AbortController();
  controller.abort();
  try {
    await range(fakeDeps().deps, { signal: controller.signal });
  } catch (err) {
    caught = err;
  }
  check("a cancelled range stops cleanly", caught?.kind === "cancelled");
}

// ── 5. rendering ─────────────────────────────────────────────────────────────
console.log("\nrendering");
{
  const html = renderOcrPlainText("| १ |\n# not a heading\n<script>alert(1)</script>\n\nनमः");
  check("OCR text is escaped before anything else", html.includes("&lt;script&gt;") && !html.includes("<script>"));
  check("a danda read as '|' is not turned into a table", !html.includes("<table") && html.includes("| १ |"));
  check("a leading '#' is not turned into a heading", !html.includes("<h") && html.includes("# not a heading"));
  check("line breaks and paragraphs are kept", html.includes("<br />") && html.split("<p").length === 3);
  check("legacy Markdown pages still render as before", renderOcrMarkdown("# Title").includes("<h"));
}

// ── 6. estimate + lanes ──────────────────────────────────────────────────────
console.log("\nETA and CPU lanes");
{
  const { estimateJob } = await import("../server/ocr/estimate.ts");
  const now = 1_000_000;
  const chunk = (i, status, durationMs = 0) => ({ chunkIndex: i, startPage: i + 1, endPage: i + 1, status, durationMs });
  const base = { now, concurrency: 2, requestsPerMinute: 0, historicalMsPerPage: null, quality: "fast", startedAt: now - 5_000, running: true, live: {} };
  const guess = estimateJob({ ...base, chunks: [chunk(0, "queued"), chunk(1, "queued")], guessMsPerPage: { fast: 2_500, accurate: 4_000 }, rangeOverheadMs: 500 });
  check("a fresh local job is a labelled guess at local speed", guess.basis === "guess" && guess.msPerPage === 2_500);
  const measured = estimateJob({ ...base, chunks: [chunk(0, "done", 1_500), chunk(1, "queued")], rangeOverheadMs: 500 });
  check("measured pages set the pace", measured.basis === "measured" && measured.msPerPage === 1_000, `got ${measured.msPerPage}`);
  check("no request-rate floor applies to a local engine", measured.etaMs === 1_500, `got ${measured.etaMs}`);

  const { Semaphore } = await import("../server/lib/semaphore.ts");
  const lanes = new Semaphore(() => 2);
  const a = await lanes.acquire();
  const b = await lanes.acquire();
  let third = false;
  const pending = lanes.acquire().then((r) => ((third = true), r));
  await new Promise((r) => setTimeout(r, 30));
  check("work beyond the lane count waits", !third && lanes.waiting === 1);
  const ac = new AbortController();
  const cancelled = lanes.acquire(ac.signal).catch((e) => e.message);
  ac.abort();
  check("a cancelled waiter leaves the queue", (await cancelled) === "cancelled" && lanes.waiting === 1);
  a();
  const c = await pending;
  check("a release wakes the next waiter in order", third && lanes.active === 2);
  a(); // double release must not corrupt the count
  b();
  c();
  check("every lane comes back", lanes.active === 0);
  check("range planning is gapless and capped", planChunks(7, 3).map((r) => `${r.startPage}-${r.endPage}`).join() === "1-3,4-6,7-7");
}

// ── 7. the real engine ───────────────────────────────────────────────────────
console.log("\nreal poppler + Tesseract on fixtures");
const { ocrEngineAvailability } = await import("../server/ocr/availability.ts");
const { localEngine, localEngineSettings } = await import("../server/ocr/local-engine.ts");
const availability = await ocrEngineAvailability(true);
if (!availability.ok) {
  for (const name of ["text PDF uses its text layer", "scanned PDF goes through OCR", "corrupt PDF fails safely"]) {
    skip(name, `engine not available: ${availability.problems.join(" ")}`);
  }
} else {
  const GT = {
    1: "ईशावास्योपनिषत् ॐ पूर्णमदः पूर्णमिदं पूर्णात्पूर्णमुदच्यते । पूर्णस्य पूर्णमादाय पूर्णमेवावशिष्यते ॥ ईशा वास्यमिदꣳ सर्वं यत्किञ्च जगत्यां जगत् । तेन त्यक्तेन भुञ्जीथा मा गृधः कस्यस्विद्धनम् ॥ १ ॥",
    2: "कुर्वन्नेवेह कर्माणि जिजीविषेच्छतꣳ समाः । एवं त्वयि नान्यथेतोऽस्ति न कर्म लिप्यते नरे ॥ २ ॥ असुर्या नाम ते लोका अन्धेन तमसाऽऽवृताः । ताꣳस्ते प्रेत्याभिगच्छन्ति ये के चात्महनो जनाः ॥ ३ ॥",
    3: "īśā vāsyam idaṃ sarvaṃ yat kiñca jagatyāṃ jagat | tena tyaktena bhuñjīthā mā gṛdhaḥ kasya svid dhanam || 1 ||",
  };
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const cer = (gt, hyp) => {
    const a = [...norm(gt)];
    const b = [...norm(hyp)];
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1])));
      prev = cur;
    }
    return prev[b.length] / Math.max(1, a.length);
  };
  const work = await mkdtemp(path.join(os.tmpdir(), "ocr-real-"));
  const run = (file, textMode, dpi = 300) =>
    transcribeRange({
      sourcePath: path.join(FIXTURES, file),
      mimeType: "application/pdf",
      startPage: 1,
      endPage: 3,
      textMode,
      dpi,
      workDir: path.join(work, `${file}-${textMode}`),
      deps: localEngine,
      settings: localEngineSettings(),
      maxAttempts: 2,
      retryBaseDelayMs: 50,
    });

  check("fixtures are 3-page PDFs", (await readPdfPageCount(await readFile(path.join(FIXTURES, "isha-scan.pdf")))) === 3);

  let t = Date.now();
  const text = await run("isha-text.pdf", "auto");
  const textMs = Date.now() - t;
  check("text PDF: every page read from its text layer — no OCR", text.pages.every((m) => m.source === "embedded"), JSON.stringify(text.pages.map((m) => m.source)));
  console.log(`       text PDF, 3 pages via pdftotext: ${textMs}ms`);

  t = Date.now();
  const scan = await run("isha-scan.pdf", "auto");
  const scanMs = Date.now() - t;
  const scanPages = splitChunkPages(scan.markdown, 1, 3);
  check("scanned PDF: every page went through OCR", scan.pages.every((m) => m.source === "ocr"));
  check("page order and boundaries are kept", scanPages.map((p) => p.page).join() === "1,2,3");
  check("Devanagari pages are read with san, the IAST page with script/Latin",
    /\(san\)/.test(scan.pages[0].engine) && /\(san\)/.test(scan.pages[1].engine) && /script\/Latin/.test(scan.pages[2].engine),
    scan.pages.map((m) => m.engine).join(" | "));
  const rates = scanPages.map((p) => cer(GT[p.page], p.markdown));
  console.log(`       scanned PDF, 3 pages at 300dpi: ${scanMs}ms; CER per page ${rates.map((r) => (r * 100).toFixed(1) + "%").join(", ")}`);
  check("Devanagari pages are read with under 6% character error", rates[0] < 0.06 && rates[1] < 0.06, rates.join());
  check("the IAST page is read with under 20% character error", rates[2] < 0.2, String(rates[2]));
  check("the anusvara, visarga and dandas survive OCR", /ं/.test(scanPages[0].markdown) && /ः/.test(scanPages[0].markdown) && /॥/.test(scanPages[0].markdown));
  check("no word-final ZWNJ reaches the normalized text", !/्‌(\s|$)/.test(scan.markdown));
  check("…but the raw output still has what Tesseract produced", /‌/.test(scan.raw));
  check("each OCR page carries a confidence", scan.pages.every((m) => typeof m.confidence === "number"));

  const corruptPath = path.join(work, "corrupt.pdf");
  await writeFile(corruptPath, "%PDF-1.4\n%garbage that is not a pdf\n");
  let caught = null;
  try {
    await transcribeRange({
      sourcePath: corruptPath, mimeType: "application/pdf", startPage: 1, endPage: 1, textMode: "auto", dpi: 200,
      workDir: path.join(work, "corrupt"), deps: localEngine, settings: localEngineSettings(), maxAttempts: 2, retryBaseDelayMs: 10,
    });
  } catch (err) {
    caught = err;
  }
  check("a corrupt PDF fails as bad input, not a crash", caught instanceof OcrTranscribeError && caught.kind === "bad_input", String(caught?.message));
  let pageCountError = null;
  try {
    await readPdfPageCount(Buffer.from("not a pdf"));
  } catch (err) {
    pageCountError = err;
  }
  check("…and is refused at upload with a 400", pageCountError?.status === 400);
  await rm(work, { recursive: true, force: true });
}

console.log(`\n${PASS} passed, ${FAILURES.length} failed${SKIP ? `, ${SKIP} skipped` : ""}`);
if (FAILURES.length > 0) {
  for (const f of FAILURES) console.error(` - ${f}`);
  process.exit(1);
}
