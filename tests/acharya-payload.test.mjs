#!/usr/bin/env node --import tsx
/**
 * Acharya editor payload <-> API contract — pure unit test (no I/O).
 * =================================================================
 * Builds the body the "Add acharya" / "Save" dialog actually sends from a form
 * state, then validates it with the very schemas the Express routes use. This is
 * the boundary that broke: a blank optional box is sent as `null`, and
 * `createAcharyaSchema.nameIast` only accepted a string — every acharya typed in
 * without an IAST name was rejected with "Invalid payload".
 *
 * Unicode is load-bearing here: Devanagari, IAST diacritics and Sanskrit prose must
 * survive the round trip byte for byte.
 *
 * Run: node --import tsx tests/acharya-payload.test.mjs
 */

import { buildAcharyaPayload, draftsToBioSections, bioSectionsToDrafts } from "../shared/acharya-payload.ts";
import { createAcharyaSchema, updateAcharyaSchema } from "../shared/schema.ts";

let PASS = 0;
let FAIL = 0;
function assert(cond, label) {
  if (cond) {
    PASS++;
    console.log(`  ✓ ${label}`);
  } else {
    FAIL++;
    console.error(`  ✗ ${label}`);
  }
}

/** Validate a payload and report the zod issues when it fails. */
function check(schema, payload, label) {
  const r = schema.safeParse(payload);
  if (!r.success) {
    console.error(`    issues: ${JSON.stringify(r.error.issues)}`);
  }
  assert(r.success, label);
  return r.success ? r.data : null;
}

const emptyForm = {
  name: "",
  nameDevanagari: "",
  nameIast: "",
  dates: "",
  aliases: "",
  avatarUrl: "",
  bio: [],
  selectedDocIds: [],
};
const form = (over) => ({ ...emptyForm, ...over });
const draft = (heading, body) => ({ key: "k", heading, body });

// The exact form from the bug report: Devanagari name, IAST + life dates left blank,
// one alias, a diacritic-heavy biography, no granthas ticked.
const SHANTASHRAMA = form({
  name: "Śrī Śāntāśrama Mahāsvāmī",
  nameDevanagari: "श्री शान्ताश्रम महास्वामी",
  aliases: "Śrī Saṃsthān Haldipur Śāntāśram",
  bio: [
    draft(
      "",
      "from the Keladi rulers. A subsequent Śāntāśrama and Kṛṣṇāśrama continued the Guru-paramparā.\n\n" +
        "The Matha maintains a traditional Guru-paramparā and publishes/maintains religious and " +
        "community literature, though no securely authenticated classical philosophical work " +
        "attributable to the early founding seers has been identified in accessible sources.",
    ),
  ],
});

console.log("\nregression — the form from the bug report");
{
  const payload = buildAcharyaPayload(SHANTASHRAMA, "create");
  const parsed = check(createAcharyaSchema, payload, "POST /api/acharyas accepts it");
  assert(payload.nameIast === null, "a blank IAST box is sent as null (not omitted)");
  assert(parsed?.nameIast === null, "…and the schema keeps it as null");
  check(
    updateAcharyaSchema,
    buildAcharyaPayload(SHANTASHRAMA, "edit"),
    "PATCH /api/acharyas/:slug accepts the same form",
  );
}

console.log("\n1. Unicode / IAST names survive untouched");
{
  const f = form({ name: "Ādi Śaṅkarācārya", nameIast: "Ādi Śaṅkarācārya" });
  const p = check(createAcharyaSchema, buildAcharyaPayload(f, "create"), "IAST name validates");
  assert(p?.name === "Ādi Śaṅkarācārya", "name is byte-for-byte unchanged");
  assert(p?.nameIast === "Ādi Śaṅkarācārya", "nameIast is byte-for-byte unchanged");
}

console.log("\n2. Devanagari name");
{
  const f = form({ name: "आदिशङ्कराचार्यः", nameDevanagari: "आदिशङ्कराचार्यः" });
  const p = check(createAcharyaSchema, buildAcharyaPayload(f, "create"), "Devanagari name validates");
  assert(p?.nameDevanagari === "आदिशङ्कराचार्यः", "Devanagari preserved");
}
{
  // Devanagari typed only in the main name box still fills nameDevanagari.
  const p = buildAcharyaPayload(form({ name: "आदिशङ्कराचार्यः" }), "create");
  assert(p.nameDevanagari === "आदिशङ्कराचार्यः", "nameDevanagari falls back to the typed name");
}

console.log("\n3. Sanskrit diacritics in the biography");
{
  const prose = "Kṛṣṇāśrama continued the Guru-paramparā; ṇ ṛ ṣ ñ ś ṃ ḍ ḥ ḻ ṭ.";
  const p = check(
    createAcharyaSchema,
    buildAcharyaPayload(form({ name: "X", bio: [draft("Jīvana", prose)] }), "create"),
    "diacritic-heavy biography validates",
  );
  assert(p?.biography?.[0].paragraphs[0] === prose, "biography prose is not normalized or stripped");
  assert(p?.biography?.[0].heading === "Jīvana", "heading preserved");
}

console.log("\n4. Empty life dates");
{
  const p = buildAcharyaPayload(form({ name: "X" }), "create");
  assert(p.dates === null, "blank dates -> null");
  check(createAcharyaSchema, p, "create accepts dates: null");
  check(updateAcharyaSchema, buildAcharyaPayload(form({ name: "X" }), "edit"), "edit accepts dates: null");
  check(createAcharyaSchema, { name: "X" }, "create accepts dates omitted entirely");
  const kept = check(
    createAcharyaSchema,
    buildAcharyaPayload(form({ name: "X", dates: "788-820 A.D." }), "create"),
    "a filled-in life date still validates",
  );
  assert(kept?.dates === "788-820 A.D.", "dates passed through");
}

console.log("\n5. Empty aliases");
{
  const p = buildAcharyaPayload(form({ name: "X" }), "create");
  assert(Array.isArray(p.aliases) && p.aliases.length === 0, "blank aliases -> []");
  check(createAcharyaSchema, p, "create accepts an empty alias list");
  // Stray commas must not produce "" entries, which the min(1) item rule rejects.
  const messy = buildAcharyaPayload(form({ name: "X", aliases: "Shankara, , Śaṅkara,," }), "create");
  assert(
    messy.aliases.length === 2 && messy.aliases[1] === "Śaṅkara",
    "empty alias fragments dropped, diacritics kept",
  );
  check(createAcharyaSchema, messy, "create accepts a comma-littered alias list");
}

console.log("\n6. Zero selected granthas");
{
  const p = buildAcharyaPayload(form({ name: "X" }), "create");
  assert(p.linkedGranthaDocIds.length === 0, "no granthas ticked -> []");
  check(createAcharyaSchema, p, "create accepts 0 granthas");
  check(updateAcharyaSchema, buildAcharyaPayload(form({ name: "X" }), "edit"), "edit accepts 0 granthas");
  const picked = check(
    createAcharyaSchema,
    buildAcharyaPayload(form({ name: "X", selectedDocIds: ["abc123", "def456"] }), "create"),
    "create accepts picked granthas",
  );
  assert(picked?.linkedGranthaDocIds?.length === 2, "picked documentIds kept in order");
}

console.log("\n7. Biography section with heading + body");
{
  const sections = draftsToBioSections([
    draft("Pūrvāśrama", "Born in Kālaṭī.\n\nTook saṃnyāsa young."),
    draft("", "A section with no heading."),
    draft("", "   "), // nothing typed at all — dropped
  ]);
  assert(sections.length === 2, "a wholly blank section is dropped");
  assert(sections[0].heading === "Pūrvāśrama", "heading kept");
  assert(sections[0].paragraphs.length === 2, "a blank line starts a new paragraph");
  assert(sections[1].heading === null, "a blank heading becomes null, not ''");
  check(createAcharyaSchema, { name: "X", biography: sections }, "multi-section biography validates");
  // Round trip back into the editor without losing anything.
  const back = bioSectionsToDrafts(sections);
  assert(
    back[0].heading === "Pūrvāśrama" && back[0].body === "Born in Kālaṭī.\n\nTook saṃnyāsa young.",
    "sections round-trip back into the editor",
  );
  check(createAcharyaSchema, { name: "X", biography: [] }, "an empty biography validates");
}

console.log("\n8. backward compatibility — existing records and callers");
{
  // Records seeded before the portal editor existed carry strings, not nulls.
  check(
    createAcharyaSchema,
    {
      name: "Śrī Śaṅkarācārya",
      nameDevanagari: "आदिशङ्कराचार्यः",
      nameIast: "Ādi Śaṅkarācārya",
      dates: "788-820 A. D.",
      avatarUrl: "/uploads/shankara.png",
      aliases: ["Shankara"],
      biography: [{ heading: "Jīvana", paragraphs: ["…"] }],
      linkedGranthaDocIds: ["abc"],
    },
    "a fully-populated string payload still validates",
  );
  // Validation is not weakened: the required name and well-formed sections still bite.
  assert(!createAcharyaSchema.safeParse({ nameIast: "X" }).success, "a missing name is still rejected");
  assert(!createAcharyaSchema.safeParse({ name: "   " }).success, "a whitespace-only name is still rejected");
  assert(!createAcharyaSchema.safeParse({ name: "X", biography: "prose" }).success, "a string biography is still rejected");
  assert(
    !createAcharyaSchema.safeParse({ name: "X", biography: [{ heading: "H" }] }).success,
    "a section without paragraphs is still rejected",
  );
  assert(
    !createAcharyaSchema.safeParse({ name: "X", linkedGranthaDocIds: [""] }).success,
    "an empty grantha documentId is still rejected",
  );
  assert(!createAcharyaSchema.safeParse({ name: "X", aliases: [""] }).success, "an empty alias is still rejected");
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
