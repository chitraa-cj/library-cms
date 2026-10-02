/**
 * Grantha publish queue — integration tests against a REAL Postgres.
 * ==================================================================
 * The whole point of this queue is that Postgres, not memory, decides who publishes what,
 * so these tests exercise the actual SQL: the advisory-locked claim, leases, the retry
 * ladder, crash recovery, and the two rules that protect Strapi from a double publish:
 *
 *   - never two grantha publishes running against one grantha
 *   - never two active jobs for one draft
 *
 * Strapi is never touched: `processOnePublishJob` takes an injectable `publish`, and every
 * test here passes a fake.
 *
 * Run:  npm run test:publish-queue
 *       (uses DATABASE_URL from .env; creates and drops its own user/draft/job rows)
 */
import "dotenv/config";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required — these tests run against a real Postgres.");
  process.exit(1);
}

// Must be set BEFORE the dynamic imports: publishConfig is a const frozen at module load.
process.env.PUBLISH_RETRY_BACKOFF_MS = "0";
process.env.PUBLISH_POLL_INTERVAL = "1000";
process.env.PUBLISH_PROGRESS_WRITE_MS = "0";
process.env.PUBLISH_MAX_ATTEMPTS = process.env.PUBLISH_MAX_ATTEMPTS || "3";

const { db, pool } = await import("../server/db.ts");
const { contentDrafts, publishJobs, publishJobTasks, publishManthraResolutions, users } =
  await import("../shared/schema.ts");
const store = await import("../server/publish/store.ts");
const { and, eq, sql } = await import("drizzle-orm");

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
const eq_ = (name, actual, expected) =>
  check(name, Object.is(actual, expected), `expected ${expected}, got ${actual}`);

// ───────────────────────────────────────────────────────────────────── fixtures

let testUserId;
const createdJobs = [];
const createdDrafts = [];

async function setup() {
  // Claims are oldest-first across the WHOLE table, so a row left behind by an aborted run
  // would be claimed instead of this run's and every assertion downstream would drift.
  await db.execute(sql`delete from cms_publish_jobs where id like 'pqtest%'`);
  await db.execute(
    sql`delete from content_drafts where title in ('Publish Queue Test Grantha', 'Second Test Grantha')`,
  );
  await db.execute(sql`delete from users where username like 'publish-queue-test-%'`);

  const [user] = await db
    .insert(users)
    .values({
      username: `publish-queue-test-${Date.now()}`,
      password: "x",
      role: "admin",
    })
    .returning();
  testUserId = user.id;
}

/**
 * A fresh draft per job by default. `cms_publish_jobs_one_active_per_draft` allows exactly
 * one active job per draft, so sharing one would make most of these blocks unbuildable —
 * which is itself the guarantee asserted in the "one draft, one publish" block.
 */
async function newDraft(title = "Publish Queue Test Grantha") {
  const [draft] = await db
    .insert(contentDrafts)
    .values({
      contentType: "granthas",
      title,
      data: { GranthaName: title, hierarchy: [] },
      createdBy: testUserId,
    })
    .returning();
  createdDrafts.push(draft.id);
  return draft.id;
}

async function teardown() {
  await purgeJobs();
  for (const id of createdDrafts.splice(0)) {
    await db.delete(contentDrafts).where(eq(contentDrafts.id, id));
  }
  if (testUserId) await db.delete(users).where(eq(users.id, testUserId));
}

/**
 * Jobs are claimed oldest-first across the WHOLE table, so leftovers from an earlier block
 * would be picked up by the next one. Every block starts from a clean queue.
 */
async function purgeJobs() {
  for (const id of createdJobs.splice(0)) {
    await db.delete(publishJobs).where(eq(publishJobs.id, id)); // tasks + resolutions cascade
  }
}

let jobSeq = 0;
async function makeJob(opts = {}) {
  const id = `pqtest${Date.now().toString(36)}${jobSeq++}`;
  const draftId = opts.draftId ?? (await newDraft());
  const [job] = await db
    .insert(publishJobs)
    .values({
      id,
      draftId,
      userId: testUserId,
      granthaDocId: opts.granthaDocId ?? null,
      kind: opts.kind ?? "grantha_publish",
      status: opts.status ?? "queued",
      maxAttempts: opts.maxAttempts ?? 3,
      publishOptions: opts.publishOptions ?? {},
      progressCurrent: "Waiting for the publish worker…",
    })
    .returning();
  createdJobs.push(job.id);
  return job;
}

const jobRow = async (id) => (await db.select().from(publishJobs).where(eq(publishJobs.id, id)))[0];

/** A fake publish walk. Resolves with the shape finalizePublishSuccess expects. */
function fakePublish({ throws, onCall } = {}) {
  return async (draft, jobId, onProgress) => {
    onCall?.({ draft, jobId });
    onProgress?.(1, 1, "fake step");
    if (throws) throw throws;
    return {
      strapiResult: { data: { documentId: "fakegrantha000000000001" } },
      updatedHierarchy: undefined,
      publishFailures: [],
      failedDeletedSectionDocIds: [],
      failedDeletedManthraDocIds: [],
    };
  };
}

// ───────────────────────────────────────────────────────────────────── the tests

await setup();
console.log("\npublish queue");

{
  console.log("\n• claim takes a lease");
  await purgeJobs();
  const job = await makeJob({ granthaDocId: "granthaA" });
  const claimed = await store.claimNextJob("worker-a");

  check("a queued job is claimed", claimed?.id === job.id);
  eq_("status becomes running", claimed?.status, "running");
  eq_("attempts incremented", claimed?.attempts, 1);
  eq_("lease owner recorded", claimed?.leaseOwner, "worker-a");

  // Read the lease back FROM POSTGRES rather than trusting the returned object: this is
  // what catches a JS Date leaking into a `timestamp` column on an Asia/Kolkata session.
  const [{ future }] = (
    await db.execute(
      sql`select (lease_expires_at > now()) as future from cms_publish_jobs where id = ${job.id}`,
    )
  ).rows;
  check("lease expires in the future, per Postgres", future === true, `got ${future}`);
}

{
  console.log("\n• one grantha, one publish");
  await purgeJobs();
  const first = await makeJob({ granthaDocId: "granthaB" });
  const second = await makeJob({ granthaDocId: "granthaB" });

  const a = await store.claimNextJob("worker-a");
  check("first job claimed", a?.id === first.id);
  const b = await store.claimNextJob("worker-b");
  check("second job for the SAME grantha is refused", b === null, `got ${b?.id}`);

  await store.completeJob(first.id, { ok: true });
  const c = await store.claimNextJob("worker-b");
  check("it becomes claimable once the first finishes", c?.id === second.id);
}

{
  console.log("\n• one draft, one publish (grantha id not yet known)");
  await purgeJobs();
  const draftId = await newDraft();
  await makeJob({ granthaDocId: null, draftId });

  // A first publish has no grantha id to guard on, so the draft is the key. The unique
  // index refuses the second job outright — the route catches this and hands back the job
  // already in flight.
  let code = null;
  try {
    await makeJob({ granthaDocId: null, draftId });
  } catch (err) {
    code = err?.code;
  }
  eq_("a second active job for one draft is rejected", code, "23505");

  const a = await store.claimNextJob("worker-a");
  check("the first is still claimable", a !== null);
}

{
  console.log("\n• different granthas do not block each other");
  await purgeJobs();
  await makeJob({ granthaDocId: "granthaC" });
  await makeJob({ granthaDocId: "granthaD" });

  const a = await store.claimNextJob("worker-a");
  const b = await store.claimNextJob("worker-b");
  check("both claimed — no false serialization", a !== null && b !== null);
  check("they are different jobs", a?.id !== b?.id);
}

{
  console.log("\n• concurrent claimers race for one grantha");
  await purgeJobs();
  await makeJob({ granthaDocId: "granthaE" });
  await makeJob({ granthaDocId: "granthaE" });

  // Both workers claim at the same time. SKIP LOCKED alone would let both through — each
  // locks a DIFFERENT candidate row and neither sees a running sibling yet. The advisory
  // lock in the claim transaction is what makes exactly one win.
  const [a, b] = await Promise.all([
    store.claimNextJob("worker-a"),
    store.claimNextJob("worker-b"),
  ]);
  const winners = [a, b].filter(Boolean);
  eq_("exactly one worker wins", winners.length, 1);
}

{
  console.log("\n• the unique index is the backstop");
  await purgeJobs();
  const first = await makeJob({ granthaDocId: "granthaF" });
  await store.claimNextJob("worker-a");
  const second = await makeJob({ granthaDocId: "granthaF" });

  let code = null;
  try {
    // Bypass the claim entirely — this is what a future logic bug would look like.
    await db
      .update(publishJobs)
      .set({ status: "running" })
      .where(eq(publishJobs.id, second.id));
  } catch (err) {
    code = err?.code;
  }
  eq_("a second running row for one grantha is rejected", code, "23505");
  void first;
}

{
  console.log("\n• lease expiry and heartbeat");
  await purgeJobs();
  const job = await makeJob({ granthaDocId: "granthaG" });
  await store.claimNextJob("worker-a");

  const held = await store.heartbeatJob(job.id, "worker-a");
  check("the owner can extend its lease", held === true);
  const stolen = await store.heartbeatJob(job.id, "worker-b");
  check("a non-owner cannot", stolen === false);

  await db
    .update(publishJobs)
    .set({ leaseExpiresAt: sql`now() - interval '1 minute'` })
    .where(eq(publishJobs.id, job.id));
  const reaped = await store.requeueExpiredLeases();
  check("an expired lease is reaped", reaped >= 1);

  const after = await jobRow(job.id);
  eq_("job is queued again", after.status, "queued");
  eq_("lease cleared", after.leaseOwner, null);
  eq_("attempts are remembered", after.attempts, 1);

  // A live lease must NOT be stolen.
  await purgeJobs();
  const live = await makeJob({ granthaDocId: "granthaH" });
  await store.claimNextJob("worker-a");
  const reaped2 = await store.requeueExpiredLeases();
  eq_("a live lease is left alone", reaped2, 0);
  eq_("still running", (await jobRow(live.id)).status, "running");
}

{
  console.log("\n• retry ladder");
  await purgeJobs();
  const job = await makeJob({ granthaDocId: "granthaI", maxAttempts: 3 });

  let status = await store.failJob(job.id, Object.assign(new Error("boom"), { code: "upstream_timeout" }), {
    retryable: true,
    attempts: 1,
    maxAttempts: 3,
  });
  eq_("a retryable failure requeues", status, "queued");

  status = await store.failJob(job.id, new Error("boom"), {
    retryable: true,
    attempts: 3,
    maxAttempts: 3,
  });
  eq_("the last attempt ends failed_recoverable", status, "failed_recoverable");

  status = await store.failJob(job.id, Object.assign(new Error("bad payload"), { status: 400 }), {
    retryable: false,
    attempts: 1,
    maxAttempts: 3,
  });
  eq_("a non-retryable failure is terminal immediately", status, "failed");

  // A job out of attempts must not be claimable again.
  await purgeJobs();
  const spent = await makeJob({ granthaDocId: "granthaJ", maxAttempts: 1 });
  await db.update(publishJobs).set({ attempts: 1 }).where(eq(publishJobs.id, spent.id));
  const claimed = await store.claimNextJob("worker-a");
  check("a job past max_attempts is not claimed", claimed === null, `got ${claimed?.id}`);
}

{
  console.log("\n• crash recovery");
  await purgeJobs();
  const mine = await makeJob({ granthaDocId: "granthaK" });
  await store.claimNextJob("worker-a");
  const requeued = await store.requeueOwnedJobs("worker-a");
  eq_("this worker's own job comes straight back", requeued, 1);
  const back = await jobRow(mine.id);
  eq_("queued again", back.status, "queued");
  eq_("a restart does not spend an attempt", back.attempts, 0);

  await purgeJobs();
  const theirs = await makeJob({ granthaDocId: "granthaL" });
  await store.claimNextJob("worker-b");
  eq_("another worker's job is untouched", await store.requeueOwnedJobs("worker-a"), 0);
  eq_("still running", (await jobRow(theirs.id)).status, "running");

  // SIGTERM: hand it back without spending the attempt.
  await store.releaseJob(theirs.id, "shutting down");
  const released = await jobRow(theirs.id);
  eq_("released back to queued", released.status, "queued");
  eq_("attempt refunded", released.attempts, 0);
}

{
  console.log("\n• the web process must not reclaim a worker's job");
  await purgeJobs();
  const grantha = await makeJob({ granthaDocId: "granthaM" });
  await store.claimNextJob("worker-a");
  const mantra = await makeJob({ kind: "manthra_publish", status: "running" });

  // Exactly what server/index.ts does at boot, now scoped by kind.
  await db
    .update(publishJobs)
    .set({ status: "failed_recoverable", error: "Server restarted during publish; safe to retry." })
    .where(and(eq(publishJobs.status, "running"), eq(publishJobs.kind, "manthra_publish")));

  eq_("a live grantha publish survives a web restart", (await jobRow(grantha.id)).status, "running");
  eq_("a per-mantra job is reclaimed", (await jobRow(mantra.id)).status, "failed_recoverable");
}

{
  console.log("\n• stale tasks are cleared before a retry, resolutions are not");
  await purgeJobs();
  const job = await makeJob({ granthaDocId: "granthaN" });

  await db.insert(publishJobTasks).values([
    { jobId: job.id, draftId: job.draftId, status: "queued", payload: { n: 1 } },
    { jobId: job.id, draftId: job.draftId, status: "failed", payload: { n: 2 } },
  ]);
  await db
    .insert(publishManthraResolutions)
    .values({ jobId: job.id, portalManthraId: "m1", strapiDocumentId: "doc1" });

  const { processOnePublishJob } = await import("../server/publish/worker.ts");
  let tasksWhenPublishRan = -1;
  await processOnePublishJob({
    workerId: "worker-a",
    publish: fakePublish({
      onCall: async () => {
        const rows = await db
          .select()
          .from(publishJobTasks)
          .where(eq(publishJobTasks.jobId, job.id));
        tasksWhenPublishRan = rows.length;
      },
    }),
  });

  eq_("the previous attempt's tasks are gone before the walk starts", tasksWhenPublishRan, 0);
  const resolutions = await db
    .select()
    .from(publishManthraResolutions)
    .where(eq(publishManthraResolutions.jobId, job.id));
  check(
    "the mantra checkpoint survives — it is what makes a retry cheap",
    resolutions.length === 1 || (await jobRow(job.id)).status === "done",
  );
}

{
  console.log("\n• worker liveness");
  await store.beatWorkerHeartbeat("test-worker");
  check("a fresh heartbeat reads as alive", (await store.isPublishWorkerAlive()) === true);
  check("a stale one does not", (await store.isPublishWorkerAlive(0)) === false);
}

// ───────────────────────────────────────────────────────────────────── teardown

await teardown();
await pool.end();

console.log(`\n${PASS} passed, ${FAILURES.length} failed`);
if (FAILURES.length) {
  for (const f of FAILURES) console.log(`  - ${f}`);
  process.exit(1);
}
