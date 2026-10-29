/**
 * Which Gemini account each Hermex workflow drives — kept apart on purpose.
 *
 *   translation       HERMEX_CHROME_PROFILE (server/hermex/config.ts), unchanged.
 *   grantha structure HERMEX_STRUCTURE_CHROME_PROFILE — a SEPARATE Chrome profile,
 *                     logged in to a separate Google account, with its own lock file.
 *
 * Why separate, verified against the code rather than assumed:
 *   - one Chrome profile cannot be driven by two processes (Chrome's Singleton lock),
 *     and translate_cli holds a non-blocking flock for its whole run — a second
 *     workflow on the same profile would make translation items FAIL with
 *     "Hermex translation already running", which the worker counts as an attempt;
 *   - Gemini's web quota is per account, so sharing the account would spend
 *     translation's quota on document analysis.
 *
 * `structureProfile()` therefore refuses any configuration that resolves to
 * translation's profile, hermex's default profile, or translation's lock file.
 * Nothing here reads the profile's contents; it only learns paths from the env.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hermexChromeProfile, hermexDir, hermexDisplay, hermexHeadless, hermexPython, repoRoot } from "./config";

export interface HermexTaskProfile {
  task: "structure";
  profileDir: string;
  lockFile: string;
  headless: boolean;
}

export type TaskProfileResult = { ok: true; profile: HermexTaskProfile } | { ok: false; problems: string[] };

function trimmed(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Absolute, symlink-free form of a path that may not exist yet. The nearest existing
 * ancestor is resolved and the rest appended — otherwise a not-yet-created directory
 * inside translation's profile would compare unequal through a symlink (macOS /var →
 * /private/var) and slip past the check.
 */
function canonical(p: string): string {
  const abs = path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
  let existing = abs;
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return abs;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(fs.realpathSync(existing), ...rest);
  } catch {
    return abs;
  }
}

function sameOrNested(a: string, b: string): boolean {
  const ca = canonical(a);
  const cb = canonical(b);
  return ca === cb || ca.startsWith(cb + path.sep) || cb.startsWith(ca + path.sep);
}

/** Profiles hermex itself falls back to — i.e. whatever account `npm run hermex:setup` logged in. */
function hermexDefaultProfiles(): string[] {
  return [
    path.join(os.homedir(), "Library", "Application Support", "hermex"),
    path.join(os.homedir(), ".local", "share", "hermex"),
  ];
}

/** Translation's single-flight lock, exactly as translate_cli._lock_path() resolves it. */
function translationLockFile(): string | null {
  const override = trimmed("HERMEX_LOCK_FILE");
  if (override) return override;
  const dir = hermexDir();
  if (dir) return path.join(dir, ".hermex.lock");
  const profile = hermexChromeProfile();
  return profile ? path.join(path.dirname(profile.replace(/\/+$/, "")), ".hermex.lock") : null;
}

export function structureProfile(): TaskProfileResult {
  const problems: string[] = [];
  const profileDir = trimmed("HERMEX_STRUCTURE_CHROME_PROFILE");
  if (!profileDir) {
    return {
      ok: false,
      problems: [
        "HERMEX_STRUCTURE_CHROME_PROFILE is not set. OCR → Grantha needs its own Gemini login, separate from translation's: " +
          "set it to a new directory and run `npm run hermex:setup-structure` once (it opens Chrome for the login).",
      ],
    };
  }

  const translation = hermexChromeProfile();
  if (translation && sameOrNested(profileDir, translation)) {
    problems.push("HERMEX_STRUCTURE_CHROME_PROFILE is the translation profile (or inside it). It must be a separate profile with a separate Google account.");
  }
  for (const fallback of hermexDefaultProfiles()) {
    if (sameOrNested(profileDir, fallback)) {
      problems.push(`HERMEX_STRUCTURE_CHROME_PROFILE points at hermex's default profile (${fallback}), which is the account translation uses on a dev machine. Use a separate directory.`);
    }
  }

  const lockFile = trimmed("HERMEX_STRUCTURE_LOCK_FILE") ?? `${profileDir.replace(/\/+$/, "")}.lock`;
  const tLock = translationLockFile();
  if (tLock && canonical(lockFile) === canonical(tLock)) {
    problems.push("HERMEX_STRUCTURE_LOCK_FILE is translation's lock file; the two workflows must never contend for one lock.");
  }
  if (sameOrNested(lockFile, profileDir) && canonical(lockFile) !== canonical(`${profileDir.replace(/\/+$/, "")}.lock`)) {
    problems.push("HERMEX_STRUCTURE_LOCK_FILE must not live inside the Chrome profile directory.");
  }

  if (problems.length > 0) return { ok: false, problems };

  const headlessRaw = trimmed("HERMEX_STRUCTURE_HEADLESS")?.toLowerCase();
  const headless =
    headlessRaw === "1" || headlessRaw === "true" ? true : headlessRaw === "0" || headlessRaw === "false" ? false : hermexHeadless();
  return { ok: true, profile: { task: "structure", profileDir, lockFile, headless } };
}

export function promptSessionScript(): string {
  return trimmed("HERMEX_PROMPT_SESSION_SCRIPT") ?? path.join(repoRoot(), "python", "hermex_translate", "prompt_session.py");
}

/** Env keys a browser child never needs. Credentials stay with the processes that use them. */
const SECRET_KEY = /(API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|DATABASE_URL|_KEY_ID|PRIVATE)/i;

/**
 * The environment for a task's Python/Chrome child: the parent's env minus every
 * credential and every inherited HERMEX_* (so translation's profile, marker or lock
 * can never leak in), plus exactly this task's profile, lock and display.
 */
export function taskChildEnv(profile: HermexTaskProfile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    if (key.startsWith("HERMEX_") || SECRET_KEY.test(key)) continue;
    env[key] = value;
  }
  const display = hermexDisplay();
  if (display) env.DISPLAY = display;
  env.HERMEX_CHROME_PROFILE = profile.profileDir;
  env.HERMEX_CHROME_PROFILE_DIR = profile.profileDir;
  env.HERMEX_CHROME_PROFILE_MARKER = profile.profileDir;
  env.HERMEX_LOCK_FILE = profile.lockFile;
  env.HERMEX_CLEANUP_SCOPE = "profile";
  env.HERMEX_SESSION_HEADLESS = profile.headless ? "1" : "0";
  // Behaviour switches translate_cli reads; carried over explicitly, never a path or secret.
  for (const key of ["HERMEX_WARMUP", "HERMEX_LAUNCH_ATTEMPTS", "HERMEX_HEADLESS_FALLBACK", "HERMEX_DISABLE_WEB_SECURITY"]) {
    const value = process.env[key];
    if (value != null) env[key] = value;
  }
  return env;
}

export interface StructureHermexAvailability {
  ok: boolean;
  problems: string[];
  warnings: string[];
  profileDir: string | null;
  setupComplete: boolean;
  python: string;
}

/** Filesystem-only readiness for the structure workflow. Never opens a browser or sends a prompt. */
export function structureHermexAvailability(): StructureHermexAvailability {
  const python = hermexPython();
  const result = structureProfile();
  const problems = result.ok ? [] : [...result.problems];
  const warnings: string[] = [];
  let setupComplete = false;
  const profileDir = result.ok ? result.profile.profileDir : trimmed("HERMEX_STRUCTURE_CHROME_PROFILE") ?? null;

  if (process.env.HERMEX_ENABLED === "0" || process.env.HERMEX_ENABLED === "false") problems.push("HERMEX_ENABLED is off.");
  if (python.includes("/") && !fs.existsSync(python)) problems.push(`Hermex Python not found at ${python} (set HERMEX_PYTHON).`);
  if (!fs.existsSync(promptSessionScript())) problems.push(`Prompt session script missing at ${promptSessionScript()}.`);
  if (result.ok) {
    if (!fs.existsSync(result.profile.profileDir)) {
      problems.push(`The structure Chrome profile ${result.profile.profileDir} does not exist yet — run npm run hermex:setup-structure.`);
    } else {
      setupComplete = fs.existsSync(path.join(result.profile.profileDir, ".setup_gemini"));
      if (!setupComplete) problems.push("The structure profile has no completed Gemini login (.setup_gemini missing) — run npm run hermex:setup-structure.");
    }
    if (!result.profile.headless) {
      const display = hermexDisplay();
      const m = display ? /^:(\d+)/.exec(display) : null;
      if (!display) problems.push("No DISPLAY for a headful browser — set HERMEX_DISPLAY (Xvfb) or HERMEX_STRUCTURE_HEADLESS=1.");
      else if (m && process.platform === "linux" && !fs.existsSync(`/tmp/.X11-unix/X${m[1]}`)) {
        problems.push(`No X server on ${display} — is Xvfb running?`);
      }
    }
  }
  return { ok: problems.length === 0, problems, warnings, profileDir, setupComplete, python };
}
