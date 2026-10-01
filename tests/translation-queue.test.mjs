/**
 * Translation queue - integration tests against a REAL Postgres.
 * ==============================================================
 * The queue's whole value is that Postgres, not memory, decides what runs next,
 * so these tests exercise the actual SQL: claiming with FOR UPDATE SKIP LOCKED,
 * lease expiry, the retry ceiling, counters, cancellation and pagination.
 *
 * Gemini/Chrome is never touched: the worker takes an injectable `translate`,
 * and every test passes a fake. Nothing here spends a Gemini request.
 *
 * Run:  npm run test:translation-queue
 *       (uses DATABASE_URL from .env; creates and drops its own job rows)
 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — this suite needs a Postgres to talk to.");
  process.exit(1);
}
// Keep the suite snappy and deterministic: no backoff, no inter-item sleep.
process.env.TRANSLATION_RETRY_BACKOFF_MS = "0";
process.env.TRANSLATION_ITEM_DELAY_MS = "0";
process.env.WORKER_POLL_INTERVAL = "1000";
process.env.MAX_TRANSLATION_RETRIES = process.env.MAX_TRANSLATION_RETRIES || "3";
process.env.HERMEX_ENABLED = "1";

const { db, pool } = await import("../server/db.ts");
const { translationItems, translationJobs } = await import("../shared/schema.ts");
const store = await import("../server/translation/store.ts");
const { processOneItem, reconcileOnBoot } = await import("../server/translation/worker.ts");
const { translationConfig } = await import("../server/translation/config.ts");

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

function eq_(name, actual, expected) {
  check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/**
 * The worker claims the OLDEST queued item in the whole queue (FIFO across jobs),
 * which is the behaviour we want in production but means a test block would
 * otherwise pick up the leftovers of the block before it. Each block therefore
 * starts from an empty queue.
 */
async function purgeTestJobs() {
  for (const id of createdJobs.splice(0)) {
    await db.delete(translationJobs).where(eq(translationJobs.id, id)); // items cascade
  }
}

async function makeJob(itemCount, opts = {}) {
  await purgeTestJobs();
  const job = await store.createTranslationJob({
    createdBy: null,
    granthaDocId: "testgrantha",
    granthaName: opts.granthaName ?? "Test Grantha",
    targetLanguages: opts.targetLanguages ?? ["Tamil"],
    items: Array.from({ length: itemCount }, (_, i) => ({
      mantraDocId: `testmantra${i + 1}`,
      mantraLabel: `1.1.${i + 1}`,
    })),
  });
  createdJobs.push(job.id);
  return job;
}

/** A fake Hermex: resolves, or throws for the labels listed in `failFor`. */
function fakeTranslate({ failFor = [], onCall } = {}) {
  return async (input) => {
    onCall?.(input);
    if (failFor.includes(input.mantraLabel)) {
      throw new Error(`synthetic failure for ${input.mantraLabel}`);
    }
    return { ok: 1, failed: 0, units: 1, summary: `translated ${input.mantraLabel}` };
  };
}

const itemsOf = (jobId) =>
  db.select().from(translationItems).where(eq(translationItems.jobId, jobId)).orderBy(translationItems.sequenceNumber);

// ───────────────────────────────────────────────────────────────── the tests
console.log("\ntranslation queue");

// 1. Job creation writes one queued item per mantra, inside one transaction.
{
  console.log("\n create job");
  const job = await makeJob(5);
  const items = await itemsOf(job.id);
  eq_("total_items recorded", job.totalItems, 5);
  eq_("queued_items recorded", job.queuedItems, 5);
  eq_("status starts queued", job.status, "queued");
  eq_("one item per mantra", items.length, 5);
  check("every item starts queued", items.every((i) => i.status === "queued"));
  check("sequence numbers are 1..n", items.every((i, idx) => i.sequenceNumber === idx + 1));
  check("items carry the mantra reference", items[0].mantraDocId === "testmantra1");
}

// 2. Claiming is atomic: one row, marked processing, with a lease.
{
  console.log("\n claim");
  const job = await makeJob(3);
  const claimed = await store.claimNextItem("worker-a");
  check("an item was claimed", Boolean(claimed));
  eq_("claim takes the lowest sequence first", claimed.sequenceNumber, 1);
  eq_("claimed item is processing", claimed.status, "processing");
  eq_("attempt counted on claim", claimed.attempts, 1);
  check("lease was granted", Boolean(claimed.leaseExpiresAt));
  eq_("lease owner recorded", claimed.leaseOwner, "worker-a");

  // A second claim must never hand out the same row.
  const second = await store.claimNextItem("worker-b");
  check("a second worker gets a different item", second && second.id !== claimed.id);
  await store.completeItem(claimed.id, "done");
  await store.releaseItem(second.id, null);
}

// 3. A completed item is never claimed again.
{
  console.log("\n completed items are never re-run");
  const job = await makeJob(1);
  const calls = [];
  await processOneItem({ workerId: "w1", translate: fakeTranslate({ onCall: (i) => calls.push(i.mantraLabel) }) });
  const [item] = await itemsOf(job.id);
  eq_("item completed", item.status, "completed");
  check("translated text stored", (item.translatedText || "").includes("translated"));
  check("completed_at set", Boolean(item.completedAt));

  const again = await store.claimNextItem("w1");
  check("completed item is not re-claimed", !again || again.jobId !== job.id);
  if (again) await store.releaseItem(again.id, null);
  eq_("translate was called exactly once", calls.length, 1);
}

// 4. Failure → retry → retry → failed at the ceiling.
{
  console.log("\n retries");
  const job = await makeJob(1);
  const translate = fakeTranslate({ failFor: ["1.1.1"] });
  const seen = [];
  for (let i = 0; i < translationConfig.maxRetries; i++) {
    await processOneItem({ workerId: "w1", translate });
    const [item] = await itemsOf(job.id);
    seen.push({ attempts: item.attempts, status: item.status });
  }
  check(
    "item is requeued below the ceiling",
    seen.slice(0, -1).every((s) => s.status === "queued"),
    JSON.stringify(seen),
  );
  eq_("item fails at the ceiling", seen[seen.length - 1].status, "failed");
  eq_("attempts equal the retry ceiling", seen[seen.length - 1].attempts, translationConfig.maxRetries);

  const [item] = await itemsOf(job.id);
  check("the error message is stored", (item.error || "").includes("synthetic failure"));

  // And it stays failed — no further claim.
  const after = await store.claimNextItem("w1");
  check("a failed item is not claimed again", !after || after.jobId !== job.id);
  if (after) await store.releaseItem(after.id, null);

  const progress = await store.refreshJobProgress(job.id);
  eq_("job with only failures is failed", progress.status, "failed");
  eq_("failed counter", progress.failedItems, 1);
}

// 5. Admin retry puts failed items back and buys a fresh budget.
{
  console.log("\n retry failed items");
  const job = await makeJob(2);
  const translate = fakeTranslate({ failFor: ["1.1.1", "1.1.2"] });
  for (let i = 0; i < translationConfig.maxRetries * 2; i++) {
    await processOneItem({ workerId: "w1", translate });
  }
  let progress = await store.refreshJobProgress(job.id);
  eq_("both items failed", progress.failedItems, 2);
  check("retry_count recorded", progress.retryCount > 0, `retryCount=${progress.retryCount}`);

  const { requeued } = await store.retryFailedItems(job.id);
  eq_("both items requeued", requeued, 2);
  await store.resetAttemptsForJob(job.id);
  const items = await itemsOf(job.id);
  check("requeued items are queued again", items.every((i) => i.status === "queued"));
  check("errors cleared on retry", items.every((i) => i.error === null));

  // This time they succeed.
  await processOneItem({ workerId: "w1", translate: fakeTranslate() });
  await processOneItem({ workerId: "w1", translate: fakeTranslate() });
  progress = await store.refreshJobProgress(job.id);
  eq_("job completes after a successful retry", progress.status, "completed");
  eq_("completed counter", progress.completedItems, 2);
  eq_("failed counter cleared", progress.failedItems, 0);
}

// 6. Crash recovery: an expired lease comes back to the queue.
{
  console.log("\n crash recovery");
  const job = await makeJob(1);
  const claimed = await store.claimNextItem("dead-worker");
  check("item claimed by the doomed worker", Boolean(claimed));

  // Simulate the worker dying: the lease is never renewed and lapses.
  await db
    .update(translationItems)
    .set({ leaseExpiresAt: sql`now() - interval '1 minute'` })
    .where(eq(translationItems.id, claimed.id));

  const reaped = await store.requeueExpiredLeases();
  check("the expired lease was reaped", reaped >= 1, `reaped=${reaped}`);
  const [item] = await itemsOf(job.id);
  eq_("the item is queued again", item.status, "queued");
  eq_("the lease was released", item.leaseOwner, null);
  check("the attempt is remembered", item.attempts === 1);

  // A live lease must NOT be stolen.
  const fresh = await store.claimNextItem("live-worker");
  const stolen = await store.requeueExpiredLeases();
  const [afterReap] = await itemsOf(job.id);
  eq_("a live lease is left alone", afterReap.status, "processing");
  await store.completeItem(fresh.id, "done");

  // Boot reconciliation takes back only this worker's own rows.
  const job2 = await makeJob(1);
  const mine = await store.claimNextItem("boot-worker");
  await reconcileOnBoot("boot-worker");
  const [recovered] = await itemsOf(job2.id);
  eq_("boot reconcile requeues this worker's item", recovered.status, "queued");
}

// 7. Completed work survives a crash — the big promise of the whole design.
{
  console.log("\n completed work is never redone");
  const job = await makeJob(3);
  const calls = [];
  const translate = fakeTranslate({ onCall: (i) => calls.push(i.mantraLabel) });
  await processOneItem({ workerId: "w1", translate });
  await processOneItem({ workerId: "w1", translate });

  // "Restart" mid-job.
  const inflight = await store.claimNextItem("w1");
  await reconcileOnBoot("w1");

  await processOneItem({ workerId: "w2", translate });
  const items = await itemsOf(job.id);
  eq_("all three items completed", items.filter((i) => i.status === "completed").length, 3);
  eq_("each mantra was translated exactly once", new Set(calls).size, 3);
  eq_("no mantra was translated twice", calls.length, 3);
}

// 8. Job status rollup.
{
  console.log("\n job status rollup");
  const job = await makeJob(3);
  const translate = fakeTranslate({ failFor: ["1.1.2"] });
  for (let i = 0; i < 2 + translationConfig.maxRetries; i++) {
    await processOneItem({ workerId: "w1", translate });
  }
  const progress = await store.refreshJobProgress(job.id);
  eq_("mixed outcome is partially_failed", progress.status, "partially_failed");
  eq_("completed count", progress.completedItems, 2);
  eq_("failed count", progress.failedItems, 1);
  eq_("queued count", progress.queuedItems, 0);
  check("completed_at set", Boolean(progress.completedAt));
  const pct = Number(((progress.completedItems / progress.totalItems) * 100).toFixed(2));
  eq_("progress percentage", pct, 66.67);
}

// 9. Cancellation.
{
  console.log("\n cancel");
  const job = await makeJob(4);
  await processOneItem({ workerId: "w1", translate: fakeTranslate() });
  const { cancelledItems } = await store.cancelTranslationJob(job.id);
  eq_("remaining queued items were stopped", cancelledItems, 3);

  const after = await store.getTranslationJob(job.id);
  eq_("job is cancelled", after.status, "cancelled");

  const claimed = await store.claimNextItem("w1");
  check("a cancelled job hands out no more work", !claimed || claimed.jobId !== job.id);
  if (claimed) await store.releaseItem(claimed.id, null);

  const items = await itemsOf(job.id);
  eq_("the completed item is kept", items.filter((i) => i.status === "completed").length, 1);
}

// 10. Pagination and status filters.
{
  console.log("\n pagination and filters");
  const job = await makeJob(25);
  await processOneItem({ workerId: "w1", translate: fakeTranslate() });

  const page1 = await store.listTranslationItems(job.id, { page: 1, limit: 10 });
  eq_("page 1 size", page1.items.length, 10);
  eq_("total reported", page1.total, 25);
  eq_("page 1 starts at sequence 1", page1.items[0].sequenceNumber, 1);

  const page3 = await store.listTranslationItems(job.id, { page: 3, limit: 10 });
  eq_("last page size", page3.items.length, 5);
  eq_("page 3 starts at sequence 21", page3.items[0].sequenceNumber, 21);

  const completed = await store.listTranslationItems(job.id, { status: "completed" });
  eq_("completed filter", completed.total, 1);
  const queued = await store.listTranslationItems(job.id, { status: "queued" });
  eq_("queued filter", queued.total, 24);
  check("limit is capped", (await store.listTranslationItems(job.id, { limit: 9999 })).limit === 200);
}

// 11. Queue views.
{
  console.log("\n queue views");
  const job = await makeJob(3);
  const claimed = await store.claimNextItem("queue-view-worker");
  const processing = await store.listProcessingItems(10);
  check("processing view shows the in-flight item", processing.some((i) => i.id === claimed.id));
  const upcoming = await store.listUpcomingItems(50);
  check("upcoming view shows queued items", upcoming.some((i) => i.jobId === job.id));
  check("upcoming view excludes the in-flight item", !upcoming.some((i) => i.id === claimed.id));
  await store.releaseItem(claimed.id, null);

  const summary = await store.translationSummary();
  check("summary counts jobs", summary.totalJobs >= 1, `totalJobs=${summary.totalJobs}`);
  check("summary counts queued items", summary.queuedItems >= 3);
}

// ─────────────────────────────────────────────────────────────────── cleanup
await purgeTestJobs();
await pool.end();

console.log(`\n${PASS} passed, ${FAILURES.length} failed`);
if (FAILURES.length) {
  for (const f of FAILURES) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("translation-queue: all ok");
