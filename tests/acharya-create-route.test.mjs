#!/usr/bin/env node --import tsx
/**
 * POST /api/acharyas — route-level reproduction of the "Invalid payload" bug.
 * ===========================================================================
 * Mounts the real acharya router on a real express app, with the auth guards faked
 * and the Postgres pool stubbed, and replays the exact body the editor sends for the
 * acharya from the bug report (Devanagari name, IAST + life dates blank, one alias,
 * a diacritic-heavy biography, 0 granthas ticked).
 *
 * No network and no database: pool.query is intercepted, so this asserts the request
 * reaches the INSERT with its Unicode intact rather than dying in validation.
 *
 * Run: node --import tsx tests/acharya-create-route.test.mjs
 */

// Set before server/db.ts loads (hence the dynamic imports — static ones are hoisted
// above this line). The stub below means nothing ever dials it.
process.env.DATABASE_URL = "postgres://stub:stub@127.0.0.1:1/stub?sslmode=disable";

const { default: express } = await import("express");
const { pool } = await import("../server/db.ts");
const { createAcharyaRouter } = await import("../server/acharyas.ts");

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

// ---------------------------------------------------------------- stubbed Postgres
const queries = [];
pool.query = async (config, values) => {
  const text = typeof config === "string" ? config : config.text;
  // drizzle passes the bind values as the second argument, not on the config object.
  const params = values ?? (typeof config === "string" ? [] : config.values) ?? [];
  queries.push({ text, params });
  if (/^\s*insert/i.test(text)) {
    return { rows: [{ id: 1, slug: params[0] ?? "stub-slug" }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 }; // uniqueSlug's lookup: slug is free
};
pool.connect = async () => {
  throw new Error("the test must not open a real connection");
};

// --------------------------------------------------------------------- app + agent
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.isAuthenticated = () => true;
  req.user = { id: "test-admin", role: "admin" };
  next();
});
app.use("/api/acharyas", createAcharyaRouter());

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

async function post(body) {
  const res = await fetch(`${base}/api/acharyas`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ------------------------------------------------------------------------- the bug
const BIO = [
  {
    heading: null,
    paragraphs: [
      "from the Keladi rulers. A subsequent Śāntāśrama and Kṛṣṇāśrama continued the Guru-paramparā.",
      "The Matha maintains a traditional Guru-paramparā and publishes/maintains religious and community literature, though no securely authenticated classical philosophical work attributable to the early founding seers has been identified in accessible sources.",
    ],
  },
];
const FORM_BODY = {
  name: "Śrī Śāntāśrama Mahāsvāmī",
  nameDevanagari: "श्री शान्ताश्रम महास्वामी",
  nameIast: null, // IAST box left blank
  dates: null, // life dates left blank
  avatarUrl: null,
  aliases: ["Śrī Saṃsthān Haldipur Śāntāśram"],
  biography: BIO,
  linkedGranthaDocIds: [], // 0 granthas ticked
};

console.log("\nthe original form submission");
{
  queries.length = 0;
  const { status, body } = await post(FORM_BODY);
  if (status !== 201) console.error(`    ${JSON.stringify(body)}`);
  assert(status === 201, "POST /api/acharyas -> 201 Created (was 400 Invalid payload)");

  const insert = queries.find((q) => /^\s*insert/i.test(q.text));
  assert(!!insert, "the request reached the INSERT");
  const params = insert?.params ?? [];
  // jsonb columns arrive as JSON text; everything else as the raw value.
  const bio = JSON.parse(params.find((p) => typeof p === "string" && p.startsWith('[{"heading"')) ?? "null");
  assert(params.includes("श्री शान्ताश्रम महास्वामी"), "Devanagari name stored byte-for-byte");
  assert(params.includes("Śrī Śāntāśrama Mahāsvāmī"), "IAST display name stored byte-for-byte");
  assert(bio?.[0]?.paragraphs?.[0] === BIO[0].paragraphs[0], "biography diacritics stored intact");
  assert(bio?.[0]?.paragraphs?.[1] === BIO[0].paragraphs[1], "the biography is not truncated");
  assert(params.includes(JSON.stringify(["Śrī Saṃsthān Haldipur Śāntāśram"])), "the alias is stored intact");
  assert(
    params.filter((p) => p === null).length === 3,
    "the three blank boxes (IAST, dates, avatar) are stored as NULL",
  );
  assert(params.includes("[]"), "0 granthas selected is stored as an empty list");
  assert(params.includes("custom"), "bioStatus is 'custom' once a biography is written");
  assert(
    params.some((p) => typeof p === "string" && p.startsWith("sri-santasrama")),
    "slug derives from the IAST name (ASCII, diacritics folded)",
  );
}

console.log("\nstill a well-behaved endpoint");
{
  const { status, body } = await post({ ...FORM_BODY, name: "   " });
  assert(status === 400, "a blank name is still rejected with 400");
  assert(/name/.test(body.message ?? ""), `the 400 names the offending field (got: ${body.message})`);
  assert(Array.isArray(body.issues) && body.issues.length > 0, "the zod issues are still returned");
}
{
  // Minimal body: nothing but a name.
  const { status } = await post({ name: "Śrī Śaṅkarācārya" });
  assert(status === 201, "a name-only acharya is accepted (every other field optional)");
}
{
  const { status } = await post({ ...FORM_BODY, biography: "prose" });
  assert(status === 400, "a malformed biography is still rejected");
}

server.close();
console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
