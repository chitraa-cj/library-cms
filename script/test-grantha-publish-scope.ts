/**
 * Run: npx tsx script/test-grantha-publish-scope.ts
 */
import assert from "node:assert/strict";
import {
  resolveGranthaPublishStrategy,
  collectManthraPublishTargets,
  parsePublishScopeFromDraft,
} from "../client/src/lib/grantha-publish-scope.ts";

assert.equal(
  resolveGranthaPublishStrategy(
    { changedManthraIds: ["m1"], requiresFullPublish: false, granthaMetaDirty: false },
    { hasPublishedGrantha: true, hasPendingDeletions: false },
  ),
  "incremental",
);

assert.equal(
  resolveGranthaPublishStrategy(
    { changedManthraIds: ["m1", "m2"], requiresFullPublish: false, granthaMetaDirty: true },
    { hasPublishedGrantha: true, hasPendingDeletions: false },
  ),
  "full",
);

assert.equal(
  resolveGranthaPublishStrategy(
    { changedManthraIds: ["m1"], requiresFullPublish: true, granthaMetaDirty: false },
    { hasPublishedGrantha: true, hasPendingDeletions: false },
  ),
  "full",
);

assert.equal(
  resolveGranthaPublishStrategy(
    { changedManthraIds: [], requiresFullPublish: false, granthaMetaDirty: false },
    { hasPublishedGrantha: true, hasPendingDeletions: false },
  ),
  "none",
);

const targets = collectManthraPublishTargets(
  [
    {
      id: "a1",
      khandas: [
        {
          id: "k1",
          manthras: [{ id: "m1" }, { id: "m2" }],
          padas: [{ id: "p1", manthras: [{ id: "m3" }] }],
        },
      ],
    },
  ],
  ["m2", "m3"],
);
assert.equal(targets.length, 2);
assert.deepEqual(
  targets.map((t) => t.manthraId).sort(),
  ["m2", "m3"],
);

const restored = parsePublishScopeFromDraft({
  publishScope: { changedManthraIds: ["x"], requiresFullPublish: true, granthaMetaDirty: false },
});
assert.deepEqual(restored.changedManthraIds, ["x"]);
assert.equal(restored.requiresFullPublish, true);

console.log("test-grantha-publish-scope: all ok");
