/**
 * Which Gemini account each Hermex workflow drives — kept apart on purpose.
 *
 *   translation       HERMEX_CHROME_PROFILE (server/hermex/config.ts), unchanged.
 *   OCR + grantha     HERMEX_STRUCTURE_CHROME_PROFILE — a SEPARATE Chrome profile,
 *   structure         logged in to a separate Google account, with its own lock file.
 *                     OCR and OCR → Grantha share it; HermexPromptSession lets only
 *                     one of their sessions hold it at a time.
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
import { hermexChromeProfile, hermexDir, hermexHeadless, hermexPython, hermexStructureDisplay, isValidXDisplay, repoRoot } from "./config";

export interface HermexTaskProfile {
  task: "structure";
  profileDir: string;
  lockFile: string;
  headless: boolean;
  /** X display for its headful browser (HERMEX_STRUCTURE_DISPLAY, else the shared one). */
  display: string | undefined;
  /**
   * The Chrome profile inside the user-data dir (`Profile 1`, `Default`, …) —
   * HERMEX_STRUCTURE_PROFILE_DIRECTORY. Needed when that dir holds more than one
   * profile; otherwise Chrome opens its profile picker and never reaches Gemini.
   */
  profileDirectory: string | undefined;
}

export interface ChromeProfileEntry {
  directory: string;
  name: string;
  /** Signed in to Chrome (a Google account attached to the profile). */
  signedIn: boolean;
}

/** hermex always launches Chrome with `--user-data-dir=<data dir>/chrome_profile`. */
export function chromeUserDataDir(profileDir: string): string {
  return path.join(profileDir.replace(/\/+$/, ""), "chrome_profile");
}

/**
 * The profiles Chrome lists in `<user-data dir>/Local State`: directory, display name
 * and whether it is signed in. Never the account's email, a cookie or a token.
 * Empty when the file is missing or unreadable (Chrome has not run there yet).
 */
export function listChromeProfiles(userDataDir: string): ChromeProfileEntry[] {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(userDataDir, "Local State"), "utf8"));
    const cache = state?.profile?.info_cache;
    if (!cache || typeof cache !== "object") return [];
    return Object.entries(cache as Record<string, any>)
      .map(([directory, info]) => ({ directory, name: String(info?.name ?? ""), signedIn: Boolean(info?.gaia_id) }))
      .sort((a, b) => a.directory.localeCompare(b.directory));
  } catch {
    return [];
  }
}

function describeProfiles(profiles: ChromeProfileEntry[]): string {
  return profiles.map((p) => `${p.directory} "${p.name}" (${p.signedIn ? "signed in" : "not signed in"})`).join(", ");
}

const VALID_PROFILE_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

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
        "HERMEX_STRUCTURE_CHROME_PROFILE is not set. OCR and OCR → Grantha need their own Gemini login, separate from translation's: " +
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

  // An explicit structure display that is malformed is reported, never swapped for
  // translation's display.
  const explicitDisplay = trimmed("HERMEX_STRUCTURE_DISPLAY");
  if (explicitDisplay && !isValidXDisplay(explicitDisplay)) {
    problems.push(`HERMEX_STRUCTURE_DISPLAY "${explicitDisplay}" is not an X display (expected something like :98).`);
  }
  const profileDirectory = trimmed("HERMEX_STRUCTURE_PROFILE_DIRECTORY");
  if (profileDirectory && (!VALID_PROFILE_DIRECTORY.test(profileDirectory) || profileDirectory === "..")) {
    problems.push(`HERMEX_STRUCTURE_PROFILE_DIRECTORY "${profileDirectory}" is not a Chrome profile directory name (e.g. "Profile 1").`);
  }

  if (problems.length > 0) return { ok: false, problems };

  const display = hermexStructureDisplay();
  const headlessRaw = trimmed("HERMEX_STRUCTURE_HEADLESS")?.toLowerCase();
  const headless =
    headlessRaw === "1" || headlessRaw === "true"
      ? true
      : headlessRaw === "0" || headlessRaw === "false"
        ? false
        : explicitDisplay
          ? false
          : hermexHeadless();
  return { ok: true, profile: { task: "structure", profileDir, lockFile, headless, display, profileDirectory } };
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
  // This task's display only: an inherited DISPLAY (translation's :99 from .env) is
  // replaced, or dropped when the task has none.
  delete env.DISPLAY;
  if (profile.display) env.DISPLAY = profile.display;
  env.HERMEX_CHROME_PROFILE = profile.profileDir;
  env.HERMEX_CHROME_PROFILE_DIR = profile.profileDir;
  env.HERMEX_CHROME_PROFILE_MARKER = profile.profileDir;
  env.HERMEX_LOCK_FILE = profile.lockFile;
  env.HERMEX_CLEANUP_SCOPE = "profile";
  env.HERMEX_SESSION_HEADLESS = profile.headless ? "1" : "0";
  if (profile.profileDirectory) env.HERMEX_SESSION_PROFILE_DIRECTORY = profile.profileDirectory;
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
      // Which Chrome profile inside the user-data dir: verified against Chrome's own list,
      // never assumed from a display name.
      const udd = chromeUserDataDir(result.profile.profileDir);
      const chromeProfiles = listChromeProfiles(udd);
      const chosen = result.profile.profileDirectory;
      const signedIn = chromeProfiles.filter((p) => p.signedIn).map((p) => p.directory);
      if (chosen && chromeProfiles.length > 0 && !chromeProfiles.some((p) => p.directory === chosen)) {
        problems.push(`HERMEX_STRUCTURE_PROFILE_DIRECTORY "${chosen}" is not a profile in ${udd} (it has: ${describeProfiles(chromeProfiles)}).`);
      } else if (!chosen && chromeProfiles.length > 1) {
        problems.push(
          `${udd} holds ${chromeProfiles.length} Chrome profiles (${describeProfiles(chromeProfiles)}) and none is selected, so Chrome opens its profile picker instead of Gemini. ` +
            `Set HERMEX_STRUCTURE_PROFILE_DIRECTORY to the one logged in to Gemini${signedIn.length ? ` (signed in: ${signedIn.join(", ")})` : ""}.`,
        );
      } else if (chosen && chromeProfiles.some((p) => p.directory === chosen && !p.signedIn)) {
        warnings.push(`Chrome profile "${chosen}" is not signed in to Chrome; the Gemini login itself is checked when a session starts.`);
      }
    }
    if (!result.profile.headless) {
      const display = result.profile.display;
      const source = trimmed("HERMEX_STRUCTURE_DISPLAY") ? "HERMEX_STRUCTURE_DISPLAY" : trimmed("HERMEX_DISPLAY") ? "HERMEX_DISPLAY" : "DISPLAY";
      const m = display ? /^:(\d+)/.exec(display) : null;
      if (!display) problems.push("No X display for the OCR browser — set HERMEX_STRUCTURE_DISPLAY (an Xvfb display such as :98) or HERMEX_STRUCTURE_HEADLESS=1.");
      else if (m && process.platform === "linux" && !fs.existsSync(`/tmp/.X11-unix/X${m[1]}`)) {
        problems.push(`No X server on ${display} (from ${source}) — start Xvfb on ${display}.`);
      }
    }
  }
  return { ok: problems.length === 0, problems, warnings, profileDir, setupComplete, python };
}
