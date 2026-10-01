/**
 * EC2 smoke test: does the CMS actually reach Gemini through the server-side
 * Hermex install?
 *
 *   npm run hermex:smoke            # full round-trip (spends ONE Gemini request)
 *   npm run hermex:smoke -- --check # configuration only, no Gemini call
 *
 * Run it from the CMS directory on the box (so it reads the same .env the
 * backend does) right after a deploy. Exit code 0 means the website can
 * translate; anything else prints exactly which link in the chain is broken.
 */
import "../server/env";

import {
  hermexAvailability,
  runHermexSmokeTest,
  HermexError,
} from "../server/hermex-translate";
import { hermexConfigSummary } from "../server/hermex/config";

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(22)} ${value === null || value === undefined ? "(unset)" : String(value)}`);
}

async function main() {
  const checkOnly = process.argv.includes("--check");

  console.log("\nHermex configuration");
  const cfg = hermexConfigSummary();
  line("HERMEX_ENABLED", cfg.enabled);
  line("HERMEX_DIR", cfg.dir);
  line("HERMEX_PYTHON", cfg.python);
  line("HERMEX_CHROME_PROFILE", cfg.chromeProfile);
  line("DISPLAY", cfg.display);
  line("headless", cfg.headless);
  line("translate script", cfg.translateScript);
  line("timeout", `${Math.round(cfg.translateTimeoutMs / 1000)}s`);

  console.log("\nReadiness (filesystem only, no Gemini call)");
  const a = hermexAvailability();
  line("python present", a.pythonExists);
  line("script present", a.scriptExists);
  line("profile present", a.chromeProfileExists);
  line("gemini setup marker", a.geminiSetupComplete);
  line("X display socket", a.displaySocketExists === null ? "n/a (headless)" : a.displaySocketExists);
  line("ready", a.ok);

  if (a.problems.length > 0) {
    console.log("\nProblems (these block translation):");
    for (const p of a.problems) console.log(`  - ${p}`);
  }
  if (a.warnings.length > 0) {
    console.log("\nNotes (not blocking):");
    for (const w of a.warnings) console.log(`  - ${w}`);
  }

  if (checkOnly) {
    console.log(a.ok ? "\nConfiguration looks right.\n" : "\nConfiguration is incomplete (see above).\n");
    process.exit(a.ok ? 0 : 1);
  }

  if (!a.ok) {
    console.error("\nRefusing to run the Gemini round-trip while the configuration is incomplete.");
    console.error("Fix the problems above, or re-run with --check to re-verify.\n");
    process.exit(1);
  }

  console.log('\nAsking Gemini for "HERMEX_TEST_OK" — this opens Chrome and takes a few seconds…\n');
  try {
    const result = await runHermexSmokeTest();
    console.log(`\nGemini replied: ${JSON.stringify(result.response)}`);
    console.log(`Expected:       ${JSON.stringify(result.expected)}`);
    console.log(`Round-trip:     ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log("\nHERMEX SMOKE TEST PASSED — the CMS can translate through Gemini.\n");
    process.exit(0);
  } catch (err) {
    const reason = err instanceof HermexError ? err.reason : "unknown";
    console.error(`\nHERMEX SMOKE TEST FAILED (${reason})`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    console.error(
      {
        login: "\n  → The Gemini session expired. Re-run the interactive Hermex setup on the server.",
        display: "\n  → No X display. Check Xvfb on :99 (see docs/HERMEX.md, EC2 section).",
        chrome: "\n  → Chrome/chromedriver is wedged. Stop the worker, pkill -f chromedriver, remove Singleton* from the profile.",
        timeout: "\n  → Gemini did not answer in time. Try again; if it persists the session may be rate-limited.",
        unavailable: "\n  → Hermex is not reachable from this process. Check HERMEX_PYTHON / HERMEX_ENABLED in .env.",
      }[reason] ?? "",
    );
    console.error("");
    process.exit(1);
  }
}

void main();
