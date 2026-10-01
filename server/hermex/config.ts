/**
 * Where Hermex lives, as *deployment configuration* rather than an assumption.
 *
 * The EC2 box has a persistent, already-authenticated Hermex install that this
 * repo must never touch:
 *
 *   HERMEX_DIR=/home/ubuntu/hermex-translation
 *   HERMEX_PYTHON=/home/ubuntu/hermex-translation/.venv/bin/python
 *   HERMEX_CHROME_PROFILE=/home/ubuntu/hermex-translation/chrome-profile
 *   DISPLAY=:99                      (Xvfb)
 *
 * A Mac has none of those paths, so every lookup here is lazy and best-effort:
 * resolving config NEVER throws and never touches the filesystem at import time.
 * Local development falls back to the repo's own `.venv-hermex`, and when even
 * that is missing the feature simply reports itself unavailable instead of
 * taking the backend down.
 *
 * Nothing secret lives here. The Gemini session is a Chrome profile on disk on
 * EC2; this module only ever learns its *path* from the environment.
 */
import fs from "node:fs";
import path from "node:path";

/** Project root — cwd works in the CJS bundle (dist/index.cjs); start pm2 from the repo root. */
export function repoRoot(): string {
  return process.env.CMS_REPO_ROOT || process.cwd();
}

function trimmed(name: string): string | undefined {
  const v = process.env[name];
  const t = v?.trim();
  return t ? t : undefined;
}

/** `HERMEX_DIR` — the persistent install root on EC2; undefined on a dev box. */
export function hermexDir(): string | undefined {
  return trimmed("HERMEX_DIR");
}

/**
 * The Python that has `hermex` importable.
 *
 * Precedence: explicit HERMEX_PYTHON → <HERMEX_DIR>/.venv/bin/python (the EC2
 * layout) → the repo's own .venv-hermex (local dev) → `python3` on PATH. The
 * last one is a guess that will fail loudly at spawn time rather than silently
 * translating with the wrong interpreter.
 */
export function hermexPython(): string {
  const explicit = trimmed("HERMEX_PYTHON");
  if (explicit) return explicit;

  const dir = hermexDir();
  if (dir) {
    for (const candidate of [
      path.join(dir, ".venv", "bin", "python"),
      path.join(dir, ".venv", "bin", "python3"),
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  const localVenv = path.join(repoRoot(), ".venv-hermex", "bin", "python3");
  if (fs.existsSync(localVenv)) return localVenv;

  return "python3";
}

/**
 * The persistent Chrome profile holding the Gemini login.
 *
 * MUST stay on EC2 and out of git. When unset, hermex uses its own default
 * profile directory — which on a fresh box is NOT logged in, so a deployment
 * that forgets this variable fails with "Gemini session not logged in".
 */
export function hermexChromeProfile(): string | undefined {
  const explicit = trimmed("HERMEX_CHROME_PROFILE");
  if (explicit) return explicit;
  const dir = hermexDir();
  if (dir) {
    const candidate = path.join(dir, "chrome-profile");
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * X display for Chrome. On EC2 this is Xvfb's `:99`; on a Mac it is undefined
 * and Chrome uses the real window server.
 *
 * HERMEX_DISPLAY wins over an inherited DISPLAY so the pm2 process does not have
 * to carry one: we set it explicitly on the child instead, which is far more
 * reliable than hoping `pm2 restart --update-env` picked the right shell up.
 */
export function hermexDisplay(): string | undefined {
  return trimmed("HERMEX_DISPLAY") ?? trimmed("DISPLAY");
}

/**
 * Headless or headful?
 *
 * Under Xvfb the browser is *headful* on a virtual display — that is the
 * configuration proven to work on this box, and Gemini is friendlier to it.
 * So: a configured display means headless=false unless explicitly overridden.
 */
export function hermexHeadless(): boolean {
  const explicit = trimmed("HERMEX_HEADLESS")?.toLowerCase();
  if (explicit === "1" || explicit === "true" || explicit === "yes") return true;
  if (explicit === "0" || explicit === "false" || explicit === "no") return false;
  return !hermexDisplay();
}

export function hermexTranslateScriptPath(): string {
  return (
    trimmed("HERMEX_TRANSLATE_SCRIPT") ??
    path.join(repoRoot(), "python", "hermex_translate", "translate_cli.py")
  );
}

export function hermexSmokeScriptPath(): string {
  return (
    trimmed("HERMEX_SMOKE_SCRIPT") ??
    path.join(repoRoot(), "python", "hermex_translate", "smoke_test.py")
  );
}

/** Hard ceiling for one Hermex subprocess. */
export function hermexTranslateTimeoutMs(): number {
  const n = parseInt(process.env.HERMEX_TRANSLATE_TIMEOUT_MS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : 45 * 60 * 1000;
}

export function hermexSmokeTimeoutMs(): number {
  const n = parseInt(process.env.HERMEX_SMOKE_TIMEOUT_MS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : 4 * 60 * 1000;
}

export function hermexEnabled(): boolean {
  const flag = process.env.HERMEX_ENABLED;
  if (flag === "0" || flag === "false") return false;
  return true;
}

/**
 * Environment handed to the Hermex child process.
 *
 * Built explicitly rather than inherited wholesale so the browser always gets
 * the display and profile it needs, whatever pm2's own environment looks like.
 * `HERMEX_CHROME_PROFILE_DIR` / `_MARKER` are what the CLI's stale-Chrome
 * cleanup uses; without them it would look for a macOS-shaped path and would
 * never reap an orphan on the server.
 */
export function hermexChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const display = hermexDisplay();
  if (display) env.DISPLAY = display;

  const profile = hermexChromeProfile();
  if (profile) {
    env.HERMEX_CHROME_PROFILE = profile;
    env.HERMEX_CHROME_PROFILE_DIR = profile;
    // pkill -f pattern for orphaned Chrome on THIS profile. The path is specific
    // enough that a human's own browser is never matched.
    env.HERMEX_CHROME_PROFILE_MARKER ??= profile;
  }

  const dir = hermexDir();
  if (dir) env.HERMEX_DIR = dir;
  return env;
}

/** A flat, loggable, secret-free view of the resolved configuration. */
export function hermexConfigSummary() {
  return {
    enabled: hermexEnabled(),
    dir: hermexDir() ?? null,
    python: hermexPython(),
    chromeProfile: hermexChromeProfile() ?? null,
    display: hermexDisplay() ?? null,
    headless: hermexHeadless(),
    translateScript: hermexTranslateScriptPath(),
    translateTimeoutMs: hermexTranslateTimeoutMs(),
  };
}
