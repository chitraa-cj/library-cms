/**
 * OCR over Hermex — prompt, answer parsing, range files, retries and the shared profile.
 * ======================================================================================
 * No Chrome, no Gemini, no network, no database. Sessions are fakes (engine tests) or a
 * throwaway Python peer speaking prompt_session.py's JSON-lines protocol (gate tests).
 *
 *   1. the prompt asks for a verbatim transcription between page markers;
 *   2. the parser takes text only between the markers, needs every page once, in order,
 *      and an end marker (a cut-off answer is rejected, never stored short);
 *   3. the engine uploads exactly the range's pages, retries an unusable answer in a
 *      fresh request, stops the job on setup failures, cancels;
 *   4. OCR and OCR → Grantha share one profile: a second session waits for the first
 *      instead of failing on the profile lock, and a failed start frees the profile.
 *
 * Run: npm run test:ocr-hermex
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-hermex-"));
const PROFILE = path.join(tmp, "document-profile");
fs.mkdirSync(PROFILE, { recursive: true });
process.env.HERMEX_ENABLED = "1";
process.env.HERMEX_PYTHON = process.env.TEST_PYTHON || "python3";
process.env.HERMEX_CHROME_PROFILE = path.join(tmp, "translation-profile");
process.env.HERMEX_STRUCTURE_CHROME_PROFILE = PROFILE;
process.env.HERMEX_STRUCTURE_HEADLESS = "1";
process.env.OCR_HERMEX_RETRY_BASE_MS = "250";
process.env.OCR_HERMEX_TRANSIENT_COOLDOWN_MS = "1000";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test@127.0.0.1:1/none";

const { buildOcrPrompt, parseOcrReply, createHermexOcrEngine, OcrReplyError } = await import("../server/ocr/hermex-engine.ts");
const { ocrConfig, OCR_SUPPORTED_MIME } = await import("../server/ocr/config.ts");
const { HermexError } = await import("../server/hermex-translate.ts");
const { HermexPromptSession } = await import("../server/hermex/prompt-session.ts");
const profiles = await import("../server/hermex/task-profiles.ts");

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
async function rejects(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

const reply = (pages, { end = true, before = "Plaintext\n", after = "\nUse code with caution." } = {}) =>
  before + pages.map(([n, t]) => `=== PAGE ${n} ===\n${t}`).join("\n") + (end ? "\n=== END ===" : "") + after;

// ── 1. configuration + prompt ────────────────────────────────────────────────
console.log("\nconfiguration and prompt");
{
  check("the engine label is Hermex's", ocrConfig.engineLabel === "hermex/gemini-web" && !("engine" in ocrConfig) && !("binaries" in ocrConfig));
  check("one lane and one active job (one browser)", ocrConfig.concurrency === 1 && ocrConfig.maxActiveJobs === 1);
  check("TIFF is refused (Gemini's upload does not take it)", !OCR_SUPPORTED_MIME.has("image/tiff") && OCR_SUPPORTED_MIME.has("application/pdf"));
  const p = buildOcrPrompt({ startPage: 4, endPage: 5, instructions: "Old Nirnaya Sagar print." });
  check("asks for every page of the range by marker", p.includes("=== PAGE 4 ===") && p.includes("=== PAGE 5 ===") && p.includes("=== END ==="));
  check("forbids correcting, translating and guessing", /do not transliterate, translate, correct/i.test(p) && /Never guess/.test(p));
  check("editor notes are included but cannot change the rules", p.includes("Nirnaya Sagar") && /never change the rules/.test(p));
}

// ── 2. parser ────────────────────────────────────────────────────────────────
console.log("\nanswer parsing");
{
  const one = parseOcrReply(reply([[7, "ईशा वास्यमिदं सर्वं\nयत्किञ्च जगत्यां जगत् ।"]]), 7, 7);
  check("keeps the page's lines exactly", one.length === 1 && one[0].text === "ईशा वास्यमिदं सर्वं\nयत्किञ्च जगत्यां जगत् ।");
  check("UI chrome around the block is not page text", !one[0].text.includes("Plaintext") && !one[0].text.includes("caution"));

  const two = parseOcrReply(reply([[1, "a"], [2, "b"]]), 1, 2);
  check("multi-page ranges split on the markers", two.map((p) => `${p.page}:${p.text}`).join() === "1:a,2:b");

  const cut = (() => { try { parseOcrReply(reply([[1, "a"]], { end: false }), 1, 1); } catch (e) { return e; } })();
  check("no end marker (cut off) → rejected", cut instanceof OcrReplyError);
  const missing = (() => { try { parseOcrReply(reply([[1, "a"]]), 1, 2); } catch (e) { return e; } })();
  check("a missing page → rejected", missing instanceof OcrReplyError && /expected pages 1–2/.test(missing.message));
  const wrong = (() => { try { parseOcrReply(reply([[3, "a"]]), 1, 1); } catch (e) { return e; } })();
  check("a wrong page number → rejected", wrong instanceof OcrReplyError);
  const chatter = (() => { try { parseOcrReply("I can't read this file.", 1, 1); } catch (e) { return e; } })();
  check("a refusal with no markers → rejected, never stored as text", chatter instanceof OcrReplyError);
  const empty = parseOcrReply(reply([[1, ""]]), 1, 1);
  check("an honestly blank page is accepted (and flagged later)", empty[0].text === "");
}

console.log("\nreview flags and normalization");
{
  const { pagesToRangeResult } = await import("../server/ocr/hermex-engine.ts");
  const r = pagesToRangeResult([
    { page: 1, text: "" },
    { page: 2, text: "धर्मक्षेत्रे [?] कुरुक्षेत्रे समवेता युयुत्सवः ।" },
    { page: 3, text: "त्‌ क्‍ष ꣳ ॥ १ ॥   \r\nline two\n\n\n\nline three" },
  ], 1);
  check("an empty page is flagged 'empty' (a warning, not a failure)", r.pages[0].flags.includes("empty"));
  check("[?] marks are counted and flagged 'illegible'", r.pages[1].illegibleMarks === 1 && r.pages[1].flags.includes("illegible"));
  const p3 = r.markdown.split("<<<PAGE:3>>>\n")[1];
  check("normalization keeps ZWNJ/ZWJ and Vedic signs, changes only whitespace", p3 === "त्‌ क्‍ष ꣳ ॥ १ ॥\nline two\n\nline three", JSON.stringify(p3));
  check("the raw copy is the answer as received", r.raw.includes("॥ १ ॥   \r\nline two"));
}

// ── 3. engine ────────────────────────────────────────────────────────────────
console.log("\nengine");
const SOURCE = path.resolve("tests/fixtures/ocr/isha-scan.pdf");
function fakeSession(replies) {
  const calls = [];
  let opened = 0;
  return {
    calls,
    get opened() {
      return opened;
    },
    open: async () => {
      opened++;
      return {
        alive: true,
        async ask(prompt, opts) {
          const file = opts.attachments?.[0];
          const pdfPages = file?.endsWith(".pdf") ? (await PDFDocument.load(fs.readFileSync(file))).getPageCount() : null;
          calls.push({ prompt, file, pdfPages, exists: file ? fs.existsSync(file) : false });
          const next = replies.shift();
          if (next instanceof Error) throw next;
          return next;
        },
        async close() {},
      };
    },
  };
}
const workDir = () => fs.mkdtempSync(path.join(tmp, "work-"));
const REQ = { sourcePath: SOURCE, mimeType: "application/pdf", startPage: 2, endPage: 3, maxAttempts: 3 };
{
  const ok = fakeSession([reply([[2, "page two"], [3, "page three"]])]);
  const engine = createHermexOcrEngine({ label: "t", openSession: ok.open });
  const result = await engine.transcribeRange({ ...REQ, workDir: workDir() });
  await engine.close();
  check("uploads a PDF holding exactly the range's pages", ok.calls[0].exists && ok.calls[0].pdfPages === 2, JSON.stringify(ok.calls[0]));
  check("the upload is an absolute path", path.isAbsolute(ok.calls[0].file));
  check("stores pages with the shared page markers", result.markdown === "<<<PAGE:2>>>\npage two\n<<<PAGE:3>>>\npage three");
  check("per-page meta names the engine, no invented confidence", result.pages.every((m) => m.engine === "hermex/gemini-web" && m.confidence === null && m.source === "ocr"));
  check("the original upload is untouched", fs.statSync(SOURCE).size === 323472);

  const img = path.join(tmp, "scan.jpeg");
  fs.writeFileSync(img, "not really a jpeg");
  const imgSession = fakeSession([reply([[1, "x"]])]);
  await createHermexOcrEngine({ label: "t", openSession: imgSession.open }).transcribeRange({
    ...REQ, sourcePath: img, mimeType: "image/jpeg", startPage: 1, endPage: 1, workDir: workDir(),
  });
  check("an image is uploaded as itself, with an extension Gemini accepts", /page-1\.jpg$/.test(imgSession.calls[0].file));

  const fix = fakeSession(["Sure! Here is the text: page two", reply([[2, "a"], [3, "b"]])]);
  const fixed = await createHermexOcrEngine({ label: "t", openSession: fix.open }).transcribeRange({ ...REQ, workDir: workDir() });
  check("an unusable answer is retried, then the good one kept", fix.calls.length === 2 && fixed.attempts === 2);

  const never = fakeSession(["nope", "nope", "nope"]);
  const err = await rejects(createHermexOcrEngine({ label: "t", openSession: never.open }).transcribeRange({ ...REQ, workDir: workDir() }));
  check("three unusable answers → the range fails (not the job)", err?.kind === "transient" && !err.fatal && never.calls.length === 3, err?.message);

  const login = fakeSession([new HermexError("login", "not logged in")]);
  const lerr = await rejects(createHermexOcrEngine({ label: "t", openSession: login.open }).transcribeRange({ ...REQ, workDir: workDir() }));
  check("not logged in → the job stops, pages stay queued", lerr?.kind === "engine_unavailable" && lerr.fatal && login.calls.length === 1);

  const busy = fakeSession([new HermexError("busy", "lock held")]);
  const berr = await rejects(createHermexOcrEngine({ label: "t", openSession: busy.open }).transcribeRange({ ...REQ, workDir: workDir() }));
  check("profile lock held by another process → the job stops", berr?.kind === "engine_unavailable");

  const t0 = Date.now();
  const transient = fakeSession([new HermexError("transient", "Something went wrong"), reply([[2, "a"], [3, "b"]])]);
  await createHermexOcrEngine({ label: "t", openSession: transient.open }).transcribeRange({ ...REQ, workDir: workDir() });
  check("Gemini's canned error → cool down, then retry", transient.calls.length === 2 && Date.now() - t0 >= 1000);

  const ac = new AbortController();
  ac.abort();
  const cerr = await rejects(createHermexOcrEngine({ label: "t", openSession: fakeSession([]).open }).transcribeRange({ ...REQ, workDir: workDir(), signal: ac.signal }));
  check("cancel → cancelled, nothing sent", cerr?.kind === "cancelled");

  const reuse = fakeSession([reply([[2, "a"]]), reply([[3, "b"]])]);
  const engine2 = createHermexOcrEngine({ label: "t", openSession: reuse.open });
  await engine2.transcribeRange({ ...REQ, endPage: 2, workDir: workDir() });
  await engine2.transcribeRange({ ...REQ, startPage: 3, workDir: workDir() });
  check("one browser session serves every range of a job", reuse.opened === 1 && reuse.calls.length === 2);
}

// ── 4. one profile, two workflows ────────────────────────────────────────────
console.log("\nshared document profile");
const FAKE = path.join(tmp, "fake_session.py");
fs.writeFileSync(
  FAKE,
  String.raw`
import json, os, sys
mode = os.environ.get("FAKE_MODE", "ok")
def emit(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
if mode == "login":
    emit({"type": "fatal", "reason": "login", "error": "not logged in"}); sys.exit(3)
emit({"type": "ready", "loggedIn": True})
for line in sys.stdin:
    req = json.loads(line)
    if req.get("op") == "close":
        break
    emit({"id": req["id"], "ok": True, "text": json.dumps(req.get("attachments", []))})
`,
);
{
  const open = (mode, extra = {}) => {
    process.env.FAKE_MODE = mode;
    return HermexPromptSession.open({ profile: profiles.structureProfile().profile, launchTimeoutMs: 5_000, script: FAKE, label: "test", ...extra });
  };
  const first = await open("ok");
  const echoed = JSON.parse(await first.ask("read this", { timeoutMs: 10_000, attachments: ["/abs/page.pdf"] }));
  check("attachments travel to the Python side", echoed[0] === "/abs/page.pdf");

  let secondReady = false;
  const second = open("ok").then((s) => ((secondReady = true), s));
  await new Promise((r) => setTimeout(r, 1500));
  check("a second session on the same profile waits (no lock failure)", !secondReady);
  await first.close();
  const s2 = await second;
  check("…and starts as soon as the first one closes", secondReady && s2.alive);

  const ac = new AbortController();
  const third = open("ok", { signal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  check("a cancelled job stops waiting for the profile", (await rejects(third)) != null);
  await s2.close();

  const failed = await rejects(open("login"));
  check("a failed start reports why", failed?.reason === "login");
  const after = await open("ok");
  check("…and frees the profile for the next session", after.alive);
  await after.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${PASS} passed, ${FAILURES.length} failed`);
if (FAILURES.length > 0) {
  for (const f of FAILURES) console.log(`  - ${f}`);
  process.exit(1);
}
