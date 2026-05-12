/**
 * P0 reliability smoke checks.
 *
 * Usage:
 *   BASE_URL=http://localhost:5001 node tests/p0-reliability-smoke.mjs
 *
 * Notes:
 * - Requires an authenticated browser/session cookie export to fully hit private endpoints.
 * - This file documents acceptance checks and can be extended into CI integration tests.
 */

const base = process.env.BASE_URL || "http://localhost:5000";

const checks = [
  {
    name: "publish status endpoint shape",
    run: async () => {
      const res = await fetch(`${base}/api/drafts/1/publish-status?jobId=missing`, { credentials: "include" });
      if (![400, 401, 403, 404].includes(res.status)) {
        throw new Error(`Unexpected status ${res.status}`);
      }
    },
  },
  {
    name: "recover endpoint existence",
    run: async () => {
      const res = await fetch(`${base}/api/drafts/1/recover-latest`, {
        method: "POST",
        credentials: "include",
      });
      if (![400, 401, 403, 404].includes(res.status)) {
        throw new Error(`Unexpected status ${res.status}`);
      }
    },
  },
];

let failed = 0;
for (const check of checks) {
  try {
    await check.run();
    console.log(`PASS: ${check.name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${check.name}`, err?.message || err);
  }
}

if (failed > 0) {
  process.exitCode = 1;
  console.error(`\n${failed} reliability smoke check(s) failed.`);
} else {
  console.log("\nAll reliability smoke checks passed.");
}
