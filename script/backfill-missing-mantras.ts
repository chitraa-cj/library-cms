/**
 * Idempotent backfill for mantras that failed to create during a snapshot restore
 * (e.g. 413 PayloadTooLarge before the Strapi body limit was raised). For each grantha
 * that ALREADY exists live, it maps live sections back to the snapshot sections
 * (by parentTitle|title|type|order), then creates only the snapshot mantras whose
 * ShlokaManthraNumber is not already present in the matching live section. Safe to
 * re-run — existing mantras are skipped.
 *
 * Run from a machine with the snapshot DB (local) + reachable Strapi (env like the
 * restore script):
 *   tsx script/backfill-missing-mantras.ts --backup-id 8
 *   tsx script/backfill-missing-mantras.ts --backup-id 8 --grantha "Mandukya"   # scope to one
 */
import { gunzipSync } from "node:zlib";

const STRAPI_URL = (process.env.STRAPI_URL || "").replace(/\/$/, "");
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN || "";
const DATABASE_URL = process.env.DATABASE_URL || "";
const INTERNAL_KEYS = new Set(["id", "documentId", "createdAt", "updatedAt", "publishedAt", "locale"]);

function parseArgs() {
  const a = process.argv.slice(2);
  const out: { backupId: number; granthaFilter?: string } = { backupId: NaN };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--backup-id" && a[i + 1]) out.backupId = parseInt(a[++i], 10);
    else if (a[i] === "--grantha" && a[i + 1]) out.granthaFilter = a[++i];
  }
  return out;
}

function stripInternal(obj: any): any {
  if (Array.isArray(obj)) return obj.map(stripInternal);
  if (obj && typeof obj === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (INTERNAL_KEYS.has(k)) continue;
      out[k] = stripInternal(v);
    }
    return out;
  }
  return obj;
}

async function strapi(path: string, method = "GET", body?: any): Promise<any> {
  const url = `${STRAPI_URL}${path}`;
  let lastErr: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${STRAPI_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body != null ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (!res.ok) {
        if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408) {
          throw new Error(`Strapi ${res.status} on ${method} ${path}: ${text.slice(0, 200)}`);
        }
        lastErr = new Error(`Strapi ${res.status} on ${method} ${path}: ${text.slice(0, 200)}`);
      } else {
        return text.trim() ? JSON.parse(text) : { data: null };
      }
    } catch (e: any) {
      if (/Strapi 4(0[0-9]|[1-9][0-9])/.test(e.message) && !/429|408/.test(e.message)) throw e;
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  throw lastErr;
}

const secKey = (title: any, type: any, order: any, parentTitle: any) =>
  `${title ?? ""}␟${type ?? ""}␟${order ?? ""}␟${parentTitle ?? ""}`;

async function loadBackup(id: number) {
  const { storage } = await import("../server/storage.ts");
  const row = await storage.getBackup(id);
  if (!row?.data) throw new Error(`Backup ${id} not found`);
  let raw: any = row.data;
  if (typeof raw === "string") raw = JSON.parse(raw);
  if (raw?._compressed && typeof raw.data === "string") raw = JSON.parse(gunzipSync(Buffer.from(raw.data, "base64")).toString("utf8"));
  if (raw?.data && raw.granthas === undefined && raw.data.granthas) raw = raw.data;
  return { granthas: raw.granthas ?? [], sections: raw.sections ?? [], manthras: raw.manthras ?? [] };
}

async function fetchAllPages(basePath: string): Promise<any[]> {
  const sep = basePath.includes("?") ? "&" : "?";
  const out: any[] = [];
  let page = 1;
  while (true) {
    const r = await strapi(`${basePath}${sep}pagination[page]=${page}&pagination[pageSize]=100`);
    const items = r?.data ?? [];
    out.push(...items);
    if (items.length < 100) break;
    page++;
  }
  return out;
}

async function main() {
  const args = parseArgs();
  if (Number.isNaN(args.backupId)) throw new Error("--backup-id <N> required");
  if (!STRAPI_URL || !STRAPI_TOKEN || !DATABASE_URL) throw new Error("STRAPI_URL, STRAPI_API_TOKEN, DATABASE_URL must be set");

  const snap = await loadBackup(args.backupId);
  const secById = new Map<string, any>(snap.sections.map((s: any) => [s.documentId, s]));
  const parentTitle = (s: any) => (s.parent?.documentId ? secById.get(s.parent.documentId)?.title : "");

  let granthas = snap.granthas;
  if (args.granthaFilter) {
    const q = args.granthaFilter.toLowerCase();
    granthas = granthas.filter((g: any) => String(g.GranthaName ?? "").toLowerCase().includes(q));
  }

  let totalCreated = 0;
  const errors: string[] = [];

  // Fetch all live granthas once; match by normalized name (whitespace/case-insensitive)
  // so trailing/double spaces in the source data don't cause misses.
  const norm = (x: any) => String(x ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const liveGranthas = await fetchAllPages(`/api/granthas?fields[0]=GranthaName&fields[1]=documentId`);
  const liveByNorm = new Map<string, string[]>();
  for (const lg of liveGranthas) {
    const k = norm(lg.GranthaName);
    if (!liveByNorm.has(k)) liveByNorm.set(k, []);
    liveByNorm.get(k)!.push(lg.documentId);
  }

  for (const g of granthas) {
    const name = String(g.GranthaName ?? "").trim();
    const oldGid = g.documentId;
    // Find the live grantha by normalized name.
    const liveIds = liveByNorm.get(norm(name)) ?? [];
    if (liveIds.length !== 1) {
      if (liveIds.length > 1) errors.push(`"${name}": ${liveIds.length} live matches — skipped`);
      continue;
    }
    const liveGid = liveIds[0];

    // snapshot sections for this grantha, keyed by composite.
    const snapSecs = snap.sections.filter((s: any) => s.grantha?.documentId === oldGid);
    const snapSecKeyToOld = new Map<string, string>();
    for (const s of snapSecs) snapSecKeyToOld.set(secKey(s.title, s.type, s.order, parentTitle(s)), s.documentId);

    // live sections for this grantha (with parent title), keyed by same composite.
    const liveSecs = await fetchAllPages(
      `/api/sections?filters[grantha][documentId][$eq]=${encodeURIComponent(liveGid)}&fields[0]=title&fields[1]=type&fields[2]=order&populate[parent][fields][0]=title`,
    );
    const keyToLiveSec = new Map<string, string>();
    for (const s of liveSecs) keyToLiveSec.set(secKey(s.title, s.type, s.order, s.parent?.title), s.documentId);

    // old snapshot section docId -> live section docId
    const oldSecToLive = new Map<string, string>();
    for (const [key, oldId] of snapSecKeyToOld) {
      const liveId = keyToLiveSec.get(key);
      if (liveId) oldSecToLive.set(oldId, liveId);
    }

    // live mantra numbers already present, per live section docId.
    const liveMantras = await fetchAllPages(
      `/api/manthras?filters[Section][grantha][documentId][$eq]=${encodeURIComponent(liveGid)}&fields[0]=ShlokaManthraNumber&populate[Section][fields][0]=documentId`,
    );
    const presentBySec = new Map<string, Set<string>>();
    for (const m of liveMantras) {
      const sid = m.Section?.documentId;
      if (!sid) continue;
      if (!presentBySec.has(sid)) presentBySec.set(sid, new Set());
      presentBySec.get(sid)!.add(String(m.ShlokaManthraNumber ?? ""));
    }

    // live teekas for this grantha, matched to snapshot teekas by TeekaName.
    const liveTeekas = (await strapi(`/api/teekas?filters[grantha][documentId][$eq]=${encodeURIComponent(liveGid)}&fields[0]=TeekaName&pagination[pageSize]=100`))?.data ?? [];
    const teekaNameToLive = new Map<string, string>();
    for (const t of liveTeekas) teekaNameToLive.set(String(t.TeekaName ?? ""), t.documentId);

    // snapshot mantras for this grantha.
    const snapSecDocIds = new Set(snapSecs.map((s: any) => s.documentId));
    const snapMantras = snap.manthras.filter((m: any) => snapSecDocIds.has(m.Section?.documentId ?? m.section?.documentId ?? ""));

    let createdHere = 0;
    for (const m of snapMantras) {
      const oldSec = m.Section?.documentId ?? m.section?.documentId;
      const liveSec = oldSec ? oldSecToLive.get(oldSec) : undefined;
      const num = String(m.ShlokaManthraNumber ?? "");
      if (!liveSec) {
        errors.push(`"${name}" mantra "${num}": no live section match — skipped`);
        continue;
      }
      if (presentBySec.get(liveSec)?.has(num)) continue; // already there
      const mp = stripInternal(m);
      mp.Section = liveSec;
      if (Array.isArray(m.Teekas)) {
        mp.Teekas = m.Teekas.map((t: any) => {
          const clean = stripInternal(t);
          const liveT = t.teeka?.TeekaName ? teekaNameToLive.get(String(t.teeka.TeekaName)) : undefined;
          if (liveT) clean.teeka = liveT;
          else delete clean.teeka;
          return clean;
        });
      }
      try {
        await strapi("/api/manthras", "POST", { data: mp });
        createdHere++;
        totalCreated++;
      } catch (e: any) {
        errors.push(`"${name}" mantra "${num}": ${e.message}`);
      }
    }
    if (createdHere) console.log(`  "${name}": backfilled ${createdHere} mantra(s)`);
  }

  console.log(`\nDONE — backfilled ${totalCreated} mantra(s), ${errors.length} error(s)`);
  for (const e of errors.slice(0, 30)) console.log(`  - ${e}`);
  process.exit(errors.length ? 2 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e?.message ?? e);
  process.exit(1);
});
