/**
 * A throwaway in-memory Strapi for end-to-end publish tests.
 *
 * Answers the subset of the Strapi v5 REST API the grantha publish walk uses:
 *   POST   /api/:type               create → { data: record }
 *   PUT    /api/:type/:documentId   merge  → { data: record }
 *   GET    /api/:type/:documentId   read   → { data: record } | 404
 *   GET    /api/:type?filters…      list   → { data: [...], meta.pagination }
 *   DELETE /api/:type/:documentId   remove → { data: record }
 * plus an inspection endpoint for the test itself:
 *   GET    /__mock/:type            every record of that type
 *
 * Nothing here knows about vocabulary: it stores whatever `data` it is sent, which is the
 * point — the test asserts what the publish walk actually wrote.
 *
 *   node tests/support/mock-strapi.mjs <port>
 */
import http from "node:http";

const port = Number(process.argv[2] || 5056);
const store = new Map(); // type → records[]
let nextId = 1;

function records(type) {
  if (!store.has(type)) store.set(type, []);
  return store.get(type);
}
function newDocId() {
  return "mock" + Math.random().toString(36).slice(2, 12) + String(nextId).padStart(4, "0");
}
function envelope(rec) {
  return { data: rec, meta: {} };
}
function matches(rec, filters) {
  for (const { field, sub, op, value } of filters) {
    let actual = rec[field];
    if (sub) actual = actual && typeof actual === "object" ? actual[sub] : sub === "documentId" ? actual : undefined;
    if (actual && typeof actual === "object" && !Array.isArray(actual) && actual.connect) {
      actual = actual.connect[0]?.documentId;
    }
    const a = actual == null ? "" : String(actual);
    if (op === "eq" && a !== value) return false;
    if (op === "eqi" && a.toLowerCase() !== value.toLowerCase()) return false;
    if (op === "contains" && !a.includes(value)) return false;
    if (op === "containsi" && !a.toLowerCase().includes(value.toLowerCase())) return false;
    if (op === "in" && !value.split(",").includes(a)) return false;
  }
  return true;
}
function parseFilters(url) {
  const out = [];
  for (const [k, v] of url.searchParams) {
    const m = k.match(/^filters\[(\w+)\](?:\[(\w+)\])?\[\$(eq|eqi|contains|containsi|in)\](?:\[\d+\])?$/);
    if (m) out.push({ field: m[1], sub: m[2], op: m[3], value: v });
  }
  return out;
}
function readBody(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); }
    });
  });
}
function relationsToIds(data) {
  // Strapi accepts `{ connect: [{ documentId }] }` or a bare documentId for a relation; keep
  // both readable by the filter matcher above by leaving them as sent.
  return data;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const mock = url.pathname.match(/^\/__mock\/([\w-]+)$/);
  if (mock) return send(200, records(mock[1]));
  const m = url.pathname.match(/^\/api\/([\w-]+)(?:\/([\w-]+))?$/);
  if (!m) return send(404, { error: { status: 404, message: "Not Found" } });
  const [, type, docId] = m;
  const list = records(type);

  if (req.method === "POST" && !docId) {
    const body = await readBody(req);
    const rec = {
      id: nextId++,
      documentId: newDocId(),
      ...relationsToIds(body.data ?? {}),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      publishedAt: new Date().toISOString(),
    };
    list.push(rec);
    return send(201, envelope(rec));
  }
  if (req.method === "PUT" && docId) {
    const body = await readBody(req);
    const rec = list.find((r) => r.documentId === docId);
    if (!rec) return send(404, { error: { status: 404, message: "Not Found" } });
    Object.assign(rec, relationsToIds(body.data ?? {}), { updatedAt: new Date().toISOString() });
    return send(200, envelope(rec));
  }
  if (req.method === "DELETE" && docId) {
    const idx = list.findIndex((r) => r.documentId === docId);
    if (idx < 0) return send(404, { error: { status: 404, message: "Not Found" } });
    const [rec] = list.splice(idx, 1);
    return send(200, envelope(rec));
  }
  if (req.method === "GET" && docId) {
    const rec = list.find((r) => r.documentId === docId);
    if (!rec) return send(404, { error: { status: 404, message: "Not Found" } });
    return send(200, envelope(rec));
  }
  if (req.method === "GET") {
    const filtered = list.filter((r) => matches(r, parseFilters(url)));
    const pageSize = Number(url.searchParams.get("pagination[pageSize]") || 100);
    const page = Number(url.searchParams.get("pagination[page]") || 1);
    const slice = filtered.slice((page - 1) * pageSize, page * pageSize);
    return send(200, {
      data: slice,
      meta: { pagination: { page, pageSize, pageCount: Math.max(1, Math.ceil(filtered.length / pageSize)), total: filtered.length } },
    });
  }
  send(405, { error: { status: 405, message: "Method Not Allowed" } });
});

server.listen(port, "127.0.0.1", () => console.log(`[mock-strapi] listening on ${port}`));
