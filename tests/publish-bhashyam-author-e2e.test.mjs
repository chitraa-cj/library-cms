/**
 * Save & Publish with a Shared-lists Bhashyam author - END TO END, across processes.
 * ===================================================================================
 * Reproduces the 2026-10-21 incident over HTTP, with the real API server and the real
 * `cms-publish-worker` running as SEPARATE processes (that separation is the bug):
 *
 *   Shared lists -> Bhashyam authors -> Jeevan Mukthi Viveka -> Save & Publish
 *
 * Sequence (the order matters, it is what made the worker's old cache stale):
 *   1. the worker publishes one grantha with a built-in author, so it has read the vocabulary
 *   2. an admin adds "Achyutharaya Modaka" through the Shared-lists API (web process)
 *   3. a Jeevan Mukthi Viveka draft with that author is published
 *      -> must be queued, run by the worker, and land in Strapi with that author
 *
 * Strapi is a throwaway in-memory mock (tests/support/mock-strapi.mjs); nothing real is
 * published. Postgres is real and must be a scratch database: the test refuses any
 * DATABASE_URL whose database name does not contain "test".
 *
 * Run:
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:15999/cms_vocab_test DATABASE_SSL=false \
 *     node --import tsx tests/publish-bhashyam-author-e2e.test.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL (a SCRATCH database) is required.");
  process.exit(1);
}
if (!/\/[^/?]*test[^/?]*(\?|$)/i.test(DATABASE_URL)) {
  console.error(`Refusing to run against ${DATABASE_URL.replace(/:[^:@/]+@/, ":***@")} - the database name must contain "test".`);
  process.exit(1);
}

const API_PORT = Number(process.env.E2E_API_PORT || 5055);
const STRAPI_PORT = Number(process.env.E2E_STRAPI_PORT || 5056);
const API = `http://127.0.0.1:${API_PORT}`;
const STRAPI = `http://127.0.0.1:${STRAPI_PORT}`;
const CUSTOM = "Achyutharaya Modaka";
const BUILT_IN = "Sri Shankarayacharya";
const RUN = Date.now().toString(36);

const env = {
  ...process.env,
  NODE_ENV: "development",
  PORT: String(API_PORT),
  DATABASE_URL,
  DATABASE_SSL: process.env.DATABASE_SSL || "false",
  STRAPI_URL: STRAPI,
  STRAPI_API_TOKEN: "mock-token",
  SESSION_SECRET: "e2e-session-secret",
  STRAPI_SQLITE_PATH: "/nonexistent/e2e-no-sqlite.db",
  PUBLISH_POLL_INTERVAL: "1000",
  PUBLISH_HEARTBEAT_MS: "5000",
  PUBLISH_RETRY_BACKOFF_MS: "0",
  PUBLISH_PROGRESS_WRITE_MS: "0",
  PUBLISH_MAX_ATTEMPTS: "1",
};

let PASS = 0;
const FAILURES = [];
function check(name, cond, detail = "") {
  if (cond) {
    PASS++;
    console.log(`  ok  ${name}`);
  } else {
    FAILURES.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------- process helpers
const children = [];
function boot(label, args, extraEnv = {}) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  const tap = (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      lines.push(line);
      if (process.env.E2E_VERBOSE) console.log(`    [${label}] ${line}`);
    }
  };
  child.stdout.on("data", tap);
  child.stderr.on("data", tap);
  children.push(child);
  return { child, lines };
}
async function waitFor(fn, { timeoutMs = 60_000, every = 300, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`timed out waiting for ${what}: ${last?.message ?? JSON.stringify(last)}`);
}
function shutdown() {
  for (const c of children) {
    try { c.kill("SIGTERM"); } catch {}
  }
}

// ---------------------------------------------------------------- http helpers
let cookie = "";
async function api(method, route, body, opts = {}) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: json };
}
async function mockRecords(type) {
  return (await fetch(`${STRAPI}/__mock/${type}`)).json();
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}
/** A Prakarana -> Anuvaka -> Shloka grantha, the shape the Jeevan Mukthi Viveka editor saves. */
function granthaDraftData(name, author) {
  const shloka = (n) => ({
    id: uid(),
    title: `Shloka 1.${n}`,
    order: n,
    ShlokaManthraEntry: {
      SanskritTextEntry: [{ type: "paragraph", children: [{ type: "text", text: `verse ${n}` }] }],
    },
  });
  return {
    GranthaName: name,
    GranthaType: "Prakarana Grantha",
    BhashyamAuthor: author,
    BhashyamName: `${name} Bhashyam`,
    structureConfig: {
      levelOneName: "Prakarana",
      levelTwoName: "Anuvaka",
      leafName: "Shloka",
      levelTwoEnabled: true,
      levelThreeEnabled: false,
    },
    teekas: [],
    hierarchy: [
      {
        id: uid(),
        title: "Prakarana 1",
        order: 1,
        expanded: true,
        khandas: [{ id: uid(), title: "Anuvaka 1", order: 1, expanded: true, padas: [], manthras: [shloka(1), shloka(2)] }],
      },
    ],
  };
}
async function createDraft(name, author) {
  const r = await api("POST", "/api/drafts", { contentType: "granthas", title: name, data: granthaDraftData(name, author) });
  if (r.status !== 201 && r.status !== 200) throw new Error(`create draft ${name}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
/** Click Save & Publish: enqueue, then poll /publish-status like the editor does. */
async function publish(draftId, { timeoutMs = 90_000 } = {}) {
  const start = await api("POST", `/api/drafts/${draftId}/publish`, {}, { headers: { "Idempotency-Key": `${RUN}-${draftId}-${uid()}` } });
  if (start.status !== 200) return { enqueue: start, final: null };
  const jobId = start.body?.jobId;
  const final = await waitFor(
    async () => {
      const s = await api("GET", `/api/drafts/${draftId}/publish-status?jobId=${jobId}`);
      if (["done", "failed", "failed_recoverable"].includes(s.body?.status)) return s.body;
      return null;
    },
    { timeoutMs, what: `publish job ${jobId} on draft ${draftId}` },
  );
  return { enqueue: start, final };
}

// ---------------------------------------------------------------- main
const sql = new pg.Pool({ connectionString: DATABASE_URL, ssl: false });
try {
  // Scratch-row hygiene from an aborted run.
  await sql.query(`delete from cms_publish_jobs where draft_id in (select id from content_drafts where title like 'E2E %')`);
  await sql.query(`delete from content_drafts where title like 'E2E %'`);
  await sql.query(`update cms_portal_vocabulary set custom = '{}'::jsonb where id = 1`);

  console.log("\nBooting mock Strapi, the API server and the publish worker (3 processes)");
  const strapi = boot("mock-strapi", ["tests/support/mock-strapi.mjs", String(STRAPI_PORT)]);
  await waitFor(async () => (await fetch(`${STRAPI}/__mock/granthas`)).ok, { what: "mock strapi" });
  const api_ = boot("api", ["--import", "tsx", "server/index.ts"]);
  await waitFor(async () => (await fetch(`${API}/api/auth/user`)).status === 401, { timeoutMs: 120_000, what: "api server" });
  const worker = boot("worker", ["--import", "tsx", "server/publish/worker-main.ts"]);
  await waitFor(
    async () => (await sql.query(`select 1 from cms_worker_heartbeats where worker_kind = 'publish' and beat_at > now() - interval '30 seconds'`)).rowCount > 0,
    { timeoutMs: 60_000, what: "worker heartbeat" },
  );
  check("the API server, the publish worker and the mock Strapi are up as separate processes", true);

  // An admin session: register (editor), promote in the DB, log in again.
  const username = `e2e-admin-${RUN}`;
  const reg = await api("POST", "/api/auth/register", { username, password: "e2e-password", displayName: "E2E Admin" });
  check("register an editor", reg.status === 201, JSON.stringify(reg.body));
  await sql.query(`update users set role = 'admin' where username = $1`, [username]);
  cookie = "";
  const login = await api("POST", "/api/auth/login", { username, password: "e2e-password" });
  check("log in as admin", login.status === 200 && login.body?.role === "admin", JSON.stringify(login.body));

  // ---- Shared lists as the UI reads them
  console.log("\nShared lists -> Bhashyam authors (GET /api/cms/vocabulary)");
  let vocab = await api("GET", "/api/cms/vocabulary");
  check("the vocabulary endpoint answers", vocab.status === 200);
  check(`built-in "${BUILT_IN}" is listed`, vocab.body?.bhashyamAuthors?.includes(BUILT_IN));
  check(`"${CUSTOM}" is NOT listed yet (clean start)`, !vocab.body?.bhashyamAuthors?.includes(CUSTOM));

  // ---- 1. prime the worker: a publish with a built-in author (unrelated publishing works)
  console.log("\nUnrelated publish first: built-in author (this is what made the old worker cache stale)");
  const primeDraft = await createDraft(`E2E Prime ${RUN}`, BUILT_IN);
  const prime = await publish(primeDraft.id);
  check("publish with a built-in author is queued", prime.enqueue.status === 200 && prime.enqueue.body?.jobId, JSON.stringify(prime.enqueue.body));
  check("…and the worker finishes it", prime.final?.status === "done", JSON.stringify(prime.final?.error ?? prime.final));
  let granthas = await mockRecords("granthas");
  const primeRec = granthas.find((g) => g.GranthaName === `E2E Prime ${RUN}`);
  check("…and Strapi received the grantha with the built-in author", primeRec?.BhashyamAuthor === BUILT_IN, JSON.stringify(primeRec?.BhashyamAuthor));
  check("…with its sections and verses", (await mockRecords("sections")).length >= 2 && (await mockRecords("manthras")).length >= 2);

  // ---- The screenshot: Jeevan Mukthi Viveka with the custom author, BEFORE it is added
  console.log("\nJeevan Mukthi Viveka -> Save & Publish before the author exists");
  const jmv = await createDraft(`E2E Jeevan Mukthi Viveka ${RUN}`, CUSTOM);
  const before = await publish(jmv.id);
  const beforeMsg = before.enqueue.body?.message ?? before.final?.error ?? "";
  check("publishing is refused", before.enqueue.status === 400 || before.final?.status?.startsWith("failed"), JSON.stringify(before.enqueue.body));
  check("…with the actionable message", /not in the shared vocabulary/.test(beforeMsg) && /Shared lists/.test(beforeMsg), beforeMsg);
  check("…immediately at enqueue (400), not as a failed job minutes later", before.enqueue.status === 400, `status ${before.enqueue.status}`);
  check("…and nothing was written to Strapi for it", !(await mockRecords("granthas")).some((g) => g.GranthaName === jmv.title));

  // ---- 2. Shared lists -> add the author (web process)
  console.log(`\nShared lists -> add "${CUSTOM}" (POST /api/admin/cms/vocabulary)`);
  const add = await api("POST", "/api/admin/cms/vocabulary", { key: "bhashyamAuthors", value: CUSTOM });
  check("the add succeeds", add.status === 200, JSON.stringify(add.body));
  check("the response (what the UI renders) lists it", add.body?.bhashyamAuthors?.includes(CUSTOM));
  vocab = await api("GET", "/api/cms/vocabulary");
  check("a fresh GET lists it too", vocab.body?.bhashyamAuthors?.includes(CUSTOM));
  const row = await sql.query(`select custom from cms_portal_vocabulary where id = 1`);
  check("it is persisted in cms_portal_vocabulary", (row.rows[0]?.custom?.bhashyamAuthors ?? []).includes(CUSTOM), JSON.stringify(row.rows[0]?.custom));

  // ---- 3. Save & Publish again: the worker (separate process, already warm) must accept it
  console.log("\nJeevan Mukthi Viveka -> Save & Publish after the add");
  const after = await publish(jmv.id);
  check("publishing is accepted and queued", after.enqueue.status === 200 && after.enqueue.body?.jobId, JSON.stringify(after.enqueue.body));
  check("the publish worker completes the job", after.final?.status === "done", JSON.stringify(after.final?.error ?? after.final));
  granthas = await mockRecords("granthas");
  const jmvRec = granthas.find((g) => g.GranthaName === jmv.title);
  check(`Strapi received the grantha with BhashyamAuthor "${CUSTOM}"`, jmvRec?.BhashyamAuthor === CUSTOM, JSON.stringify(jmvRec?.BhashyamAuthor));
  const jmvDraft = await api("GET", `/api/drafts/${jmv.id}`);
  check("the draft is marked published and linked to the Strapi document", jmvDraft.body?.status === "published" && jmvDraft.body?.strapiDocumentId === jmvRec?.documentId, JSON.stringify({ status: jmvDraft.body?.status, doc: jmvDraft.body?.strapiDocumentId }));
  check("the draft still carries the author (nothing silently discarded)", jmvDraft.body?.data?.BhashyamAuthor === CUSTOM);
  check("verse count in Strapi matches the draft", (await mockRecords("manthras")).filter((m) => (m.Section?.connect?.[0]?.documentId || m.Section) && m.ShlokaManthraNumber?.startsWith("Shloka 1.")).length >= 4);

  // ---- fresh reads
  console.log("\nReload: vocabulary and publication state survive a fresh read");
  vocab = await api("GET", "/api/cms/vocabulary");
  check("vocabulary still lists the author", vocab.body?.bhashyamAuthors?.includes(CUSTOM));
  const reread = await api("GET", `/api/drafts/${jmv.id}`);
  check("draft still published with the same Strapi document", reread.body?.status === "published" && reread.body?.strapiDocumentId === jmvRec?.documentId);

  // ---- republish in place (the in-place update path, with a known strapiDocumentId)
  const again = await publish(jmv.id);
  check("a republish of the same grantha (in-place PUT) still succeeds", again.enqueue.status === 200 && again.final?.status === "done", JSON.stringify(again.final?.error ?? again.enqueue.body));
  check("…and Strapi still shows one grantha with that author", (await mockRecords("granthas")).filter((g) => g.GranthaName === jmv.title).length === 1);

  // ---- negative + edge cases
  console.log("\nNegative and edge cases");
  const unknown = await createDraft(`E2E Unknown ${RUN}`, "Nobody Known");
  const unk = await publish(unknown.id);
  check("a genuinely unknown author is still rejected (400 at enqueue)", unk.enqueue.status === 400 && /Nobody Known/.test(unk.enqueue.body?.message ?? ""), JSON.stringify(unk.enqueue.body));

  const sloppy = await createDraft(`E2E Sloppy ${RUN}`, `  ${CUSTOM.toLowerCase()}\t`);
  const slop = await publish(sloppy.id);
  const sloppyRec = (await mockRecords("granthas")).find((g) => g.GranthaName === sloppy.title);
  check("whitespace + case variant of the custom author publishes", slop.final?.status === "done", JSON.stringify(slop.final?.error ?? slop.enqueue.body));
  check("…and Strapi stores the canonical spelling", sloppyRec?.BhashyamAuthor === CUSTOM, JSON.stringify(sloppyRec?.BhashyamAuthor));

  const nfd = "Mādhavācārya".normalize("NFD");
  const unicode = await createDraft(`E2E Unicode ${RUN}`, nfd);
  const uni = await publish(unicode.id);
  const uniRec = (await mockRecords("granthas")).find((g) => g.GranthaName === unicode.title);
  check("the NFD spelling of a built-in author publishes", uni.final?.status === "done", JSON.stringify(uni.final?.error ?? uni.enqueue.body));
  check("…and Strapi stores the NFC built-in", uniRec?.BhashyamAuthor === "Mādhavācārya".normalize("NFC"), JSON.stringify(uniRec?.BhashyamAuthor));

  const dup1 = await api("POST", "/api/admin/cms/vocabulary", { key: "bhashyamAuthors", value: CUSTOM });
  const dup2 = await api("POST", "/api/admin/cms/vocabulary", { key: "bhashyamAuthors", value: ` ${CUSTOM.toUpperCase()} ` });
  const dupRow = await sql.query(`select custom from cms_portal_vocabulary where id = 1`);
  check("re-adding the author (exact, case, whitespace) keeps one stored record", dup1.status === 200 && dup2.status === 200 && (dupRow.rows[0].custom.bhashyamAuthors ?? []).filter((v) => v.toLowerCase() === CUSTOM.toLowerCase()).length === 1, JSON.stringify(dupRow.rows[0].custom));
  check("…and the list shows it once", (dup2.body?.bhashyamAuthors ?? []).filter((v) => v.toLowerCase() === CUSTOM.toLowerCase()).length === 1);

  const delBuiltIn = await api("DELETE", "/api/admin/cms/vocabulary", { key: "bhashyamAuthors", value: BUILT_IN });
  check("a built-in author cannot be deleted through the API (still listed)", delBuiltIn.status === 200 && delBuiltIn.body?.bhashyamAuthors?.includes(BUILT_IN));

  const editorReg = await api("POST", "/api/auth/register", { username: `e2e-editor-${RUN}`, password: "e2e-password", displayName: "E2E Editor" });
  const asEditorCookie = cookie;
  const editorAdd = await api("POST", "/api/admin/cms/vocabulary", { key: "bhashyamAuthors", value: "Editor Added" });
  check("a non-admin cannot add to Shared lists (403)", editorReg.status === 201 && editorAdd.status === 403, `status ${editorAdd.status}`);
  cookie = "";
  await api("POST", "/api/auth/login", { username, password: "e2e-password" });
  void asEditorCookie;

  console.log(`\nShared lists -> delete "${CUSTOM}" (content-integrity: later publishes are refused)`);
  const del = await api("DELETE", "/api/admin/cms/vocabulary", { key: "bhashyamAuthors", value: CUSTOM });
  check("the delete succeeds and the list no longer shows it", del.status === 200 && !del.body?.bhashyamAuthors?.includes(CUSTOM));
  const afterDel = await publish(jmv.id);
  check("republishing Jeevan Mukthi Viveka is now refused (400, actionable)", afterDel.enqueue.status === 400 && /not in the shared vocabulary/.test(afterDel.enqueue.body?.message ?? ""), JSON.stringify(afterDel.enqueue.body));
  const stillPublished = await api("GET", `/api/drafts/${jmv.id}`);
  check("…without touching the already-published content", stillPublished.body?.strapiDocumentId === jmvRec?.documentId && (await mockRecords("granthas")).find((g) => g.GranthaName === jmv.title)?.BhashyamAuthor === CUSTOM);

  // ---- the vocabulary cannot be read: fail closed, with a database error, not an author one
  console.log("\nShared vocabulary unreadable (table renamed away on the scratch DB)");
  await api("POST", "/api/admin/cms/vocabulary", { key: "bhashyamAuthors", value: CUSTOM });
  const granthasBefore = (await mockRecords("granthas")).length;
  const outageDraft = await createDraft(`E2E Outage ${RUN}`, CUSTOM);
  let outage, outageBuiltIn;
  await sql.query(`alter table cms_portal_vocabulary rename to cms_portal_vocabulary_e2e_hidden`);
  try {
    outage = await publish(outageDraft.id);
    outageBuiltIn = await publish(primeDraft.id);
  } finally {
    await sql.query(`alter table cms_portal_vocabulary_e2e_hidden rename to cms_portal_vocabulary`);
  }
  check("a listed author is refused with a 503 while the vocabulary is unreadable", outage.enqueue.status === 503, JSON.stringify(outage.enqueue.body));
  check("…as a database error, never as 'not in the shared vocabulary'", outage.enqueue.body?.code !== "bhashyam_author_not_in_vocabulary" && !/not in the shared vocabulary/.test(outage.enqueue.body?.message ?? ""), JSON.stringify(outage.enqueue.body));
  check("even a built-in author is refused (no fail-open to the defaults)", outageBuiltIn.enqueue.status === 503, JSON.stringify(outageBuiltIn.enqueue.body));
  check("…and nothing reached Strapi during the outage", (await mockRecords("granthas")).length === granthasBefore);
  const recovered = await publish(outageDraft.id);
  const recoveredRec = (await mockRecords("granthas")).find((g) => g.GranthaName === outageDraft.title);
  check("once readable again, the same draft publishes with its author", recovered.final?.status === "done" && recoveredRec?.BhashyamAuthor === CUSTOM, JSON.stringify(recovered.final?.error ?? recovered.enqueue.body));

  // Worker log sanity: the worker never logged the vocabulary rejection for the JMV grantha
  const workerRejected = worker.lines.filter((l) => /not in the shared vocabulary/.test(l));
  check("the worker process never rejected an author the UI listed", workerRejected.length === 0, workerRejected.join(" | ").slice(0, 300));
  void strapi; void api_;
} catch (err) {
  FAILURES.push(`harness error - ${err?.stack ?? err}`);
  console.log(`  FAIL harness error - ${err?.message ?? err}`);
} finally {
  shutdown();
  await sql.end().catch(() => {});
}

console.log(`\n${PASS} passed, ${FAILURES.length} failed`);
if (FAILURES.length) {
  for (const f of FAILURES) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
