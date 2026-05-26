import assert from "node:assert/strict";
import {
  fetchManthraDetailCached,
  getCachedManthraDetail,
  invalidateManthraCache,
  setCachedManthraDetail,
} from "../client/src/lib/mantra-cms-cache";

const DOC = "doc-aaaaaaaaaaaaaa";

function row(label: string): { data: Record<string, unknown>; documentId: string; corrected: boolean } {
  return { data: { label }, documentId: DOC, corrected: false };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function testInFlightDedup(): Promise<void> {
  invalidateManthraCache();
  let loads = 0;
  const loader = async () => {
    loads += 1;
    await sleep(20);
    return row("one");
  };
  const [a, b] = await Promise.all([
    fetchManthraDetailCached(DOC, loader),
    fetchManthraDetailCached(DOC, loader),
  ]);
  assert.equal(loads, 1);
  assert.equal(a.data.label, "one");
  assert.equal(b.data.label, "one");
  assert.equal(getCachedManthraDetail(DOC)?.data.label, "one");
}

async function testStaleInFlightSkippedAfterInvalidate(): Promise<void> {
  invalidateManthraCache();
  let loads = 0;
  const slow = fetchManthraDetailCached(DOC, async () => {
    loads += 1;
    await sleep(40);
    return row("stale");
  });
  await sleep(5);
  invalidateManthraCache(DOC);
  setCachedManthraDetail(DOC, row("fresh"));
  const staleResult = await slow;
  assert.equal(staleResult.data.label, "stale");
  assert.equal(getCachedManthraDetail(DOC)?.data.label, "fresh");
  assert.equal(loads, 1);
}

async function testExplicitSetBlocksOlderInFlightWrite(): Promise<void> {
  invalidateManthraCache();
  let loads = 0;
  const slow = fetchManthraDetailCached(DOC, async () => {
    loads += 1;
    await sleep(40);
    return row("late");
  });
  await sleep(5);
  setCachedManthraDetail(DOC, row("authoritative"));
  await slow;
  assert.equal(getCachedManthraDetail(DOC)?.data.label, "authoritative");
  assert.equal(loads, 1);
}

async function main(): Promise<void> {
  await testInFlightDedup();
  await testStaleInFlightSkippedAfterInvalidate();
  await testExplicitSetBlocksOlderInFlightWrite();
  invalidateManthraCache();
  console.log("test-mantra-cms-cache: all ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
