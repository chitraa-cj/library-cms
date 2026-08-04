/**
 * Export an Excel workbook summarising every Upanishad in the library, the
 * bhāṣya + ṭīkā commentaries attached to each, and the translation status of
 * every individual component (mūla verse, bhāṣya, and each ṭīkākāra).
 *
 * Source of truth: the most recent local grantha backup snapshot (grantha_backups
 * in the portal Postgres) — the live Strapi instance is private and not reachable
 * from a dev machine. Pass --backup-id <N> to pick a specific snapshot (default:
 * the latest by created_at).
 *
 * Translation model (per manthra, per component — see shared/schema.ts
 * TextAndTranslation): SanskritTextEntry = source, IASTTransliteration =
 * transliteration, EnglishTranslationText = English, OtherTranslations[] = an
 * array of { LanguageOfTranslation, TranslationText, isAiTranslated }.
 *
 *   tsx script/export-upanishad-translation-status.ts
 *   tsx script/export-upanishad-translation-status.ts --backup-id 8 --out /tmp/upanishads.xlsx
 */
import { gunzipSync } from "node:zlib";
import * as path from "node:path";
import * as XLSX from "xlsx";

function parseArgs() {
  const a = process.argv.slice(2);
  const out: { backupId?: number; out?: string } = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--backup-id" && a[i + 1]) out.backupId = parseInt(a[++i], 10);
    else if (a[i] === "--out" && a[i + 1]) out.out = a[++i];
  }
  return out;
}

async function pickBackupId(explicit?: number): Promise<number> {
  if (explicit != null && !Number.isNaN(explicit)) return explicit;
  const { pool } = await import("../server/db.ts");
  const r = await pool.query("select id from grantha_backups order by created_at desc limit 1");
  if (!r.rows.length) throw new Error("No grantha_backups snapshots found in the local database");
  return r.rows[0].id;
}

async function loadBackup(id: number) {
  const { storage } = await import("../server/storage.ts");
  const row = await storage.getBackup(id);
  if (!row?.data) throw new Error(`Backup ${id} not found`);
  let raw: any = row.data;
  if (typeof raw === "string") raw = JSON.parse(raw);
  if (raw?._compressed && typeof raw.data === "string")
    raw = JSON.parse(gunzipSync(Buffer.from(raw.data, "base64")).toString("utf8"));
  if (raw?.data && raw.granthas === undefined && raw.data.granthas) raw = raw.data;
  return {
    label: row.label,
    createdAt: row.createdAt,
    granthas: raw.granthas ?? [],
    sections: raw.sections ?? [],
    manthras: raw.manthras ?? [],
  };
}

/** True if a Strapi rich-text / string field carries any non-whitespace text. */
function hasText(v: any): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.some(hasText);
  if (typeof v === "object") {
    if (typeof v.text === "string" && v.text.trim().length > 0) return true;
    if (v.children) return hasText(v.children);
  }
  return false;
}

/** Languages (from OtherTranslations[]) that actually carry text. */
function otherLangs(entry: any): { langs: string[]; ai: string[]; human: string[] } {
  const langs: string[] = [];
  const ai: string[] = [];
  const human: string[] = [];
  const arr = entry?.OtherTranslations;
  if (Array.isArray(arr)) {
    for (const t of arr) {
      if (!hasText(t?.TranslationText)) continue;
      const lang = String(t?.LanguageOfTranslation ?? "").trim();
      if (!lang) continue;
      langs.push(lang);
      if (t?.isAiTranslated) ai.push(lang);
      else human.push(lang);
    }
  }
  return { langs, ai, human };
}

type CompStats = {
  entries: number; // manthras where this component has Sanskrit source text
  iast: number;
  english: number;
  englishAi: number;
  withOther: number; // manthras with >=1 other-language translation
  otherLangUnion: Set<string>;
  otherAiUnion: Set<string>;
  otherHumanUnion: Set<string>;
};

function newStats(): CompStats {
  return { entries: 0, iast: 0, english: 0, englishAi: 0, withOther: 0, otherLangUnion: new Set(), otherAiUnion: new Set(), otherHumanUnion: new Set() };
}

/** Accumulate one TextAndTranslation entry into a component's stats. */
function accumulate(s: CompStats, entry: any, opts?: { englishAi?: boolean }) {
  if (!entry) return;
  const hasSrc = hasText(entry.SanskritTextEntry);
  const hasEng = hasText(entry.EnglishTranslationText);
  const { langs, ai, human } = otherLangs(entry);
  // "entries" = units that exist to be translated (have source text, or at least
  // some content). Fall back to English/other presence so we never undercount.
  if (hasSrc || hasEng || langs.length) s.entries++;
  if (hasText(entry.IASTTransliteration)) s.iast++;
  if (hasEng) {
    s.english++;
    if (opts?.englishAi) s.englishAi++;
  }
  if (langs.length) {
    s.withOther++;
    for (const l of langs) s.otherLangUnion.add(l);
    for (const l of ai) s.otherAiUnion.add(l);
    for (const l of human) s.otherHumanUnion.add(l);
  }
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

function statusLabel(s: CompStats): string {
  if (s.entries === 0) return "No content";
  if (s.english === 0 && s.otherLangUnion.size === 0) return "Not translated (source only)";
  if (s.english >= s.entries) return s.otherLangUnion.size ? "Complete (Eng + others)" : "English complete";
  if (s.english > 0) return "English partial";
  return "Other langs only";
}

async function main() {
  const args = parseArgs();
  const backupId = await pickBackupId(args.backupId);
  const snap = await loadBackup(backupId);
  console.log(`Using backup #${backupId} — "${snap.label}" (${snap.createdAt})`);
  console.log(`  ${snap.granthas.length} granthas, ${snap.sections.length} sections, ${snap.manthras.length} manthras`);

  // section documentId -> grantha documentId
  const secToGrantha = new Map<string, string>();
  for (const s of snap.sections) {
    if (s?.documentId && s?.grantha?.documentId) secToGrantha.set(s.documentId, s.grantha.documentId);
  }
  const granthaOf = (m: any): string | undefined =>
    m?.Section?.grantha?.documentId ?? (m?.Section?.documentId ? secToGrantha.get(m.Section.documentId) : undefined);

  // group manthras by grantha
  const manthrasByGrantha = new Map<string, any[]>();
  for (const m of snap.manthras) {
    const gid = granthaOf(m);
    if (!gid) continue;
    if (!manthrasByGrantha.has(gid)) manthrasByGrantha.set(gid, []);
    manthrasByGrantha.get(gid)!.push(m);
  }

  // count sections per grantha
  const sectionsByGrantha = new Map<string, number>();
  for (const s of snap.sections) {
    const gid = s?.grantha?.documentId;
    if (gid) sectionsByGrantha.set(gid, (sectionsByGrantha.get(gid) ?? 0) + 1);
  }

  // All restored granthas, grouped by type then name. GranthaType is carried as a
  // column so Upanishads / Prakarana Granthas / Brahma Sutra / Bhagavad Gita can be
  // filtered in the sheet.
  const granthas = [...snap.granthas].sort((a: any, b: any) => {
    const ta = String(a.GranthaType ?? "~"), tb = String(b.GranthaType ?? "~");
    return ta === tb ? String(a.GranthaName).localeCompare(String(b.GranthaName)) : ta.localeCompare(tb);
  });

  const summaryRows: any[] = [];
  const detailRows: any[] = [];

  for (const g of granthas) {
    const gid = g.documentId;
    const manthras = manthrasByGrantha.get(gid) ?? [];

    const shloka = newStats();
    const bhashya = newStats();
    // teeka key -> { name, author, stats }
    const teekas = new Map<string, { name: string; author: string; stats: CompStats }>();

    for (const m of manthras) {
      accumulate(shloka, m.ShlokaManthraEntry);
      accumulate(bhashya, m.BhashyamEntry);
      if (Array.isArray(m.Teekas)) {
        for (const t of m.Teekas) {
          const meta = t?.teeka ?? {};
          const key = String(meta.documentId ?? `${meta.TeekaAuthor ?? ""}|${meta.TeekaName ?? ""}`);
          if (!key.trim()) continue;
          if (!teekas.has(key))
            teekas.set(key, { name: String(meta.TeekaName ?? "").trim(), author: String(meta.TeekaAuthor ?? "").trim(), stats: newStats() });
          accumulate(teekas.get(key)!.stats, t.TeekaEntry);
        }
      }
    }

    const teekaList = [...teekas.values()].sort((a, b) => a.author.localeCompare(b.author));
    // Disambiguate repeated authors (e.g. two distinct ṭīkās by Anandagiri) by
    // appending the ṭīkā's own name.
    const authorCounts = new Map<string, number>();
    for (const t of teekaList) authorCounts.set(t.author, (authorCounts.get(t.author) ?? 0) + 1);
    const teekakarNames = teekaList
      .map((t) => {
        const base = t.author || t.name;
        if (!base) return "";
        return t.author && (authorCounts.get(t.author) ?? 0) > 1 && t.name ? `${t.author} (${t.name})` : base;
      })
      .filter(Boolean);

    // ---- Summary row (one per grantha) ----
    summaryRows.push({
      Grantha: g.GranthaName,
      Type: g.GranthaType || "—",
      "Bhāṣya (commentary)": g.BhashyamName || (bhashya.entries ? "(bhāṣya present)" : "—"),
      "Bhāṣyakāra (author)": g.BhashyamAuthor || "—",
      "Sections": sectionsByGrantha.get(gid) ?? 0,
      "Verses (mantras)": manthras.length,
      "# Ṭīkākāras": teekaList.length,
      "Ṭīkākāras": teekakarNames.join(", ") || "—",
      "Verse Eng %": pct(shloka.english, shloka.entries),
      "Bhāṣya entries": bhashya.entries,
      "Bhāṣya Eng %": pct(bhashya.english, bhashya.entries),
      "Other-language coverage (verse)": shloka.otherLangUnion.size,
      Published: g.publishedAt ? "Yes" : "No",
    });

    // ---- Detail rows (one per translatable component) ----
    const addDetail = (compType: string, name: string, author: string, s: CompStats, extraAi?: boolean) => {
      const aiSummary = s.otherAiUnion.size
        ? s.otherHumanUnion.size
          ? `Mixed (${s.otherAiUnion.size} AI / ${s.otherHumanUnion.size} human langs)`
          : "AI"
        : s.otherLangUnion.size
          ? "Human"
          : "—";
      detailRows.push({
        Grantha: g.GranthaName,
        Type: g.GranthaType || "—",
        Component: compType,
        "Name / Author": author ? (name ? `${author} — ${name}` : author) : name || "—",
        "Units (mantras)": s.entries,
        "IAST %": pct(s.iast, s.entries),
        "English translated": s.english,
        "English %": pct(s.english, s.entries),
        "Other langs (distinct)": s.otherLangUnion.size,
        "Mantras w/ other-lang": s.withOther,
        "AI vs human (other)": aiSummary,
        Status: statusLabel(s),
      });
    };

    addDetail("Mūla (verse)", "", "", shloka);
    addDetail("Bhāṣya", g.BhashyamName ?? "", g.BhashyamAuthor ?? "", bhashya);
    for (const t of teekaList) addDetail("Ṭīkā", t.name, t.author, t.stats);
  }

  // ---- Build workbook ----
  const wb = XLSX.utils.book_new();

  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  wsSummary["!cols"] = [
    { wch: 38 }, { wch: 18 }, { wch: 26 }, { wch: 22 }, { wch: 9 }, { wch: 14 }, { wch: 11 },
    { wch: 40 }, { wch: 11 }, { wch: 13 }, { wch: 12 }, { wch: 26 }, { wch: 10 },
  ];
  XLSX.utils.book_append_sheet(wb, wsSummary, "Granthas Summary");

  const wsDetail = XLSX.utils.json_to_sheet(detailRows);
  wsDetail["!cols"] = [
    { wch: 38 }, { wch: 18 }, { wch: 14 }, { wch: 34 }, { wch: 14 }, { wch: 9 }, { wch: 16 },
    { wch: 10 }, { wch: 18 }, { wch: 18 }, { wch: 28 }, { wch: 28 },
  ];
  XLSX.utils.book_append_sheet(wb, wsDetail, "Translation Status");

  // type breakdown for provenance
  const typeCounts = new Map<string, number>();
  for (const g of granthas) {
    const t = g.GranthaType || "(no type)";
    typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
  }
  const typeBreakdown = [...typeCounts.entries()].map(([t, n]) => `${t}: ${n}`).join(", ");

  // ---- About sheet: provenance ----
  const about = [
    { Field: "Report", Value: "Granthas — bhāṣya & ṭīkā translation status (Upanishads + Prakarana Granthas + Brahma Sutra + Bhagavad Gita)" },
    { Field: "Source", Value: `Local grantha backup snapshot #${backupId} ("${snap.label}")` },
    { Field: "Snapshot created", Value: String(snap.createdAt) },
    { Field: "Granthas found", Value: granthas.length },
    { Field: "Type breakdown", Value: typeBreakdown },
    { Field: "Note", Value: "Live Strapi is private/unreachable from dev; snapshot is the latest local copy." },
    { Field: "Units (mantras)", Value: '"Units" = mantras where a component has Sanskrit source, English, or other-lang text.' },
    { Field: "English %", Value: "share of units that have an EnglishTranslationText." },
    { Field: "Other langs", Value: "distinct languages in OtherTranslations[] that carry text (up to ~43 supported)." },
  ];
  const wsAbout = XLSX.utils.json_to_sheet(about);
  wsAbout["!cols"] = [{ wch: 22 }, { wch: 100 }];
  XLSX.utils.book_append_sheet(wb, wsAbout, "About");

  const outPath = args.out
    ? path.resolve(args.out)
    : path.resolve(process.cwd(), `Granthas-translation-status.xlsx`);
  XLSX.writeFile(wb, outPath);

  console.log(`\nWrote ${granthas.length} granthas (${typeBreakdown}) → ${detailRows.length} component rows`);
  console.log(`Excel file: ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FATAL:", e?.message ?? e);
    process.exit(1);
  });
