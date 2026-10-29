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
 * Needs a display: on EC2 run it under the Xvfb display with a VNC/X forward, exactly as
 * the translation profile was set up.
 */
import "../server/env";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { hermexDisplay, hermexPython, repoRoot } from "../server/hermex/config";
import { structureProfile } from "../server/hermex/task-profiles";

const result = structureProfile();
if (!result.ok) {
  console.error("Cannot set up the structure profile:\n  - " + result.problems.join("\n  - "));
  process.exit(1);
}

const env: NodeJS.ProcessEnv = { ...process.env };
const display = hermexDisplay();
if (display) env.DISPLAY = display;
console.log(`Opening Chrome on the dedicated structure profile: ${result.profile.profileDir}`);
const run = spawnSync(
  hermexPython(),
  [path.join(repoRoot(), "python", "hermex_translate", "setup_gemini.py"), "--profile", result.profile.profileDir],
  { stdio: "inherit", env, shell: false },
);
process.exit(run.status ?? 1);
