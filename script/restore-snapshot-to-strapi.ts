/**
 * Rebuild an ENTIRE Strapi content tree (granthas + teekas + sections + mantras)
 * from a portal snapshot (grantha_backups row). This is a whole-snapshot version of
 * the per-grantha `restore-grantha-full` route in server/routes.ts: for each grantha
 * in the snapshot it recreates the grantha, its teekas, its section hierarchy
 * (parents before children), and every mantra inside — remapping all relations to the
 * new Strapi documentIds. Intended for disaster recovery into an EMPTY Strapi.
 *
 * MUST run where the prod DB + Strapi token are reachable (i.e. on the EC2 box):
 *   cd ~/library/library-cms
 *   export DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-)
 *   export STRAPI_URL=$(grep ^STRAPI_URL= .env | cut -d= -f2-)
 *   export STRAPI_API_TOKEN=$(grep ^STRAPI_API_TOKEN= .env | cut -d= -f2-)
 *
 * Usage:
 *   tsx script/restore-snapshot-to-strapi.ts --backup-id 8 --dry-run   # plan only, no writes
 *   tsx script/restore-snapshot-to-strapi.ts --backup-id 8             # create everything
 *   tsx script/restore-snapshot-to-strapi.ts --backup-id 8 --grantha "Isha"   # one grantha
 *   tsx script/restore-snapshot-to-strapi.ts --backup-id 8 --replace   # delete live dup then recreate
 *
 * Flags:
 *   --backup-id N   (required) snapshot id to restore from
 *   --dry-run       validate + print the plan, write nothing
 *   --grantha STR   only restore granthas whose GranthaName matches STR (case-insensitive substring)
 *   --replace       if a live grantha with the same name exists, delete it (mantras→sections→grantha)
 *                   and recreate. Without this flag, existing granthas are SKIPPED (idempotent).
 *   --limit N       stop after N granthas (useful for a cautious first run)
 */
import { gunzipSync } from "node:zlib";

const STRAPI_URL = (process.env.STRAPI_URL || "").replace(/\/$/, "");
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

// Strapi-internal keys that must never be sent back on create (Strapi v5 assigns its own).
const INTERNAL_KEYS = new Set(["id", "documentId", "createdAt", "updatedAt", "publishedAt", "locale"]);

interface Args {
  backupId: number;
  dryRun: boolean;
  granthaFilter?: string;
  replace: boolean;
  limit?: number;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const out: Args = { backupId: NaN, dryRun: false, replace: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--backup-id" && a[i + 1]) out.backupId = parseInt(a[++i], 10);
    else if (a[i] === "--dry-run") out.dryRun = true;
    else if (a[i] === "--replace") out.replace = true;
    else if (a[i] === "--grantha" && a[i + 1]) out.granthaFilter = a[++i];
    else if (a[i] === "--limit" && a[i + 1]) out.limit = parseInt(a[++i], 10);
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

class StrapiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
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
        // 4xx (except 429/408) are permanent — do not retry.
        if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408) {
          throw new StrapiError(res.status, `Strapi ${res.status} on ${method} ${path}: ${text.slice(0, 300)}`);
        }
        lastErr = new StrapiError(res.status, `Strapi ${res.status} on ${method} ${path}: ${text.slice(0, 300)}`);
      } else {
        return text.trim() ? JSON.parse(text) : { data: null };
      }
    } catch (e: any) {
      if (e instanceof StrapiError && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 408) throw e;
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  throw lastErr;
}

async function loadBackup(backupId: number): Promise<{ granthas: any[]; sections: any[]; manthras: any[] }> {
  if (!DATABASE_URL) throw new Error("DATABASE_URL required to load backup from Postgres");
  const { storage } = await import("../server/storage.ts");
  const row = await storage.getBackup(backupId);
  if (!row?.data) throw new Error(`Backup id ${backupId} not found`);
  let raw: any = row.data;
  if (typeof raw === "string") raw = JSON.parse(raw);
  if (raw?._compressed && typeof raw.data === "string") {
    raw = JSON.parse(gunzipSync(Buffer.from(raw.data, "base64")).toString("utf8"));
  }
  if (raw?.data && raw.granthas === undefined && raw.data.granthas) raw = raw.data;
  return {
    granthas: raw.granthas ?? [],
    sections: raw.sections ?? [],
    manthras: raw.manthras ?? [],
  };
}

/** Confirm every content-type route we need is actually served (not 404). */
async function preflight(): Promise<void> {
  const need = ["granthas", "teekas", "sections", "manthras"];
  const bad: string[] = [];
  for (const ct of need) {
    try {
      await strapi(`/api/${ct}?pagination[pageSize]=1`);
    } catch (e: any) {
      const status = e instanceof StrapiError ? e.status : "ERR";
      bad.push(`/api/${ct} → ${status}`);
    }
  }
  if (bad.length) {
    throw new Error(
      `Preflight FAILED — Strapi is not ready to receive this data:\n  ${bad.join("\n  ")}\n` +
        `A 404 means that content type is not deployed on the Strapi backend. Fix/redeploy Strapi ` +
        `(so all four routes respond) BEFORE restoring, or the section/mantra writes will fail.`,
    );
  }
}

async function findLiveGranthasByName(name: string): Promise<any[]> {
  const r = await strapi(
    `/api/granthas?filters[GranthaName][$eqi]=${encodeURIComponent(name)}&fields[0]=documentId&fields[1]=GranthaName&pagination[pageSize]=100`,
  );
  return r?.data ?? [];
}

async function deleteLiveGrantha(liveGid: string, log: (s: string) => void): Promise<void> {
  const manthraIds: string[] = [];
  let page = 1;
  while (true) {
    const lr = await strapi(
      `/api/manthras?filters[Section][grantha][documentId][$eq]=${encodeURIComponent(liveGid)}&fields[0]=documentId&pagination[page]=${page}&pagination[pageSize]=100`,
    );
    const items: any[] = lr?.data ?? [];
    manthraIds.push(...items.map((x) => x.documentId));
    if (items.length < 100) break;
    page++;
  }
  for (const did of manthraIds) await strapi(`/api/manthras/${did}`, "DELETE").catch(() => {});
  log(`    deleted ${manthraIds.length} live mantra(s)`);
  const lsr = await strapi(
    `/api/sections?filters[grantha][documentId][$eq]=${encodeURIComponent(liveGid)}&fields[0]=documentId&pagination[pageSize]=100`,
  );
  const secIds: string[] = (lsr?.data ?? []).map((x: any) => x.documentId);
  for (const sid of secIds) await strapi(`/api/sections/${sid}`, "DELETE").catch(() => {});
  log(`    deleted ${secIds.length} live section(s)`);
  await strapi(`/api/granthas/${liveGid}`, "DELETE").catch(() => {});
  log(`    deleted live grantha ${liveGid}`);
}

interface Totals {
  granthasCreated: number;
  granthasSkipped: number;
  teekasCreated: number;
  sectionsCreated: number;
  manthrasCreated: number;
  errors: string[];
}

async function restoreOneGrantha(
  snapGrantha: any,
  allSections: any[],
  allManthras: any[],
  args: Args,
  totals: Totals,
): Promise<void> {
  const name = String(snapGrantha.GranthaName ?? "").trim();
  const oldGid = snapGrantha.documentId;
  const log = (s: string) => console.log(s);
  log(`\n── Grantha: "${name}" (snapshot ${oldGid})`);

  const snapSections = allSections.filter((s) => s.grantha?.documentId === oldGid);
  const snapSectionDocIds = new Set(snapSections.map((s) => s.documentId));
  const snapManthras = allManthras.filter((m) =>
    snapSectionDocIds.has(m.Section?.documentId ?? m.section?.documentId ?? ""),
  );
  log(`   snapshot has ${snapSections.length} section(s), ${snapManthras.length} mantra(s), ${(snapGrantha.teekas ?? []).length} teeka(s)`);

  // Idempotency / replace handling.
  const live = await findLiveGranthasByName(name);
  if (live.length > 1) {
    totals.errors.push(`"${name}": ${live.length} live granthas share this name — resolve manually`);
    log(`   ⚠ SKIP: ${live.length} live granthas match this name (ambiguous)`);
    totals.granthasSkipped++;
    return;
  }
  if (live.length === 1 && !args.replace) {
    log(`   ↷ SKIP: already exists live (${live[0].documentId}). Use --replace to overwrite.`);
    totals.granthasSkipped++;
    return;
  }

  if (args.dryRun) {
    log(`   [dry-run] would ${live.length === 1 ? "REPLACE" : "create"}: 1 grantha, ${(snapGrantha.teekas ?? []).length} teeka(s), ${snapSections.length} section(s), ${snapManthras.length} mantra(s)`);
    totals.granthasCreated++;
    totals.teekasCreated += (snapGrantha.teekas ?? []).length;
    totals.sectionsCreated += snapSections.length;
    totals.manthrasCreated += snapManthras.length;
    return;
  }

  if (live.length === 1 && args.replace) {
    log(`   replacing live grantha ${live[0].documentId} …`);
    await deleteLiveGrantha(live[0].documentId, log);
  }

  // 1. Create the grantha (without relations/media that can't be linked yet).
  const gp = stripInternal(snapGrantha);
  delete gp.sections;
  delete gp.manthras;
  delete gp.teekas;
  if (gp.coverImage) {
    delete gp.coverImage; // media library is not restored by this script; re-upload separately.
    log(`   note: coverImage dropped (media not restored here)`);
  }
  const gRes = await strapi("/api/granthas", "POST", { data: gp });
  const newGid: string | undefined = gRes?.data?.documentId;
  if (!newGid) throw new Error(`Grantha "${name}" create returned no documentId`);
  totals.granthasCreated++;
  log(`   ✓ created grantha ${newGid}`);

  // 2. Recreate teekas for this grantha, mapping old→new documentId.
  const teekaMap = new Map<string, string>();
  for (const t of snapGrantha.teekas ?? []) {
    const tp = stripInternal(t);
    delete tp.grantha;
    delete tp.manthras;
    tp.grantha = newGid;
    try {
      const tRes = await strapi("/api/teekas", "POST", { data: tp });
      const newTid = tRes?.data?.documentId;
      if (newTid && t.documentId) teekaMap.set(t.documentId, newTid);
      totals.teekasCreated++;
    } catch (e: any) {
      totals.errors.push(`"${name}" teeka "${t.TeekaName ?? t.documentId}": ${e.message}`);
    }
  }
  if (teekaMap.size) log(`   ✓ created ${teekaMap.size} teeka(s)`);

  // 3. Recreate sections, parents before children, remapping grantha + parent.
  const secMap = new Map<string, string>(); // old → new documentId
  const pending = [...snapSections];
  let guard = pending.length * pending.length + 10;
  while (pending.length && guard-- > 0) {
    const s = pending.shift()!;
    const parentOld = s.parent?.documentId;
    if (parentOld && snapSectionDocIds.has(parentOld) && !secMap.has(parentOld)) {
      pending.push(s); // wait until parent exists
      continue;
    }
    const sp = stripInternal(s);
    delete sp.manthras;
    sp.grantha = newGid;
    if (parentOld && secMap.has(parentOld)) sp.parent = secMap.get(parentOld);
    else delete sp.parent;
    try {
      const sRes = await strapi("/api/sections", "POST", { data: sp });
      const newSid = sRes?.data?.documentId;
      if (newSid) secMap.set(s.documentId, newSid);
      totals.sectionsCreated++;
    } catch (e: any) {
      totals.errors.push(`"${name}" section "${s.title ?? s.documentId}": ${e.message}`);
    }
  }
  log(`   ✓ created ${secMap.size}/${snapSections.length} section(s)`);
  if (pending.length) totals.errors.push(`"${name}": ${pending.length} section(s) had unresolved parents`);

  // 4. Recreate mantras, remapping Section + each Teeka component's teeka relation.
  let created = 0;
  for (const m of snapManthras) {
    const oldSec = m.Section?.documentId ?? m.section?.documentId;
    const newSec = oldSec ? secMap.get(oldSec) : undefined;
    const label = String(m.ShlokaManthraNumber ?? m.documentId ?? "?");
    if (!newSec) {
      totals.errors.push(`"${name}" mantra "${label}": section could not be remapped — skipped`);
      continue;
    }
    const mp = stripInternal(m);
    mp.Section = newSec;
    if (Array.isArray(m.Teekas)) {
      mp.Teekas = m.Teekas.map((t: any) => {
        const clean = stripInternal(t);
        const remapped = t.teeka?.documentId ? teekaMap.get(t.teeka.documentId) : undefined;
        if (remapped) clean.teeka = remapped;
        else delete clean.teeka; // referenced teeka not in this grantha's set — leave unlinked
        return clean;
      });
    }
    try {
      await strapi("/api/manthras", "POST", { data: mp });
      created++;
      totals.manthrasCreated++;
    } catch (e: any) {
      totals.errors.push(`"${name}" mantra "${label}": ${e.message}`);
    }
  }
  log(`   ✓ created ${created}/${snapManthras.length} mantra(s)`);
}

async function main() {
  const args = parseArgs();
  if (Number.isNaN(args.backupId)) {
    console.error("ERROR: --backup-id <N> is required (e.g. --backup-id 8)");
    process.exit(1);
  }
  if (!STRAPI_URL || !STRAPI_TOKEN) {
    console.error("ERROR: STRAPI_URL and STRAPI_API_TOKEN must be set in the environment");
    process.exit(1);
  }

  console.log(`Loading snapshot #${args.backupId} from DB …`);
  const snap = await loadBackup(args.backupId);
  console.log(`Snapshot: ${snap.granthas.length} granthas, ${snap.sections.length} sections, ${snap.manthras.length} mantras`);

  let granthas = snap.granthas;
  if (args.granthaFilter) {
    const q = args.granthaFilter.toLowerCase();
    granthas = granthas.filter((g) => String(g.GranthaName ?? "").toLowerCase().includes(q));
    console.log(`Filter "${args.granthaFilter}" → ${granthas.length} grantha(s)`);
  }
  if (args.limit != null) granthas = granthas.slice(0, args.limit);
  if (!granthas.length) {
    console.log("Nothing to restore. Exiting.");
    process.exit(0);
  }

  console.log(`\nPreflight: checking Strapi routes at ${STRAPI_URL} …`);
  await preflight();
  console.log("Preflight OK — all content-type routes respond.");

  if (args.dryRun) console.log("\n*** DRY RUN — no data will be written ***");
  else console.log(`\n*** LIVE RUN — creating content in ${STRAPI_URL} ***`);

  const totals: Totals = {
    granthasCreated: 0,
    granthasSkipped: 0,
    teekasCreated: 0,
    sectionsCreated: 0,
    manthrasCreated: 0,
    errors: [],
  };

  for (const g of granthas) {
    try {
      await restoreOneGrantha(g, snap.sections, snap.manthras, args, totals);
    } catch (e: any) {
      totals.errors.push(`"${g.GranthaName ?? g.documentId}": FATAL ${e.message}`);
      console.error(`   ✗ FATAL for "${g.GranthaName}": ${e.message}`);
    }
  }

  console.log(`\n${"=".repeat(60)}\nSUMMARY (${args.dryRun ? "dry-run — planned" : "created"}):`);
  console.log(`  granthas: ${totals.granthasCreated}  (skipped ${totals.granthasSkipped})`);
  console.log(`  teekas:   ${totals.teekasCreated}`);
  console.log(`  sections: ${totals.sectionsCreated}`);
  console.log(`  mantras:  ${totals.manthrasCreated}`);
  console.log(`  errors:   ${totals.errors.length}`);
  if (totals.errors.length) {
    console.log(`\nFirst ${Math.min(30, totals.errors.length)} error(s):`);
    for (const err of totals.errors.slice(0, 30)) console.log(`  - ${err}`);
  }
  process.exit(totals.errors.length ? 2 : 0);
}

main().catch((e) => {
  console.error("\nFATAL:", e?.message ?? e);
  process.exit(1);
});
