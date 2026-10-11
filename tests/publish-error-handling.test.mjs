/**
 * How a failing publish is reported.
 * ==================================
 * The incident these cover: a box whose `20261003_publish_job_queue.sql` had never been
 * applied. Every publish route's first statement threw `column "kind" does not exist`, and
 * the editor saw two useless things —
 *
 *   "Publish failed — column "kind" does not exist"          (Postgres's own wording)
 *   "Mantra publish is taking longer than expected…"          (a 500 polled 1,200 times)
 *
 * — neither of which says what to do. These tests pin the three pieces that fix that:
 * classifying a driver error, deciding whether a failed poll is worth waiting out, and the
 * schema check that refuses the publish before anything is written.
 *
 * No database and no server: every function here is pure.
 *
 * Run:  npm run test:publish-errors
 */
const { classifyDbError, isSchemaError, toApiError } = await import("../server/db-errors.ts");
const { diffRequiredSchema, PUBLISH_REQUIRED_SCHEMA, SchemaOutOfDateError } = await import(
  "../server/schema-guard.ts"
);
const { decidePollResponse, timedOutMessage, MAX_CONSECUTIVE_STATUS_ERRORS } = await import(
  "../client/src/lib/publish-poll.ts"
);

let PASS = 0;
const FAILURES = [];
function check(name, cond, detail) {
  if (cond) {
    PASS++;
    console.log(`  ok  ${name}`);
  } else {
    FAILURES.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** The error node-postgres actually throws for the reported failure. */
function pgError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

const KIND_MISSING = pgError("42703", 'column "kind" does not exist', {
  severity: "ERROR",
  position: "18",
  file: "parse_relation.c",
  routine: "errorMissingColumn",
});

// ── the reported error ───────────────────────────────────────────────────────────
console.log("\nthe missing `kind` column");
{
  const classified = classifyDbError(KIND_MISSING);
  check("is classified as a schema problem", classified?.code === "schema_out_of_date");
  check("answers 503, not 500", classified?.status === 503);
  check("tells the operator to run the migration", /npm run migrate/.test(classified?.message ?? ""));
  check("names the missing column", /\bkind\b/.test(classified?.message ?? ""));
  check("isSchemaError agrees", isSchemaError(KIND_MISSING));
  check(
    "keeps the raw driver text for the log only",
    classified?.detail === 'column "kind" does not exist',
  );
}

console.log("\nwhat reaches the browser");
{
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const { status, body } = toApiError(KIND_MISSING, "Failed to publish draft");
  process.env.NODE_ENV = previous;

  check("status is 503", status === 503);
  check("carries a machine-readable code", body.code === "schema_out_of_date");
  check(
    "no SQLSTATE in the message",
    !body.message.includes("42703"),
    body.message,
  );
  check(
    "no internal file or routine name in the message",
    !/parse_relation\.c|errorMissingColumn/.test(body.message),
    body.message,
  );
  check(
    "no bracketed raw driver text in production",
    !body.message.includes("["),
    body.message,
  );
  check("still actionable", /npm run migrate/.test(body.message));
}

console.log("\nother database failures");
{
  const cases = [
    ["missing table", pgError("42P01", 'relation "cms_worker_heartbeats" does not exist'), "schema_out_of_date", 503],
    ["connection refused", pgError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.1:5432"), "db_unavailable", 503],
    ["admin shutdown", pgError("57P01", "terminating connection due to administrator command"), "db_unavailable", 503],
    ["statement timeout", pgError("57014", "canceling statement due to statement timeout"), "db_timeout", 503],
    ["unique violation", pgError("23505", "duplicate key value violates unique constraint"), "db_conflict", 409],
  ];
  for (const [name, err, code, status] of cases) {
    const classified = classifyDbError(err);
    check(`${name} → ${code}`, classified?.code === code, classified?.code);
    check(`${name} → HTTP ${status}`, classified?.status === status, String(classified?.status));
  }
}

console.log("\nnon-database failures are left alone");
{
  // Strapi and validation errors are written for editors; rewriting them would be a
  // regression, so toApiError must pass them through untouched.
  const strapiErr = Object.assign(new Error("Strapi rejected the mantra: Title is required"), {
    status: 422,
  });
  const { status, body } = toApiError(strapiErr, "Failed to publish mantra");
  check("keeps the status", status === 422);
  check("keeps the message", body.message === "Strapi rejected the mantra: Title is required");
  check("adds no code", body.code === undefined);

  const bare = new Error("something went wrong");
  check("a bare Error still answers 500", toApiError(bare, "fallback").status === 500);
  check("classifyDbError ignores it", classifyDbError(bare) === null);
  check("classifyDbError ignores a plain string", classifyDbError("boom") === null);
}

console.log("\nthe guard refuses before it writes");
{
  const err = new SchemaOutOfDateError(["cms_publish_jobs.kind", "cms_publish_jobs.attempts"]);
  const { status, body } = toApiError(err, "Failed to publish draft");
  check("status 503", status === 503);
  check("code schema_out_of_date", body.code === "schema_out_of_date");
  check("says nothing was published", /Nothing was published/.test(body.message));
  check("names the missing columns", /cms_publish_jobs\.kind/.test(body.message));
}

// ── the schema check itself ──────────────────────────────────────────────────────
console.log("\ndiffRequiredSchema");
{
  /** A catalogue reading that has everything the publish path needs. */
  const healthy = new Map(
    PUBLISH_REQUIRED_SCHEMA.map((r) => [r.table, new Set(r.columns)]),
  );
  check("a complete schema reports nothing missing", diffRequiredSchema(healthy).length === 0);

  // Exactly the production state: the table is there, 20261003's columns are not.
  const preMigration = new Map(
    PUBLISH_REQUIRED_SCHEMA.map((r) => [r.table, new Set(r.columns)]),
  );
  for (const column of [
    "kind",
    "attempts",
    "max_attempts",
    "lease_owner",
    "lease_expires_at",
    "last_heartbeat_at",
    "next_attempt_at",
    "started_at",
    "publish_options",
  ]) {
    preMigration.get("cms_publish_jobs").delete(column);
  }
  preMigration.delete("cms_worker_heartbeats");

  const missing = diffRequiredSchema(preMigration);
  check("the un-migrated box reports cms_publish_jobs.kind", missing.includes("cms_publish_jobs.kind"));
  check("…and the heartbeat table", missing.includes("cms_worker_heartbeats"));
  check("…and nothing that is actually present", !missing.includes("cms_publish_jobs.status"));
  check("a missing table is reported once, not column by column", missing.filter((m) => m.startsWith("cms_worker_heartbeats")).length === 1);

  check("an empty database reports every relation", diffRequiredSchema(new Map()).length === PUBLISH_REQUIRED_SCHEMA.length);
}

// ── polling: failure vs. patience ────────────────────────────────────────────────
console.log("\ndecidePollResponse");
{
  const wait = (httpStatus, body, consecutiveErrors) =>
    decidePollResponse({ httpStatus, body, consecutiveErrors });

  check("200 means read the body", wait(200, null, 0).kind === "read");
  check("401 is handed to the caller's session logic", wait(401, null, 1).kind === "auth");

  // THE regression: an endpoint failing every call must not look like a slow publish.
  check("the first 500 is waited out", wait(500, { message: "boom" }, 1).kind === "wait");
  check(
    `a 500 on every poll gives up at ${MAX_CONSECUTIVE_STATUS_ERRORS}`,
    wait(500, { message: "boom" }, MAX_CONSECUTIVE_STATUS_ERRORS).kind === "fail",
  );
  {
    const decision = wait(500, { message: "boom" }, MAX_CONSECUTIVE_STATUS_ERRORS);
    check("…quoting the server's own wording", decision.message.includes("boom"));
    check("…and admitting the outcome is unknown", decision.certain === false);
    check("…and telling the editor to check Strapi first", /check Strapi/i.test(decision.message));
  }

  // A schema failure cannot resolve by waiting, and nothing was written.
  {
    const decision = wait(503, { message: "run `npm run migrate`", code: "schema_out_of_date" }, 1);
    check("a schema error fails on the FIRST poll", decision.kind === "fail");
    check("…is reported as certain", decision.certain === true);
    check("…and passes the server's message through", decision.message === "run `npm run migrate`");
  }

  {
    const decision = wait(404, { message: "Job not found", code: "job_not_found" }, 1);
    check("a vanished job fails immediately", decision.kind === "fail");
    check("…but its outcome is NOT certain", decision.certain === false);
    check("…so the editor is sent to Strapi, not to Publish", /check the content in Strapi/i.test(decision.message));
  }

  {
    const decision = wait(403, { message: "This publish job belongs to another user" }, 1);
    check("someone else's job fails immediately", decision.kind === "fail");
    check("…certainly", decision.certain === true);
  }

  check(
    "a body-less failure still reports the status",
    wait(502, null, MAX_CONSECUTIVE_STATUS_ERRORS).message.includes("HTTP 502"),
  );
}

console.log("\nthe timeout message no longer claims a failure");
{
  for (const what of ["Mantra", "Publish"]) {
    const message = timedOutMessage(what);
    check(`${what}: says it may still be running`, /may still be running/.test(message));
    check(`${what}: warns against republishing blind`, /check Strapi before republishing/i.test(message));
    check(`${what}: never says it failed`, !/\bfailed\b/i.test(message));
  }
}

// ── report ───────────────────────────────────────────────────────────────────────
console.log(`\n${PASS} passed, ${FAILURES.length} failed`);
if (FAILURES.length) {
  for (const name of FAILURES) console.log(`  - ${name}`);
  process.exit(1);
}
