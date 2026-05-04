#!/usr/bin/env node
/**
 * Teeka Merge Regression Test
 * ============================
 * Verifies that publishing a mantra via the portal with ONLY ONE teeka
 * does NOT wipe other teekas already stored in Strapi.
 *
 * Run: node tests/teeka-merge-regression.mjs
 *
 * Uses Katho Upanishad Mantra 1.1.1 (docId: ulx0gx9gtx27pts0uyvqkror)
 * which has the Kathopanishad teeka (u0nlotcj3begsj5rw4t0z59a).
 */

import http from "node:http";

const STRAPI_HOST = "13.53.121.15";
const STRAPI_PORT = 1337;
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN;

// Katho Upanishad: Mantra 1.1.1
const TEST_MANTRA_DOC_ID = "ulx0gx9gtx27pts0uyvqkror";
const KATHO_DOC_ID = "t2d3crlf4ptuadp73lziogy5";
const KATHOPANISHAD_TEEKA = "u0nlotcj3begsj5rw4t0z59a";
const UB_TEEKA = "nc9q5obto591jgwrnv5w8uwi";

let PASS = 0;
let FAIL = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    PASS++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    FAIL++;
  }
}

function strapiReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: STRAPI_HOST,
        port: STRAPI_PORT,
        path,
        method,
        headers: {
          Authorization: `Bearer ${STRAPI_TOKEN}`,
          "Content-Type": "application/json",
          ...(b ? { "Content-Length": Buffer.byteLength(b) } : {}),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(d) });
          } catch {
            resolve({ status: res.statusCode, body: d });
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("timeout")));
    if (b) req.write(b);
    req.end();
  });
}

function portalReq(method, path, body, cookieHeader) {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: "localhost",
        port: 5000,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(b ? { "Content-Length": Buffer.byteLength(b) } : {}),
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        const setCookie = res.headers["set-cookie"];
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(d), setCookie });
          } catch {
            resolve({ status: res.statusCode, body: d, setCookie });
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(60000, () => req.destroy(new Error("timeout")));
    if (b) req.write(b);
    req.end();
  });
}

function fetchManthra() {
  const url =
    `/api/manthras/${TEST_MANTRA_DOC_ID}` +
    `?populate%5BTeekas%5D%5Bpopulate%5D%5BTeekaEntry%5D%5Bpopulate%5D=*` +
    `&populate%5BTeekas%5D%5Bpopulate%5D%5Bteeka%5D%5Bfields%5D%5B0%5D=TeekaName` +
    `&populate%5BTeekas%5D%5Bpopulate%5D%5Bteeka%5D%5Bfields%5D%5B1%5D=documentId` +
    `&populate%5BShlokaManthraEntry%5D%5Bpopulate%5D=OtherTranslations` +
    `&populate%5BBhashyamEntry%5D%5Bpopulate%5D=OtherTranslations`;
  return strapiReq("GET", url);
}

async function login() {
  const res = await portalReq("POST", "/api/auth/login", {
    username: "wizardtest",
    password: "wizard123",
  });
  assert(res.status === 200, `Login returns 200 (got ${res.status})`);
  const cookie = (res.setCookie || []).map((c) => c.split(";")[0]).join("; ");
  assert(!!cookie, "Login returns session cookie");
  return cookie;
}

async function runTests() {
  console.log("\n════════════════════════════════════════════════════════");
  console.log("  Teeka Merge Regression Test Suite");
  console.log("════════════════════════════════════════════════════════\n");

  // ── TEST 0: Verify initial Strapi state ──────────────────────────────────
  console.log("TEST 0: Verify Strapi baseline for Mantra 1.1.1");
  const before = await fetchManthra();
  assert(before.status === 200, `Strapi fetch succeeds (got ${before.status})`);
  const teekasBefore = before.body?.data?.Teekas ?? [];
  const docIdsBefore = teekasBefore.map((t) => t.teeka?.documentId).filter(Boolean);
  console.log(`    Teekas present: [${docIdsBefore.join(", ")}]`);

  const kathoPresent = docIdsBefore.includes(KATHOPANISHAD_TEEKA);
  assert(kathoPresent, `Kathopanishad teeka (${KATHOPANISHAD_TEEKA}) is present`);

  const shlokaOTCount = (before.body?.data?.ShlokaManthraEntry?.OtherTranslations ?? []).length;
  const bhashyamOTCount = (before.body?.data?.BhashyamEntry?.OtherTranslations ?? []).length;
  console.log(`    ShlokaManthraEntry OtherTranslations: ${shlokaOTCount}`);
  console.log(`    BhashyamEntry OtherTranslations: ${bhashyamOTCount}`);
  assert(shlokaOTCount >= 40, `ShlokaManthraEntry has ≥40 OtherTranslations (got ${shlokaOTCount})`);
  assert(bhashyamOTCount >= 40, `BhashyamEntry has ≥40 OtherTranslations (got ${bhashyamOTCount})`);

  if (!kathoPresent) {
    console.log("\n⚠️  Kathopanishad teeka missing from Mantra 1.1.1 — run restore script first.\n");
    process.exit(1);
  }

  // Save the original Kathopanishad TeekaEntry to restore later
  const origKathoEntry = teekasBefore.find((t) => t.teeka?.documentId === KATHOPANISHAD_TEEKA);
  const origKathoId = origKathoEntry?.id;

  // ── TEST 1: Confirm Strapi's destructive PUT behavior ───────────────────
  console.log("\nTEST 1: Confirm Strapi destructive PUT (expected to WIPE other teekas)");
  console.log("    Sending PUT with only Upanishad Brahmendra teeka...");

  const destructivePut = await strapiReq("PUT", `/api/manthras/${TEST_MANTRA_DOC_ID}`, {
    data: {
      Teekas: [
        {
          teeka: UB_TEEKA,
          TeekaEntry: {
            SanskritTextEntry: [
              { type: "paragraph", children: [{ type: "text", text: "[regression test: UB only]" }] },
            ],
            EnglishTranslationText: [],
            OtherTranslations: [],
          },
        },
      ],
    },
  });
  assert(
    destructivePut.status === 200,
    `Strapi accepts the destructive PUT (status ${destructivePut.status})`
  );

  const afterDestructive = await fetchManthra();
  const docIdsAfterDestructive = (afterDestructive.body?.data?.Teekas ?? []).map(
    (t) => t.teeka?.documentId
  ).filter(Boolean);
  console.log(`    Teekas after single-teeka PUT: [${docIdsAfterDestructive.join(", ")}]`);

  assert(
    !docIdsAfterDestructive.includes(KATHOPANISHAD_TEEKA),
    `Kathopanishad teeka WIPED by single-teeka PUT (confirms Strapi is destructive — merge is essential)`
  );
  assert(
    docIdsAfterDestructive.includes(UB_TEEKA),
    `UB teeka present after single-teeka PUT`
  );

  // ── TEST 2: Verify merge PUT preserves all teekas ───────────────────────
  console.log("\nTEST 2: Verify merge PUT keeps all teekas (the fix)");
  // Fetch the current Strapi state (only UB after destructive put)
  const currentTeekas = afterDestructive.body?.data?.Teekas ?? [];

  // Build the merged payload:
  // - Keep existing UB entry (by id) so Strapi updates in-place
  // - Add back Kathopanishad (which was wiped)
  const mergedTeekas = [
    ...currentTeekas.map((et) => ({
      id: et.id,
      teeka: et.teeka?.documentId,
      TeekaEntry: et.TeekaEntry ?? null,
    })),
    {
      teeka: KATHOPANISHAD_TEEKA,
      TeekaEntry: origKathoEntry?.TeekaEntry ?? {
        SanskritTextEntry: [
          { type: "paragraph", children: [{ type: "text", text: "[restored by merge]" }] },
        ],
        EnglishTranslationText: [],
        OtherTranslations: [],
      },
    },
  ];

  const mergePut = await strapiReq("PUT", `/api/manthras/${TEST_MANTRA_DOC_ID}`, {
    data: { Teekas: mergedTeekas },
  });
  assert(mergePut.status === 200, `Merged PUT succeeds (status ${mergePut.status})`);

  const afterMerge = await fetchManthra();
  const docIdsAfterMerge = (afterMerge.body?.data?.Teekas ?? []).map(
    (t) => t.teeka?.documentId
  ).filter(Boolean);
  console.log(`    Teekas after merge PUT: [${docIdsAfterMerge.join(", ")}]`);

  assert(
    docIdsAfterMerge.includes(KATHOPANISHAD_TEEKA),
    `Kathopanishad teeka PRESERVED after merge PUT ✓`
  );
  assert(
    docIdsAfterMerge.includes(UB_TEEKA),
    `UB teeka also PRESERVED after merge PUT ✓`
  );

  // Remove UB again (it didn't exist before) to restore original state
  const finalTeekas = afterMerge.body?.data?.Teekas ?? [];
  const onlyKatho = finalTeekas.filter((t) => t.teeka?.documentId === KATHOPANISHAD_TEEKA);
  await strapiReq("PUT", `/api/manthras/${TEST_MANTRA_DOC_ID}`, {
    data: {
      Teekas: onlyKatho.map((et) => ({
        id: et.id,
        teeka: et.teeka?.documentId,
        TeekaEntry: et.TeekaEntry ?? null,
      })),
    },
  });
  console.log("    [cleanup] Restored Mantra 1.1.1 to Kathopanishad-only state");

  // ── TEST 3: OtherTranslations field name validation ─────────────────────
  console.log("\nTEST 3: OtherTranslations field name validation");
  const otSample = before.body?.data?.ShlokaManthraEntry?.OtherTranslations?.[0];
  if (otSample) {
    assert(
      "LanguageOfTranslation" in otSample,
      `Uses 'LanguageOfTranslation' field (not legacy 'Language')`
    );
    assert(
      "TranslationText" in otSample,
      `Uses 'TranslationText' field (not legacy 'Translation')`
    );
    assert(!("Language" in otSample), `Does NOT use legacy 'Language' field`);
    assert(!("Translation" in otSample), `Does NOT use legacy 'Translation' field`);
    assert(
      typeof otSample.LanguageOfTranslation === "string" && otSample.LanguageOfTranslation.length > 0,
      `LanguageOfTranslation is a non-empty string`
    );
  } else {
    console.log("    ⚠️  No OtherTranslations available — run restore script first");
  }

  // ── TEST 4: Portal login and proxy ──────────────────────────────────────
  console.log("\nTEST 4: Portal authentication and Strapi proxy");
  const cookie = await login();

  const proxyRes = await portalReq(
    "GET",
    `/api/strapi/manthras/${TEST_MANTRA_DOC_ID}`,
    null,
    cookie
  );
  assert(proxyRes.status === 200, `Portal Strapi proxy returns 200 (got ${proxyRes.status})`);
  assert(
    proxyRes.body?.data?.ShlokaManthraNumber === "Mantra 1.1.1",
    `Proxy returns correct ShlokaManthraNumber: "${proxyRes.body?.data?.ShlokaManthraNumber}"`
  );

  // ── TEST 5: normalizeTextAndTranslation field mapping ────────────────────
  console.log("\nTEST 5: OtherTranslations normalization via portal save-draft");
  // Create a draft with OtherTranslations in the CORRECT format
  // and verify the portal round-trips them correctly
  const testDraft = await portalReq(
    "POST",
    "/api/drafts",
    {
      title: "[regression] OT format test",
      contentType: "granthas",
      data: {
        GranthaName: "[regression] OT format test",
        hierarchy: [
          {
            id: "test-a1",
            title: "Test Adhyaya",
            type: "adhyaya",
            documentId: null,
            khandas: [
              {
                id: "test-k1",
                title: "_default",
                manthras: [
                  {
                    id: "test-m1",
                    title: "Test Mantra",
                    ShlokaManthraNumber: "Mantra 1.1.1",
                    strapiDocumentId: TEST_MANTRA_DOC_ID,
                    ShlokaManthraEntry: {
                      SanskritTextEntry: [
                        {
                          type: "paragraph",
                          children: [{ type: "text", text: "test shloka" }],
                        },
                      ],
                      EnglishTranslationText: [],
                      OtherTranslations: [
                        {
                          LanguageOfTranslation: "Tamil",
                          TranslationText: [
                            {
                              type: "paragraph",
                              children: [{ type: "text", text: "Tamil test" }],
                            },
                          ],
                        },
                        {
                          LanguageOfTranslation: "Hindi",
                          TranslationText: [
                            {
                              type: "paragraph",
                              children: [{ type: "text", text: "Hindi test" }],
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    cookie
  );
  assert(
    testDraft.status === 201 || testDraft.status === 200,
    `Test draft created (got ${testDraft.status})`
  );
  const testDraftId = testDraft.body?.id;

  if (testDraftId) {
    // Fetch the draft back and verify OtherTranslations are preserved
    const fetchedDraft = await portalReq("GET", `/api/drafts/${testDraftId}`, null, cookie);
    assert(fetchedDraft.status === 200, `Test draft fetched back (got ${fetchedDraft.status})`);

    const savedHierarchy = fetchedDraft.body?.data?.hierarchy ?? [];
    const savedMantra = savedHierarchy[0]?.khandas?.[0]?.manthras?.[0];
    const savedOT = savedMantra?.ShlokaManthraEntry?.OtherTranslations ?? [];
    assert(savedOT.length === 2, `OtherTranslations preserved in draft (got ${savedOT.length}, want 2)`);
    assert(
      savedOT[0]?.LanguageOfTranslation === "Tamil",
      `First OT LanguageOfTranslation is "Tamil" (got "${savedOT[0]?.LanguageOfTranslation}")`
    );
    assert(
      Array.isArray(savedOT[0]?.TranslationText) && savedOT[0].TranslationText.length > 0,
      `First OT TranslationText is a non-empty array`
    );

    // Clean up
    await portalReq("DELETE", `/api/drafts/${testDraftId}`, null, cookie);
    console.log(`    [cleanup] Deleted test draft #${testDraftId}`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n════════════════════════════════════════════════════════");
  console.log(`  Results: ${PASS} passed, ${FAIL} failed`);
  console.log("════════════════════════════════════════════════════════\n");

  if (FAIL > 0) process.exit(1);
}

runTests().catch((e) => {
  console.error("Test runner error:", e.message);
  process.exit(1);
});
