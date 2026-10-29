/**
 * One-time Gemini login for the OCR → Grantha workflow's DEDICATED Chrome profile.
 *
 *   npm run hermex:setup-structure
 *
 * Refuses to run unless HERMEX_STRUCTURE_CHROME_PROFILE is set and is NOT translation's
 * profile (server/hermex/task-profiles.ts), then opens Chrome on it via setup_gemini.py
 * --profile. Log in with the Google account meant for document analysis — not the one
 * translation uses — and press Enter in the terminal.
 *
 * Needs a display: on EC2 it opens on HERMEX_STRUCTURE_DISPLAY (an Xvfb display such as
 * :98, viewed through VNC), so translation's :99 is never touched.
 */
import "../server/env";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { hermexPython, repoRoot } from "../server/hermex/config";
import { structureProfile } from "../server/hermex/task-profiles";

const result = structureProfile();
if (!result.ok) {
  console.error("Cannot set up the structure profile:\n  - " + result.problems.join("\n  - "));
  process.exit(1);
}

const env: NodeJS.ProcessEnv = { ...process.env };
// The structure display (HERMEX_STRUCTURE_DISPLAY, e.g. :98), never translation's.
const display = result.profile.display;
delete env.DISPLAY;
if (display) env.DISPLAY = display;
// Log in to the same Chrome profile the sessions will open (HERMEX_STRUCTURE_PROFILE_DIRECTORY).
if (result.profile.profileDirectory) env.HERMEX_SESSION_PROFILE_DIRECTORY = result.profile.profileDirectory;
console.log(`Opening Chrome on the dedicated structure profile: ${result.profile.profileDir} (display ${display ?? "none"})`);
const run = spawnSync(
  hermexPython(),
  [path.join(repoRoot(), "python", "hermex_translate", "setup_gemini.py"), "--profile", result.profile.profileDir],
  { stdio: "inherit", env, shell: false },
);
process.exit(run.status ?? 1);
