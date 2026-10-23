/**
 * Shared vocabulary <-> publish validation consistency.
 * ===================================================
 * The incident this locks in (Jeevan Mukthi Viveka, Save & Publish, 2026-10-21):
 *
 *   Publish failed: Cannot publish: Bhashyam author "Achyutharaya Modaka" is not in
 *   the shared vocabulary. Add it under Shared lists -> Bhashyam authors, then republish.
 *
 * ...while Shared lists -> Bhashyam authors already showed "Achyutharaya Modaka".
 *
 * Both screens read the same Postgres row. The difference was a per-PROCESS memory cache
 * in server/cms-vocabulary.ts, invalidated only in the process that served the admin
 * add request. Grantha publishing runs in `cms-publish-worker`, a separate pm2 process, whose
 * cache was built on its first publish and never refreshed - so the web process (fresh)
 * showed the name and the worker (stale) rejected it. The fix reads the row on every
 * call; these tests model "another process wrote the row" by mutating the stored custom
 * list behind the back of the module and asserting the next read sees it.
 *
 * No database is needed: the three storage-singleton vocabulary methods are replaced
 * with an in-memory row that applies the SAME pure add/remove helpers the real storage
 * uses (shared/schema.ts). DATABASE_URL just has to be set so server/db.ts loads.
 *
 * Run: npm run test:vocabulary
 */
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:59999/nothing";
if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = "false";

let PASS = 0;
const FAILURES = [];
function check(name, cond, detail = "") {
  if (cond) {
    PASS++;
    console.log(`  ok  ${name}`);
  } else {
    FAILURES.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
async function throwsWith(fn, predicate) {
  try {
    await fn();
    return { threw: false };
  } catch (err) {
    return { threw: true, ok: predicate(err), err };
  }
}

const { storage } = await import("../server/storage.ts");
const vocab = await import("../server/cms-vocabulary.ts");
const {
  bhashyamAuthors,
  addPortalVocabularyName,
  removePortalVocabularyName,
  normalizePortalVocabularyName,
  portalVocabularyNameKey,
} = await import("../shared/schema.ts");

// ── in-memory stand-in for the single cms_portal_vocabulary row ─────────────────────
// `row.custom` is what Postgres holds. Writing to it directly (not through the module
// add/remove) is how a write by a DIFFERENT process looks to this one.
const row = { custom: {} };
const realGetPortalVocabularyCustom = storage.getPortalVocabularyCustom.bind(storage);
storage.getPortalVocabularyCustom = async () => structuredClone(row.custom);
storage.addPortalVocabularyEntry = async (key, value) => {
  row.custom = addPortalVocabularyName(row.custom, key, value);
  return structuredClone(row.custom);
};
storage.removePortalVocabularyEntry = async (key, value) => {
  row.custom = removePortalVocabularyName(row.custom, key, value);
  return structuredClone(row.custom);
};

const BUILT_IN = bhashyamAuthors[0]; // "Sri Shankarayacharya"
const CUSTOM = "Achyutharaya Modaka";
const NFD = (s) => s.normalize("NFD");
const NFC = (s) => s.normalize("NFC");

/** The exact shape the publish walk and the /publish route both use. */
async function publishAuthor(author) {
  return vocab.resolveBhashyamAuthorForPublish(author, await vocab.getBhashyamAuthorsAllowlist());
}

// ── 1–7. author validation ────────────────────────────────────────────────────────────
console.log("\nAuthor validation");
{
  row.custom = {};
  check("1. a built-in author is accepted", (await publishAuthor(BUILT_IN)) === BUILT_IN);

  const unknownBefore = await throwsWith(() => publishAuthor(CUSTOM), (e) => e?.status === 400);
  check(
    "4a. an unknown author is rejected with a 400 before it is added",
    unknownBefore.threw && unknownBefore.ok,
    unknownBefore.err?.message,
  );
  check(
    "4b. the rejection names the author and where to add it",
    /Achyutharaya Modaka/.test(unknownBefore.err?.message ?? "") &&
      /Shared lists → Bhashyam authors/.test(unknownBefore.err?.message ?? ""),
    unknownBefore.err?.message,
  );
  check(
    "4c. the rejection is a client error, never retried by the worker",
    unknownBefore.err?.status === 400 && unknownBefore.err?.code === "bhashyam_author_not_in_vocabulary",
  );

  await vocab.addPortalVocabularyEntry("bhashyamAuthors", CUSTOM, "admin");
  check("2. a custom author present in the shared vocabulary is accepted", (await publishAuthor(CUSTOM)) === CUSTOM);
  check(
    "3. \"Achyutharaya Modaka\" is accepted once it exists in the persisted vocabulary",
    (await publishAuthor("Achyutharaya Modaka")) === "Achyutharaya Modaka",
  );
  check(
    "3b. the author list the dropdown reads contains it too (same source)",
    (await vocab.getPortalVocabulary()).bhashyamAuthors.includes(CUSTOM),
  );

  check("5a. surrounding whitespace does not cause a false rejection", (await publishAuthor(`  ${CUSTOM}\n`)) === CUSTOM);
  check(
    "5b. a case variant resolves to the canonical vocabulary spelling",
    (await publishAuthor("achyutharaya modaka")) === CUSTOM,
  );
  check("5c. an empty author is not an error — the field is simply omitted", (await publishAuthor("   ")) === undefined);
  check("5d. a missing author is not an error either", (await publishAuthor(undefined)) === undefined);

  const stillUnknown = await throwsWith(() => publishAuthor("Achyutharaya Modak"), (e) => e?.status === 400);
  check("4d. a near-miss spelling is still rejected (no fuzzy matching)", stillUnknown.threw && stillUnknown.ok);

  // Unicode: "Mādhavācārya" is a built-in; a keyboard that emits decomposed diacritics
  // produces a different string that renders identically.
  const madhava = bhashyamAuthors.find((a) => /ā/.test(a));
  check("6a. fixture: a built-in with diacritics exists", !!madhava, "no diacritic author in bhashyamAuthors");
  check("6b. fixture: NFD and NFC forms really differ", NFD(madhava) !== NFC(madhava));
  check("6c. the NFD spelling of a built-in is accepted and resolves to the NFC built-in", (await publishAuthor(NFD(madhava))) === madhava);
  check(
    "6d. normalizePortalVocabularyName composes to NFC and trims",
    normalizePortalVocabularyName(`  ${NFD(madhava)} `) === NFC(madhava),
  );
  check("6e. the identity key folds NFC/NFD and case together", portalVocabularyNameKey(NFD(madhava).toUpperCase()) === portalVocabularyNameKey(madhava));
  check(
    "6f. the identity key does NOT fold punctuation or inner spacing (distinct authors stay distinct)",
    portalVocabularyNameKey("Sri Shankaracharya") !== portalVocabularyNameKey("SriShankaracharya") &&
      portalVocabularyNameKey("Modaka") !== portalVocabularyNameKey("Modaka."),
  );

  // Duplicate records
  const before = (row.custom.bhashyamAuthors ?? []).length;
  await vocab.addPortalVocabularyEntry("bhashyamAuthors", CUSTOM, "admin");
  await vocab.addPortalVocabularyEntry("bhashyamAuthors", CUSTOM.toUpperCase(), "admin");
  await vocab.addPortalVocabularyEntry("bhashyamAuthors", `  ${CUSTOM}  `, "admin");
  check("7a. adding the same name again (exact, case, whitespace) creates no duplicate record", (row.custom.bhashyamAuthors ?? []).length === before);
  await vocab.addPortalVocabularyEntry("bhashyamAuthors", NFD(madhava), "admin");
  check(
    "7b. whatever is stored for a built-in typed in NFD is the NFC form, never the raw NFD bytes",
    !(row.custom.bhashyamAuthors ?? []).includes(NFD(madhava)) &&
      (row.custom.bhashyamAuthors ?? []).filter((v) => portalVocabularyNameKey(v) === portalVocabularyNameKey(madhava)).length <= 1,
  );
  const merged = (await vocab.getPortalVocabulary()).bhashyamAuthors;
  check("7c. the merged list exposes one entry per identity", new Set(merged.map(portalVocabularyNameKey)).size === merged.length);
  check("7d. adding a built-in as custom does not duplicate it in the merged list", merged.filter((v) => portalVocabularyNameKey(v) === portalVocabularyNameKey(madhava)).length === 1);
  const nfdOnly = "Ācārya Test Ā";
  await vocab.addPortalVocabularyEntry("bhashyamAuthors", NFD(nfdOnly), "admin");
  check("7e. a NEW custom name typed in NFD is stored in NFC", (row.custom.bhashyamAuthors ?? []).includes(NFC(nfdOnly)) && !(row.custom.bhashyamAuthors ?? []).includes(NFD(nfdOnly)));
  check("7f. …and is accepted at publish time whichever form the draft carries", (await publishAuthor(NFD(nfdOnly))) === NFC(nfdOnly) && (await publishAuthor(NFC(nfdOnly))) === NFC(nfdOnly));
  await vocab.removePortalVocabularyEntry("bhashyamAuthors", nfdOnly, "admin");
}

// ── 8–12. vocabulary updates ──────────────────────────────────────────────────────────
console.log("\nVocabulary updates");
{
  row.custom = {};
  const NEW = "Vidyaranya Swami";
  const r1 = await throwsWith(() => publishAuthor(NEW), (e) => e?.status === 400);
  check("8a. before the add the name is rejected", r1.threw && r1.ok);
  await vocab.addPortalVocabularyEntry("bhashyamAuthors", NEW, "admin");
  check("8b. immediately after the add it is accepted by publishing", (await publishAuthor(NEW)) === NEW);

  // The regression: a write by ANOTHER process (the web API) must be visible to THIS
  // process (the publish worker) without any restart or invalidation call. Model it by
  // priming a read, then editing the stored row behind the back of the module.
  await vocab.getBhashyamAuthorsAllowlist(); // whatever would be cached, is now
  row.custom = addPortalVocabularyName(row.custom, "bhashyamAuthors", CUSTOM); // "other process"
  check(
    "9a. a name added by another process is seen on the very next read (no stale per-process cache)",
    (await vocab.getBhashyamAuthorsAllowlist()).has(CUSTOM),
  );
  check("9b. …and publishing accepts it", (await publishAuthor(CUSTOM)) === CUSTOM);
  row.custom = removePortalVocabularyName(row.custom, "bhashyamAuthors", CUSTOM); // "other process" removes
  const r2 = await throwsWith(() => publishAuthor(CUSTOM), (e) => e?.status === 400);
  check("9c. a name removed by another process is rejected on the very next publish", r2.threw && r2.ok);

  await vocab.addPortalVocabularyEntry("bhashyamAuthors", CUSTOM, "admin");
  const afterRemove = await vocab.removePortalVocabularyEntry("bhashyamAuthors", CUSTOM.toLowerCase(), "admin");
  check("10a. deleting a custom author (any case) removes it from the stored row", !(row.custom.bhashyamAuthors ?? []).includes(CUSTOM));
  check("10b. …and from the merged list the API returns", !afterRemove.bhashyamAuthors.includes(CUSTOM));
  check("10c. …and publishing then rejects it (no orphan acceptance)", (await throwsWith(() => publishAuthor(CUSTOM), (e) => e?.status === 400)).ok === true);
  check("10d. deleting a custom author leaves the other custom names alone", (await vocab.getPortalVocabulary()).bhashyamAuthors.includes(NEW));

  const afterBuiltInDelete = await vocab.removePortalVocabularyEntry("bhashyamAuthors", BUILT_IN, "admin");
  check("11a. a built-in author survives a DELETE through the backend API", afterBuiltInDelete.bhashyamAuthors.includes(BUILT_IN));
  check("11b. …and is still accepted by publishing afterwards", (await publishAuthor(BUILT_IN)) === BUILT_IN);
  check("11c. …and the stored custom row was not polluted by the attempt", !(row.custom.bhashyamAuthors ?? []).includes(BUILT_IN));

  const empty = await throwsWith(() => vocab.addPortalVocabularyEntry("bhashyamAuthors", "   ", "admin"), (e) => e?.status === 400);
  check("11d. an empty name is refused with a 400", empty.threw && empty.ok);

  row.custom = {};
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      vocab.addPortalVocabularyEntry("bhashyamAuthors", i % 2 ? CUSTOM : ` ${CUSTOM.toUpperCase()} `, "admin"),
    ),
  );
  check("12a. repeated / concurrent adds of one identity leave exactly one record", (row.custom.bhashyamAuthors ?? []).length === 1, JSON.stringify(row.custom));
  check("12b. the surviving record is the first spelling that was stored", (row.custom.bhashyamAuthors ?? [])[0] === CUSTOM.toUpperCase() || (row.custom.bhashyamAuthors ?? [])[0] === CUSTOM);
  check("12c. the pure add helper is idempotent", addPortalVocabularyName(addPortalVocabularyName({}, "bhashyamAuthors", CUSTOM), "bhashyamAuthors", CUSTOM).bhashyamAuthors.length === 1);
  check("12d. the pure add helper ignores an empty value", addPortalVocabularyName({}, "bhashyamAuthors", "  ").bhashyamAuthors === undefined);
}

// ── 13–16. publishing integration (the payload transform the walk applies) ───────────
console.log("\nPublishing integration");
{
  row.custom = {};
  await vocab.addPortalVocabularyEntry("bhashyamAuthors", CUSTOM, "admin");

  /** Mirror of the BhashyamAuthor block of the walk in publishGranthaWithHierarchy. */
  async function applyToPayload(granthaPayload) {
    const resolved = vocab.resolveBhashyamAuthorForPublish(granthaPayload.BhashyamAuthor, await vocab.getBhashyamAuthorsAllowlist());
    if (resolved) granthaPayload.BhashyamAuthor = resolved;
    else if ("BhashyamAuthor" in granthaPayload) delete granthaPayload.BhashyamAuthor;
    return granthaPayload;
  }

  const p1 = await applyToPayload({ GranthaName: "Jeevan Mukthi Viveka", BhashyamAuthor: CUSTOM, BhashyamName: "Modaka" });
  check("13. a valid custom author passes through to the Strapi payload", p1.BhashyamAuthor === CUSTOM && p1.BhashyamName === "Modaka");

  const p2 = await throwsWith(() => applyToPayload({ GranthaName: "X", BhashyamAuthor: "Nobody Known" }), (e) => e?.status === 400);
  check("14. an unknown author fails safely with a 400 before anything is sent", p2.threw && p2.ok);

  // "UI shows it, publish rejects it" can only happen if the two read different sources.
  const uiList = (await vocab.getPortalVocabulary()).bhashyamAuthors; // GET /api/cms/vocabulary
  const publishAllow = await vocab.getBhashyamAuthorsAllowlist(); // publish walk + /publish route
  check("15a. the list the UI shows and the set publishing checks are identical", uiList.length === publishAllow.size && uiList.every((v) => publishAllow.has(v)));
  let allAccepted = true;
  for (const name of uiList) {
    if ((await publishAuthor(name)) !== name && !["Sri Shankaracharya", "Sri Upanishad Brahmendra"].includes(name)) allAccepted = false;
  }
  check("15b. every name the UI shows is accepted by publishing", allAccepted);

  const p3 = await applyToPayload({ GranthaName: "Y", BhashyamAuthor: "" });
  check("16a. an empty author is dropped from the payload (existing behaviour)", !("BhashyamAuthor" in p3));
  const p4 = await applyToPayload({ GranthaName: "Z" });
  check("16b. a payload with no author field is untouched", !("BhashyamAuthor" in p4) && p4.GranthaName === "Z");
  const p5 = await applyToPayload({ GranthaName: "W", BhashyamAuthor: "Sri Shankaracharya" });
  check("16c. the prasthana alias still maps to the canonical grantha spelling", p5.BhashyamAuthor === "Sri Shankarayacharya");
  check("16d. teeka authors go through the same identity rule", vocab.resolveAllowedTeekaAuthor("  anandagiri ", new Set(["Anandagiri"])) === "Anandagiri");
}

// ── 17. the vocabulary cannot be read ─────────────────────────────────────────────────
// A failed lookup must never look like "empty vocabulary" (which would wrongly reject
// a listed author as "not in the shared vocabulary") nor like "allowed" (which would let
// any author through). It must surface as a database error the routes map to a 503.
console.log("\nVocabulary lookup failure");
{
  const { toApiError } = await import("../server/db-errors.ts");
  row.custom = {};
  await vocab.addPortalVocabularyEntry("bhashyamAuthors", CUSTOM, "admin");

  /** Mirror of the enqueue route's author block: only a 400 becomes an author error. */
  async function enqueueCheck(author) {
    try {
      vocab.resolveBhashyamAuthorForPublish(author, await vocab.getBhashyamAuthorsAllowlist());
      return { accepted: true };
    } catch (err) {
      if (err?.status === 400) return { authorError: err };
      return { dbError: err, api: toApiError(err, "Failed to publish draft") };
    }
  }

  const failures = [];
  // (a) The real storage method + real pg driver against an unreachable server: the
  // exact error from the 2026-10-23 outage (AggregateError, code ECONNREFUSED, empty
  // message). Only when the dummy URL is in use — never against a real database.
  if (/:59999\/nothing$/.test(process.env.DATABASE_URL)) {
    failures.push(["real driver, server unreachable", realGetPortalVocabularyCustom]);
  } else {
    console.log("  skip 17a (DATABASE_URL is not the unreachable dummy)");
  }
  // (b) A connection dropped mid-query (SQLSTATE 08006).
  failures.push([
    "connection dropped (08006)",
    async () => {
      throw Object.assign(new Error("terminating connection due to administrator command"), { code: "08006" });
    },
  ]);

  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  for (const [label, impl] of failures) {
    storage.getPortalVocabularyCustom = impl;
    for (const author of [CUSTOM, "Nobody Known", BUILT_IN]) {
      const r = await enqueueCheck(author);
      check(`17. ${label}: "${author}" is neither accepted nor reported as an author problem`, !r.accepted && !r.authorError && !!r.dbError, JSON.stringify(r));
    }
    const r = await enqueueCheck(CUSTOM);
    check(`17. ${label}: the API answers 503 db_unavailable`, r.api?.status === 503 && r.api?.body?.code === "db_unavailable", JSON.stringify(r.api));
    check(`17. ${label}: the message says nothing was published`, /Nothing was published/.test(r.api?.body?.message ?? ""), r.api?.body?.message);
    check(`17. ${label}: no driver text, host or port reaches the browser`, !/ECONNREFUSED|59999|127\.0\.0\.1|postgres|08006|administrator command/i.test(r.api?.body?.message ?? ""), r.api?.body?.message);
    const walk = await throwsWith(() => publishAuthor(CUSTOM), (e) => e?.status !== 400);
    check(`17. ${label}: the publish walk's lookup throws too (fails closed before any Strapi write)`, walk.threw && walk.ok);
  }
  process.env.NODE_ENV = prevEnv;

  storage.getPortalVocabularyCustom = async () => structuredClone(row.custom);
  check("17. once the database is back, the listed author publishes again", (await publishAuthor(CUSTOM)) === CUSTOM);
}

console.log(`\n${PASS} passed, ${FAILURES.length} failed`);
if (FAILURES.length) {
  for (const f of FAILURES) console.log(`  - ${f}`);
  process.exit(1);
}
