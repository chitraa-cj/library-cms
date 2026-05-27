/**
 * Ensures portal-only draft fields (especially publishScope) never reach Strapi payloads.
 * Run: npx tsx script/test-grantha-strapi-payload-strip.ts
 */
import assert from "node:assert/strict";
import {
  isPortalDraftDataKey,
  stripPortalMetaFromGranthaPayload,
  PORTAL_DRAFT_DATA_KEYS,
} from "../shared/portal-draft-meta.ts";

const sample = {
  GranthaName: "Ishavasya",
  publishScope: {
    changedManthraIds: ["m1"],
    requiresFullPublish: true,
    granthaMetaDirty: false,
  },
  hierarchy: [{ id: "a1" }],
  structureConfig: { leafName: "Mantra" },
  deletedStrapiManthraDocIds: ["x"],
};

const stripped = stripPortalMetaFromGranthaPayload(sample);
assert.equal(stripped.GranthaName, "Ishavasya");
for (const key of PORTAL_DRAFT_DATA_KEYS) {
  assert.equal((stripped as Record<string, unknown>)[key], undefined, `expected ${key} removed`);
}
assert.equal(isPortalDraftDataKey("publishScope"), true);
assert.equal(isPortalDraftDataKey("GranthaName"), false);

console.log("test-grantha-strapi-payload-strip: all ok");
