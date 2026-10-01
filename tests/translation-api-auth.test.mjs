/**
 * Translation API - authorization + HTTP contract.
 * ================================================
 * Mounts the REAL router behind the REAL `requireAuth`/`requireAdmin` from
 * server/auth.ts, exactly as server/routes.ts does, and drives it over HTTP.
 * Authorization has to hold on the backend; hiding the button is not security.
 *
 *   anonymous  -> 401 on every route
 *   editor     -> 403 on every route
 *   admin      -> allowed, and creating a job must return immediately
 *
 * Needs Postgres (DATABASE_URL) but never Gemini: jobs are created from an
 * explicit item list, so no Strapi or Chrome call happens.
 *
 * Run:  npm run test:translation-api
 */
import "dotenv/config";
import express from "express";
import { eq } from "drizzle-orm";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — this suite needs a Postgres to talk to.");
  process.exit(1);
}

const { requireAuth, requireAdmin } = await import("../server/auth.ts");
const { default: translationJobsRouter } = await import("../server/translation/routes.ts");
const { db, pool } = await import("../server/db.ts");
const { translationJobs } = await import("../shared/schema.ts");

let PASS = 0;
const FAILURES = [];
const createdJobs = [];

function check(name, cond, detail = "") {
  if (cond) {
    PASS += 1;
    console.log(`  ok   ${name}`);
  } else {
    FAILURES.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// `who` is swapped per request; the middleware under test reads only these two.
let who = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.isAuthenticated = () => who !== null;
  req.user = who ?? undefined;
  next();
});
app.use("/api/translation-jobs", requireAuth, requireAdmin, translationJobsRouter);

const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, path, body, actor = null) {
  who = actor;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body is itself a failure the assertions will catch */
  }
  return { status: res.status, body: json, text };
}

const ADMIN = { id: "11111111-1111-1111-1111-111111111111", username: "t-admin", role: "admin" };
const EDITOR = { id: "22222222-2222-2222-2222-222222222222", username: "t-editor", role: "editor" };

const ROUTES = [
  ["POST", "/api/translation-jobs", { items: [{ mantraDocId: "abc123" }] }],
  ["GET", "/api/translation-jobs", null],
  ["GET", "/api/translation-jobs/queue/overview", null],
  ["GET", "/api/translation-jobs/some-id", null],
  ["GET", "/api/translation-jobs/some-id/items", null],
  ["POST", "/api/translation-jobs/some-id/retry", {}],
  ["POST", "/api/translation-jobs/some-id/retry-failed", {}],
  ["POST", "/api/translation-jobs/some-id/cancel", {}],
];

console.log("\ntranslation API authorization");

console.log("\n anonymous users");
for (const [method, path, body] of ROUTES) {
  const res = await call(method, path, body, null);
  check(`401 for ${method} ${path}`, res.status === 401, `got ${res.status}`);
}

console.log("\n authenticated non-admin (editor)");
for (const [method, path, body] of ROUTES) {
  const res = await call(method, path, body, EDITOR);
  check(`403 for ${method} ${path}`, res.status === 403, `got ${res.status}`);
}

console.log("\n admin");
{
  // created_by is a FK to users; a synthetic id would violate it, so the job is
  // created with a null author — the route still proves admins are let through.
  const started = Date.now();
  const res = await call(
    "POST",
    "/api/translation-jobs",
    {
      items: [
        { mantraDocId: "mantraone", mantraLabel: "1.1.1" },
        { mantraDocId: "mantratwo", mantraLabel: "1.1.2" },
        { mantraDocId: "mantrathree", mantraLabel: "1.1.3" },
      ],
      targetLanguages: ["Tamil", "Kannada"],
    },
    { ...ADMIN, id: null },
  );
  check("admin can create a job", res.status === 201, `got ${res.status}: ${res.text.slice(0, 200)}`);
  if (res.body?.job_id) createdJobs.push(res.body.job_id);
  check("response carries the job id", Boolean(res.body?.job_id));
  check("total_items is reported", res.body?.total_items === 3, `got ${res.body?.total_items}`);
  check("queued_items is reported", res.body?.queued_items === 3, `got ${res.body?.queued_items}`);
  check("status is queued", res.body?.status === "queued", `got ${res.body?.status}`);
  // No Gemini work may happen in the request; creating rows is milliseconds.
  check("create returns immediately", Date.now() - started < 3000, `took ${Date.now() - started}ms`);

  const jobId = res.body.job_id;

  const list = await call("GET", "/api/translation-jobs", null, ADMIN);
  check("admin can list jobs", list.status === 200, `got ${list.status}`);
  check("the new job is in the list", list.body?.jobs?.some((j) => j.id === jobId));
  check("summary tiles are present", typeof list.body?.summary?.totalJobs === "number");

  const detail = await call("GET", `/api/translation-jobs/${jobId}`, null, ADMIN);
  check("admin can read job detail", detail.status === 200, `got ${detail.status}`);
  check("detail reports totals", detail.body?.total === 3, `got ${detail.body?.total}`);
  check("detail reports progress", detail.body?.progress === 0, `got ${detail.body?.progress}`);
  check("detail reports per-status counts", detail.body?.counts?.queued === 3);

  const items = await call("GET", `/api/translation-jobs/${jobId}/items?limit=2&page=1`, null, ADMIN);
  check("items are paginated", items.body?.items?.length === 2, `got ${items.body?.items?.length}`);
  check("items report the total", items.body?.total === 3);
  check("items report the page count", items.body?.page_count === 2);

  const filtered = await call(`GET`, `/api/translation-jobs/${jobId}/items?status=completed`, null, ADMIN);
  check("status filter works", filtered.body?.total === 0, `got ${filtered.body?.total}`);

  const badFilter = await call("GET", `/api/translation-jobs/${jobId}/items?status=bogus`, null, ADMIN);
  check("an unknown status filter is rejected", badFilter.status === 400, `got ${badFilter.status}`);

  const queue = await call("GET", "/api/translation-jobs/queue/overview", null, ADMIN);
  check("admin can read the queue", queue.status === 200, `got ${queue.status}`);
  check("queue lists upcoming items", Array.isArray(queue.body?.upcoming));
  check("queue shows what is processing", Array.isArray(queue.body?.processing));

  const cancel = await call("POST", `/api/translation-jobs/${jobId}/cancel`, {}, ADMIN);
  check("admin can cancel", cancel.status === 200, `got ${cancel.status}`);
  check("cancel stops the queued items", cancel.body?.cancelledItems === 3, `got ${cancel.body?.cancelledItems}`);

  const retry = await call("POST", `/api/translation-jobs/${jobId}/retry-failed`, {}, ADMIN);
  check("admin can retry failed items", retry.status === 200, `got ${retry.status}`);
  check("cancelled items come back on retry", retry.body?.requeued === 3, `got ${retry.body?.requeued}`);

  const missing = await call("GET", "/api/translation-jobs/does-not-exist", null, ADMIN);
  check("unknown job is 404 (not 500)", missing.status === 404, `got ${missing.status}`);
}

console.log("\n input validation");
{
  const empty = await call("POST", "/api/translation-jobs", {}, ADMIN);
  check("a job with no source is rejected", empty.status === 400, `got ${empty.status}`);

  const badLang = await call(
    "POST",
    "/api/translation-jobs",
    { items: [{ mantraDocId: "abc123" }], targetLanguages: ["Klingon"] },
    ADMIN,
  );
  check("an unsupported language is rejected", badLang.status === 400, `got ${badLang.status}`);

  // A documentId is interpolated into a CMS query string, so anything that is
  // not an opaque id must never reach it.
  const traversal = await call(
    "POST",
    "/api/translation-jobs",
    { items: [{ mantraDocId: "../../admin/users" }] },
    ADMIN,
  );
  check("a path-traversal documentId is rejected", traversal.status === 400, `got ${traversal.status}`);

  const injection = await call(
    "POST",
    "/api/translation-jobs",
    { granthaDocId: "abc' or '1'='1" },
    ADMIN,
  );
  check("a quoted documentId is rejected", injection.status === 400, `got ${injection.status}`);
}

for (const id of createdJobs) {
  await db.delete(translationJobs).where(eq(translationJobs.id, id));
}
server.close();
await pool.end();

console.log(`\n${PASS} passed, ${FAILURES.length} failed`);
if (FAILURES.length) {
  for (const f of FAILURES) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("translation-api-auth: all ok");
