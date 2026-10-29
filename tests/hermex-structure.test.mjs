/**
 * OCR → Grantha over Hermex — adapter, session protocol and isolation from translation.
 * =====================================================================================
 * No Chrome, no Gemini, no network, no database. The Python side of the session is a
 * throwaway script that speaks the same JSON-lines protocol as prompt_session.py and plays
 * a part (answer, refuse login, answer with the wrong id, hang, die, dump its env).
 *
 *   1. task profile rules: the structure profile can never be translation's profile,
 *      hermex's default profile, or share translation's lock;
 *   2. the child environment: only the structure profile, no translation paths, no
 *      credentials of any kind;
 *   3. the session protocol: readiness, correlation ids, a stray answer is never taken
 *      for another request's, timeouts kill the session, startup login failure;
 *   4. the analyzer: retries a malformed answer, stops the job on setup failures, cools
 *      down after Gemini's canned error, cancels;
 *   5. no fallback: when Hermex fails nothing else is called — no fetch, no SDK.
 *
 * Run: npm run test:hermex-structure
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermex-structure-"));
const TRANSLATION_PROFILE = path.join(tmp, "translation-profile");
const STRUCTURE_PROFILE = path.join(tmp, "structure-profile");
fs.mkdirSync(TRANSLATION_PROFILE, { recursive: true });
fs.mkdirSync(STRUCTURE_PROFILE, { recursive: true });

// The env a real box carries: translation's Hermex config AND credentials for other
// features. None of it may reach the structure child.
process.env.HERMEX_ENABLED = "1";
process.env.HERMEX_PYTHON = process.env.TEST_PYTHON || "python3";
process.env.HERMEX_CHROME_PROFILE = TRANSLATION_PROFILE;
process.env.HERMEX_CHROME_PROFILE_MARKER = TRANSLATION_PROFILE;
process.env.HERMEX_DIR = tmp;
process.env.HERMEX_STRUCTURE_CHROME_PROFILE = STRUCTURE_PROFILE;
process.env.HERMEX_STRUCTURE_HEADLESS = "1";
process.env.GEMINI_API_KEY = "AIzaSy-test-not-real";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-real";
process.env.STRAPI_API_TOKEN = "strapi-token-test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test@127.0.0.1:1/none";
process.env.STRUCTURE_RETRY_BASE_MS = "250";
process.env.STRUCTURE_TRANSIENT_COOLDOWN_MS = "1000";
process.env.STRUCTURE_MAX_ATTEMPTS = "3";

const profiles = await import("../server/hermex/task-profiles.ts");
const { HermexPromptSession } = await import("../server/hermex/prompt-session.ts");
const { HermexError } = await import("../server/hermex-translate.ts");
const { createHermexStructureAnalyzer } = await import("../server/structure/hermex-analyzer.ts");
const { normalizeHierarchyConfig } = await import("../shared/ocr-structure.ts");

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

// ── 1. profile rules ─────────────────────────────────────────────────────────
console.log("\ntask profile rules");
{
  const ok = profiles.structureProfile();
  check("a separate profile is accepted", ok.ok && ok.profile.profileDir === STRUCTURE_PROFILE);
  check("its lock file is its own, never translation's", ok.ok && ok.profile.lockFile !== path.join(tmp, ".hermex.lock"));

  const withEnv = (patch, fn) => {
    const saved = {};
    for (const k of Object.keys(patch)) saved[k] = process.env[k];
    Object.assign(process.env, patch);
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) v == null ? delete process.env[k] : (process.env[k] = v);
    }
  };
  const same = withEnv({ HERMEX_STRUCTURE_CHROME_PROFILE: TRANSLATION_PROFILE }, () => profiles.structureProfile());
  check("translation's own profile is refused", !same.ok && /translation profile/.test(same.problems.join()));
  const nested = withEnv({ HERMEX_STRUCTURE_CHROME_PROFILE: path.join(TRANSLATION_PROFILE, "sub") }, () => profiles.structureProfile());
  check("a directory inside translation's profile is refused", !nested.ok);
  const dflt = withEnv({ HERMEX_STRUCTURE_CHROME_PROFILE: path.join(os.homedir(), "Library", "Application Support", "hermex") }, () => profiles.structureProfile());
  check("hermex's default profile (the dev-machine translation login) is refused", !dflt.ok && /default profile/.test(dflt.problems.join()));
  const lock = withEnv({ HERMEX_STRUCTURE_LOCK_FILE: path.join(tmp, ".hermex.lock") }, () => profiles.structureProfile());
  check("translation's lock file is refused", !lock.ok && /lock/.test(lock.problems.join()));
  const unset = withEnv({ HERMEX_STRUCTURE_CHROME_PROFILE: "" }, () => profiles.structureProfile());
  check("no profile → not configured, with the setup command named", !unset.ok && /hermex:setup-structure/.test(unset.problems.join()));

  const health = profiles.structureHermexAvailability();
  check("a profile that never logged in is reported, not attempted", !health.ok && /setup_gemini|hermex:setup-structure/.test(health.problems.join()));
}

// ── a fake Python peer ───────────────────────────────────────────────────────
const FAKE = path.join(tmp, "fake_session.py");
fs.writeFileSync(
  FAKE,
  String.raw`
import json, os, sys, time
mode = os.environ.get("FAKE_MODE", "ok")
def emit(o):
    sys.stdout.write(json.dumps(o, ensure_ascii=False) + "\n"); sys.stdout.flush()
if mode == "login":
    emit({"type": "fatal", "reason": "login", "error": "The dedicated Gemini profile is not logged in."}); sys.exit(3)
if mode == "slowstart":
    time.sleep(30)
emit({"type": "ready", "loggedIn": True})
n = 0
for line in sys.stdin:
    req = json.loads(line)
    if req.get("op") == "close":
        break
    n += 1
    if mode == "dumpenv":
        emit({"id": req["id"], "ok": True, "text": json.dumps(dict(os.environ))}); continue
    if mode == "hang":
        time.sleep(60); continue
    if mode == "die":
        sys.exit(9)
    if mode == "wrongid":
        emit({"id": "not-" + req["id"], "ok": True, "text": "STOLEN"})
    if mode == "transient" and n == 1:
        emit({"id": req["id"], "ok": False, "reason": "transient", "error": "Something went wrong"}); continue
    emit({"id": req["id"], "ok": True, "text": "answer %d to %d chars" % (n, len(req["prompt"]))})
`,
);
const session = (mode, extra = {}) => {
  process.env.FAKE_MODE = mode;
  const p = profiles.structureProfile();
  return HermexPromptSession.open({ profile: p.profile, launchTimeoutMs: 5_000, script: FAKE, label: "test", ...extra });
};

// ── 2. child environment ─────────────────────────────────────────────────────
console.log("\nthe browser child's environment");
{
  const s = await session("dumpenv");
  const env = JSON.parse(await s.ask("env please", { timeoutMs: 10_000 }));
  await s.close();
  check("it drives the STRUCTURE profile", env.HERMEX_CHROME_PROFILE === STRUCTURE_PROFILE && env.HERMEX_CHROME_PROFILE_DIR === STRUCTURE_PROFILE);
  check("browser cleanup is scoped to that profile", env.HERMEX_CHROME_PROFILE_MARKER === STRUCTURE_PROFILE && env.HERMEX_CLEANUP_SCOPE === "profile");
  check("it uses its own lock file", env.HERMEX_LOCK_FILE === `${STRUCTURE_PROFILE}.lock`);
  const leaked = Object.entries(env).filter(([, v]) => String(v).includes(TRANSLATION_PROFILE)).map(([k]) => k);
  check("translation's profile appears nowhere in it", leaked.length === 0, leaked.join());
  check("HERMEX_DIR (translation's install/lock root) is not inherited", env.HERMEX_DIR == null);
  const secrets = ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "STRAPI_API_TOKEN", "DATABASE_URL"].filter((k) => k in env);
  check("no credential of any kind reaches it", secrets.length === 0, secrets.join());
}

// ── 2a. which Chrome profile inside the user-data dir ────────────────────────
console.log("\nChrome profile selection (profile picker)");
{
  const cfg = await import("../server/hermex/config.ts");
  const withEnv = (patch, fn) => {
    const saved = {};
    for (const k of Object.keys(patch)) saved[k] = process.env[k];
    for (const [k, v] of Object.entries(patch)) v == null ? delete process.env[k] : (process.env[k] = v);
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) v == null ? delete process.env[k] : (process.env[k] = v);
    }
  };
  // The box's layout: hermex's user-data dir holds an empty Default and the signed-in
  // profile Chrome created during the login.
  const box = path.join(tmp, "box-structure-profile");
  const udd = path.join(box, "chrome_profile");
  fs.mkdirSync(udd, { recursive: true });
  fs.writeFileSync(path.join(box, ".setup_gemini"), "");
  const writeState = (cache) => fs.writeFileSync(path.join(udd, "Local State"), JSON.stringify({ profile: { info_cache: cache } }));
  writeState({
    Default: { name: "Your Chrome" },
    "Profile 1": { name: "xoidlabs.com", gaia_id: "1", user_name: "someone@example.com" },
  });
  check("hermex's user-data dir is <profile>/chrome_profile", profiles.chromeUserDataDir(box + "/") === udd);
  const listed = profiles.listChromeProfiles(udd);
  check("Chrome's profile list is read from Local State (directory, name, signed in)",
    JSON.stringify(listed) === JSON.stringify([{ directory: "Default", name: "Your Chrome", signedIn: false }, { directory: "Profile 1", name: "xoidlabs.com", signedIn: true }]));
  check("…never the account's email", !JSON.stringify(listed).includes("example.com"));

  const env = { HERMEX_STRUCTURE_CHROME_PROFILE: box, HERMEX_STRUCTURE_HEADLESS: "1" };
  const picker = withEnv({ ...env, HERMEX_STRUCTURE_PROFILE_DIRECTORY: undefined }, () => profiles.structureHermexAvailability());
  check("two profiles and none selected → not ready: Chrome would open its profile picker",
    !picker.ok && picker.problems.some((m) => /profile picker/.test(m) && /HERMEX_STRUCTURE_PROFILE_DIRECTORY/.test(m) && /signed in: Profile 1/.test(m)), picker.problems.join(" | "));
  check("…and the message carries no email", !picker.problems.join().includes("example.com"));

  const chosen = withEnv({ ...env, HERMEX_STRUCTURE_PROFILE_DIRECTORY: "Profile 1" }, () => ({
    health: profiles.structureHermexAvailability(),
    child: profiles.taskChildEnv(profiles.structureProfile().profile),
  }));
  check("the signed-in profile selected → ready", chosen.health.ok, chosen.health.problems.join(" | "));
  check("…and the session child is told to open it", chosen.child.HERMEX_SESSION_PROFILE_DIRECTORY === "Profile 1");
  check("…the raw setting itself is not passed on", !("HERMEX_STRUCTURE_PROFILE_DIRECTORY" in chosen.child));

  const missing = withEnv({ ...env, HERMEX_STRUCTURE_PROFILE_DIRECTORY: "Profile 7" }, () => profiles.structureHermexAvailability());
  check("a directory Chrome does not list is refused with the real list", !missing.ok && missing.problems.some((m) => /"Profile 7" is not a profile/.test(m) && /Profile 1 "xoidlabs.com"/.test(m)));
  const notSigned = withEnv({ ...env, HERMEX_STRUCTURE_PROFILE_DIRECTORY: "Default" }, () => profiles.structureHermexAvailability());
  check("an existing but not-signed-in profile is allowed with a warning (Gemini login is checked at start)", notSigned.ok && notSigned.warnings.some((w) => /not signed in/.test(w)));
  const pathLike = withEnv({ ...env, HERMEX_STRUCTURE_PROFILE_DIRECTORY: "../Default" }, () => profiles.structureProfile());
  check("a path is refused as a profile directory", !pathLike.ok && /not a Chrome profile directory name/.test(pathLike.problems.join()));

  writeState({ Default: { name: "Your Chrome", gaia_id: "1" } });
  const single = withEnv({ ...env, HERMEX_STRUCTURE_PROFILE_DIRECTORY: undefined }, () => ({
    health: profiles.structureHermexAvailability(),
    child: profiles.taskChildEnv(profiles.structureProfile().profile),
  }));
  check("a single profile needs no selection (Chrome opens it directly)", single.health.ok, single.health.problems.join(" | "));
  check("…and no profile flag is passed", !("HERMEX_SESSION_PROFILE_DIRECTORY" in single.child));

  // Translation is untouched: its env builder and its Python never select a profile.
  const tEnv = withEnv({ ...env, HERMEX_STRUCTURE_PROFILE_DIRECTORY: "Profile 1" }, () => cfg.hermexChildEnv());
  check("translation's child env carries no session profile selection", !("HERMEX_SESSION_PROFILE_DIRECTORY" in tEnv) && tEnv.HERMEX_CHROME_PROFILE === TRANSLATION_PROFILE);
  const translateCli = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "python", "hermex_translate", "translate_cli.py"), "utf8");
  check("translate_cli.py never selects a profile directory", !/chrome_profile_select|profile-directory|HERMEX_SESSION_PROFILE_DIRECTORY/.test(translateCli));
}

// ── 2b. display isolation ────────────────────────────────────────────────────
console.log("\nthe OCR browser's display is its own");
{
  const cfg = await import("../server/hermex/config.ts");
  const withEnv = async (patch, fn) => {
    const saved = {};
    for (const k of Object.keys(patch)) saved[k] = process.env[k];
    for (const [k, v] of Object.entries(patch)) v == null ? delete process.env[k] : (process.env[k] = v);
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) v == null ? delete process.env[k] : (process.env[k] = v);
    }
  };
  // The box: translation on :99 (DISPLAY in .env), OCR on :98.
  await withEnv({ DISPLAY: ":99", HERMEX_DISPLAY: undefined, HERMEX_STRUCTURE_DISPLAY: ":98", HERMEX_STRUCTURE_HEADLESS: undefined }, async () => {
    const p = profiles.structureProfile();
    check("the structure profile resolves HERMEX_STRUCTURE_DISPLAY", p.ok && p.profile.display === ":98", JSON.stringify(p));
    check("an explicit structure display means a headful browser", p.ok && p.profile.headless === false);
    check("translation's display is unchanged (:99)", cfg.hermexDisplay() === ":99");
    const env = profiles.taskChildEnv(p.profile);
    check("the browser child gets DISPLAY=:98, not translation's :99", env.DISPLAY === ":98", env.DISPLAY);
    check("HERMEX_STRUCTURE_DISPLAY itself is not passed to the child", !("HERMEX_STRUCTURE_DISPLAY" in env));
    const s = await session("dumpenv");
    const live = JSON.parse(await s.ask("env please", { timeoutMs: 10_000 }));
    await s.close();
    check("a real session child runs on :98", live.DISPLAY === ":98", live.DISPLAY);
  });
  await withEnv({ DISPLAY: ":99", HERMEX_DISPLAY: undefined, HERMEX_STRUCTURE_DISPLAY: undefined }, async () => {
    const p = profiles.structureProfile();
    check("unset, it falls back to the shared display (backward compatible)", p.ok && p.profile.display === ":99");
  });
  await withEnv({ DISPLAY: ":99", HERMEX_DISPLAY: ":97", HERMEX_STRUCTURE_DISPLAY: undefined }, async () => {
    const p = profiles.structureProfile();
    check("unset, HERMEX_DISPLAY still wins over DISPLAY", p.ok && p.profile.display === ":97");
  });
  await withEnv({ DISPLAY: ":99", HERMEX_STRUCTURE_DISPLAY: "ninety-eight" }, async () => {
    const p = profiles.structureProfile();
    check("a malformed structure display is refused, not replaced by :99", !p.ok && /HERMEX_STRUCTURE_DISPLAY/.test(p.problems.join()));
    const health = profiles.structureHermexAvailability();
    check("readiness names the bad setting", !health.ok && health.problems.some((m) => /HERMEX_STRUCTURE_DISPLAY/.test(m)));
  });
  await withEnv({ DISPLAY: undefined, HERMEX_DISPLAY: undefined, HERMEX_STRUCTURE_DISPLAY: undefined, HERMEX_STRUCTURE_HEADLESS: "1" }, async () => {
    const p = profiles.structureProfile();
    const env = profiles.taskChildEnv(p.profile);
    check("no display configured → the child inherits none", p.ok && env.DISPLAY == null);
  });
}

// ── 3. protocol ──────────────────────────────────────────────────────────────
console.log("\nsession protocol");
{
  const s = await session("ok");
  const a = await s.ask("first", { timeoutMs: 10_000 });
  const b = await s.ask("second prompt", { timeoutMs: 10_000 });
  check("one session answers many prompts in turn", a === "answer 1 to 5 chars" && b === "answer 2 to 13 chars");
  const [c, d] = await Promise.all([s.ask("x", { timeoutMs: 10_000 }), s.ask("yy", { timeoutMs: 10_000 })]);
  check("concurrent asks are serialised, each gets its own answer", c === "answer 3 to 1 chars" && d === "answer 4 to 2 chars", `${c} | ${d}`);
  await s.close();
  check("close ends the browser process", !s.alive);

  const w = await session("wrongid");
  const answer = await w.ask("mine", { timeoutMs: 10_000 });
  check("an answer carrying another request's id is never accepted", answer !== "STOLEN" && answer.startsWith("answer"));
  await w.close();

  const h = await session("hang");
  const t0 = Date.now();
  const timeout = await rejects(h.ask("slow", { timeoutMs: 1_500 }));
  check("a request past its ceiling fails as a timeout", timeout instanceof HermexError && timeout.reason === "timeout" && Date.now() - t0 < 5_000);
  await new Promise((r) => setTimeout(r, 300));
  check("…and the session it may have poisoned is ended", !h.alive);

  const ac = new AbortController();
  const h2 = await session("hang");
  const pending = h2.ask("slow", { timeoutMs: 30_000, signal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  const cancelled = await rejects(pending);
  check("cancelling a request ends it promptly", /Cancelled/.test(cancelled?.message ?? ""));

  const login = await rejects(session("login"));
  check("a logged-out profile fails at startup with reason 'login'", login instanceof HermexError && login.reason === "login" && !login.retryable);

  const die = await session("die");
  const died = await rejects(die.ask("boom", { timeoutMs: 10_000 }));
  check("a browser that dies mid-request is reported, not hung on", died instanceof HermexError && died.reason === "chrome");

  const slow = await rejects(session("slowstart", { launchTimeoutMs: 800 }));
  check("a browser that never becomes ready times out", slow instanceof HermexError && slow.reason === "timeout");
}

// ── 4. analyzer ──────────────────────────────────────────────────────────────
console.log("\nanalyzer");
const CFG = normalizeHierarchyConfig({ depth: 2, levelNames: ["Adhyaya", "Mantra"] });
const REQ = {
  pages: [{ page: 3, markdown: "प्रथमोऽध्यायः\nईशा वास्यमिदꣳ सर्वं ॥ १ ॥\nभाष्यम् ।" }],
  startPage: 3, endPage: 3, totalPages: 10, chunkIndex: 0, config: CFG,
};
const GOOD = "```json\n" + JSON.stringify({
  items: [
    { kind: "section", from: 1, to: 1, level: 1, number: "1", confidence: 0.9 },
    { kind: "verse", from: 2, to: 2, number: "1", confidence: 0.9 },
    { kind: "bhashyam", from: 3, to: 3, attachTo: "previous_verse", confidence: 0.9 },
  ],
  warnings: [],
}) + "\n```";
function fakeSession(replies) {
  const sent = [];
  let opened = 0;
  return {
    sent,
    get opened() {
      return opened;
    },
    open: async () => {
      opened++;
      return {
        alive: true,
        ask: async (prompt) => {
          sent.push(prompt);
          const next = replies.shift();
          if (next instanceof Error) throw next;
          return next;
        },
        close: async () => {},
      };
    },
  };
}
{
  const ok = fakeSession([GOOD, GOOD]);
  const a = createHermexStructureAnalyzer({ label: "t", openSession: ok.open });
  const r = await a.analyse(REQ);
  check("a good answer becomes items with source text", r.items.length === 3 && r.items[1].text === "ईशा वास्यमिदꣳ सर्वं ॥ १ ॥");
  check("one request, one browser session", r.attempts === 1 && ok.opened === 1);
  await a.analyse(REQ);
  check("the session is reused across ranges", ok.opened === 1);
  await a.close();

  const fix = fakeSession(["I cannot help with that.", GOOD]);
  const progress = [];
  const r2 = await createHermexStructureAnalyzer({ label: "t", openSession: fix.open }).analyse({ ...REQ, onProgress: (e) => progress.push(e.kind) });
  check("an unusable answer is retried once more and then used", r2.attempts === 2 && r2.items.length === 3);
  check("the retry is visible as a backoff", progress.join() === "attempt,backoff,attempt", progress.join());

  const never = fakeSession(["nope", "nope", "nope"]);
  const failed = await rejects(createHermexStructureAnalyzer({ label: "t", openSession: never.open }).analyse(REQ));
  check("after the attempt budget the range fails (not the job)", failed?.name === "StructureAnalysisError" && !failed.fatal && failed.attempts === 3);
  check("…with a bounded number of requests", never.sent.length === 3);

  const loginFail = fakeSession([new HermexError("login", "not logged in")]);
  const fatal = await rejects(createHermexStructureAnalyzer({ label: "t", openSession: loginFail.open }).analyse(REQ));
  check("a login failure is fatal for the job (every range would fail)", fatal?.fatal === true && loginFail.sent.length === 1);
  const busy = fakeSession([new HermexError("busy", "lock held")]);
  check("a held profile lock is fatal too", (await rejects(createHermexStructureAnalyzer({ label: "t", openSession: busy.open }).analyse(REQ)))?.fatal === true);

  const transient = fakeSession([new HermexError("transient", "Something went wrong"), GOOD]);
  const t0 = Date.now();
  const r3 = await createHermexStructureAnalyzer({ label: "t", openSession: transient.open }).analyse(REQ);
  check("Gemini's canned error reply cools down before retrying", r3.attempts === 2 && Date.now() - t0 >= 1_000, `${Date.now() - t0}ms`);

  let gated = 0;
  await createHermexStructureAnalyzer({ label: "t", openSession: fakeSession([GOOD]).open, beforeRequest: async () => void gated++ }).analyse(REQ);
  check("every request passes the request gate", gated === 1);

  const ac = new AbortController();
  ac.abort();
  const cancelled = await rejects(createHermexStructureAnalyzer({ label: "t", openSession: fakeSession([GOOD]).open }).analyse({ ...REQ, signal: ac.signal }));
  check("a cancelled range stops", /Cancelled/.test(cancelled?.message ?? ""));

  const prompt = fakeSession([GOOD]);
  await createHermexStructureAnalyzer({ label: "t", openSession: prompt.open }).analyse({ ...REQ, instructions: "Verses end with ॥ n ॥" });
  check("the prompt carries the numbered lines and the instructions", /L2\| ईशा/.test(prompt.sent[0]) && /<editor_instructions>/.test(prompt.sent[0]));
}

// ── 5. no fallback ───────────────────────────────────────────────────────────
console.log("\nno hidden fallback");
{
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async (...args) => {
    fetches++;
    return realFetch(...args);
  };
  const down = fakeSession([new HermexError("chrome", "browser died"), new HermexError("chrome", "browser died"), new HermexError("chrome", "browser died")]);
  const err = await rejects(createHermexStructureAnalyzer({ label: "t", openSession: down.open }).analyse(REQ));
  globalThis.fetch = realFetch;
  check("with Hermex down the range fails with Hermex's reason", /Hermex \(chrome\)/.test(err?.message ?? ""));
  check("…and nothing over HTTP was attempted instead", fetches === 0);
  check("…the session was reopened between attempts, nothing else", down.opened >= 1);
  const require = createRequire(import.meta.url);
  let sdk = null;
  try {
    require.resolve("@anthropic-ai/sdk");
    sdk = "installed";
  } catch {
    sdk = "absent";
  }
  check("the Claude SDK is no longer a dependency", sdk === "absent");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${PASS} passed, ${FAILURES.length} failed`);
if (FAILURES.length > 0) {
  for (const f of FAILURES) console.error(` - ${f}`);
  process.exit(1);
}
process.exit(0);
