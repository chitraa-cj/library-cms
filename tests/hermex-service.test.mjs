/**
 * Hermex adapter - unit/integration tests with a FAKE Hermex.
 * ===========================================================
 * No Chrome, no Gemini, no EC2, no network, no database. The adapter's contract
 * with the Python side is "spawn an interpreter, write JSON to its stdin, read
 * one JSON object from its stdout", so the tests point HERMEX_PYTHON at the
 * system python3 and HERMEX_TRANSLATE_SCRIPT at a throwaway script that plays a
 * part: succeed, hang, exit silently, print garbage, or report a Gemini failure.
 *
 * That exercises the parts most likely to break in production — timeout
 * handling, failure classification, the browser mutex, the child environment,
 * and the readiness check — on a laptop that has never heard of
 * /home/ubuntu/hermex-translation.
 *
 * Run:  npm run test:hermex
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermex-test-"));

// Configure BEFORE importing the adapter: config is read per call, but keeping
// the env explicit here documents what each test depends on.
process.env.HERMEX_ENABLED = "1";
process.env.HERMEX_PYTHON = process.env.TEST_PYTHON || "python3";
process.env.HERMEX_TRANSLATE_TIMEOUT_MS = "20000";
delete process.env.HERMEX_DIR;
delete process.env.HERMEX_CHROME_PROFILE;
delete process.env.HERMEX_HEADLESS;

const adapter = await import("../server/hermex-translate.ts");
const cfg = await import("../server/hermex/config.ts");

let PASS = 0;
const FAILURES = [];

function check(name, cond, detail = "") {
  if (cond) {
    PASS += 1;
    console.log(`  ok   ${name}`);
  } else {
    FAILURES.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Write a fake Hermex entry point and point the adapter at it. */
function useFakeScript(body) {
  const file = path.join(tmp, `fake-${Math.random().toString(36).slice(2)}.py`);
  fs.writeFileSync(file, body, "utf8");
  process.env.HERMEX_TRANSLATE_SCRIPT = file;
  return file;
}

const SUCCESS = `
import json, sys
req = json.loads(sys.stdin.read() or "{}")
langs = req.get("targetLanguages") or []
if req.get("jobs"):
    langs = req["jobs"][0].get("targetLanguages") or []
json.dump({"ok": True, "translations": [{"language": l, "text": "translated " + l} for l in langs]}, sys.stdout)
`;

const request = {
  sourceText: "Let there be light",
  sourceLanguage: "English",
  targetLanguages: ["Tamil", "Kannada"],
  context: "test",
};

console.log("\nhermex adapter");

// ── 1. the happy path ───────────────────────────────────────────────────────
console.log("\n successful translation");
{
  useFakeScript(SUCCESS);
  const result = await adapter.runHermexTranslate(request);
  check("ok is true", result.ok === true);
  check("rows come back", result.translations?.length === 2, JSON.stringify(result.translations));
  check("language preserved", result.translations?.[0].language === "Tamil");
  check("text preserved", result.translations?.[0].text === "translated Tamil");
}

// ── 2. the child's environment ──────────────────────────────────────────────
console.log("\n child process environment");
{
  // The adapter must hand the child DISPLAY + the profile, whatever pm2's own
  // environment looks like. The fake echoes what it received.
  process.env.HERMEX_DISPLAY = ":99";
  const profile = path.join(tmp, "chrome-profile");
  fs.mkdirSync(profile, { recursive: true });
  process.env.HERMEX_CHROME_PROFILE = profile;

  useFakeScript(`
import json, os, sys
sys.stdin.read()
json.dump({"ok": True,
           "translations": [{"language": "env", "text": "x"}],
           "seen": {"DISPLAY": os.environ.get("DISPLAY"),
                    "profile": os.environ.get("HERMEX_CHROME_PROFILE"),
                    "profileDir": os.environ.get("HERMEX_CHROME_PROFILE_DIR"),
                    "marker": os.environ.get("HERMEX_CHROME_PROFILE_MARKER")}}, sys.stdout)
`);
  const result = await adapter.runHermexTranslate(request);
  check("DISPLAY reaches the child", result.seen?.DISPLAY === ":99", JSON.stringify(result.seen));
  check("profile reaches the child", result.seen?.profile === profile);
  check("cleanup profile dir is set", result.seen?.profileDir === profile);
  check("cleanup pkill marker is set", result.seen?.marker === profile);
  check("a configured display means headful", cfg.hermexHeadless() === false);

  delete process.env.HERMEX_DISPLAY;
  delete process.env.HERMEX_CHROME_PROFILE;
  check("no display means headless", cfg.hermexHeadless() === true);
}

// ── 3. failures, each classified ────────────────────────────────────────────
console.log("\n failure handling");
async function expectFailure(name, body, expectedReason, { timeoutMs } = {}) {
  useFakeScript(body);
  const previousTimeout = process.env.HERMEX_TRANSLATE_TIMEOUT_MS;
  if (timeoutMs) process.env.HERMEX_TRANSLATE_TIMEOUT_MS = String(timeoutMs);
  try {
    await adapter.runHermexTranslate(request);
    check(name, false, "the call resolved instead of throwing");
  } catch (err) {
    check(
      name,
      err instanceof adapter.HermexError && err.reason === expectedReason,
      `reason=${err?.reason ?? "(not a HermexError)"} message=${String(err?.message).slice(0, 90)}`,
    );
  } finally {
    process.env.HERMEX_TRANSLATE_TIMEOUT_MS = previousTimeout;
  }
}

await expectFailure(
  "a hanging child times out",
  "import time\ntime.sleep(60)\n",
  "timeout",
  { timeoutMs: 2500 },
);
await expectFailure("silent exit is reported as empty", "import sys\nsys.exit(0)\n", "empty");
await expectFailure("garbage stdout is malformed", 'print("I am not JSON")\n', "malformed");
await expectFailure(
  "no translations is reported as empty",
  'import json,sys\nsys.stdin.read()\njson.dump({"ok": True, "translations": []}, sys.stdout)\n',
  "empty",
);
await expectFailure(
  "an expired Gemini login is recognised",
  'import json,sys\nsys.stdin.read()\njson.dump({"ok": False, "error": "Gemini session not logged in — run setup"}, sys.stdout)\n',
  "login",
);
await expectFailure(
  "a wedged Chrome is recognised",
  'import json,sys\nsys.stdin.read()\njson.dump({"ok": False, "error": "session not created: cannot connect to chrome"}, sys.stdout)\n',
  "chrome",
);
await expectFailure(
  "a missing X display is recognised",
  'import json,sys\nsys.stdin.read()\njson.dump({"ok": False, "error": "cannot open display :99"}, sys.stdout)\n',
  "display",
);

{
  // A bad interpreter path must be a clean "unavailable", not a crash.
  const good = process.env.HERMEX_PYTHON;
  process.env.HERMEX_PYTHON = path.join(tmp, "no-such-python");
  useFakeScript(SUCCESS);
  try {
    await adapter.runHermexTranslate(request);
    check("a missing Python is unavailable", false, "resolved unexpectedly");
  } catch (err) {
    check("a missing Python is unavailable", err?.reason === "unavailable", `reason=${err?.reason}`);
    check("the error names the variable to set", /HERMEX_PYTHON/.test(err.message));
  }
  process.env.HERMEX_PYTHON = good;
}

{
  process.env.HERMEX_ENABLED = "0";
  try {
    await adapter.runHermexTranslate(request);
    check("disabled Hermex refuses to run", false, "resolved unexpectedly");
  } catch (err) {
    check("disabled Hermex refuses to run", err?.reason === "unavailable");
    check("a disabled adapter is not retryable", err?.retryable === false);
    check("it maps to 503", err?.status === 503);
  }
  process.env.HERMEX_ENABLED = "1";
}

// ── 4. the browser mutex ────────────────────────────────────────────────────
console.log("\n one browser at a time");
{
  // Each child records enter/exit timestamps in a shared file. If the mutex
  // works, no two intervals overlap — which is the whole point: two Chrome
  // sessions on one profile would corrupt both answers.
  const ledger = path.join(tmp, "ledger.txt");
  fs.writeFileSync(ledger, "", "utf8");
  useFakeScript(`
import json, sys, time, os
sys.stdin.read()
ledger = ${JSON.stringify(ledger)}
with open(ledger, "a") as f:
    f.write("enter %.6f\\n" % time.time())
time.sleep(0.6)
with open(ledger, "a") as f:
    f.write("exit %.6f\\n" % time.time())
json.dump({"ok": True, "translations": [{"language": "Tamil", "text": "x"}]}, sys.stdout)
`);

  const started = Date.now();
  const results = await Promise.all([
    adapter.runHermexTranslate(request),
    adapter.runHermexTranslate(request),
    adapter.runHermexTranslate(request),
  ]);
  const elapsed = Date.now() - started;

  check("all three calls succeed", results.every((r) => r.ok === true));

  const events = fs
    .readFileSync(ledger, "utf8")
    .trim()
    .split("\n")
    .map((l) => l.split(" "));
  check("every call ran", events.filter((e) => e[0] === "enter").length === 3, JSON.stringify(events));
  // Serialised means the sequence is strictly enter,exit,enter,exit,enter,exit.
  const serialised = events.every((e, i) => e[0] === (i % 2 === 0 ? "enter" : "exit"));
  check("no two browser sessions overlap", serialised, events.map((e) => e[0]).join(","));
  check("three 0.6s calls take >1.5s (they queued)", elapsed > 1500, `${elapsed}ms`);
  check("the queue drains back to zero", adapter.hermexQueueDepth() === 0);
}

// ── 5. readiness, on a host with no EC2 paths ───────────────────────────────
console.log("\n readiness check");
{
  delete process.env.HERMEX_CHROME_PROFILE;
  delete process.env.HERMEX_DISPLAY;
  const a = adapter.hermexAvailability();
  // Off-EC2 (no HERMEX_DIR) a missing profile is a WARNING, not a blocker: hermex
  // uses its own default profile, which is where `npm run hermex:setup` logs in.
  check("a dev box without a profile is still usable", a.ok === true, JSON.stringify(a.problems));
  check("but it says the profile is unset", a.warnings.some((w) => /HERMEX_CHROME_PROFILE/.test(w)), JSON.stringify(a.warnings));
  check("reading availability never throws", typeof a.pythonPath === "string");

  // Simulate the EC2 shape inside the temp dir: dir/.venv/bin/python + profile.
  const dir = path.join(tmp, "hermex-translation");
  fs.mkdirSync(path.join(dir, ".venv", "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".venv", "bin", "python"), "#!/bin/sh\n", { mode: 0o755 });
  fs.mkdirSync(path.join(dir, "chrome-profile"), { recursive: true });
  fs.writeFileSync(path.join(dir, "chrome-profile", ".setup_gemini"), "", "utf8");

  const savedPython = process.env.HERMEX_PYTHON;
  delete process.env.HERMEX_PYTHON;
  process.env.HERMEX_DIR = dir;
  process.env.HERMEX_HEADLESS = "true"; // skip the X-socket check on a Mac

  check("python is derived from HERMEX_DIR", cfg.hermexPython() === path.join(dir, ".venv", "bin", "python"));
  check("profile is derived from HERMEX_DIR", cfg.hermexChromeProfile() === path.join(dir, "chrome-profile"));
  const b = adapter.hermexAvailability();
  check("the EC2 shape reports ready", b.ok === true, JSON.stringify(b.problems));
  check("the setup marker is seen", b.geminiSetupComplete === true);

  // Same shape, profile removed: on a deployment this must block, because hermex
  // would otherwise silently use a profile that is not logged in.
  fs.rmSync(path.join(dir, "chrome-profile"), { recursive: true, force: true });
  const c = adapter.hermexAvailability();
  check("a deployment without a profile is NOT ready", c.ok === false, JSON.stringify(c.problems));
  check("and it says which variable", c.problems.some((p) => /profile/i.test(p)), JSON.stringify(c.problems));

  delete process.env.HERMEX_DIR;
  delete process.env.HERMEX_HEADLESS;
  process.env.HERMEX_PYTHON = savedPython;
}

// ── 6. nothing secret escapes ───────────────────────────────────────────────
console.log("\n log and error scrubbing");
{
  const dirty =
    "failed GET https://gemini.google.com/app?access_token=ya29.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef " +
    "cookie: SID=verysecretvalue /home/ubuntu/hermex-translation/chrome-profile";
  const clean = adapter.scrubHermexText(dirty);
  check("tokens are redacted", !clean.includes("ya29.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef"), clean);
  check("cookies are redacted", !/verysecretvalue/.test(clean), clean);
  check("home paths are collapsed", !clean.includes("/home/ubuntu"), clean);
  check("the useful part survives", /gemini\.google\.com/.test(clean), clean);

  const summary = cfg.hermexConfigSummary();
  const serialised = JSON.stringify(summary);
  check("the config summary carries no secrets", !/password|cookie|token|secret/i.test(serialised), serialised);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${PASS} passed, ${FAILURES.length} failed`);
if (FAILURES.length) {
  for (const f of FAILURES) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("hermex-service: all ok");
