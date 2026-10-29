/**
 * OCR text quality — pure functions shared by the server pipeline, the viewer and
 * the tests. Nothing here talks to a process, a database or a model.
 *
 * Three stages of a page's text are kept apart on purpose:
 *
 *   raw         each page's text exactly as Gemini returned it (through Hermex) — stored
 *               in `cms_ocr_job_chunks.raw_text`, never modified;
 *   normalized  raw minus whitespace artefacts that carry no meaning (see
 *               `normalizeOcrText`) — what the viewer shows and the structure step reads;
 *   approved    whatever the editor later commits through the grantha editor.
 *
 * There is deliberately no "corrected" stage: nothing in this pipeline rewrites
 * source text after transcription. Uncertain passages are FLAGGED for a human.
 */

/** Why a page deserves a human look. A flag never changes the text. */
export const OCR_PAGE_FLAGS = [
  "empty",
  "short",
  "illegible",
  "invalid_unicode",
  "repeated_lines",
  // Older pages only (stored before OCR moved to Hermex); kept so they still display.
  "low_confidence",
  "low_confidence_words",
  "embedded_text_rejected",
] as const;
export type OcrPageFlag = (typeof OCR_PAGE_FLAGS)[number];

export const OCR_PAGE_FLAG_LABELS: Record<OcrPageFlag, string> = {
  empty: "No text found on this page",
  short: "Very little text for a page",
  illegible: "Gemini marked text it could not read with [?]",
  invalid_unicode: "Contains replacement or invalid characters",
  repeated_lines: "The same line repeats — possible transcription loop",
  low_confidence: "Low recognition confidence",
  low_confidence_words: "Some words were read with low confidence",
  embedded_text_rejected: "The PDF's own text layer looked unusable; the page was OCR'd instead",
};

/** Where a page's text came from ("embedded" only on pages stored before OCR moved to Hermex). */
export type OcrPageSource = "embedded" | "ocr";

/** Per-page provenance and review data, stored beside the text in `pages_meta`. */
export interface OcrPageMeta {
  page: number;
  source: OcrPageSource;
  /** e.g. "hermex/gemini-web". */
  engine: string;
  script?: string | null;
  /** Gemini reports none, so null on every Hermex page. */
  confidence: number | null;
  wordCount: number;
  lowConfidenceWords: number;
  lowConfidenceSamples?: string[];
  /** Places the transcription marked unreadable ([?]). */
  illegibleMarks?: number;
  /** True when normalization changed the raw text. */
  normalized: boolean;
  flags: OcrPageFlag[];
}

// ─────────────────────────────────────────────────────────────── normalization

/**
 * Remove artefacts that change bytes but not meaning, and nothing else: CRLF → LF,
 * form feeds, trailing spaces per line, runs of 3+ blank lines, outer blank lines.
 *
 * No character inside a line is ever changed or dropped — no Unicode normalization
 * form (NFC/NFKC can merge or decompose Vedic and nukta sequences), no zero-width
 * joiner handling: the transcription's own code points are the record.
 */
export function normalizeOcrText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\f/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

/** How many times the transcription marked something unreadable. */
export function countIllegibleMarks(text: string): number {
  return (text.match(/\[\?\]/g) ?? []).length;
}

// ────────────────────────────────────────────────────────── character checks

/** U+FFFD, lone surrogates, C0/C1 controls other than \t \n \f \r. */
export function countInvalidChars(text: string): number {
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0xfffd) bad++;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else bad++;
    } else if (code >= 0xdc00 && code <= 0xdfff) bad++;
    else if ((code < 0x20 && code !== 9 && code !== 10 && code !== 12 && code !== 13) || (code >= 0x7f && code <= 0x9f)) bad++;
  }
  return bad;
}

function visibleLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

// ─────────────────────────────────────────────────────────── page assessment

/** The same non-trivial line three or more times in a row, or one line filling half the page. */
export function hasRepeatedLines(text: string): boolean {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.replace(/\s/g, "").length >= 6);
  if (lines.length < 3) return false;
  let run = 1;
  for (let i = 1; i < lines.length; i++) {
    run = lines[i] === lines[i - 1] ? run + 1 : 1;
    if (run >= 3) return true;
  }
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  const top = Math.max(...counts.values());
  return lines.length >= 6 && top / lines.length >= 0.5;
}

export function assessPage(text: string, opts: { shortPageChars?: number } = {}): OcrPageFlag[] {
  const flags: OcrPageFlag[] = [];
  const visible = visibleLength(text);
  if (visible === 0) flags.push("empty");
  else if (visible < (opts.shortPageChars ?? 25)) flags.push("short");
  if (countIllegibleMarks(text) > 0) flags.push("illegible");
  if (countInvalidChars(text) > 0) flags.push("invalid_unicode");
  if (hasRepeatedLines(text)) flags.push("repeated_lines");
  return flags;
}
