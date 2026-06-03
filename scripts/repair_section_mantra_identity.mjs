/**
 * Repair mantra order + ShlokaManthraNumber labels for one Strapi section.
 *
 * Use when a section has:
 *   - duplicate `order` values (e.g. two rows at 600000)
 *   - blank or reset labels ("Mantra 1" on many rows)
 *   - order continuing correctly but labels out of sync with position
 *
 * Canonical order is the current CMS sort order (order ASC, documentId tie-break).
 * Labels are rebuilt as:  {LEAF} {SUFFIX_PREFIX}.{1-based index}
 *
 * Duplicate rows at the same order: keeps the row with the best existing suffix match
 * to its position; extra rows are reported for manual deletion (not auto-deleted).
 *
 * Usage:
 *   STRAPI_API_TOKEN=... node scripts/repair_section_mantra_identity.mjs \
 *     --section=<sectionDocumentId> \
 *     --leaf=Mantra \
 *     --suffix-prefix=1 \
 *     [--apply]
 *
 * Without --apply, runs in dry-run mode (report only).
 */
import http from "node:http";

const STRAPI_HOST = process.env.STRAPI_HOST || "13.53.121.15";
const STRAPI_PORT = Number(process.env.STRAPI_PORT || 1337);
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN;
const PAGE_SIZE = 100;
const CONCURRENCY = 4;
const STRAPI_SORT_GAP = 100_000;

function parseArgs() {
  const out = { apply: false, leaf: "Mantra", suffixPrefix: "1", section: "" };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--apply") out.apply = true;
    else if (arg.startsWith("--section=")) out.section = arg.slice("--section=".length).trim();
    else if (arg.startsWith("--leaf=")) out.leaf = arg.slice("--leaf=".length).trim() || "Mantra";
    else if (arg.startsWith("--suffix-prefix=")) {
      out.suffixPrefix = arg.slice("--suffix-prefix=".length).trim() || "1";
    }
  }
  return out;
}

if (!STRAPI_TOKEN) {
  console.error("Set STRAPI_API_TOKEN in the environment.");
  process.exit(1);
}

function strapiReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: STRAPI_HOST,
        port: STRAPI_PORT,
        path,
        method,
        headers: {
          Authorization: `Bearer ${STRAPI_TOKEN}`,
          "Content-Type": "application/json",
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: { _raw: data } });
          }
        });
      },
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function fetchAllManthras(sectionDocId) {
  const all = [];
  let page = 1;
  while (true) {
    const path =
      `/api/manthras` +
      `?filters[Section][documentId][$eq]=${encodeURIComponent(sectionDocId)}` +
      `&fields[0]=ShlokaManthraNumber&fields[1]=order&fields[2]=documentId` +
      `&pagination[page]=${page}&pagination[pageSize]=${PAGE_SIZE}` +
      `&sort=order:asc`;
    const { body: res } = await strapiReq("GET", path);
    const items = res?.data ?? [];
    all.push(...items);
    const total = res?.meta?.pagination?.total ?? 0;
    if (items.length < PAGE_SIZE || all.length >= total) break;
    page++;
  }
  return all;
}

function suffixFromLabel(label) {
  const m = String(label ?? "").match(/(\d+(?:\.\d+)+)\s*$/);
  return m ? m[1] : null;
}

/** e.g. "Vaakhyaa 1", "Mantra 2" — leaf + integer, no dotted verse suffix. */
function isBareLeafCounterTitle(label) {
  const t = String(label ?? "").trim();
  if (!t || suffixFromLabel(t)) return false;
  return /^.+\s+\d+$/.test(t);
}

function sanskritHasContent(raw) {
  if (!raw) return false;
  const s = String(raw);
  return s.length > 20 && !/^\[\]$/.test(s.trim());
}

function leafPrefixFromDottedLabel(label) {
  const t = String(label ?? "").trim();
  const m = t.match(/^(.+?)\s+\d+(?:\.\d+)+\s*$/);
  return m ? m[1].trim() : null;
}

function expectedLabel(leaf, suffixPrefix, index1) {
  return `${leaf} ${suffixPrefix}.${index1}`.trim();
}

function expectedOrder(index1) {
  return index1 * STRAPI_SORT_GAP;
}

async function fetchMantraSanskrit(docId) {
  const { body } = await strapiReq("GET", `/api/manthras/${docId}?populate[ShlokaManthraEntry][fields][0]=SanskritTextEntry`);
  const entry = body.data?.ShlokaManthraEntry;
  if (!entry) return "";
  return JSON.stringify(entry);
}

function verseMarkerFromSanskrit(raw) {
  const m = String(raw).match(/\|\|(\d+)\|\|/);
  return m ? parseInt(m[1], 10) : null;
}

async function runConcurrent(tasks, limit) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

async function main() {
  const args = parseArgs();
  if (!args.section || args.section.length < 10) {
    console.error("Required: --section=<sectionDocumentId>");
    process.exit(1);
  }

  console.log(`Section: ${args.section}`);
  console.log(`Leaf: ${args.leaf}, suffix prefix: ${args.suffixPrefix}`);
  console.log(`Mode: ${args.apply ? "APPLY" : "DRY RUN"}\n`);

  const rows = await fetchAllManthras(args.section);
  console.log(`Fetched ${rows.length} mantras.\n`);

  const normalized = rows
    .map((m) => ({
      docId: m.documentId,
      order: m.order ?? 0,
      label: m.ShlokaManthraNumber ?? "",
      suffix: suffixFromLabel(m.ShlokaManthraNumber),
      sanskrit: "",
    }))
    .sort((a, b) => {
      const d = a.order - b.order;
      if (d !== 0) return d;
      return String(a.docId).localeCompare(String(b.docId));
    });

  // ── Diagnostics ─────────────────────────────────────────────────────────
  const byOrder = new Map();
  const byLabel = new Map();
  for (const r of normalized) {
    byOrder.set(r.order, [...(byOrder.get(r.order) ?? []), r]);
    const lbl = (r.label || "").trim() || "(blank)";
    byLabel.set(lbl, [...(byLabel.get(lbl) ?? []), r]);
  }

  const dupOrders = [...byOrder.entries()].filter(([, list]) => list.length > 1);
  const dupLabels = [...byLabel.entries()].filter(([lbl, list]) => list.length > 1 && lbl !== "(blank)");

  console.log("── Duplicate orders ──────────────────────────────────────────");
  if (dupOrders.length === 0) console.log("  (none)");
  else {
    for (const [order, list] of dupOrders) {
      console.log(`  order=${order}: ${list.map((r) => `${r.docId} "${r.label}"`).join(" | ")}`);
    }
  }

  console.log("\n── Duplicate labels ──────────────────────────────────────────");
  if (dupLabels.length === 0) console.log("  (none)");
  else {
    for (const [lbl, list] of dupLabels) {
      console.log(`  "${lbl}": ${list.length} rows`);
    }
  }

  // Resolve duplicate orders: keep best row per order (verse marker in text > valid suffix > bare label)
  async function loadSanskritForDuplicates() {
    const dupIds = new Set();
    for (const [, list] of byOrder.entries()) {
      if (list.length > 1) for (const r of list) dupIds.add(r.docId);
    }
    for (const r of normalized) {
      if (dupIds.has(r.docId)) {
        r.sanskrit = await fetchMantraSanskrit(r.docId);
      }
    }
  }
  await loadSanskritForDuplicates();

  const hasDottedVerse = normalized.some((r) => !!suffixFromLabel(r.label));
  const bareStubOrphans = [];
  if (hasDottedVerse) {
    for (const r of normalized) {
      if (!isBareLeafCounterTitle(r.label)) continue;
      if (!r.sanskrit) r.sanskrit = await fetchMantraSanskrit(r.docId);
      if (!sanskritHasContent(r.sanskrit)) bareStubOrphans.push(r);
    }
  }
  if (bareStubOrphans.length > 0) {
    console.log("\n── Bare stub rows (empty + leaf-only label — will delete on --apply) ──");
    for (const r of bareStubOrphans) {
      console.log(`  ${r.docId} order=${r.order} label="${r.label}"`);
    }
  }

  function keeperScore(row, orderNum) {
    let s = 0;
    const expectedSuffix = `${args.suffixPrefix}.${orderNum}`;
    const verse = verseMarkerFromSanskrit(row.sanskrit);
    if (verse === orderNum) s += 500;
    else if (verse != null) s -= Math.abs(verse - orderNum) * 10;
    if (row.suffix === expectedSuffix) s += 200;
    else if (row.suffix) s += 80;
    const lbl = (row.label || "").trim();
    if (/^Mantra 1$/i.test(lbl) || lbl === `${args.leaf} 1`) s -= 100;
    if (!lbl) s -= 20;
    return s;
  }

  const stubIds = new Set(bareStubOrphans.map((r) => r.docId));
  const working = normalized.filter((r) => !stubIds.has(r.docId));

  const byOrderWorking = new Map();
  for (const r of working) {
    byOrderWorking.set(r.order, [...(byOrderWorking.get(r.order) ?? []), r]);
  }

  const canonical = [];
  const orphans = [...bareStubOrphans];

  for (const [order, list] of byOrderWorking.entries()) {
    const orderNum = Math.round(order / STRAPI_SORT_GAP) || canonical.length + 1;
    if (list.length === 1) {
      canonical.push(list[0]);
      continue;
    }
    const ranked = [...list].sort(
      (a, b) => keeperScore(b, orderNum) - keeperScore(a, orderNum) || String(a.docId).localeCompare(String(b.docId)),
    );
    canonical.push(ranked[0]);
    orphans.push(...ranked.slice(1));
  }

  canonical.sort((a, b) => {
    const d = a.order - b.order;
    if (d !== 0) return d;
    return String(a.docId).localeCompare(String(b.docId));
  });

  if (orphans.length > 0) {
    console.log("\n── Orphan rows (duplicate order — will delete on --apply) ─────");
    for (const r of orphans) {
      console.log(`  ${r.docId} order=${r.order} label="${r.label}"`);
    }
  }

  // Build repair plan from canonical sequence (skip relabel when dotted labels already unique).
  const nonStubCanonical = canonical;
  const labelsUnique =
    new Set(nonStubCanonical.map((r) => (r.label || "").trim()).filter(Boolean)).size ===
    nonStubCanonical.length;
  const ordersUnique =
    new Set(nonStubCanonical.map((r) => r.order)).size === nonStubCanonical.length;
  const allDotted =
    nonStubCanonical.length > 0 && nonStubCanonical.every((r) => !!suffixFromLabel(r.label));
  const skipRelabel = allDotted && labelsUnique && ordersUnique && bareStubOrphans.length > 0;

  const plan = skipRelabel
    ? nonStubCanonical.map((r) => ({
        docId: r.docId,
        currentOrder: r.order,
        currentLabel: r.label,
        wantOrder: r.order,
        wantLabel: r.label,
        needsFix: false,
      }))
    : nonStubCanonical.map((r, idx) => {
        const pos = idx + 1;
        const wantOrder = expectedOrder(pos);
        const wantLabel = expectedLabel(args.leaf, args.suffixPrefix, pos);
        return {
          docId: r.docId,
          currentOrder: r.order,
          currentLabel: r.label,
          wantOrder,
          wantLabel,
          needsFix: r.order !== wantOrder || (r.label || "").trim() !== wantLabel,
        };
      });

  if (skipRelabel) {
    console.log("\n── Relabel skipped: canonical dotted labels already unique (stubs only) ──");
  }

  const toFix = plan.filter((p) => p.needsFix);
  console.log(`\n── Repair plan: ${toFix.length} / ${plan.length} rows need updates ──`);
  for (const p of toFix.slice(0, 30)) {
    console.log(
      `  ${p.docId}: order ${p.currentOrder}→${p.wantOrder}, label "${p.currentLabel}"→"${p.wantLabel}"`,
    );
  }
  if (toFix.length > 30) console.log(`  ... +${toFix.length - 30} more`);

  // Verify monotonic labels after repair
  const labelsAfter = plan.map((p) => p.wantLabel);
  const ordersAfter = plan.map((p) => p.wantOrder);
  const uniqueOrders = new Set(ordersAfter).size === ordersAfter.length;
  const uniqueLabels = new Set(labelsAfter).size === labelsAfter.length;
  console.log(`\n── Post-repair checks ────────────────────────────────────────`);
  console.log(`  unique orders: ${uniqueOrders}`);
  console.log(`  unique labels: ${uniqueLabels}`);
  console.log(`  monotonic orders: ${ordersAfter.every((o, i) => i === 0 || o > ordersAfter[i - 1])}`);

  if (!args.apply) {
    console.log("\nDry run complete. Re-run with --apply to write fixes.");
    if (orphans.length > 0) {
      console.log("Orphan / bare-stub rows will be deleted on --apply.");
    }
    return;
  }

  if (orphans.length > 0) {
    console.log(`\nDeleting ${orphans.length} duplicate-order orphan(s)...`);
    for (const r of orphans) {
      const { status } = await strapiReq("DELETE", `/api/manthras/${r.docId}`);
      console.log(status >= 200 && status < 300 ? `  ✓ deleted ${r.docId}` : `  ✗ failed ${r.docId} (${status})`);
    }
  }

  if (toFix.length === 0) {
    console.log("\nNothing to update.");
    return;
  }

  console.log(`\nApplying ${toFix.length} updates ...`);
  let ok = 0;
  let err = 0;
  const tasks = toFix.map((p) => async () => {
    const { status, body } = await strapiReq("PUT", `/api/manthras/${p.docId}`, {
      data: { order: p.wantOrder, ShlokaManthraNumber: p.wantLabel },
    });
    if (status >= 200 && status < 300 && (body?.data?.documentId || body?.data?.id)) {
      ok++;
      process.stdout.write(`\r  ✓ ${ok} updated   `);
    } else {
      err++;
      console.error(`\n  ✗ ${p.docId}: HTTP ${status}`, JSON.stringify(body).slice(0, 120));
    }
  });
  await runConcurrent(tasks, CONCURRENCY);
  console.log(`\n\nDone. Updated: ${ok}, errors: ${err}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
