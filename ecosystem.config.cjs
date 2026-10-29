/**
 * pm2 definitions for the background workers ONLY.
 *
 * The web app (`cmslibrary` on this box) is already running on EC2 and is
 * restarted by CI, which resolves the real pm2 name itself. It is deliberately NOT defined
 * here: re-declaring a live process from a file that guesses at its flags is how
 * you lose a working configuration.
 *
 *   pm2 start ecosystem.config.cjs --only cms-translation-worker
 *   pm2 start ecosystem.config.cjs --only cms-publish-worker
 *   pm2 start ecosystem.config.cjs --only cms-ocr-worker
 *   pm2 save
 *
 * Hermex configuration (HERMEX_DIR / HERMEX_PYTHON / HERMEX_CHROME_PROFILE /
 * DISPLAY) is read from the CMS `.env` on the box, which is NOT in git. Both
 * processes load it through server/env.ts, so there is one source of truth and
 * no server path is ever committed.
 *
 * DISPLAY deserves a note: the Node processes do not need it. The adapter sets
 * DISPLAY explicitly on the Python/Chrome child it spawns (see
 * server/hermex/config.ts → hermexChildEnv), which is far more reliable than
 * hoping `pm2 --update-env` inherited the right shell. Setting it here too is
 * harmless belt-and-braces.
 */
module.exports = {
  apps: [
    {
      name: "cms-translation-worker",
      script: "dist/translation-worker.cjs",
      cwd: process.env.CMS_DIR || "/home/ubuntu/library/library-cms",
      // The worker holds one mantra at a time; it needs a fraction of the API's heap.
      node_args: "--max-old-space-size=1024",
      instances: 1,
      // Fork mode, ONE instance: a single authenticated Chrome profile cannot be
      // driven by two processes at once. The Postgres queue (FOR UPDATE SKIP
      // LOCKED) is already safe for more workers if a second profile ever exists.
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        // Falls back to the values in .env when these are unset.
        DISPLAY: process.env.DISPLAY || ":99",
      },
      autorestart: true,
      // A crash loop here usually means Chrome or the Gemini session is broken;
      // back off hard rather than hammering it.
      restart_delay: 30_000,
      max_restarts: 50,
      // SIGTERM lets the current mantra wind down; worker-main hard-exits after 30s.
      kill_timeout: 45_000,
      out_file: "logs/translation-worker.out.log",
      error_file: "logs/translation-worker.err.log",
      time: true,
    },
    {
      name: "cms-publish-worker",
      script: "dist/publish-worker.cjs",
      cwd: process.env.CMS_DIR || "/home/ubuntu/library/library-cms",
      // Publishing holds a whole grantha draft in memory — Chandogya's is ~55MB before the
      // hierarchy and progress plan are built on top of it. 1GB (what the translation
      // worker gets) is not enough.
      node_args: "--max-old-space-size=3072",
      // ONE instance. The claim is advisory-locked per grantha so more would be SAFE, but
      // nothing here benefits from parallel publishes and each one is memory-hungry.
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
      autorestart: true,
      restart_delay: 10_000,
      max_restarts: 50,
      // A publish runs for many minutes and cannot be waited out: on SIGTERM the worker
      // hands the job back unclaimed and exits within ~10s, so this only needs headroom
      // over that, not over a publish.
      kill_timeout: 20_000,
      out_file: "logs/publish-worker.out.log",
      error_file: "logs/publish-worker.err.log",
      time: true,
    },
    {
      name: "cms-ocr-worker",
      script: "dist/ocr-worker.cjs",
      cwd: process.env.CMS_DIR || "/home/ubuntu/library/library-cms",
      // Holds one job's chunk plan and one range's page file at a time; the 500-page
      // preparation benchmark peaked ~235MB RSS. The browser is a separate process.
      node_args: "--max-old-space-size=1024",
      // ONE instance: one dedicated Chrome profile, one Gemini session, one range at a
      // time. The claim (FOR UPDATE SKIP LOCKED + run token) would keep a second safe.
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        // The profile and display come from .env (HERMEX_STRUCTURE_CHROME_PROFILE,
        // HERMEX_STRUCTURE_DISPLAY), loaded by server/env.ts — one source of truth. The
        // Chrome child's DISPLAY is set from HERMEX_STRUCTURE_DISPLAY by taskChildEnv,
        // never inherited, so translation's :99 cannot leak in.
      },
      autorestart: true,
      // A crash loop here usually means Chrome or the Gemini session is broken;
      // back off rather than hammering it.
      restart_delay: 30_000,
      max_restarts: 50,
      // SIGTERM aborts the range in flight and hands the job back within ~20s
      // (worker-main GRACE_MS), with a 30s backstop; this leaves headroom over both.
      kill_timeout: 45_000,
      out_file: "logs/ocr-worker.out.log",
      error_file: "logs/ocr-worker.err.log",
      time: true,
    },
  ],
};
