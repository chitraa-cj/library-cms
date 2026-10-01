/**
 * Hermex retry classification — the circuit breaker must be FINAL.
 * ================================================================
 * `isHermexRetryableError()` decides whether runHermexWithRetry re-runs the whole
 * Python subprocess (a new browser, a new warm-up, the same oversized chunks). It
 * matched the substring "hermex", and the Python circuit breaker's abort message
 * mentioned HERMEX_MAX_SOURCE_CHARS — so the guard that exists to STOP wasted Gemini
 * round trips was classified as retryable and the entire 6-language job was relaunched
 * three times over. This locks that shut without weakening ordinary retries.
 *
 * No browser, no Gemini, no network.
 *
 * Run:  npm run test:hermex-retry
 */
import "dotenv/config";
import { readFileSync } from "node:fs";

const { isHermexRetryableError, NON_RETRYABLE_HERMEX_MARKER } = await import(
  "../script/lib/hermex-grantha-sync.ts"
);

let PASS = 0;
const FAILURES = [];

function check(name, ok, detail = "") {
  if (ok) {
    PASS += 1;
    console.log(`  ok   ${name}`);
  } else {
    FAILURES.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\nhermex retry classification");

// The exact message the Python breaker raises (translate_cli.py `_run_one_chunk`).
const BREAKER_MESSAGE =
  "GEMINI_BACKEND_ERROR_LIMIT: Gemini returned its own backend error on 4 consecutive " +
  "chunk attempts — aborting this job rather than re-sending for every remaining chunk. " +
  "This is FINAL for this run: relaunching the same subprocess would repeat the same " +
  "wasted round trips. Retry later (the checkpoint resumes), or set " +
  "HERMEX_TRANSIENT_ABORT_AFTER=0 to disable this guard.";

console.log("\n the circuit breaker is final");
check("marker is exported", NON_RETRYABLE_HERMEX_MARKER === "GEMINI_BACKEND_ERROR_LIMIT", NON_RETRYABLE_HERMEX_MARKER);
check(
  "the breaker abort is NOT retryable",
  isHermexRetryableError(new Error(BREAKER_MESSAGE)) === false,
  "it would relaunch the whole subprocess",
);
check(
  "still not retryable as a bare string",
  isHermexRetryableError(BREAKER_MESSAGE) === false,
);
check(
  "the marker wins even though the message mentions HERMEX_ vars",
  /hermex/i.test(BREAKER_MESSAGE) && isHermexRetryableError(new Error(BREAKER_MESSAGE)) === false,
);
check(
  "case does not matter",
  isHermexRetryableError(new Error("gemini_backend_error_limit: lower case variant")) === false,
);

console.log("\n ordinary retryable failures are unchanged");
for (const msg of [
  "session not created: cannot connect to chrome at 127.0.0.1:53603",
  "Message: no such window: web view not found",
  "Hermex translation timed out after 2700s",
  "Could not parse response (raw saved to logs/x.txt)",
  "Empty Gemini response",
  "element click intercepted: Element <rich-textarea> is not clickable at point (1050, 496)",
  "chromedriver unexpectedly exited",
  "did not reach state State.IDLE",
]) {
  check(`retryable: ${msg.slice(0, 48)}…`, isHermexRetryableError(new Error(msg)) === true);
}

console.log("\n genuinely non-retryable things stay non-retryable");
for (const msg of [
  "sourceText is required",
  "targetLanguages must be a non-empty array",
  "Mantra abc123 not found during sync",
]) {
  check(`not retryable: ${msg.slice(0, 40)}`, isHermexRetryableError(new Error(msg)) === false);
}

console.log("\n the two sides agree on the token");
// A mismatch here would silently restore the old behaviour, so compare the literal
// in the Python source with the exported TypeScript constant.
const py = readFileSync("python/hermex_translate/translate_cli.py", "utf8");
const m = /TRANSIENT_ABORT_MARKER\s*=\s*"([^"]+)"/.exec(py);
check("python defines the marker", Boolean(m), "TRANSIENT_ABORT_MARKER not found");
check(
  "python and typescript use the SAME token",
  m && m[1] === NON_RETRYABLE_HERMEX_MARKER,
  `python=${m && m[1]} ts=${NON_RETRYABLE_HERMEX_MARKER}`,
);
check(
  "the python abort message actually carries the marker",
  new RegExp(`\\{TRANSIENT_ABORT_MARKER\\}:`).test(py) ||
    py.includes("f\"{TRANSIENT_ABORT_MARKER}:"),
  "the breaker raise does not interpolate the marker",
);

console.log(`\n${PASS} passed, ${FAILURES.length} failed`);
if (FAILURES.length) {
  for (const f of FAILURES) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("hermex-retry-classification: all ok");
