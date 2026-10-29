/**
 * OCR → Grantha structure: the contract, the assembler, the validator and the CSV writer.
 *
 * Why it all lives here (and not in the server or the dialog)
 * ----------------------------------------------------------
 * The model is asked for ONE thing only: label consecutive spans of the transcription
 * (see ocr-structure-lines.ts — it names line ranges and never writes the text; the
 * text is cut from the OCR output). Every relational decision —
 * which section a verse sits under, which verse a bhashyam belongs to, what the CSV
 * number has to be so the existing importer places it correctly — is made HERE, by
 * deterministic code that runs identically on the server, in the review UI and under
 * `tests/ocr-structure-*.test.mjs`. A model answer can therefore never invent a
 * hierarchy: it can only propose items, and this module decides what they mean.
 *
 *   model answer ──► StructureItem[]            (validated, text cut from the source lines)
 *        └─ applyStructureOverrides()           user edits + resolved ambiguities
 *             └─ assembleStructure()            sections, verses, attachments, warnings
 *                  └─ validateStructure()       blocking errors vs. acknowledgeable warnings
 *                       └─ buildStructureCsv()  exactly the columns the CSV importer maps
 *
 * The CSV it writes is the SAME format `client/src/lib/grantha-csv-import.ts` already
 * parses: one row per verse, a verse-number column whose leading tokens are the section
 * path (that is what `grantha-csv-placement.ts` reads), and one column per
 * scope × field that actually has content. Nothing new is invented; see
 * `tests/ocr-structure-csv.test.mjs`, which drives the generated CSV back through the
 * real importer and asserts the tree it produces.
 */

// ───────────────────────────────────────────────────────────── hierarchy config

/**
 * Hierarchy levels the CMS can express: three section levels (Adhyaya → Khanda → Pada
 * in the editor's own terms) plus the leaf entry. `depth` counts the leaf, so depth 4
 * means "three section levels and a verse", and depth 1 means "verses only".
 */
export const STRUCTURE_MAX_SECTION_LEVELS = 3;
export const STRUCTURE_MAX_DEPTH = STRUCTURE_MAX_SECTION_LEVELS + 1;

export interface StructureHierarchyConfig {
  /** 1…4 — number of levels INCLUDING the leaf (verse/mantra) level. */
  depth: number;
  /** Semantic name per level, length === depth; the last entry names the leaf. */
  levelNames: string[];
}

/** Section levels only (depth minus the leaf). */
export function sectionLevelCount(cfg: StructureHierarchyConfig): number {
  return Math.max(0, Math.min(STRUCTURE_MAX_SECTION_LEVELS, cfg.depth - 1));
}

export function leafLevelName(cfg: StructureHierarchyConfig): string {
  return cfg.levelNames[cfg.depth - 1]?.trim() || "Mantra";
}

export function sectionLevelNames(cfg: StructureHierarchyConfig): string[] {
  return cfg.levelNames.slice(0, sectionLevelCount(cfg)).map((n) => n.trim());
}

export function normalizeHierarchyConfig(input: unknown): StructureHierarchyConfig {
  const raw = (input ?? {}) as Partial<StructureHierarchyConfig>;
  const depth = Math.max(1, Math.min(STRUCTURE_MAX_DEPTH, Math.floor(Number(raw.depth) || 0) || 2));
  const names = Array.isArray(raw.levelNames) ? raw.levelNames.map((n) => String(n ?? "").trim()) : [];
  const fallback = ["Adhyaya", "Khanda", "Pada", "Mantra"];
  const levelNames: string[] = [];
  for (let i = 0; i < depth; i++) {
    // The leaf keeps its own default; section levels fall back positionally.
    const fb = i === depth - 1 ? "Mantra" : fallback[i] ?? `Level ${i + 1}`;
    levelNames.push(names[i] || fb);
  }
  return { depth, levelNames };
}

/**
 * Two level names that differ only by case/whitespace make the portal's structure step
 * open on its duplicate-heading warning, so the wizard blocks it up front.
 */
export function duplicateLevelNames(cfg: StructureHierarchyConfig): string[] {
  const seen = new Map<string, number>();
  for (const name of cfg.levelNames) {
    const key = name.trim().toLowerCase();
    if (!key) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
}

// ──────────────────────────────────────────────────────────────── page window

/** A page window the editor asked for; either bound may be left open. */
export interface StructurePageWindow {
  from?: number | null;
  to?: number | null;
}

export interface ResolvedStructurePageWindow {
  /** The pages inside the window, in order. */
  pages: Array<{ page: number; markdown: string }>;
  /** The window actually applied, clamped to the pages that exist. Null = everything. */
  window: { from: number; to: number } | null;
  /** First and last transcribed page of the whole document, for the UI's bounds. */
  availableFrom: number;
  availableTo: number;
  /** Transcribed pages in the whole document. */
  availableCount: number;
}

/**
 * Cut the transcription down to the pages the editor chose.
 *
 * A window is a scope decision, not a filter applied later: only these pages are planned
 * into ranges and only they are sent to the model — which is what makes "analyse pages
 * 40–90 of this 900-page scan" take what those fifty pages take.
 * Bounds are inclusive, either may be omitted, they are accepted in either order, and
 * they are clamped to the pages that actually have a transcription (so "1–100" on a
 * document whose OCR stopped at page 60 analyses 60 pages rather than failing).
 *
 * Pure, and here with the rest of the pure logic, so the server, the estimate and the
 * tests all resolve a window the same way.
 */
export function selectPageWindow(
  pages: readonly { page: number; markdown: string }[],
  requested?: StructurePageWindow | null,
): ResolvedStructurePageWindow {
  const ordered = [...pages].sort((a, b) => a.page - b.page);
  const availableFrom = ordered[0]?.page ?? 0;
  const availableTo = ordered[ordered.length - 1]?.page ?? 0;
  const base = {
    availableFrom,
    availableTo,
    availableCount: ordered.length,
  };

  const asPage = (value: unknown): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : null;
  };
  let from = asPage(requested?.from);
  let to = asPage(requested?.to);
  if (from != null && to != null && from > to) [from, to] = [to, from];
  if (from == null && to == null) return { ...base, pages: ordered, window: null };

  const lower = from ?? availableFrom;
  const upper = to ?? availableTo;
  const selected = ordered.filter((p) => p.page >= lower && p.page <= upper);
  // A window that happens to cover the whole document is not a window: recording it as
  // one would make the review claim a scope the editor never chose.
  const coversEverything =
    selected.length === ordered.length && lower <= availableFrom && upper >= availableTo;
  return {
    ...base,
    pages: selected,
    window: coversEverything
      ? null
      : { from: selected[0]?.page ?? lower, to: selected[selected.length - 1]?.page ?? upper },
  };
}

// ────────────────────────────────────────────────────────────── chunk planning

export interface StructureChunkRange {
  startPage: number;
  endPage: number;
}

/**
 * Group transcribed pages into contiguous, gapless ranges of at most `pagesPerChunk`
 * pages and `maxChars` characters. A single page over the character cap gets a range of
 * its own rather than being split mid-text — a cut inside a verse is worse than a long
 * request, and a range that still overflows fails with an actionable message.
 *
 * Lives here, with the rest of the pure logic, so the plan can be tested without a
 * database (`tests/ocr-structure-contract.test.mjs`).
 */
export function planStructureChunks(
  pages: readonly { page: number; markdown: string }[],
  opts: { pagesPerChunk: number; maxChars: number },
): StructureChunkRange[] {
  const ranges: StructureChunkRange[] = [];
  let current: { startPage: number; endPage: number; chars: number } | null = null;

  for (const page of pages) {
    const size = page.markdown.length;
    const wouldOverflow =
      current != null &&
      (current.endPage - current.startPage + 1 >= opts.pagesPerChunk ||
        current.chars + size > opts.maxChars ||
        page.page !== current.endPage + 1);
    if (!current || wouldOverflow) {
      if (current) ranges.push({ startPage: current.startPage, endPage: current.endPage });
      current = { startPage: page.page, endPage: page.page, chars: size };
      continue;
    }
    current.endPage = page.page;
    current.chars += size;
  }
  if (current) ranges.push({ startPage: current.startPage, endPage: current.endPage });
  return ranges;
}

// ─────────────────────────────────────────────────────────── the model's answer

/**
 * Content kinds the model may return. Every one of them maps onto something the CMS
 * actually stores (see `assembleStructure`), except `prose`/`footnote`/`ignored`, which
 * are parked as unassigned and surfaced for review rather than silently dropped.
 */
export const STRUCTURE_ITEM_KINDS = [
  "section",
  "verse",
  "bhashyam",
  "teeka",
  "translation",
  "prose",
  "footnote",
  "ignored",
] as const;
export type StructureItemKind = (typeof STRUCTURE_ITEM_KINDS)[number];

/** Which of a `shared.text-and-translation` component's fields the text belongs in. */
export const STRUCTURE_SCRIPTS = ["devanagari", "iast", "english", "other"] as const;
export type StructureScript = (typeof STRUCTURE_SCRIPTS)[number];

export const STRUCTURE_ATTACHMENTS = ["previous_verse", "section"] as const;
export type StructureAttachment = (typeof STRUCTURE_ATTACHMENTS)[number];

export interface StructureItem {
  /** Stable within a job: `c<chunkIndex>-<n>`, assigned by the server, never by the model. */
  id: string;
  kind: StructureItemKind;
  /** `section` only: 1-based hierarchy level. */
  level?: number;
  /** Section number or verse number exactly as printed ("2", "108", "1.2", "Mangala"). */
  number?: string;
  /** Section heading text as printed. */
  title?: string;
  /** Content items: the source text, verbatim. */
  text?: string;
  script?: StructureScript;
  /** `teeka` only: the commentary's name as printed. */
  teekaName?: string;
  /** `translation` only: the language of the translation. */
  language?: string;
  attachTo?: StructureAttachment;
  /** 1-based page in the OCR document this item came from. */
  page: number;
  /** The model's own confidence, 0…1. Never trusted on its own — see `itemRisk`. */
  confidence: number;
  note?: string;
  /** Set when a user edit changed this item; the AI's original text is kept alongside. */
  edited?: boolean;
  originalText?: string;
  /**
   * Provenance, set by `resolveLineAnswer` (absent on items from before it existed):
   * the inclusive span of numbered source lines this item's text was cut from, and
   * whether its number / commentary name was found printed in the source or only
   * inferred by the model. `user` is never set here — user edits are `edited`.
   */
  sourceLines?: [number, number];
  numberSource?: "printed" | "inferred";
  teekaNameSource?: "printed" | "known" | "instructions" | "inferred";
  /** True for source lines the model left unclassified, kept so no text is ever dropped. */
  unclassified?: boolean;
}

/** What one model answer for one page range resolves to, before ids are assigned. */
export interface StructureChunkAnswer {
  items: Array<Omit<StructureItem, "id" | "edited" | "originalText">>;
  /** Free-text observations (suspicious numbering, illegible passages, …). */
  warnings: string[];
  /** The section path still open at the end of the range, so the next range continues it. */
  openPath?: Array<{ level: number; number: string; title: string }>;
}

export class StructureAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructureAnswerError";
  }
}

function asTrimmedString(value: unknown, max = 100_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+$/u, "");
  if (!trimmed.trim()) return undefined;
  return trimmed.slice(0, max);
}

/**
 * Validate one model answer and hand back items with stable ids.
 *
 * Throws `StructureAnswerError` for anything a retry could fix (truncated JSON, a
 * missing `items` array). Individual malformed items are dropped into `rejected`
 * instead of failing the whole range: losing one item to a bad enum must not cost the
 * other ninety, and the count is reported so the range can be re-run deliberately.
 */
export function parseStructureChunkAnswer(
  raw: string,
  ctx: { chunkIndex: number; startPage: number; endPage: number },
): { items: StructureItem[]; warnings: string[]; rejected: number; openPath: StructureChunkAnswer["openPath"] } {
  const text = String(raw ?? "").trim();
  if (!text) throw new StructureAnswerError("The model returned an empty answer.");

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A schema-constrained answer should never need this, but a truncated stream does
    // land here — recovering the outermost object keeps a long range from being lost.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new StructureAnswerError("The model answer is not JSON (it may have been truncated).");
    }
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new StructureAnswerError("The model answer is truncated or malformed JSON.");
    }
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) {
    throw new StructureAnswerError('The model answer has no "items" array.');
  }

  const items: StructureItem[] = [];
  let rejected = 0;
  let seq = 0;

  for (const entry of parsed.items) {
    if (!entry || typeof entry !== "object") {
      rejected++;
      continue;
    }
    const kind = STRUCTURE_ITEM_KINDS.includes(entry.kind) ? (entry.kind as StructureItemKind) : null;
    if (!kind) {
      rejected++;
      continue;
    }

    const page = Math.round(Number(entry.page));
    const item: StructureItem = {
      // Assigned on acceptance, so the ids are dense and reproducible for a given
      // answer — a rejected item must not consume one.
      id: "",
      kind,
      page:
        Number.isFinite(page) && page >= ctx.startPage && page <= ctx.endPage
          ? page
          : ctx.startPage,
      confidence: (() => {
        const c = Number(entry.confidence);
        return Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0.5;
      })(),
    };

    const number = asTrimmedString(entry.number, 120);
    const title = asTrimmedString(entry.title, 500);
    const body = asTrimmedString(entry.text);
    const note = asTrimmedString(entry.note, 500);
    if (number) item.number = number;
    if (title) item.title = title;
    if (body) item.text = body;
    if (note) item.note = note;
    if (STRUCTURE_SCRIPTS.includes(entry.script)) item.script = entry.script;
    if (STRUCTURE_ATTACHMENTS.includes(entry.attachTo)) item.attachTo = entry.attachTo;
    const teekaName = asTrimmedString(entry.teekaName, 200);
    if (teekaName) item.teekaName = teekaName;
    const language = asTrimmedString(entry.language, 60);
    if (language) item.language = language;

    if (kind === "section") {
      const level = Math.round(Number(entry.level));
      if (!Number.isFinite(level) || level < 1 || level > STRUCTURE_MAX_SECTION_LEVELS) {
        rejected++;
        continue;
      }
      item.level = level;
      if (!item.number && !item.title) {
        rejected++;
        continue;
      }
    } else if (kind !== "ignored" && !item.text) {
      // A content item with no text carries nothing; keeping it would only produce an
      // empty CMS field.
      rejected++;
      continue;
    }

    item.id = `c${ctx.chunkIndex}-${seq++}`;
    items.push(item);
  }

  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.map((w: unknown) => String(w ?? "").slice(0, 500)).filter(Boolean).slice(0, 50)
    : [];

  const openPath = Array.isArray(parsed.openPath)
    ? parsed.openPath
        .filter((p: any) => p && Number.isFinite(Number(p.level)))
        .map((p: any) => ({
          level: Math.min(STRUCTURE_MAX_SECTION_LEVELS, Math.max(1, Math.round(Number(p.level)))),
          number: String(p.number ?? "").slice(0, 120),
          title: String(p.title ?? "").slice(0, 500),
        }))
        .slice(0, STRUCTURE_MAX_SECTION_LEVELS)
    : undefined;

  return { items, warnings, rejected, openPath };
}

// ────────────────────────────────────────────────────────── user edits (overrides)

export type StructureOverride =
  | {
      op: "edit";
      id: string;
      patch: Partial<
        Pick<
          StructureItem,
          "kind" | "level" | "number" | "title" | "text" | "script" | "teekaName" | "language" | "attachTo"
        >
      >;
    }
  | { op: "delete"; id: string }
  /** Cut one item in two at a character offset — the "split block" review action. */
  | { op: "split"; id: string; at: number }
  /** Fold an item into the preceding item of the same kind — "merge block". */
  | { op: "merge"; id: string }
  /** Reorder: move `id` to sit directly after `after` (or to the front when null). */
  | { op: "move"; id: string; after: string | null };

function cloneItem(item: StructureItem): StructureItem {
  return { ...item };
}

/**
 * Apply the review's edits to the AI's items, in order, and return a new list.
 *
 * Every edit records `edited: true` and keeps `originalText`, so the review UI (and the
 * export) can always tell an AI proposal from a human-approved correction. Unknown ids
 * are ignored rather than thrown: a stale resolution from a re-run must not wedge a job.
 */
export function applyStructureOverrides(
  items: readonly StructureItem[],
  overrides: readonly StructureOverride[] = [],
): StructureItem[] {
  const list = items.map(cloneItem);

  for (const override of overrides) {
    const index = list.findIndex((i) => i.id === override.id);
    if (index < 0) continue;

    if (override.op === "delete") {
      list.splice(index, 1);
      continue;
    }

    if (override.op === "edit") {
      const current = list[index];
      const next: StructureItem = { ...current, ...override.patch, edited: true };
      if (override.patch.text != null && current.originalText == null) {
        next.originalText = current.text ?? "";
      }
      if (next.kind !== "section") delete next.level;
      if (next.kind !== "teeka") delete next.teekaName;
      if (next.kind !== "translation") delete next.language;
      list[index] = next;
      continue;
    }

    if (override.op === "split") {
      const current = list[index];
      const text = current.text ?? "";
      const at = Math.max(1, Math.min(text.length - 1, Math.round(override.at)));
      if (!text || at <= 0 || at >= text.length) continue;
      const head: StructureItem = {
        ...current,
        text: text.slice(0, at).replace(/\s+$/u, ""),
        edited: true,
        originalText: current.originalText ?? text,
      };
      const tail: StructureItem = {
        ...current,
        id: `${current.id}+${at}`,
        text: text.slice(at).replace(/^\s+/u, ""),
        edited: true,
        originalText: current.originalText ?? text,
      };
      list.splice(index, 1, head, tail);
      continue;
    }

    if (override.op === "merge") {
      const current = list[index];
      const prev = index > 0 ? list[index - 1] : null;
      if (!prev || prev.kind !== current.kind) continue;
      list.splice(index - 1, 2, {
        ...prev,
        text: [prev.text ?? "", current.text ?? ""].filter(Boolean).join("\n"),
        edited: true,
        originalText: prev.originalText ?? prev.text ?? "",
      });
      continue;
    }

    if (override.op === "move") {
      const [moved] = list.splice(index, 1);
      if (override.after == null) {
        list.unshift(moved);
      } else {
        const target = list.findIndex((i) => i.id === override.after);
        list.splice(target < 0 ? list.length : target + 1, 0, moved);
      }
    }
  }

  return list;
}

// ──────────────────────────────────────────────────────────────────── assembly

/** One `shared.text-and-translation` component's worth of text, as plain strings. */
export interface StructureFieldSet {
  sanskrit?: string;
  iast?: string;
  english?: string;
  /** `OtherTranslations` — one entry per language. */
  others: Array<{ language: string; text: string }>;
  /** Item ids that contributed, for the review overlay's selection highlight. */
  itemIds: string[];
  /** True once any contributing item was edited by a human. */
  edited: boolean;
}

export interface StructureTeekaEntry extends StructureFieldSet {
  teekaName: string;
}

export interface AssembledVerse {
  /** Unique within the document: the section path plus the verse number. */
  key: string;
  /** Section numbers, one per configured section level. */
  path: string[];
  /** Section titles as printed, one per configured section level. */
  pathTitles: string[];
  /** Verse number exactly as printed. */
  number: string;
  /** What goes in the CSV's number column — the importer reads its leading tokens. */
  csvNumber: string;
  page: number;
  shloka: StructureFieldSet;
  bhashyam: StructureFieldSet;
  teekas: StructureTeekaEntry[];
  /** 0…1, the weakest link among the items that built this verse. */
  confidence: number;
  itemIds: string[];
  warnings: string[];
}

export interface AssembledSection {
  level: number;
  number: string;
  title: string;
  path: string[];
  itemId: string;
  page: number;
  confidence: number;
}

export interface StructureAmbiguity {
  id: string;
  question: string;
  /** Why the system could not settle it — shown next to the question. */
  evidence: string;
  itemIds: string[];
  page: number;
  options: Array<{
    id: string;
    label: string;
    recommended?: boolean;
    /** Picking the option appends exactly these edits. One code path for every answer. */
    apply: StructureOverride[];
  }>;
}

export interface AssembledStructure {
  config: StructureHierarchyConfig;
  sections: AssembledSection[];
  verses: AssembledVerse[];
  /** Items that belong to no verse (prose, footnotes, orphaned commentary). */
  unassigned: Array<{ item: StructureItem; reason: string }>;
  ambiguities: StructureAmbiguity[];
  warnings: string[];
  /** Teeka names seen in the document, in first-seen order. */
  teekaNames: string[];
  /** Languages seen on `translation` items, in first-seen order. */
  languages: string[];
  stats: {
    items: number;
    sections: number;
    verses: number;
    unassigned: number;
    lowConfidence: number;
    edited: number;
  };
}

/** Digit groups of a printed number: "Shloka 1.42" → ["1","42"]. */
export function numberTokensOf(value: string | undefined): string[] {
  return (value ?? "").match(/\d+/g) ?? [];
}

/** The verse's own number, stripped of any section prefix the page printed with it. */
function verseTail(number: string | undefined): string {
  const tokens = numberTokensOf(number);
  if (tokens.length > 0) return tokens[tokens.length - 1];
  return (number ?? "").trim();
}

function emptyFieldSet(): StructureFieldSet {
  return { others: [], itemIds: [], edited: false };
}

function fieldSetIsEmpty(set: StructureFieldSet): boolean {
  return !set.sanskrit && !set.iast && !set.english && set.others.length === 0;
}

/** Devanagari/other scripts default to the Sanskrit field; English to the English one. */
function scriptField(item: StructureItem): "sanskrit" | "iast" | "english" {
  switch (item.script) {
    case "iast":
      return "iast";
    case "english":
      return "english";
    case "devanagari":
    case "other":
    default:
      return "sanskrit";
  }
}

function addText(set: StructureFieldSet, item: StructureItem): void {
  const text = item.text ?? "";
  if (!text.trim()) return;
  set.itemIds.push(item.id);
  if (item.edited) set.edited = true;

  if (item.kind === "translation") {
    const language = (item.language ?? "").trim();
    if (!language || /^english$/i.test(language)) {
      set.english = set.english ? `${set.english}\n${text}` : text;
      return;
    }
    if (/^sanskrit$/i.test(language)) {
      set.sanskrit = set.sanskrit ? `${set.sanskrit}\n${text}` : text;
      return;
    }
    const existing = set.others.find((o) => o.language.toLowerCase() === language.toLowerCase());
    if (existing) existing.text = `${existing.text}\n${text}`;
    else set.others.push({ language, text });
    return;
  }

  const field = scriptField(item);
  set[field] = set[field] ? `${set[field]}\n${text}` : text;
}

/**
 * Fold the classified items into sections and verses.
 *
 * The rules, all of them local and inspectable:
 *   - a `section` item at level L sets the path at L and clears every deeper level;
 *   - a `verse` opens a new verse under the current path;
 *   - `bhashyam` / `teeka` / `translation` attach to the open verse unless the item asks
 *     for `section` (then they are parked as unassigned with a reason);
 *   - a content item arriving before any verse is parked, never guessed onto one;
 *   - `prose` / `footnote` / `ignored` are always parked — the CMS has no field for them
 *     on a mantra, and inventing one is exactly what this module must not do.
 */
export function assembleStructure(
  items: readonly StructureItem[],
  config: StructureHierarchyConfig,
  opts: { confidenceThreshold?: number } = {},
): AssembledStructure {
  const cfg = normalizeHierarchyConfig(config);
  const levels = sectionLevelCount(cfg);
  const threshold = opts.confidenceThreshold ?? 0.7;

  const sections: AssembledSection[] = [];
  const verses: AssembledVerse[] = [];
  const unassigned: AssembledStructure["unassigned"] = [];
  const ambiguities: StructureAmbiguity[] = [];
  const warnings: string[] = [];
  const teekaNames: string[] = [];
  const languages: string[] = [];

  /** Current section path: numbers and titles per level (index 0 = level 1). */
  const path: string[] = [];
  const pathTitles: string[] = [];
  let openVerse: AssembledVerse | null = null;
  let lastSectionLevel = 0;
  let edited = 0;
  let lowConfidence = 0;

  const pathForDepth = (): string[] => {
    const out: string[] = [];
    for (let i = 0; i < levels; i++) out.push(path[i] ?? "1");
    return out;
  };
  const titlesForDepth = (): string[] => {
    const out: string[] = [];
    for (let i = 0; i < levels; i++) out.push(pathTitles[i] ?? "");
    return out;
  };

  const park = (item: StructureItem, reason: string) => {
    unassigned.push({ item, reason });
  };

  for (const item of items) {
    if (item.edited) edited++;
    if (item.confidence < threshold) lowConfidence++;

    if (item.kind === "ignored") continue;

    if (item.kind === "section") {
      const level = Math.min(Math.max(1, item.level ?? 1), STRUCTURE_MAX_SECTION_LEVELS);
      if (level > levels) {
        // The document has a heading deeper than the configured hierarchy can hold.
        // Treated as content of the current section rather than reshaping the config.
        park(item, `Heading at level ${level}, but the hierarchy has ${levels} section level(s).`);
        ambiguities.push({
          id: `deep-section:${item.id}`,
          question: `"${item.title || item.number || "This heading"}" looks like a level-${level} heading, but the hierarchy only has ${levels} section level(s). What is it?`,
          evidence: `Page ${item.page}. Configured levels: ${sectionLevelNames(cfg).join(" › ") || "(none)"}.`,
          itemIds: [item.id],
          page: item.page,
          options: [
            {
              id: "as-level-last",
              label: `Treat it as a level-${levels} ${sectionLevelNames(cfg)[levels - 1] ?? "section"} heading`,
              recommended: levels > 0,
              apply: [{ op: "edit", id: item.id, patch: { kind: "section", level: Math.max(1, levels) } }],
            },
            {
              id: "as-prose",
              label: "It is ordinary text, not a heading",
              apply: [{ op: "edit", id: item.id, patch: { kind: "prose", text: item.title || item.number } }],
            },
            { id: "drop", label: "Leave it out of the import", apply: [{ op: "delete", id: item.id }] },
          ],
        });
        continue;
      }

      const number = verseTail(item.number) || String((path[level - 1] ? Number(path[level - 1]) + 1 : 1));
      if (!numberTokensOf(item.number).length) {
        warnings.push(
          `Page ${item.page}: heading "${item.title || "(untitled)"}" has no printed number — numbered ${number} from its position.`,
        );
      }
      if (level > lastSectionLevel + 1 && lastSectionLevel > 0) {
        warnings.push(
          `Page ${item.page}: hierarchy jumps from level ${lastSectionLevel} to level ${level} at "${item.title || number}".`,
        );
      }

      path[level - 1] = number;
      pathTitles[level - 1] = item.title ?? "";
      for (let i = level; i < path.length; i++) {
        path[i] = "";
        pathTitles[i] = "";
      }
      lastSectionLevel = level;
      openVerse = null;
      sections.push({
        level,
        number,
        title: item.title ?? "",
        path: pathForDepth(),
        itemId: item.id,
        page: item.page,
        confidence: item.confidence,
      });
      continue;
    }

    if (item.kind === "verse") {
      const printed = item.number ?? "";
      const tail = verseTail(printed);

      // The same entry printed twice — Devanagari and then its IAST transliteration, or
      // the text and then its English rendering — arrives as two `verse` items carrying
      // the same number. That is one entry with two fields filled, not two entries, so
      // it is folded into the open one WHEN the field it wants is still free. If the
      // field is already taken, the book really did repeat a number in the same script:
      // a new entry is created and the duplicate-number check reports it, which is a
      // reviewable outcome rather than a silent concatenation of two different verses.
      if (openVerse && tail && verseTail(openVerse.number) === tail) {
        const field = scriptField(item);
        if (!openVerse.shloka[field]) {
          addText(openVerse.shloka, item);
          openVerse.itemIds.push(item.id);
          openVerse.confidence = Math.min(openVerse.confidence, item.confidence);
          continue;
        }
        openVerse.warnings.push(
          `Page ${item.page}: a second passage is numbered ${printed} in the same script. If it is a continuation, merge the two blocks in the review.`,
        );
      }
      const sectionPath = pathForDepth();
      // With no number of its own there is nothing to append: the section path alone
      // ("1.") would address the section's first entry, which is a different verse. The
      // label is kept as printed so the validator can block it and the review can fix it.
      const csvNumber = tail
        ? levels > 0
          ? [...sectionPath, tail].join(".")
          : tail
        : printed.trim();
      const verse: AssembledVerse = {
        key: `${sectionPath.join(".")}#${tail || printed || item.id}`,
        path: sectionPath,
        pathTitles: titlesForDepth(),
        number: printed || tail,
        csvNumber,
        page: item.page,
        shloka: emptyFieldSet(),
        bhashyam: emptyFieldSet(),
        teekas: [],
        confidence: item.confidence,
        itemIds: [item.id],
        warnings: [],
      };
      addText(verse.shloka, item);
      if (!tail) {
        verse.warnings.push("No verse number was printed for this entry.");
        ambiguities.push({
          id: `verse-number:${item.id}`,
          question: "This entry has no printed number. How should it be numbered?",
          evidence: `Page ${item.page}. Text begins: "${(item.text ?? "").slice(0, 80)}…"`,
          itemIds: [item.id],
          page: item.page,
          options: [
            {
              id: "sequential",
              label: `Number it ${verses.filter((v) => v.path.join(".") === sectionPath.join(".")).length + 1} (next in this section)`,
              recommended: true,
              apply: [
                {
                  op: "edit",
                  id: item.id,
                  patch: {
                    number: String(
                      verses.filter((v) => v.path.join(".") === sectionPath.join(".")).length + 1,
                    ),
                  },
                },
              ],
            },
            {
              id: "to-previous",
              label: "It is a continuation of the previous entry",
              apply: [{ op: "merge", id: item.id }],
            },
            { id: "drop", label: "Leave it out of the import", apply: [{ op: "delete", id: item.id }] },
          ],
        });
      }
      if (levels > 0 && Array.from({ length: levels }, (_, i) => path[i]).some((p) => !p)) {
        verse.warnings.push(
          "This entry sits above the first heading of the document; it was placed in section 1.",
        );
      }
      verses.push(verse);
      openVerse = verse;
      continue;
    }

    // ── associated content: bhashyam / teeka / translation ──
    if (item.kind === "bhashyam" || item.kind === "teeka" || item.kind === "translation") {
      if (item.attachTo === "section" || !openVerse) {
        park(
          item,
          openVerse
            ? "Marked as belonging to the section rather than to a verse; the CMS stores commentary on a verse."
            : "Arrived before any numbered entry, so there is no verse to attach it to.",
        );
        if (!openVerse) {
          ambiguities.push({
            id: `orphan-content:${item.id}`,
            question: `This ${item.kind} appears before the first numbered entry. Where does it belong?`,
            evidence: `Page ${item.page}. Text begins: "${(item.text ?? "").slice(0, 80)}…"`,
            itemIds: [item.id],
            page: item.page,
            options: [
              {
                id: "own-verse",
                label: "Treat it as its own numbered entry",
                apply: [{ op: "edit", id: item.id, patch: { kind: "verse" } }],
              },
              {
                id: "drop",
                label: "Leave it out of the import (front matter)",
                recommended: true,
                apply: [{ op: "delete", id: item.id }],
              },
            ],
          });
        }
        continue;
      }

      openVerse.itemIds.push(item.id);
      openVerse.confidence = Math.min(openVerse.confidence, item.confidence);

      if (item.kind === "bhashyam") {
        addText(openVerse.bhashyam, item);
      } else if (item.kind === "teeka") {
        const name = (item.teekaName ?? "").trim() || "Teeka";
        if (!teekaNames.includes(name)) teekaNames.push(name);
        let entry = openVerse.teekas.find((t) => t.teekaName.toLowerCase() === name.toLowerCase());
        if (!entry) {
          entry = { teekaName: name, ...emptyFieldSet() };
          openVerse.teekas.push(entry);
        }
        addText(entry, item);
      } else {
        const language = (item.language ?? "").trim();
        if (language && !languages.includes(language)) languages.push(language);
        addText(openVerse.shloka, item);
      }
      continue;
    }

    // prose / footnote — real text the CMS has no mantra field for.
    park(
      item,
      item.kind === "footnote"
        ? "Footnote text; the CMS has no footnote field on a verse."
        : "Prose that is neither a heading nor a numbered entry.",
    );
  }

  // Duplicate CSV numbers are fatal downstream (the portal renumbers the odd one out
  // straight onto its neighbour), so they are raised here, before anything is written.
  const byCsvNumber = new Map<string, AssembledVerse[]>();
  for (const verse of verses) {
    const list = byCsvNumber.get(verse.csvNumber);
    if (list) list.push(verse);
    else byCsvNumber.set(verse.csvNumber, [verse]);
  }
  for (const [number, group] of byCsvNumber) {
    if (group.length > 1) {
      for (const verse of group) verse.warnings.push(`Verse number ${number} is used ${group.length} times.`);
    }
  }

  return {
    config: cfg,
    sections,
    verses,
    unassigned,
    ambiguities,
    warnings,
    teekaNames,
    languages,
    stats: {
      items: items.length,
      sections: sections.length,
      verses: verses.length,
      unassigned: unassigned.length,
      lowConfidence,
      edited,
    },
  };
}

// ──────────────────────────────────────────────────────────────── validation

export interface StructureIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  itemIds?: string[];
  verseKeys?: string[];
}

export interface StructureValidation {
  ok: boolean;
  errors: StructureIssue[];
  warnings: StructureIssue[];
}

/**
 * What must be true before a CSV may be written, and what the user may acknowledge.
 *
 * Errors are the conditions that would produce wrong CMS records (no verses at all,
 * two verses fighting over one number, a verse whose number cannot address a section).
 * Everything else — parked prose, low confidence, numbering gaps — is a warning the
 * editor can accept, which is the same split the existing CSV dialog uses.
 */
export function validateStructure(structure: AssembledStructure): StructureValidation {
  const errors: StructureIssue[] = [];
  const warnings: StructureIssue[] = [];
  const levels = sectionLevelCount(structure.config);

  if (structure.verses.length === 0) {
    errors.push({
      code: "no-verses",
      severity: "error",
      message: `No ${leafLevelName(structure.config)} entries were detected. Check the hierarchy configuration and the structuring instructions, then re-run the analysis.`,
    });
  }

  const byNumber = new Map<string, AssembledVerse[]>();
  for (const verse of structure.verses) {
    const list = byNumber.get(verse.csvNumber);
    if (list) list.push(verse);
    else byNumber.set(verse.csvNumber, [verse]);
  }
  for (const [number, group] of byNumber) {
    if (group.length > 1) {
      errors.push({
        code: "duplicate-number",
        severity: "error",
        message: `${group.length} entries share the number ${number}. Renumber them in the review, or merge them.`,
        verseKeys: group.map((v) => v.key),
        itemIds: group.flatMap((v) => v.itemIds),
      });
    }
  }

  const numberless = structure.verses.filter((v) => numberTokensOf(v.csvNumber).length === 0);
  if (numberless.length > 0 && levels > 0) {
    errors.push({
      code: "unnumbered-verse",
      severity: "error",
      message: `${numberless.length} entr${numberless.length === 1 ? "y has" : "ies have"} no number, so the importer cannot place ${numberless.length === 1 ? "it" : "them"} in a section. Give them numbers in the review.`,
      verseKeys: numberless.map((v) => v.key),
      itemIds: numberless.flatMap((v) => v.itemIds),
    });
  }

  const empty = structure.verses.filter(
    (v) => fieldSetIsEmpty(v.shloka) && fieldSetIsEmpty(v.bhashyam) && v.teekas.length === 0,
  );
  if (empty.length > 0) {
    warnings.push({
      code: "empty-verse",
      severity: "warning",
      message: `${empty.length} entr${empty.length === 1 ? "y has" : "ies have"} no text; ${empty.length === 1 ? "it" : "they"} would be created as numbered but empty.`,
      verseKeys: empty.map((v) => v.key),
    });
  }

  // Section numbers the document never fills — the same check the CSV dialog runs,
  // because a gap leaves sections whose ordinal name no longer matches their position.
  if (levels > 0) {
    const present = new Set<number>();
    for (const verse of structure.verses) {
      const first = Number.parseInt(verse.path[0] ?? "", 10);
      if (Number.isFinite(first) && first >= 1) present.add(first);
    }
    if (present.size > 0) {
      const max = Math.max(...present);
      const missing: number[] = [];
      for (let i = 1; i < max; i++) if (!present.has(i)) missing.push(i);
      if (missing.length > 0) {
        warnings.push({
          code: "section-gap",
          severity: "warning",
          message: `No entries for ${sectionLevelNames(structure.config)[0] ?? "section"} ${missing.join(", ")} — the document may be incomplete or its numbering misread.`,
        });
      }
    }
  }

  if (structure.unassigned.length > 0) {
    warnings.push({
      code: "unassigned",
      severity: "warning",
      message: `${structure.unassigned.length} passage(s) are not part of any entry and will not be imported.`,
      itemIds: structure.unassigned.map((u) => u.item.id),
    });
  }

  if (structure.ambiguities.length > 0) {
    warnings.push({
      code: "open-questions",
      severity: "warning",
      message: `${structure.ambiguities.length} question(s) are still open. Answering them improves the result.`,
      itemIds: structure.ambiguities.flatMap((a) => a.itemIds),
    });
  }

  const lowConfidenceVerses = structure.verses.filter((v) => v.confidence < 0.6);
  if (lowConfidenceVerses.length > 0) {
    warnings.push({
      code: "low-confidence",
      severity: "warning",
      message: `${lowConfidenceVerses.length} entr${lowConfidenceVerses.length === 1 ? "y was" : "ies were"} classified with low confidence — worth a look in the review.`,
      verseKeys: lowConfidenceVerses.map((v) => v.key),
    });
  }

  for (const w of structure.warnings.slice(0, 50)) {
    warnings.push({ code: "analysis", severity: "warning", message: w });
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ───────────────────────────────────────────────────────────────── CSV export

export type StructureCsvRole =
  | { type: "number" }
  | {
      type: "core";
      scope: "shloka" | "bhashyam" | "teeka";
      teekaName?: string;
      field: "SanskritTextEntry" | "IASTTransliteration" | "EnglishTranslationText";
    }
  | { type: "translation"; scope: "shloka" | "bhashyam" | "teeka"; teekaName?: string; language: string };

export interface StructureCsvColumn {
  header: string;
  role: StructureCsvRole;
}

export interface StructureCsvResult {
  csv: string;
  columns: StructureCsvColumn[];
  rowCount: number;
  /** Section path levels encoded in the number column — the importer's `sectionLevels`. */
  sectionLevels: number;
}

/** RFC-4180 quoting, matching what `parseCsv` in the import dialog accepts. */
export function csvCell(value: string | undefined): string {
  const text = value ?? "";
  if (text === "") return "";
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Write the CSV the existing grantha importer maps.
 *
 * Only columns that actually carry text are emitted, so the mapping step the editor
 * sees has no empty rows to dismiss. The number column comes first and is named
 * "Number", which `guessNumberColumn` already recognises.
 */
export function buildStructureCsv(structure: AssembledStructure): StructureCsvResult {
  const levels = sectionLevelCount(structure.config);
  const columns: StructureCsvColumn[] = [{ header: "Number", role: { type: "number" } }];

  const used = {
    shloka: { sanskrit: false, iast: false, english: false },
    bhashyam: { sanskrit: false, iast: false, english: false },
  };
  const teekaUsed = new Map<string, { sanskrit: boolean; english: boolean; iast: boolean }>();
  const shlokaLanguages: string[] = [];
  const bhashyamLanguages: string[] = [];
  const teekaLanguages = new Map<string, string[]>();

  for (const verse of structure.verses) {
    for (const scope of ["shloka", "bhashyam"] as const) {
      const set = verse[scope];
      if (set.sanskrit) used[scope].sanskrit = true;
      if (set.iast) used[scope].iast = true;
      if (set.english) used[scope].english = true;
      const bucket = scope === "shloka" ? shlokaLanguages : bhashyamLanguages;
      for (const other of set.others) if (!bucket.includes(other.language)) bucket.push(other.language);
    }
    for (const teeka of verse.teekas) {
      const flags = teekaUsed.get(teeka.teekaName) ?? { sanskrit: false, english: false, iast: false };
      if (teeka.sanskrit) flags.sanskrit = true;
      if (teeka.iast) flags.iast = true;
      if (teeka.english) flags.english = true;
      teekaUsed.set(teeka.teekaName, flags);
      const langs = teekaLanguages.get(teeka.teekaName) ?? [];
      for (const other of teeka.others) if (!langs.includes(other.language)) langs.push(other.language);
      teekaLanguages.set(teeka.teekaName, langs);
    }
  }

  const leaf = leafLevelName(structure.config);
  if (used.shloka.sanskrit)
    columns.push({ header: `${leaf} (Sanskrit)`, role: { type: "core", scope: "shloka", field: "SanskritTextEntry" } });
  if (used.shloka.iast)
    columns.push({ header: `${leaf} (IAST)`, role: { type: "core", scope: "shloka", field: "IASTTransliteration" } });
  if (used.shloka.english)
    columns.push({
      header: `${leaf} (English)`,
      role: { type: "core", scope: "shloka", field: "EnglishTranslationText" },
    });
  if (used.bhashyam.sanskrit)
    columns.push({
      header: "Bhashyam (Sanskrit)",
      role: { type: "core", scope: "bhashyam", field: "SanskritTextEntry" },
    });
  if (used.bhashyam.iast)
    columns.push({ header: "Bhashyam (IAST)", role: { type: "core", scope: "bhashyam", field: "IASTTransliteration" } });
  if (used.bhashyam.english)
    columns.push({
      header: "Bhashyam (English)",
      role: { type: "core", scope: "bhashyam", field: "EnglishTranslationText" },
    });
  for (const [name, flags] of teekaUsed) {
    if (flags.sanskrit)
      columns.push({
        header: `${name} (Sanskrit)`,
        role: { type: "core", scope: "teeka", teekaName: name, field: "SanskritTextEntry" },
      });
    if (flags.english)
      columns.push({
        header: `${name} (English)`,
        role: { type: "core", scope: "teeka", teekaName: name, field: "EnglishTranslationText" },
      });
    // The importer maps only Sanskrit + English for a teeka; IAST has no target column,
    // so it is folded into Sanskrit rather than dropped (and reported as a warning).
  }
  for (const language of shlokaLanguages)
    columns.push({ header: `${leaf} (${language})`, role: { type: "translation", scope: "shloka", language } });
  for (const language of bhashyamLanguages)
    columns.push({ header: `Bhashyam (${language})`, role: { type: "translation", scope: "bhashyam", language } });
  for (const [name, langs] of teekaLanguages) {
    for (const language of langs)
      columns.push({
        header: `${name} (${language})`,
        role: { type: "translation", scope: "teeka", teekaName: name, language },
      });
  }

  const cellFor = (verse: AssembledVerse, role: StructureCsvRole): string => {
    if (role.type === "number") return verse.csvNumber;
    const set: StructureFieldSet | undefined =
      role.scope === "shloka"
        ? verse.shloka
        : role.scope === "bhashyam"
          ? verse.bhashyam
          : verse.teekas.find((t) => t.teekaName === role.teekaName);
    if (!set) return "";
    if (role.type === "translation") {
      return set.others.find((o) => o.language === role.language)?.text ?? "";
    }
    if (role.field === "SanskritTextEntry") {
      // Teeka IAST has no column of its own in the importer: keep the text by appending
      // it to the Sanskrit cell instead of losing it.
      if (role.scope === "teeka" && set.iast) {
        return [set.sanskrit, set.iast].filter(Boolean).join("\n");
      }
      return set.sanskrit ?? "";
    }
    if (role.field === "IASTTransliteration") return set.iast ?? "";
    return set.english ?? "";
  };

  const lines: string[] = [columns.map((c) => csvCell(c.header)).join(",")];
  for (const verse of structure.verses) {
    lines.push(columns.map((c) => csvCell(cellFor(verse, c.role))).join(","));
  }

  return {
    csv: `${lines.join("\n")}\n`,
    columns,
    rowCount: structure.verses.length,
    sectionLevels: levels,
  };
}

// ─────────────────────────────────────────────── hierarchy mapping to a grantha

/** The destination grantha's structure, as the editor holds it. */
export interface GranthaStructureShape {
  levelOneEnabled?: boolean;
  levelOneName?: string;
  levelTwoEnabled?: boolean;
  levelTwoName?: string;
  levelThreeEnabled?: boolean;
  levelThreeName?: string;
  leafName?: string;
}

export interface HierarchyLevelMapping {
  /** 1-based level in the OCR configuration. */
  sourceLevel: number;
  sourceName: string;
  /** The destination level it maps onto, or null when the grantha has no such level. */
  targetLevel: number | null;
  targetName: string | null;
  /** Same level, same name — nothing to confirm. */
  exact: boolean;
}

export interface HierarchyMappingProposal {
  levels: HierarchyLevelMapping[];
  leaf: { sourceName: string; targetName: string; exact: boolean };
  /** Blocking: the destination cannot hold the configured depth. */
  errors: string[];
  /** Confirmable: the levels line up but are named differently. */
  warnings: string[];
}

/**
 * Propose how the OCR hierarchy maps onto a destination grantha's levels.
 *
 * Position decides the mapping, never the name: two granthas calling their second level
 * "Pada" is not evidence that one's level 2 is the other's level 2, and a name match is
 * reported as "exact" only when the position matches too. Depth that the destination
 * cannot hold is an error with a named remedy, not a silent collapse.
 */
export function proposeHierarchyMapping(
  cfg: StructureHierarchyConfig,
  target: GranthaStructureShape,
): HierarchyMappingProposal {
  const sourceNames = sectionLevelNames(cfg);
  const targetLevels: Array<{ level: number; name: string }> = [];
  if (target.levelOneEnabled !== false) targetLevels.push({ level: 1, name: (target.levelOneName || "Adhyaya").trim() });
  if (target.levelTwoEnabled !== false) targetLevels.push({ level: 2, name: (target.levelTwoName || "Khanda").trim() });
  if (target.levelThreeEnabled) targetLevels.push({ level: 3, name: (target.levelThreeName || "Pada").trim() });

  const levels: HierarchyLevelMapping[] = sourceNames.map((name, index) => {
    const match = targetLevels[index];
    return {
      sourceLevel: index + 1,
      sourceName: name,
      targetLevel: match?.level ?? null,
      targetName: match?.name ?? null,
      exact: Boolean(match) && match!.name.toLowerCase() === name.toLowerCase(),
    };
  });

  const errors: string[] = [];
  const warnings: string[] = [];

  const unmapped = levels.filter((l) => l.targetLevel == null);
  if (unmapped.length > 0) {
    errors.push(
      `The grantha has ${targetLevels.length} section level(s) but the document was configured with ${sourceNames.length}. Enable level ${targetLevels.length + 1} on the grantha's Structure step, or reduce the document's depth.`,
    );
  }
  if (targetLevels.length > sourceNames.length) {
    warnings.push(
      `The grantha has ${targetLevels.length} section level(s); the document only fills ${sourceNames.length}. Deeper levels will be left empty.`,
    );
  }
  for (const level of levels) {
    if (level.targetLevel != null && !level.exact) {
      warnings.push(
        `Level ${level.sourceLevel} is "${level.sourceName}" in the document and "${level.targetName}" in the grantha. Section headings will use the grantha's name.`,
      );
    }
  }

  const sourceLeaf = leafLevelName(cfg);
  const targetLeaf = (target.leafName || "Mantra").trim();
  if (sourceLeaf.toLowerCase() !== targetLeaf.toLowerCase()) {
    warnings.push(
      `The document calls its entries "${sourceLeaf}"; the grantha calls them "${targetLeaf}". Imported entries will be labelled "${targetLeaf}".`,
    );
  }

  return {
    levels,
    leaf: { sourceName: sourceLeaf, targetName: targetLeaf, exact: sourceLeaf.toLowerCase() === targetLeaf.toLowerCase() },
    errors,
    warnings,
  };
}

// ──────────────────────────────────────────────────────────── workflow states

/**
 * The workflow state the UI shows. Derived, never stored twice: the job row owns the
 * analysis status and the import status, and this function turns the pair (plus the
 * validation result) into the single label the wizard renders.
 */
export const STRUCTURE_WORKFLOW_STATES = [
  "configuration_pending",
  "analysis_queued",
  "analysis_in_progress",
  "analysis_failed",
  "clarification_required",
  "review_pending",
  "validation_failed",
  "ready_for_export",
  "ready_for_import",
  "import_in_progress",
  "import_completed",
  "import_failed",
] as const;
export type StructureWorkflowState = (typeof STRUCTURE_WORKFLOW_STATES)[number];

export function structureWorkflowState(input: {
  analysisStatus: string;
  importStatus?: string | null;
  openQuestions: number;
  validationOk: boolean;
  hasVerses: boolean;
  reviewed?: boolean;
}): StructureWorkflowState {
  if (input.importStatus === "running") return "import_in_progress";
  if (input.importStatus === "done") return "import_completed";
  if (input.importStatus === "failed") return "import_failed";

  switch (input.analysisStatus) {
    case "queued":
      return "analysis_queued";
    case "running":
      return "analysis_in_progress";
    case "failed":
    case "cancelled":
      return "analysis_failed";
    default:
      break;
  }
  if (!input.hasVerses) return "validation_failed";
  if (input.openQuestions > 0) return "clarification_required";
  if (!input.validationOk) return "validation_failed";
  if (!input.reviewed) return "review_pending";
  return "ready_for_export";
}

export const STRUCTURE_WORKFLOW_LABELS: Record<StructureWorkflowState, string> = {
  configuration_pending: "Configuration pending",
  analysis_queued: "Analysis queued",
  analysis_in_progress: "Analysis in progress",
  analysis_failed: "Analysis failed",
  clarification_required: "Clarification required",
  review_pending: "Review pending",
  validation_failed: "Validation failed",
  ready_for_export: "Ready for export",
  ready_for_import: "Ready for import",
  import_in_progress: "Import in progress",
  import_completed: "Import completed",
  import_failed: "Import failed",
};
