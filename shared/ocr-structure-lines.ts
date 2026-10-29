/**
 * Line-referenced classification: how a language model labels a page range
 * WITHOUT ever writing source text.
 *
 * The pages are shown to the model as numbered lines (`numberSourceLines`). The
 * model answers with line SPANS — "lines 4–5 are verse 1, lines 6–12 its bhashya" —
 * and `resolveLineAnswer` cuts the text from the OCR transcription itself. So:
 *
 *   - the text that reaches the review and the CSV is byte-identical to the OCR
 *     output; a model cannot paraphrase, "correct", transliterate or lose it — not
 *     even through a chat UI's rendering, which is how this answer is transported;
 *   - coverage is CHECKED, not hoped for: every line belongs to exactly one item, in
 *     order. Overlapping or backwards spans reject the answer (one retry); lines the
 *     model skipped become `unclassified` prose items, so nothing is silently dropped;
 *   - a verse/section number the model gives is looked for in the printed text of its
 *     own lines; a commentary name in the printed text, the names already seen, or the
 *     editor's instructions. Anything not found is kept but marked `inferred`, capped
 *     in confidence, and so flagged for review — never presented as printed.
 *
 * Pure: no I/O, no provider. Used by the server analyzer and the tests alike.
 */
import {
  STRUCTURE_ATTACHMENTS,
  STRUCTURE_ITEM_KINDS,
  STRUCTURE_MAX_SECTION_LEVELS,
  STRUCTURE_SCRIPTS,
  StructureAnswerError,
  type StructureAttachment,
  type StructureChunkAnswer,
  type StructureItem,
  type StructureItemKind,
  type StructureScript,
} from "./ocr-structure";

export interface SourceLine {
  /** 1-based, contiguous within one page range. */
  n: number;
  page: number;
  text: string;
}

/** Non-blank lines of the given pages, numbered from 1 in reading order. */
export function numberSourceLines(pages: ReadonlyArray<{ page: number; markdown: string }>): SourceLine[] {
  const lines: SourceLine[] = [];
  for (const p of pages) {
    for (const raw of p.markdown.split("\n")) {
      if (!raw.trim()) continue;
      lines.push({ n: lines.length + 1, page: p.page, text: raw.replace(/\s+$/u, "") });
    }
  }
  return lines;
}

/** The numbered rendering placed inside <document>: page headers, then `L<n>| text`. */
export function renderNumberedDocument(lines: readonly SourceLine[]): string {
  const out: string[] = [];
  let page = -1;
  for (const line of lines) {
    if (line.page !== page) {
      page = line.page;
      out.push(`[page ${page}]`);
    }
    out.push(`L${line.n}| ${line.text}`);
  }
  return out.join("\n");
}

/** The answer format, stated for a model that has no schema enforcement. */
export const LINE_ANSWER_FORMAT = `Answer with ONE JSON object inside a single \`\`\`json code block, and nothing else:
{
  "items": [
    {"kind": "<section|verse|bhashyam|teeka|translation|prose|footnote|ignored>",
     "from": <first line number>, "to": <last line number>,
     "level": <section only: 1-${STRUCTURE_MAX_SECTION_LEVELS}>,
     "number": "<section/verse number in ASCII digits, e.g. \\"12\\" or \\"1.2\\"; omit if none is printed>",
     "script": "<devanagari|iast|english|other>",
     "attachTo": "<previous_verse|section>",
     "teekaName": "<teeka only>", "language": "<translation only>",
     "confidence": <0..1>, "note": "<optional>"}
  ],
  "warnings": ["<observations about the range>"],
  "openPath": [{"level": 1, "number": "<n>", "title": "<heading as printed>"}]
}
Rules for spans: items are in line order; spans never overlap; every line belongs to exactly one item; "from" ≤ "to".`;

const DEVANAGARI_DIGITS = "०१२३४५६७८९";

/** Map Devanagari digits to ASCII. Numbers only — never applied to source text. */
export function asciiDigits(value: string): string {
  return value.replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));
}

/** Is every digit group of `number` printed as a standalone number in `text`? Non-numeric labels need a literal match. */
export function numberIsPrinted(number: string, text: string): boolean {
  const target = asciiDigits(number);
  const groups = target.match(/[0-9]+/g);
  const haystack = asciiDigits(text);
  if (!groups) return haystack.toLowerCase().includes(target.trim().toLowerCase());
  return groups.every((g) => new RegExp(`(^|[^0-9])0*${g}(?![0-9])`).test(haystack));
}

function extractJsonObject(raw: string): any {
  const text = String(raw ?? "").trim();
  if (!text) throw new StructureAnswerError("The model returned an empty answer.");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new StructureAnswerError("The model answer contains no JSON object.");
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new StructureAnswerError("The model answer is truncated or malformed JSON.");
  }
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t ? t.slice(0, max) : undefined;
}

export interface LineAnswerContext {
  chunkIndex: number;
  lines: readonly SourceLine[];
  /** Commentary names already used earlier in the document. */
  knownTeekaNames?: readonly string[];
  /** The editor's instructions, where a commentary may be named. */
  instructions?: string | null;
  /** Confidence ceiling for an item whose number/name was not found printed. */
  inferredConfidenceCap?: number;
}

export interface ResolvedLineAnswer {
  items: StructureItem[];
  warnings: string[];
  /** Model items dropped for invalid fields (bad kind, bad level, empty span). */
  rejected: number;
  /** Source lines no item covered — kept as unclassified prose. */
  unclassifiedLines: number;
  openPath: StructureChunkAnswer["openPath"];
}

/**
 * Validate a line-referenced answer and turn it into StructureItems whose text is
 * cut verbatim from `ctx.lines`. Throws StructureAnswerError for answers a retry
 * could fix (no JSON, overlapping/backwards spans, spans outside the range).
 */
export function resolveLineAnswer(raw: string, ctx: LineAnswerContext): ResolvedLineAnswer {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) {
    throw new StructureAnswerError('The model answer has no "items" array.');
  }
  const total = ctx.lines.length;
  const cap = ctx.inferredConfidenceCap ?? 0.5;
  const known = new Set((ctx.knownTeekaNames ?? []).map((n) => n.trim().toLowerCase()));
  const instructions = (ctx.instructions ?? "").toLowerCase();
  const rangeText = ctx.lines.map((l) => l.text).join("\n");

  type Span = { from: number; to: number; entry: any; kind: StructureItemKind };
  const spans: Span[] = [];
  let rejected = 0;

  for (const entry of parsed.items) {
    const kind = STRUCTURE_ITEM_KINDS.includes(entry?.kind) ? (entry.kind as StructureItemKind) : null;
    const from = Number(entry?.from);
    const to = Number(entry?.to ?? entry?.from);
    if (!kind || !Number.isInteger(from) || !Number.isInteger(to)) {
      rejected++;
      continue;
    }
    if (from < 1 || to > total) {
      throw new StructureAnswerError(`An item refers to lines ${from}–${to}, outside this range's lines 1–${total}.`);
    }
    if (from > to) throw new StructureAnswerError(`An item's span runs backwards (${from}–${to}).`);
    spans.push({ from, to, entry, kind });
  }

  // Order and overlap are the model's job; checking them is ours.
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].from <= spans[i - 1].to) {
      throw new StructureAnswerError(
        `Items overlap or are out of order (lines ${spans[i - 1].from}–${spans[i - 1].to} then ${spans[i].from}–${spans[i].to}).`,
      );
    }
  }

  const items: StructureItem[] = [];
  let unclassifiedLines = 0;
  let seq = 0;
  const id = () => `c${ctx.chunkIndex}-${seq++}`;
  const textOf = (from: number, to: number) =>
    ctx.lines
      .slice(from - 1, to)
      .map((l) => l.text)
      .join("\n");

  const pushGap = (from: number, to: number) => {
    if (from > to) return;
    unclassifiedLines += to - from + 1;
    items.push({
      id: id(),
      kind: "prose",
      text: textOf(from, to),
      page: ctx.lines[from - 1].page,
      confidence: 0,
      sourceLines: [from, to],
      unclassified: true,
      note: "Not classified by the model — review where this text belongs.",
    });
  };

  let next = 1;
  for (const span of spans) {
    pushGap(next, span.from - 1);
    next = span.to + 1;

    const e = span.entry;
    const text = textOf(span.from, span.to);
    const confidence = Number.isFinite(Number(e.confidence)) ? Math.min(1, Math.max(0, Number(e.confidence))) : 0.5;
    const item: StructureItem = {
      id: "",
      kind: span.kind,
      page: ctx.lines[span.from - 1].page,
      confidence,
      sourceLines: [span.from, span.to],
    };
    const notes: string[] = [];
    const note = cleanString(e.note, 400);
    if (note) notes.push(note);
    if (STRUCTURE_SCRIPTS.includes(e.script)) item.script = e.script as StructureScript;
    if (STRUCTURE_ATTACHMENTS.includes(e.attachTo)) item.attachTo = e.attachTo as StructureAttachment;
    const language = cleanString(e.language, 60);
    if (language && span.kind === "translation") item.language = language;

    const number = cleanString(e.number, 120);
    if (number) {
      item.number = asciiDigits(number);
      if (numberIsPrinted(number, text)) item.numberSource = "printed";
      else {
        item.numberSource = "inferred";
        item.confidence = Math.min(item.confidence, cap);
        notes.push(`Number "${item.number}" is not printed in this passage — inferred by the model.`);
      }
    }

    if (span.kind === "section") {
      const level = Math.round(Number(e.level));
      if (!Number.isFinite(level) || level < 1 || level > STRUCTURE_MAX_SECTION_LEVELS) {
        // A heading we cannot place is still text: keep it, unclassified.
        rejected++;
        pushGapLike(item, text, "Heading level missing or out of range — review.");
      } else {
        item.level = level;
        item.title = text.slice(0, 500);
      }
    } else {
      // `ignored` keeps its text too, so the review can show what was set aside.
      item.text = text;
    }

    if (span.kind === "teeka") {
      const name = cleanString(e.teekaName, 200);
      if (name) {
        item.teekaName = name;
        const lower = name.toLowerCase();
        if (rangeText.toLowerCase().includes(lower)) item.teekaNameSource = "printed";
        else if (known.has(lower)) item.teekaNameSource = "known";
        else if (instructions.includes(lower)) item.teekaNameSource = "instructions";
        else {
          item.teekaNameSource = "inferred";
          item.confidence = Math.min(item.confidence, cap);
          notes.push(`Commentary name "${name}" is not printed here, not named earlier and not in the instructions — inferred.`);
        }
      }
    }

    if (notes.length) item.note = notes.join(" ").slice(0, 500);
    item.id = id();
    items.push(item);
  }
  pushGap(next, total);

  function pushGapLike(item: StructureItem, text: string, why: string) {
    item.kind = "prose";
    item.text = text;
    item.unclassified = true;
    item.confidence = 0;
    item.note = why;
  }

  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.map((w: unknown) => String(w ?? "").slice(0, 500)).filter(Boolean).slice(0, 50)
    : [];
  if (unclassifiedLines > 0) {
    warnings.push(`${unclassifiedLines} line(s) were not classified by the model and are kept as unclassified text for review.`);
  }

  const openPath = Array.isArray(parsed.openPath)
    ? parsed.openPath
        .filter((p: any) => p && Number.isFinite(Number(p.level)))
        .map((p: any) => ({
          level: Math.min(STRUCTURE_MAX_SECTION_LEVELS, Math.max(1, Math.round(Number(p.level)))),
          number: asciiDigits(String(p.number ?? "")).slice(0, 120),
          title: String(p.title ?? "").slice(0, 500),
        }))
        .slice(0, STRUCTURE_MAX_SECTION_LEVELS)
    : undefined;

  return { items, warnings, rejected, unclassifiedLines, openPath };
}
