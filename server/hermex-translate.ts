/**
 * The Hermex adapter — the ONE door between the CMS and Gemini-through-Chrome.
 *
 *   CMS backend → runHermexTranslate() → python/hermex_translate/translate_cli.py
 *                                      → hermex → Chrome (Xvfb :99) → Gemini
 *
 * Three properties the rest of the app relies on:
 *
 *  1. **Serialised.** One Chrome profile cannot be driven by two requests at
 *     once — the second would fight the first for the same window and corrupt
 *     both answers. Every call queues behind `browserLock`, so concurrency is
 *     safe at the API level without the caller thinking about it.
 *  2. **Diagnosable.** Failures come back as a `HermexError` with a `reason`
 *     (timeout / chrome / display / login / empty / malformed / process /
 *     unavailable), so the HTTP layer can map them to sensible statuses and an
 *     admin sees "the Gemini login expired" instead of a Selenium stack trace.
 *  3. **Locally harmless.** Nothing here touches the EC2 paths at import time;
 *     a Mac without /home/ubuntu/hermex-translation just reports unavailable.
 *
 * Secrets: none. The Gemini session is a Chrome profile *on the server*; this
 * module only learns its path from the environment, never its contents, and the
 * error/log scrubber below keeps cookies and tokens out of logs and responses.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

import {
  hermexChildEnv,
  hermexChromeProfile,
  hermexConfigSummary,
  hermexDir,
  hermexDisplay,
  hermexEnabled,
  hermexHeadless,
  hermexPython,
  hermexSmokeScriptPath,
  hermexSmokeTimeoutMs,
  hermexTranslateScriptPath,
  hermexTranslateTimeoutMs,
  repoRoot,
} from "./hermex/config";

// Re-exported so existing importers (routes, script/lib, the translation worker)
// keep working unchanged.
export {
  hermexEnabled,
  hermexTranslateScriptPath,
  hermexTranslateTimeoutMs,
  hermexConfigSummary,
};
/** @deprecated kept for older call sites; prefer hermexPython() from ./hermex/config. */
export const hermexPythonBin = hermexPython;

export type HermexTranslateJob = {
  sourceText: string;
  sourceLanguage: "English" | "Sanskrit";
  targetLanguages: string[];
  context?: string;
};

export type HermexTranslateRequest = HermexTranslateJob & {
  jobs?: HermexTranslateJob[];
  chunkSize?: number;
  headless?: boolean;
  queryTimeoutSec?: number;
  continueOnError?: boolean;
  chunkDelaySec?: number;
  maxRetries?: number;
};

export type HermexTranslationRow = {
  language: string;
  text: string;
};

export type HermexBatchResult = {
  context?: string;
  translations: HermexTranslationRow[];
};

export type HermexTranslateResponse = {
  ok: boolean;
  translations?: HermexTranslationRow[];
  results?: HermexBatchResult[];
  error?: string;
};

// ───────────────────────────────────────────────────────────── errors + logging
export type HermexFailureReason =
  | "unavailable" // Hermex disabled, or Python/profile missing on this host
  | "display" // no X display — Xvfb not running
  | "chrome" // Chrome/chromedriver could not be driven
  | "login" // the Gemini session expired; a human must re-run setup
  | "timeout" // the subprocess outlived its ceiling
  | "empty" // Gemini answered nothing usable
  | "malformed" // the CLI's stdout was not the JSON contract
  | "process" // non-zero exit / spawn failure
  | "unknown";

export class HermexError extends Error {
  readonly reason: HermexFailureReason;
  /** True when retrying later could plausibly succeed. */
  readonly retryable: boolean;
  /** Suggested HTTP status when this surfaces through an API. */
  readonly status: number;

  constructor(reason: HermexFailureReason, message: string, opts?: { retryable?: boolean; status?: number }) {
    super(message);
    this.name = "HermexError";
    this.reason = reason;
    this.retryable = opts?.retryable ?? (reason !== "unavailable" && reason !== "login");
    this.status = opts?.status ?? (reason === "unavailable" || reason === "display" || reason === "login" ? 503 : 502);
  }
}

/**
 * Scrub anything credential-shaped out of text that is about to be logged or
 * returned. Hermex failures quote browser/driver chatter, which can carry a
 * profile path or a URL with a token.
 */
export function scrubHermexText(input: unknown, max = 600): string {
  const raw = input instanceof Error ? input.message : String(input ?? "");
  return raw
    .replace(/([?&](?:access_)?(?:token|key|auth|password|secret|sid)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(bearer|cookie|set-cookie|authorization)\b\s*[:=]\s*\S+/gi, "$1 [redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    .replace(/\/(?:home|Users)\/[^/\s]+/g, "~")
    .slice(0, max);
}

function log(message: string): void {
  console.log(`[hermex] ${message}`);
}

/** Classify a failure from the child's own words. Patterns come from real logs. */
export function classifyHermexFailure(text: string): HermexFailureReason {
  const t = text.toLowerCase();
  if (/cannot open display|no display|xvfb|display :\d+|x server/.test(t)) return "display";
  if (/not logged in|sign in|signin|login|authentication required/.test(t)) return "login";
  if (
    /chrome|chromedriver|session not created|web view not found|no such window|cannot connect to chrome|selenium|webdriver/.test(
      t,
    )
  ) {
    return "chrome";
  }
  if (/timed out|timeout|stall/.test(t)) return "timeout";
  if (/no output|empty response|no translations/.test(t)) return "empty";
  if (/invalid json|unexpected token|json/.test(t)) return "malformed";
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────── mutex
/**
 * One request at a time, process-wide.
 *
 * This is a promise chain, not a timed lock: each waiter runs when the previous
 * settles, so a long translation delays the next request instead of racing it.
 * It protects a single Node process; the cross-process guarantee comes from
 * running exactly ONE translation worker (see docs/TRANSLATION-JOBS.md) —
 * Postgres is what serialises there.
 */
let browserLock: Promise<unknown> = Promise.resolve();
let queueDepth = 0;

export function hermexQueueDepth(): number {
  return queueDepth;
}

function withBrowserLock<T>(label: string, work: () => Promise<T>): Promise<T> {
  queueDepth += 1;
  if (queueDepth > 1) {
    log(`waiting for the browser lock (${queueDepth - 1} ahead) — ${label}`);
  }
  const run = browserLock.then(work, work);
  // Keep the chain alive regardless of outcome, and never leak a rejection.
  browserLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run.finally(() => {
    queueDepth -= 1;
  });
}

// ──────────────────────────────────────────────────────────────── availability
export interface HermexAvailability {
  ok: boolean;
  enabled: boolean;
  pythonPath: string;
  pythonExists: boolean;
  scriptPath: string;
  scriptExists: boolean;
  chromeProfilePath: string | null;
  chromeProfileExists: boolean;
  /** A completed `hermex:setup` leaves this marker inside the profile. */
  geminiSetupComplete: boolean;
  display: string | null;
  /** Unix socket for the X display, e.g. /tmp/.X11-unix/X99 — present when Xvfb runs. */
  displaySocketExists: boolean | null;
  headless: boolean;
  /** Blocking: Hermex cannot translate on this host until these are fixed. */
  problems: string[];
  /** Non-blocking: worth knowing, but translation can still work. */
  warnings: string[];
}

/**
 * Cheap, filesystem-only readiness check — **no Gemini query**, so it is safe to
 * call from a health endpoint on every poll.
 */
export function hermexAvailability(): HermexAvailability {
  const pythonPath = hermexPython();
  const scriptPath = hermexTranslateScriptPath();
  const profile = hermexChromeProfile();
  const display = hermexDisplay();
  const headless = hermexHeadless();
  const problems: string[] = [];
  const warnings: string[] = [];
  // HERMEX_DIR set == the deployed shape, where the profile path is mandatory.
  // Without it we are on a dev box, where hermex's own default profile is the
  // convention (`npm run hermex:setup` logs in there), so its absence is only
  // worth mentioning.
  const deployedShape = Boolean(hermexDir());

  const pythonExists = pythonPath.includes("/") ? fs.existsSync(pythonPath) : true;
  if (!pythonExists) {
    problems.push(`Hermex Python not found at ${pythonPath} (set HERMEX_PYTHON).`);
  }

  const scriptExists = fs.existsSync(scriptPath);
  if (!scriptExists) problems.push(`Translation script missing at ${scriptPath}.`);

  const chromeProfileExists = profile ? fs.existsSync(profile) : false;
  if (!profile) {
    (deployedShape ? problems : warnings).push(
      deployedShape
        ? "HERMEX_CHROME_PROFILE is not set — hermex would fall back to an unauthenticated profile."
        : "HERMEX_CHROME_PROFILE is not set; hermex will use its own default profile (the local convention).",
    );
  } else if (!chromeProfileExists) {
    problems.push(`Chrome profile not found at ${profile}.`);
  }

  const geminiSetupComplete = profile ? fs.existsSync(`${profile}/.setup_gemini`) : false;
  if (profile && chromeProfileExists && !geminiSetupComplete) {
    problems.push("Gemini setup marker (.setup_gemini) missing in the profile — run hermex setup on the server.");
  }

  // Only meaningful for a local display like ":99"; a remote DISPLAY has no socket.
  let displaySocketExists: boolean | null = null;
  if (!headless) {
    if (!display) {
      problems.push("No DISPLAY configured and headless is off — Chrome has nowhere to draw.");
    } else {
      const m = /^:(\d+)(\.\d+)?$/.exec(display);
      if (m) {
        displaySocketExists = fs.existsSync(`/tmp/.X11-unix/X${m[1]}`);
        if (!displaySocketExists) {
          problems.push(`No X server on ${display} — is Xvfb running?`);
        }
      }
    }
  }

  const enabled = hermexEnabled();
  if (!enabled) problems.push("HERMEX_ENABLED is off.");

  return {
    // A profile is only required where one is configured to exist (EC2).
    ok: enabled && pythonExists && scriptExists && problems.length === 0,
    enabled,
    pythonPath,
    pythonExists,
    scriptPath,
    scriptExists,
    chromeProfilePath: profile ?? null,
    chromeProfileExists,
    geminiSetupComplete,
    display: display ?? null,
    displaySocketExists,
    headless,
    problems,
    warnings,
  };
}

/** Throw a precise HermexError when this host plainly cannot run a translation. */
function assertRunnable(): void {
  if (!hermexEnabled()) {
    throw new HermexError("unavailable", "Hermex is disabled on this server (HERMEX_ENABLED=0).");
  }
  const a = hermexAvailability();
  if (!a.pythonExists) {
    throw new HermexError(
      "unavailable",
      `Hermex Python not found at ${a.pythonPath}. On EC2 set HERMEX_PYTHON=/home/ubuntu/hermex-translation/.venv/bin/python; locally run npm run hermex:install.`,
    );
  }
  if (!a.scriptExists) {
    throw new HermexError("unavailable", `Hermex translation script missing at ${a.scriptPath}.`);
  }
}

// ──────────────────────────────────────────────────────────────── the spawn
interface SpawnJsonOptions {
  label: string;
  script: string;
  payload: unknown;
  timeoutMs: number;
}

/**
 * Run a Hermex Python entry point and parse its single JSON object from stdout.
 *
 * Arguments are an array and there is no shell — nothing user-supplied can ever
 * become a command. The request itself travels on stdin as JSON, so even a
 * mantra full of quotes and newlines cannot affect the command line.
 */
async function spawnHermexJson<T>({ label, script, payload, timeoutMs }: SpawnJsonOptions): Promise<T> {
  const python = hermexPython();
  const env = hermexChildEnv();

  log(`Hermex translation started — ${label}`);
  log(
    `browser connection: python=${python} display=${env.DISPLAY ?? "(none)"} headless=${hermexHeadless()} profile=${
      hermexChromeProfile() ? "configured" : "DEFAULT (not logged in!)"
    }`,
  );

  return new Promise<T>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(python, [script], {
        cwd: repoRoot(),
        stdio: ["pipe", "pipe", "pipe"],
        env,
        shell: false, // never a shell: no injection surface
      });
    } catch (err: any) {
      reject(new HermexError("process", `Could not start Hermex: ${scrubHermexText(err)}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Chrome can keep the process alive; make sure it actually dies.
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref?.();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      // The CLI's own progress lines are useful; they carry no secrets.
      process.stderr.write(text);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new HermexError("process", `Hermex process error: ${scrubHermexText(err)}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (timedOut) {
        log(`Hermex translation failed — ${label}: timed out after ${Math.round(timeoutMs / 1000)}s`);
        reject(
          new HermexError(
            "timeout",
            `Gemini did not answer within ${Math.round(timeoutMs / 1000)}s (HERMEX_TRANSLATE_TIMEOUT_MS).`,
          ),
        );
        return;
      }

      const trimmedOut = stdout.trim();
      if (!trimmedOut) {
        const reason = classifyHermexFailure(stderr) === "unknown" ? "empty" : classifyHermexFailure(stderr);
        log(`Hermex translation failed — ${label}: no output (exit ${code ?? "?"})`);
        reject(
          new HermexError(
            reason,
            `Hermex exited ${code ?? "?"} with no output.${stderr ? ` Details: ${scrubHermexText(stderr, 400)}` : ""}`,
          ),
        );
        return;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(trimmedOut);
      } catch {
        log(`Hermex translation failed — ${label}: unparseable output`);
        reject(
          new HermexError(
            "malformed",
            `Hermex returned output that is not JSON (exit ${code ?? "?"}): ${scrubHermexText(trimmedOut, 300)}`,
          ),
        );
        return;
      }

      if (!parsed || parsed.ok !== true) {
        const message = scrubHermexText(parsed?.error ?? "Hermex reported a failure", 400);
        const reason = classifyHermexFailure(`${parsed?.error ?? ""} ${stderr}`);
        log(`Hermex translation failed — ${label}: ${message}`);
        reject(new HermexError(reason, message));
        return;
      }

      log(`Gemini request completed — ${label}`);
      resolve(parsed as T);
    });

    child.stdin?.write(JSON.stringify(payload));
    child.stdin?.end();
  });
}

// ───────────────────────────────────────────────────────────── public surface
/**
 * Translate through the server-side Hermex/Gemini session.
 *
 * Serialised against every other Hermex call in this process. Callers keep the
 * same signature they always had.
 */
export function runHermexTranslate(req: HermexTranslateRequest): Promise<HermexTranslateResponse> {
  const label =
    (Array.isArray(req.jobs) && req.jobs.length > 0
      ? `${req.jobs.length} job(s)`
      : req.context || `${req.targetLanguages?.length ?? 0} language(s)`) || "translate";

  return withBrowserLock(label, async () => {
    assertRunnable();

    // The caller may force headless; otherwise the host's configuration decides
    // (headful under Xvfb on EC2, headless on a server with no display).
    const headless = req.headless ?? hermexHeadless();

    const payload =
      Array.isArray(req.jobs) && req.jobs.length > 0
        ? {
            jobs: req.jobs,
            chunkSize: req.chunkSize,
            headless,
            queryTimeoutSec: req.queryTimeoutSec,
            continueOnError: req.continueOnError ?? true,
            chunkDelaySec: req.chunkDelaySec,
            maxRetries: req.maxRetries,
          }
        : {
            ...req,
            headless,
            continueOnError: req.continueOnError ?? true,
            chunkDelaySec: req.chunkDelaySec,
            maxRetries: req.maxRetries,
          };

    const result = await spawnHermexJson<HermexTranslateResponse>({
      label,
      script: hermexTranslateScriptPath(),
      payload,
      timeoutMs: hermexTranslateTimeoutMs(),
    });

    const rows = result.translations ?? result.results?.flatMap((r) => r.translations ?? []) ?? [];
    if (rows.length === 0) {
      throw new HermexError("empty", "Gemini returned no translations for this request.");
    }
    return result;
  });
}

export interface HermexSmokeResult {
  ok: boolean;
  response: string;
  expected: string;
  durationMs: number;
}

/**
 * The real round-trip: ask Gemini for a fixed token and check it comes back.
 *
 * Deliberately NOT wired into the health endpoint — it costs a Gemini request
 * and several seconds of browser time. Run it by hand after a deploy
 * (`npm run hermex:smoke`) or from the admin health route with `?deep=1`.
 */
export function runHermexSmokeTest(): Promise<HermexSmokeResult> {
  return withBrowserLock("smoke test", async () => {
    assertRunnable();
    const started = Date.now();
    const result = await spawnHermexJson<{ ok: boolean; response?: string; expected?: string }>({
      label: "smoke test",
      script: hermexSmokeScriptPath(),
      payload: { headless: hermexHeadless() },
      timeoutMs: hermexSmokeTimeoutMs(),
    });

    const expected = result.expected ?? "HERMEX_TEST_OK";
    const response = (result.response ?? "").trim();
    const ok = response.includes(expected);
    if (!ok) {
      throw new HermexError(
        "malformed",
        `Gemini replied "${scrubHermexText(response, 120)}" instead of ${expected}.`,
      );
    }
    return { ok, response, expected, durationMs: Date.now() - started };
  });
}
