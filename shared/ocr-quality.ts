/**
 * OCR text quality — pure functions shared by the server pipeline, the viewer and
 * the tests. Nothing here talks to a process, a database or a model.
 *
 * Three stages of a page's text are kept apart on purpose:
 *
 *   raw         exactly what the engine (or the PDF's text layer) produced — stored
 *               in `cms_ocr_job_chunks.raw_text`, never modified;
 *   normalized  raw minus engine artefacts that carry no meaning (see
 *               `normalizeOcrText`) — what the viewer shows and the structure step reads;
 *   approved    whatever the editor later commits through the grantha editor.
 *
 * There is deliberately no "corrected" stage produced by a language model: nothing
 * in this pipeline rewrites source text. Uncertain passages are FLAGGED for a human.
 */

/** Why a page deserves a human look. A flag never changes the text. */
export const OCR_PAGE_FLAGS = [
  "empty",
  "short",
  "low_confidence",
  "low_confidence_words",
  "invalid_unicode",
  "repeated_lines",
  "embedded_text_rejected",
] as const;
export type OcrPageFlag = (typeof OCR_PAGE_FLAGS)[number];

export const OCR_PAGE_FLAG_LABELS: Record<OcrPageFlag, string> = {
  empty: "No text found on this page",
  short: "Very little text for a page",
  low_confidence: "Low recognition confidence",
  low_confidence_words: "Some words were read with low confidence",
  invalid_unicode: "Contains replacement or invalid characters",
  repeated_lines: "The same line repeats — possible recognition loop",
  embedded_text_rejected: "The PDF's own text layer looked unusable; the page was OCR'd instead",
};

/** Where a page's text came from. */
export type OcrPageSource = "embedded" | "ocr";

/** Per-page provenance and review data, stored beside the text in `pages_meta`. */
export interface OcrPageMeta {
  page: number;
  source: OcrPageSource;
  /** e.g. "pdftotext" or "tesseract 5.5.1 (san)". */
  engine: string;
  /** Script Tesseract's OSD detected, when the page was OCR'd. */
  script?: string | null;
  /** Length-weighted mean word confidence 0–100; null for embedded text. */
  confidence: number | null;
  wordCount: number;
  lowConfidenceWords: number;
  /** Up to 20 low-confidence words, so the viewer can point at them. */
  lowConfidenceSamples?: string[];
  /** True when normalization changed the raw text. */
  normalized: boolean;
  flags: OcrPageFlag[];
}

// ─────────────────────────────────────────────────────────────── normalization

const VIRAMA = "्";
const ZWNJ = "‌";

/**
 * Remove engine artefacts that change bytes but not meaning. Deliberately small:
 *
 *  - CRLF → LF, trailing spaces per line, form feeds (Tesseract ends every page
 *    with \f), and runs of 3+ blank lines;
 *  - a ZERO WIDTH NON-JOINER immediately after a Devanagari VIRAMA at the END of
 *    a word. Tesseract emits `त्‌` (virama + ZWNJ) for every word-final halant; the
 *    ZWNJ only matters between two consonants (where it blocks a conjunct), so at a
 *    word end it is invisible and breaks search. A ZWNJ between letters is kept.
 *
 * No Unicode normalization form is applied: NFC/NFKC can merge or decompose
 * Vedic and nukta sequences, and the source's own code points are the record.
 */
export function normalizeOcrText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\f/g, "")
    .replace(new RegExp(`${VIRAMA}${ZWNJ}(?=[\\s\\p{P}]|$)`, "gu"), VIRAMA)
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

/** Private Use Area code points — a PDF font with no Unicode mapping lands here. */
export function countPrivateUseChars(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0x10fffd)) n++;
  }
  return n;
}

function visibleLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

// ─────────────────────────────────────────────────────── embedded text layer

export interface EmbeddedTextVerdict {
  usable: boolean;
  /** Why it was rejected, when it was. */
  reason: string | null;
}

/**
 * Is the PDF's own text layer good enough to use instead of OCR?
 *
 * Rejects what can be detected from the text alone: almost nothing on the page
 * (a scan with only a folio in its text layer), replacement characters, and
 * Private Use code points from fonts without a Unicode map.
 *
 * What it CANNOT detect: a legacy 8-bit Devanagari font (Kruti Dev and friends)
 * whose text layer is plausible-looking Latin, or a font whose map silently drops
 * a sign (observed: Vedic ꣳ U+A8F3 missing from a Chrome-produced PDF). That is
 * why the upload form offers "Always OCR" — the editor knows the source.
 */
export function assessEmbeddedText(text: string, opts: { minVisibleChars?: number } = {}): EmbeddedTextVerdict {
  const min = opts.minVisibleChars ?? 40;
  const visible = visibleLength(text);
  if (visible < min) return { usable: false, reason: `text layer has only ${visible} visible characters` };
  const invalid = countInvalidChars(text);
  const pua = countPrivateUseChars(text);
  const bad = invalid + pua;
  if (bad / visible > 0.01) {
    return { usable: false, reason: `${bad} unmapped or invalid characters in the text layer` };
  }
  return { usable: true, reason: null };
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

export interface PageAssessmentInput {
  text: string;
  /** Length-weighted mean confidence, null when the engine gave none. */
  confidence: number | null;
  lowConfidenceWords: number;
  wordCount: number;
  thresholds: { lowPageConfidence: number; shortPageChars?: number };
}

export function assessPage(input: PageAssessmentInput): OcrPageFlag[] {
  const flags: OcrPageFlag[] = [];
  const visible = visibleLength(input.text);
  if (visible === 0) flags.push("empty");
  else if (visible < (input.thresholds.shortPageChars ?? 25)) flags.push("short");
  if (input.confidence != null && visible > 0 && input.confidence < input.thresholds.lowPageConfidence) {
    flags.push("low_confidence");
  }
  if (input.lowConfidenceWords > 0 && !flags.includes("low_confidence")) flags.push("low_confidence_words");
  if (countInvalidChars(input.text) > 0) flags.push("invalid_unicode");
  if (hasRepeatedLines(input.text)) flags.push("repeated_lines");
  return flags;
}
