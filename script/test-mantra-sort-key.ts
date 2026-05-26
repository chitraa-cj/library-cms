/**
 * Run: npx tsx script/test-mantra-sort-key.ts
 */
import assert from "node:assert/strict";
import {
  sortKeyBetween,
  assignSpacedSortKeysFromPortalOrder,
  portalIndexToStrapiSortKey,
  STRAPI_SORT_GAP,
} from "../shared/mantra-sort-key.ts";

const a = sortKeyBetween(undefined, undefined);
assert.equal(a.sortKey, STRAPI_SORT_GAP);
assert.equal(a.needsRecompact, false);

const between = sortKeyBetween(1000, 2000);
assert.equal(between.sortKey, 1500);
assert.equal(between.needsRecompact, false);

const atEnd = sortKeyBetween(5000, undefined);
assert.equal(atEnd.sortKey, 6000);

const tight = sortKeyBetween(1000, 1001);
assert.equal(tight.needsRecompact, true);

const keys = assignSpacedSortKeysFromPortalOrder([
  { id: "a" },
  { id: "b" },
  { id: "c" },
]);
assert.equal(keys.get("a"), portalIndexToStrapiSortKey(1));
assert.equal(keys.get("c"), portalIndexToStrapiSortKey(3));

console.log("test-mantra-sort-key: all ok");
