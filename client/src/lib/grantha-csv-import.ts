/**
 * CSV → grantha import: parsing, row classification, and column→field mapping.
 *
 * Pulled out of `components/grantha-csv-import-dialog.tsx` so the whole import path can
 * be exercised without a browser — see `tests/grantha-csv-upload-e2e.test.mjs`, which
 * drives raw CSV text through these functions and `placeCsvCreates` to the tree the
 * editor would hold. The dialog keeps the state and the UI; the rules live here.
 */

import { textToBlocks } from "./strapi-blocks";
import type { TextAndTranslation } from "@shared/schema";
import type { CsvPlacement, PlacementTargetRef } from "./grantha-csv-placement";

// ── Structural mirrors of the grantha editor's tree node types ──
//    Deliberately minimal: structural typing keeps them compatible with the real
//    ManthraNode / AdhyayaNode in `pages/granthas.tsx` without importing that module.

export interface TeekaEntryShape {
  TeekaName: string;
  TeekaAuthor: string;
  teekaDocId?: string;
  TeekaEntry?: TextAndTranslation;
}
export interface ManthraNodeShape {
  id: string;
  title: string;
  order: number;
  strapiDocumentId?: string;
  ShlokaManthraEntry?: TextAndTranslation;
  BhashyamForShlokaManthra?: TextAndTranslation;
  Teekas?: TeekaEntryShape[];
}
export interface PadaNodeShape { id: string; title: string; manthras: ManthraNodeShape[]; }
export interface KhandaNodeShape {
  id: string;
  title: string;
  padas: PadaNodeShape[];
  manthras: ManthraNodeShape[];
}
export interface AdhyayaNodeShape { id: string; title: string; khandas: KhandaNodeShape[]; }

export interface TeekaDefShape { id: string; TeekaName: string; TeekaAuthor: string; }

export type ContentUpdates = {
  ShlokaManthraEntry?: TextAndTranslation;
  BhashyamForShlokaManthra?: TextAndTranslation;
  Teekas?: TeekaEntryShape[];
};

/** One verse located in the tree, flattened for matching/range selection. */
export interface FlatManthra {
  adhyayaId: string;
  khandaId: string;
  padaId?: string;
  manthraId: string;
  /** Verse number / label as shown in the editor (node.title). */
  label: string;
  node: ManthraNodeShape;
  /** Sequential position across the whole grantha (1-based). */
  ordinal: number;
}

/** Update payload for an existing verse. */
export interface GranthaCsvImportUpdate {
  adhyayaId: string;
  khandaId: string;
  padaId?: string;
  manthraId: string;
  updates: ContentUpdates;
}

/** Spec for a brand-new verse to be created from a CSV row. */
export interface GranthaCsvNewVerse {
  /** Verse number/label (becomes the new mantra's title / ShlokaManthraNumber). */
  number: string;
  updates: ContentUpdates;
}

export type GranthaCsvTargetRef = PlacementTargetRef;
export type GranthaCsvPlacement = CsvPlacement;

export interface GranthaCsvImportPayload {
  updates: GranthaCsvImportUpdate[];
  creates: GranthaCsvNewVerse[];
  placement: GranthaCsvPlacement | null;
}

export type Scope = "shloka" | "bhashyam" | string; // string = teeka id

export interface CoreTargetKey {
  key: string;
  label: string;
  scope: Scope;
  field: "SanskritTextEntry" | "IASTTransliteration" | "EnglishTranslationText";
}

export interface TranslationMapRow {
  id: string;
  scope: Scope;
  language: string;
  column: number | null;
}

// ── CSV parsing (RFC-4180-ish: quoted fields, escaped "", embedded newlines) ──

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/** Column index that looks like the verse-number column, or -1. */
export function guessNumberColumn(headers: readonly string[]): number {
  return headers.findIndex((h) => /(^|\b)(number|no\.?|verse|mantra|shloka|sloka|num)\b/i.test(h));
}

// ── Verse-number matching ──

export function normLabel(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}

/** Last numeric-ish token of a dotted/hyphenated label, e.g. "1.2.3" → "3". */
export function lastToken(s: string): string {
  const parts = normLabel(s).split(/[.\-/:|]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : normLabel(s);
}

/**
 * Section-aware numeric path of a label: all numeric groups joined by ".", ignoring
 * any prefix word. e.g. "Shloka 2.108" → "2.108", "Mantra 5" → "5", "1.2.3" → "1.2.3".
 * Used so a CSV number like "2.108" matches only verse "2.108" — never "1.108" in another
 * khanda that happens to share the trailing number.
 */
export function numPath(s: string): string {
  const nums = normLabel(s).match(/\d+/g);
  return nums ? nums.join(".") : normLabel(s);
}

export function flattenTree(adhyayas: readonly AdhyayaNodeShape[]): FlatManthra[] {
  const out: FlatManthra[] = [];
  let ordinal = 0;
  for (const a of adhyayas) {
    for (const k of a.khandas ?? []) {
      const push = (m: ManthraNodeShape, padaId?: string) => {
        ordinal++;
        out.push({
          adhyayaId: a.id, khandaId: k.id, padaId, manthraId: m.id,
          label: m.title ?? "", node: m, ordinal,
        });
      };
      if ((k.padas ?? []).length > 0) {
        for (const p of k.padas) for (const m of p.manthras ?? []) push(m, p.id);
      } else {
        for (const m of k.manthras ?? []) push(m);
      }
    }
  }
  return out;
}

/**
 * How many verses in the WHOLE grantha share each trailing token. A bare-number CSV
 * (e.g. "5") may only fall back to last-token matching when that token is unique —
 * otherwise "2.5" could wrongly match "1.5" in another khanda and be skipped as
 * "out of range" instead of created as a new verse.
 */
export function buildTokenCounts(flat: readonly FlatManthra[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of flat) {
    const t = lastToken(v.label);
    m.set(t, (m.get(t) ?? 0) + 1);
  }
  return m;
}

export type PlanRow = {
  rowIndex: number;
  rowNumber: string;
  action: "update" | "create" | "skip";
  target?: FlatManthra;
  reason?: string;
};

export interface PlanCsvRowsArgs {
  rows: readonly string[][];
  numberColumn: number | null;
  matchMode: "number" | "sequential";
  onMissing: "create" | "skip";
  /** Every verse in the grantha, in tree order. */
  flat: readonly FlatManthra[];
  /** Verses the user allowed this import to overwrite, in tree order. */
  rangeVerses: readonly FlatManthra[];
  rangeIds: ReadonlySet<string>;
  tokenCounts: ReadonlyMap<string, number>;
}

/** Classify each CSV data row: update an existing verse / create a new one / skip it. */
export function planCsvRows(args: PlanCsvRowsArgs): PlanRow[] {
  const { rows, numberColumn, matchMode, onMissing, flat, rangeVerses, rangeIds, tokenCounts } = args;
  const result: PlanRow[] = [];
  const consumed = new Set<string>();

  rows.forEach((row, rowIndex) => {
    if (matchMode === "sequential") {
      const target = rangeVerses[rowIndex];
      result.push({
        rowIndex,
        rowNumber: numberColumn != null ? (row[numberColumn] ?? "").trim() : `row ${rowIndex + 1}`,
        action: target ? "update" : "skip",
        target,
        reason: target ? undefined : "beyond range",
      });
      return;
    }

    const rawNum = numberColumn != null ? (row[numberColumn] ?? "").trim() : "";
    if (!rawNum) { result.push({ rowIndex, rowNumber: "(blank)", action: "skip", reason: "no number" }); return; }

    const want = normLabel(rawNum);
    const wantPath = numPath(rawNum);
    const wantTok = lastToken(rawNum);
    // A CSV number is "bare" when it's a single token (e.g. "5"), vs a dotted, section-
    // qualified number (e.g. "2.108"). A dotted number is authoritative: it must match
    // the SAME full path only ("2.108" ↦ "2.108", never "1.108" in another khanda).
    const bareNumber = wantPath === wantTok;
    // Match against the WHOLE grantha to decide exists-vs-create. Prefer an exact label
    // match, then a section-aware numeric-path match. Only fall back to the loose
    // trailing-token match for a BARE CSV number whose token is unique across the grantha —
    // so importing a new khanda whose verse numbers overlap another khanda's trailing
    // numbers creates new verses instead of skipping them as "out of range".
    const existing =
      flat.find((v) => !consumed.has(v.manthraId) && normLabel(v.label) === want) ??
      flat.find((v) => !consumed.has(v.manthraId) && numPath(v.label) === wantPath) ??
      (bareNumber && (tokenCounts.get(wantTok) ?? 0) === 1
        ? flat.find((v) => !consumed.has(v.manthraId) && lastToken(v.label) === wantTok)
        : undefined);

    if (existing) {
      consumed.add(existing.manthraId);
      if (rangeIds.has(existing.manthraId)) {
        result.push({ rowIndex, rowNumber: rawNum, action: "update", target: existing });
      } else {
        result.push({ rowIndex, rowNumber: rawNum, action: "skip", target: existing, reason: "out of range" });
      }
    } else if (onMissing === "create") {
      result.push({ rowIndex, rowNumber: rawNum, action: "create" });
    } else {
      result.push({ rowIndex, rowNumber: rawNum, action: "skip", reason: "no matching verse" });
    }
  });
  return result;
}

// ── Column → field mapping ──

/** The fields a CSV column can be mapped onto, for this grantha's teekas. */
export function buildCoreTargets(teekas: readonly TeekaDefShape[]): CoreTargetKey[] {
  const t: CoreTargetKey[] = [
    { key: "shloka.SanskritTextEntry", label: "Shloka — Sanskrit", scope: "shloka", field: "SanskritTextEntry" },
    { key: "shloka.IASTTransliteration", label: "Shloka — IAST", scope: "shloka", field: "IASTTransliteration" },
    { key: "shloka.EnglishTranslationText", label: "Shloka — English", scope: "shloka", field: "EnglishTranslationText" },
    { key: "bhashyam.SanskritTextEntry", label: "Bhashyam — Sanskrit", scope: "bhashyam", field: "SanskritTextEntry" },
    { key: "bhashyam.IASTTransliteration", label: "Bhashyam — IAST", scope: "bhashyam", field: "IASTTransliteration" },
    { key: "bhashyam.EnglishTranslationText", label: "Bhashyam — English", scope: "bhashyam", field: "EnglishTranslationText" },
  ];
  for (const tk of teekas) {
    const name = tk.TeekaName || tk.TeekaAuthor || "Teeka";
    t.push(
      { key: `${tk.id}.SanskritTextEntry`, label: `${name} (Teeka) — Sanskrit`, scope: tk.id, field: "SanskritTextEntry" },
      { key: `${tk.id}.EnglishTranslationText`, label: `${name} (Teeka) — English`, scope: tk.id, field: "EnglishTranslationText" },
    );
  }
  return t;
}

export function mergeOtherTranslations(
  existing: TextAndTranslation["OtherTranslations"],
  language: string,
  textBlocks: ReturnType<typeof textToBlocks>,
): NonNullable<TextAndTranslation["OtherTranslations"]> {
  const out = [...(existing ?? [])];
  const idx = out.findIndex((o) => (o.LanguageOfTranslation ?? "") === language);
  const entry = { LanguageOfTranslation: language, TranslationText: textBlocks as any };
  if (idx >= 0) out[idx] = { ...out[idx], ...entry };
  else out.push(entry);
  return out;
}

export interface FieldMapping {
  coreTargets: readonly CoreTargetKey[];
  /** Target key → CSV column index. */
  coreMapping: Readonly<Record<string, number | null>>;
  translationRows: readonly TranslationMapRow[];
  teekas: readonly TeekaDefShape[];
}

/** Build merged content for one row, starting from `base` (existing node content or empty). */
export function buildVerseContent(
  row: readonly string[],
  base: ManthraNodeShape | null,
  mapping: FieldMapping,
): ContentUpdates {
  const { coreTargets, coreMapping, translationRows, teekas } = mapping;
  const shloka: TextAndTranslation = { ...(base?.ShlokaManthraEntry ?? {}) };
  const bhashyam: TextAndTranslation = { ...(base?.BhashyamForShlokaManthra ?? {}) };
  const teekaAcc = new Map<string, TextAndTranslation>();
  let touchedShloka = false;
  let touchedBhashyam = false;
  const touchedTeekas = new Set<string>();

  const getTeekaEntry = (tid: string): TextAndTranslation => {
    if (!teekaAcc.has(tid)) {
      const def = teekas.find((t) => t.id === tid);
      const existing = (base?.Teekas ?? []).find(
        (t) =>
          (def?.id && def.id.length >= 20 && t.teekaDocId === def.id) ||
          (def?.TeekaName && t.TeekaName === def.TeekaName) ||
          (def?.TeekaAuthor && t.TeekaAuthor === def.TeekaAuthor),
      );
      teekaAcc.set(tid, { ...(existing?.TeekaEntry ?? {}) });
    }
    return teekaAcc.get(tid)!;
  };

  for (const tgt of coreTargets) {
    const col = coreMapping[tgt.key];
    if (col == null) continue;
    const cell = (row[col] ?? "").trim();
    if (!cell) continue;
    const blocks = textToBlocks(cell);
    if (tgt.scope === "shloka") { shloka[tgt.field] = blocks as any; touchedShloka = true; }
    else if (tgt.scope === "bhashyam") { bhashyam[tgt.field] = blocks as any; touchedBhashyam = true; }
    else { (getTeekaEntry(tgt.scope) as any)[tgt.field] = blocks; touchedTeekas.add(tgt.scope); }
  }

  for (const tr of translationRows) {
    if (tr.column == null || !tr.language) continue;
    const cell = (row[tr.column] ?? "").trim();
    if (!cell) continue;
    const blocks = textToBlocks(cell);
    if (tr.scope === "shloka") { shloka.OtherTranslations = mergeOtherTranslations(shloka.OtherTranslations, tr.language, blocks); touchedShloka = true; }
    else if (tr.scope === "bhashyam") { bhashyam.OtherTranslations = mergeOtherTranslations(bhashyam.OtherTranslations, tr.language, blocks); touchedBhashyam = true; }
    else { const e = getTeekaEntry(tr.scope); e.OtherTranslations = mergeOtherTranslations(e.OtherTranslations, tr.language, blocks); touchedTeekas.add(tr.scope); }
  }

  const updates: ContentUpdates = {};
  if (touchedShloka) updates.ShlokaManthraEntry = shloka;
  if (touchedBhashyam) updates.BhashyamForShlokaManthra = bhashyam;
  if (touchedTeekas.size > 0) {
    const nextTeekas: TeekaEntryShape[] = [...(base?.Teekas ?? [])];
    for (const tid of touchedTeekas) {
      const def = teekas.find((t) => t.id === tid);
      const entry = teekaAcc.get(tid)!;
      const docId = def && def.id.length >= 20 ? def.id : undefined;
      const idx = nextTeekas.findIndex(
        (t) =>
          (docId && t.teekaDocId === docId) ||
          (def?.TeekaName && t.TeekaName === def.TeekaName) ||
          (def?.TeekaAuthor && t.TeekaAuthor === def.TeekaAuthor),
      );
      const merged: TeekaEntryShape = {
        TeekaName: def?.TeekaName ?? (idx >= 0 ? nextTeekas[idx].TeekaName : ""),
        TeekaAuthor: def?.TeekaAuthor ?? (idx >= 0 ? nextTeekas[idx].TeekaAuthor : ""),
        teekaDocId: docId ?? (idx >= 0 ? nextTeekas[idx].teekaDocId : undefined),
        TeekaEntry: entry,
      };
      if (idx >= 0) nextTeekas[idx] = { ...nextTeekas[idx], ...merged };
      else nextTeekas.push(merged);
    }
    updates.Teekas = nextTeekas;
  }
  return updates;
}

/** Turn the classified rows + column mapping into the payload the editor applies. */
export function buildImportPayload(args: {
  plan: readonly PlanRow[];
  rows: readonly string[][];
  mapping: FieldMapping;
  placement: GranthaCsvPlacement | null;
}): GranthaCsvImportPayload {
  const { plan, rows, mapping, placement } = args;
  const updates: GranthaCsvImportUpdate[] = [];
  const creates: GranthaCsvNewVerse[] = [];

  for (const p of plan) {
    const row = rows[p.rowIndex];
    if (p.action === "update" && p.target) {
      const u = buildVerseContent(row, p.target.node, mapping);
      if (Object.keys(u).length === 0) continue;
      updates.push({
        adhyayaId: p.target.adhyayaId,
        khandaId: p.target.khandaId,
        padaId: p.target.padaId,
        manthraId: p.target.manthraId,
        updates: u,
      });
    } else if (p.action === "create") {
      const u = buildVerseContent(row, null, mapping);
      // Even with no mapped content, a create still makes the numbered verse.
      creates.push({ number: p.rowNumber, updates: u });
    }
  }

  return { updates, creates, placement: creates.length > 0 ? placement : null };
}
