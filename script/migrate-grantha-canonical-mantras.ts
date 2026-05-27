/**
 * Canonicalize mantra hierarchy rows in Strapi for one grantha.
 *
 * Default mode is DRY RUN (no writes). Execute mode performs:
 * - delete non-canonical duplicate/manually-corrupted rows
 * - rebuild deterministic spaced sort keys (1000, 2000, ...)
 *
 * Idempotency guarantees:
 * - rerunning dry-run returns same plan for unchanged data
 * - rerunning execute after success yields zero-op mutations
 *
 * Usage:
 *   npx tsx script/migrate-grantha-canonical-mantras.ts --grantha "Ishavasya"
 *   npx tsx script/migrate-grantha-canonical-mantras.ts --grantha-doc-id <docId> --execute
 */
import "../server/env";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { portalIndexToStrapiSortKey } from "../shared/mantra-sort-key";
import { strapiRequest } from "../server/strapi";

type SectionRow = {
  documentId: string;
  title?: string;
  type?: string | null;
  order?: number;
  parent?: { documentId?: string; title?: string };
};

type MantraRow = {
  documentId: string;
  ShlokaManthraNumber?: string;
  order?: number;
  ShlokaManthraEntry?: unknown;
  BhashyamEntry?: unknown;
  Section?: { documentId?: string; title?: string };
};

type Candidate = {
  row: MantraRow;
  sectionPath: SectionRow[];
  sectionPathKey: string;
  suffix: string | null;
  suffixDepth: number;
  leafIndex: number | null;
  isTopLevelPlacement: boolean;
  isExpectedDepthForPath: boolean;
  contentScore: number;
};

type Args = {
  granthaQuery?: string;
  granthaDocId?: string;
  execute: boolean;
  batchSize: number;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = {
    execute: false,
    batchSize: 50,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--grantha" && args[i + 1]) out.granthaQuery = args[++i];
    else if (a === "--grantha-doc-id" && args[i + 1]) out.granthaDocId = args[++i];
    else if (a === "--execute") out.execute = true;
    else if (a === "--dry-run") out.execute = false;
    else if (a === "--batch-size" && args[i + 1]) {
      out.batchSize = Math.max(1, parseInt(args[++i], 10) || 50);
    }
  }
  if (!out.granthaDocId && !out.granthaQuery) {
    throw new Error("Pass --grantha <name> or --grantha-doc-id <docId>");
  }
  return out;
}

function log(event: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}

function parseSuffix(label: string | undefined): string | null {
  const t = (label ?? "").trim();
  const m = t.match(/(\d+(?:\.\d+)+)\s*$/);
  return m ? m[1] : null;
}

function compareSuffix(a: string | null, b: string | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function leafIndexFromSuffix(suffix: string | null): number | null {
  if (!suffix) return null;
  const parts = suffix.split(".");
  const n = parseInt(parts[parts.length - 1] ?? "", 10);
  return Number.isNaN(n) ? null : n;
}

function blockTextLen(v: unknown): number {
  if (!v) return 0;
  if (typeof v === "string") return v.trim().length;
  if (!Array.isArray(v)) return 0;
  return (v as any[])
    .map((b) =>
      ((b?.children ?? []) as any[])
        .map((c) => (typeof c?.text === "string" ? c.text : ""))
        .join(""),
    )
    .join("\n")
    .trim().length;
}

function mantraContentScore(m: MantraRow): number {
  const s = (m.ShlokaManthraEntry ?? {}) as Record<string, unknown>;
  const b = (m.BhashyamEntry ?? {}) as Record<string, unknown>;
  return (
    blockTextLen(s.SanskritTextEntry) +
    blockTextLen(s.EnglishTranslationText) +
    blockTextLen(b.SanskritTextEntry) +
    blockTextLen(b.EnglishTranslationText)
  );
}

async function fetchAllPages(path: string): Promise<any[]> {
  const out: any[] = [];
  let page = 1;
  while (true) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await strapiRequest(`${path}${sep}pagination[pageSize]=100&pagination[page]=${page}`);
    out.push(...(r?.data ?? []));
    const pageCount = r?.meta?.pagination?.pageCount ?? 1;
    if (page >= pageCount) break;
    page++;
  }
  return out;
}

async function resolveGrantha(args: Args): Promise<{ documentId: string; GranthaName: string }> {
  if (args.granthaDocId) {
    const g = await strapiRequest(
      `/api/granthas/${encodeURIComponent(args.granthaDocId)}?fields[0]=documentId&fields[1]=GranthaName`,
    );
    const row = g?.data;
    if (!row?.documentId) throw new Error(`Grantha not found: ${args.granthaDocId}`);
    return { documentId: row.documentId, GranthaName: row.GranthaName };
  }
  const q = encodeURIComponent(args.granthaQuery ?? "");
  const r = await strapiRequest(
    `/api/granthas?filters[GranthaName][$containsi]=${q}&fields[0]=documentId&fields[1]=GranthaName&pagination[pageSize]=25`,
  );
  const rows: any[] = r?.data ?? [];
  if (rows.length === 0) throw new Error(`No grantha matching "${args.granthaQuery}"`);
  return { documentId: rows[0].documentId, GranthaName: rows[0].GranthaName };
}

function sectionPath(sectionId: string, byId: Map<string, SectionRow>): SectionRow[] {
  const path: SectionRow[] = [];
  const seen = new Set<string>();
  let cur = byId.get(sectionId);
  while (cur?.documentId && !seen.has(cur.documentId)) {
    seen.add(cur.documentId);
    path.unshift(cur);
    const pid = cur.parent?.documentId;
    cur = pid ? byId.get(pid) : undefined;
  }
  return path;
}

function selectKeeper(rows: Candidate[]): Candidate {
  const scored = rows
    .map((c) => {
      const order = typeof c.row.order === "number" ? c.row.order : Number.MAX_SAFE_INTEGER;
      const canonicalDepthBonus = c.isExpectedDepthForPath ? 5000 : 0;
      const misplacedPenalty = c.isTopLevelPlacement ? -10000 : 0;
      const depthBonus = c.suffixDepth * 250;
      const legacySortPenalty = !c.isExpectedDepthForPath && order >= 1000 ? -1000 : 0;
      const total =
        canonicalDepthBonus +
        c.contentScore +
        depthBonus +
        misplacedPenalty +
        legacySortPenalty +
        (order < 1000 ? 50 : 0);
      return { c, total, order };
    })
    .sort((a, b) => {
      if (a.total !== b.total) return b.total - a.total;
      if (a.order !== b.order) return a.order - b.order;
      return String(a.c.row.documentId).localeCompare(String(b.c.row.documentId));
    });
  return scored[0].c;
}

async function main() {
  const args = parseArgs();
  const grantha = await resolveGrantha(args);
  const granthaDocId = grantha.documentId;
  const mode = args.execute ? "execute" : "dry-run";

  const sections = (await fetchAllPages(
    `/api/sections?filters[grantha][documentId][$eq]=${encodeURIComponent(granthaDocId)}` +
      `&fields[0]=documentId&fields[1]=title&fields[2]=type&fields[3]=order` +
      `&populate[parent][fields][0]=documentId&populate[parent][fields][1]=title&sort[0]=order:asc`,
  )) as SectionRow[];
  const bySectionId = new Map(sections.map((s) => [s.documentId, s]));
  const hasNestedSections = sections.some((s) => {
    const pid = s.parent?.documentId;
    return !!pid && bySectionId.has(pid);
  });

  const manthras = (await fetchAllPages(
    `/api/manthras?filters[Section][grantha][documentId][$eq]=${encodeURIComponent(granthaDocId)}` +
      `&fields[0]=documentId&fields[1]=ShlokaManthraNumber&fields[2]=order` +
      `&populate[Section][fields][0]=documentId&populate[Section][fields][1]=title` +
      `&populate[ShlokaManthraEntry][populate]=*&populate[BhashyamEntry][populate]=*&sort[0]=order:asc`,
  )) as MantraRow[];

  const candidates: Candidate[] = manthras.map((row) => {
    const sid = row.Section?.documentId ?? "";
    const path = sid ? sectionPath(sid, bySectionId) : [];
    const suffix = parseSuffix(row.ShlokaManthraNumber);
    const suffixDepth = suffix ? suffix.split(".").length : 0;
    const expectedDepth = path.length > 0 ? path.length + 1 : 0;
    return {
      row,
      sectionPath: path,
      sectionPathKey: path.map((p) => p.documentId).join("/") || sid || "__none__",
      suffix,
      suffixDepth,
      leafIndex: leafIndexFromSuffix(suffix),
      isTopLevelPlacement: path.length === 1,
      isExpectedDepthForPath: expectedDepth > 0 && suffixDepth === expectedDepth,
      contentScore: mantraContentScore(row),
    };
  });

  const keepIds = new Set<string>();
  const deleteReasons = new Map<string, string>();

  // 1) Hard-delete candidates: top-level mantras when nested sections exist.
  if (hasNestedSections) {
    for (const c of candidates) {
      if (c.isTopLevelPlacement) {
        deleteReasons.set(c.row.documentId, "misplaced_on_top_level_section");
      }
    }
  }

  // 2) Deduplicate by canonical location: section path + leaf index.
  const byCanonicalKey = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (deleteReasons.has(c.row.documentId)) continue;
    if (c.leafIndex == null) {
      // Non-numeric labels are preserved by default.
      keepIds.add(c.row.documentId);
      continue;
    }
    const key = `${c.sectionPathKey}:${c.leafIndex}`;
    if (!byCanonicalKey.has(key)) byCanonicalKey.set(key, []);
    byCanonicalKey.get(key)!.push(c);
  }

  for (const group of byCanonicalKey.values()) {
    const keeper = selectKeeper(group);
    keepIds.add(keeper.row.documentId);
    for (const c of group) {
      if (c.row.documentId !== keeper.row.documentId) {
        deleteReasons.set(c.row.documentId, "duplicate_for_same_section_leaf_index");
      }
    }
  }

  // 3) Keep any still-unclassified non-deleted rows.
  for (const c of candidates) {
    if (!deleteReasons.has(c.row.documentId)) keepIds.add(c.row.documentId);
  }

  const toDelete = candidates
    .filter((c) => deleteReasons.has(c.row.documentId))
    .map((c) => ({
      documentId: c.row.documentId,
      label: c.row.ShlokaManthraNumber ?? "",
      order: c.row.order ?? 0,
      reason: deleteReasons.get(c.row.documentId) ?? "non_canonical",
      path: c.sectionPath.map((s) => s.title?.trim() || "Section").join(" -> "),
    }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const keptRows = candidates
    .filter((c) => keepIds.has(c.row.documentId))
    .map((c) => c.row);

  // 4) Deterministic reorder plan for kept rows.
  const bySection = new Map<string, MantraRow[]>();
  for (const row of keptRows) {
    const sid = row.Section?.documentId;
    if (!sid) continue;
    if (!bySection.has(sid)) bySection.set(sid, []);
    bySection.get(sid)!.push(row);
  }
  const orderUpdates: Array<{ documentId: string; order: number; oldOrder: number }> = [];
  for (const rows of bySection.values()) {
    const sorted = [...rows].sort((a, b) => {
      const bySuf = compareSuffix(parseSuffix(a.ShlokaManthraNumber), parseSuffix(b.ShlokaManthraNumber));
      if (bySuf !== 0) return bySuf;
      return (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
    });
    for (let i = 0; i < sorted.length; i++) {
      const nextOrder = portalIndexToStrapiSortKey(i + 1);
      const oldOrder = typeof sorted[i].order === "number" ? sorted[i].order! : 0;
      if (oldOrder !== nextOrder) {
        orderUpdates.push({ documentId: sorted[i].documentId, order: nextOrder, oldOrder });
      }
    }
  }

  // 5) Validation checks over kept rows.
  const duplicateExactLabelInSection: Array<{ sectionId: string; label: string; count: number }> = [];
  for (const [sid, rows] of bySection.entries()) {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const label = (r.ShlokaManthraNumber ?? "").trim().toLowerCase();
      if (!label) continue;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    for (const [label, count] of counts.entries()) {
      if (count > 1) duplicateExactLabelInSection.push({ sectionId: sid, label, count });
    }
  }

  const report = {
    grantha: { name: grantha.GranthaName, documentId: granthaDocId },
    mode,
    totals: {
      sections: sections.length,
      manthrasBefore: manthras.length,
      manthrasKeep: keptRows.length,
      manthrasDelete: toDelete.length,
      orderUpdates: orderUpdates.length,
    },
    validations: {
      hasNestedSections,
      duplicateExactLabelInSectionCount: duplicateExactLabelInSection.length,
      duplicateExactLabelInSection,
    },
    deletePreview: toDelete.slice(0, 200),
    keepPreview: keptRows.slice(0, 60).map((m) => ({
      documentId: m.documentId,
      label: m.ShlokaManthraNumber ?? "",
      order: m.order ?? 0,
      section: m.Section?.title ?? "",
    })),
    orderUpdatePreview: orderUpdates.slice(0, 200),
  };

  log("migration.plan", report);

  if (!args.execute) {
    const outPath = join(process.cwd(), "tmp", `migration-plan-${granthaDocId}.json`);
    try {
      writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
      log("migration.plan.saved", { path: outPath });
    } catch {
      // no-op; dry-run still printed to stdout.
    }
    return;
  }

  // Execute mode: mutations in deterministic batches.
  // True cross-request DB transaction is not available through Strapi REST API;
  // this migration therefore uses a recorded plan + ordered batched mutations.
  const failures: Array<{ phase: string; documentId: string; error: string }> = [];

  // A) Delete non-canonical rows.
  for (let i = 0; i < toDelete.length; i += args.batchSize) {
    const batch = toDelete.slice(i, i + args.batchSize);
    for (const row of batch) {
      try {
        await strapiRequest(`/api/manthras/${row.documentId}`, { method: "DELETE" });
      } catch (e: any) {
        if (e?.status !== 404) {
          failures.push({
            phase: "delete",
            documentId: row.documentId,
            error: e?.message || String(e),
          });
        }
      }
    }
    log("migration.batch.delete", { processed: Math.min(i + args.batchSize, toDelete.length), total: toDelete.length });
  }

  // B) Rebuild deterministic ordering on survivors.
  for (let i = 0; i < orderUpdates.length; i += args.batchSize) {
    const batch = orderUpdates.slice(i, i + args.batchSize);
    for (const row of batch) {
      try {
        await strapiRequest(`/api/manthras/${row.documentId}`, {
          method: "PUT",
          body: JSON.stringify({ data: { order: row.order } }),
        });
      } catch (e: any) {
        failures.push({
          phase: "reorder",
          documentId: row.documentId,
          error: e?.message || String(e),
        });
      }
    }
    log("migration.batch.reorder", { processed: Math.min(i + args.batchSize, orderUpdates.length), total: orderUpdates.length });
  }

  log("migration.execute.result", {
    granthaDocId,
    deletedRequested: toDelete.length,
    reorderRequested: orderUpdates.length,
    failureCount: failures.length,
    failures: failures.slice(0, 50),
  });
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});

