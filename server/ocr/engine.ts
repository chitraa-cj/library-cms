/**
 * How one page becomes text — the decision logic, independent of any engine.
 *
 *   PDF page ─► text layer usable? ──yes──► embedded text            (no OCR at all)
 *                    │ no / "Always OCR"
 *                    ▼
 *              render page image ─► detect script ─► recognise with the script's
 *              language set ─► below accept confidence? try the other sets, keep
 *              the most confident ─► normalise ─► flag for review
 *
 * The three capabilities it needs are interfaces, implemented by poppler and
 * Tesseract in `local-engine.ts` and by fakes in the tests. Nothing here knows a
 * command line, and nothing in it ever rewrites what the engine read.
 */
import {
  assessEmbeddedText,
  assessPage,
  normalizeOcrText,
  type OcrPageFlag,
  type OcrPageMeta,
} from "@shared/ocr-quality";

/** The PDF's own text for one page (1-based). */
export interface EmbeddedTextSource {
  extractPageText(pdfPath: string, page: number, signal?: AbortSignal): Promise<string>;
}

/** A PDF page rendered to an image file; returns the image path. */
export interface PageRasterizer {
  renderPage(pdfPath: string, page: number, dpi: number, outDir: string, signal?: AbortSignal): Promise<string>;
}

export interface RecognitionResult {
  text: string;
  /** Length-weighted mean word confidence 0–100, null if the engine reported none. */
  confidence: number | null;
  wordCount: number;
  lowConfidenceWords: string[];
}

/** Reads an image. `languages` is engine-specific (Tesseract: "san", "script/Latin", …). */
export interface TextRecognizer {
  /** Human-readable engine id, e.g. "tesseract 5.5.1". */
  readonly label: string;
  /** The page's dominant script ("Devanagari", "Latin", …), or null when it cannot tell. */
  detectScript(imagePath: string, signal?: AbortSignal): Promise<string | null>;
  recognize(imagePath: string, languages: string, signal?: AbortSignal): Promise<RecognitionResult>;
}

export interface PageEngineDeps {
  embedded: EmbeddedTextSource;
  rasterizer: PageRasterizer;
  recognizer: TextRecognizer;
}

export interface PageEngineSettings {
  languages: { devanagari: string; latin: string; fallback: string };
  acceptConfidence: number;
  lowPageConfidence: number;
  lowWordConfidence: number;
}

export type PageInput =
  | { kind: "pdf"; path: string; page: number }
  | { kind: "image"; path: string; page: number };

export interface PageOptions {
  /** "auto" uses a usable text layer; "ocr" always renders and recognises. */
  textMode: "auto" | "ocr";
  dpi: number;
  /** Scratch directory for rendered images; the caller owns and removes it. */
  workDir: string;
  signal?: AbortSignal;
}

export interface PageOutput {
  /** Exactly what the engine / text layer produced. */
  raw: string;
  /** `raw` minus meaningless engine artefacts — what is shown and analysed. */
  text: string;
  meta: OcrPageMeta;
}

/**
 * Candidate language sets, best guess first, without duplicates. The detected
 * script decides the order; every configured set stays available as a fallback.
 */
export function languageCandidates(script: string | null, langs: PageEngineSettings["languages"]): string[] {
  const order =
    script === "Devanagari"
      ? [langs.devanagari, langs.fallback, langs.latin]
      : script === "Latin"
        ? [langs.latin, langs.fallback, langs.devanagari]
        : [langs.fallback, langs.devanagari, langs.latin];
  return [...new Set(order.filter(Boolean))];
}

/**
 * Run candidates in order until one clears `acceptConfidence`; otherwise keep the
 * most confident. Bounded by the candidate count (at most three runs per page).
 */
export async function recognizeBest(
  recognizer: TextRecognizer,
  imagePath: string,
  candidates: string[],
  acceptConfidence: number,
  signal?: AbortSignal,
): Promise<{ result: RecognitionResult; languages: string }> {
  let best: { result: RecognitionResult; languages: string } | null = null;
  for (const languages of candidates) {
    const result = await recognizer.recognize(imagePath, languages, signal);
    const score = result.confidence ?? -1;
    if (!best || score > (best.result.confidence ?? -1)) best = { result, languages };
    if (score >= acceptConfidence) break;
  }
  if (!best) throw new Error("No OCR language set is configured.");
  return best;
}

export async function processPage(
  input: PageInput,
  opts: PageOptions,
  deps: PageEngineDeps,
  settings: PageEngineSettings,
): Promise<PageOutput> {
  const extraFlags: OcrPageFlag[] = [];

  if (input.kind === "pdf" && opts.textMode === "auto") {
    const layer = await deps.embedded.extractPageText(input.path, input.page, opts.signal);
    const verdict = assessEmbeddedText(layer);
    if (verdict.usable) {
      const text = normalizeOcrText(layer);
      return {
        raw: layer,
        text,
        meta: {
          page: input.page,
          source: "embedded",
          engine: "pdftotext",
          confidence: null,
          wordCount: text.split(/\s+/).filter(Boolean).length,
          lowConfidenceWords: 0,
          normalized: text !== layer,
          flags: assessPage({
            text,
            confidence: null,
            lowConfidenceWords: 0,
            wordCount: 0,
            thresholds: { lowPageConfidence: settings.lowPageConfidence },
          }),
        },
      };
    }
    // A text layer with real content that we still refused is worth telling the editor about.
    if (layer.replace(/\s+/g, "").length >= 40) extraFlags.push("embedded_text_rejected");
  }

  const image =
    input.kind === "pdf"
      ? await deps.rasterizer.renderPage(input.path, input.page, opts.dpi, opts.workDir, opts.signal)
      : input.path;

  const script = await deps.recognizer.detectScript(image, opts.signal);
  const candidates = languageCandidates(script, settings.languages);
  const { result, languages } = await recognizeBest(
    deps.recognizer,
    image,
    candidates,
    settings.acceptConfidence,
    opts.signal,
  );

  const text = normalizeOcrText(result.text);
  const flags = [
    ...extraFlags,
    ...assessPage({
      text,
      confidence: result.confidence,
      lowConfidenceWords: result.lowConfidenceWords.length,
      wordCount: result.wordCount,
      thresholds: { lowPageConfidence: settings.lowPageConfidence },
    }),
  ];

  return {
    raw: result.text,
    text,
    meta: {
      page: input.page,
      source: "ocr",
      engine: `${deps.recognizer.label} (${languages})`,
      script,
      confidence: result.confidence == null ? null : Math.round(result.confidence * 10) / 10,
      wordCount: result.wordCount,
      lowConfidenceWords: result.lowConfidenceWords.length,
      lowConfidenceSamples: result.lowConfidenceWords.slice(0, 20),
      normalized: text !== result.text,
      flags,
    },
  };
}
