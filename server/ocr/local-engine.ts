/**
 * The local engine: poppler for PDF text layers and page images, Tesseract for
 * recognition. Implements the interfaces in `engine.ts`; all process handling goes
 * through `runProcess` (no shell, timeouts, cancellation).
 */
import path from "node:path";
import { runProcess } from "../lib/run-process";
import type { EmbeddedTextSource, PageEngineDeps, PageRasterizer, RecognitionResult, TextRecognizer } from "./engine";
import { ocrConfig } from "./config";

function tesseractEnv(): NodeJS.ProcessEnv {
  // One thread per Tesseract process: parallelism comes from page lanes, and
  // OpenMP inside each process would oversubscribe the CPU several times over.
  const env: NodeJS.ProcessEnv = { ...process.env, OMP_THREAD_LIMIT: "1" };
  if (ocrConfig.tessdataDir) env.TESSDATA_PREFIX = ocrConfig.tessdataDir;
  return env;
}

const pageArg = (page: number): string => {
  if (!Number.isInteger(page) || page < 1) throw new Error(`Invalid page number ${page}.`);
  return String(page);
};

export const popplerText: EmbeddedTextSource = {
  async extractPageText(pdfPath, page, signal) {
    const p = pageArg(page);
    const { stdout } = await runProcess(
      ocrConfig.binaries.pdftotext,
      ["-q", "-enc", "UTF-8", "-f", p, "-l", p, pdfPath, "-"],
      { timeoutMs: ocrConfig.processTimeoutMs, signal, nice: ocrConfig.niceLevel },
    );
    return stdout.toString("utf8");
  },
};

export const popplerRasterizer: PageRasterizer = {
  async renderPage(pdfPath, page, dpi, outDir, signal) {
    const p = pageArg(page);
    const base = path.join(outDir, `page-${p}`);
    await runProcess(
      ocrConfig.binaries.pdftoppm,
      ["-q", "-f", p, "-l", p, "-r", String(Math.round(dpi)), "-gray", "-png", "-singlefile", pdfPath, base],
      { timeoutMs: ocrConfig.processTimeoutMs, signal, nice: ocrConfig.niceLevel },
    );
    return `${base}.png`;
  },
};

// ──────────────────────────────────────────────────────────────── Tesseract TSV

/**
 * Turn Tesseract's TSV into text plus confidence figures.
 *
 * Words are joined by single spaces within a line, lines by newlines, and
 * paragraphs/blocks by a blank line — the same layout Tesseract's own text
 * renderer produces, so one run yields both the text and the confidences.
 */
export function parseTesseractTsv(tsv: string, lowWordConfidence: number): RecognitionResult {
  const rows = tsv.split("\n");
  let weighted = 0;
  let weight = 0;
  let wordCount = 0;
  const lowWords: string[] = [];
  const out: string[] = [];
  let currentLine = "";
  let lineKey = "";
  let paraKey = "";

  const flushLine = () => {
    if (currentLine) out.push(currentLine);
    currentLine = "";
  };

  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i].split("\t");
    if (cols.length < 12 || cols[0] !== "5") continue;
    const word = cols.slice(11).join("\t");
    if (!word.trim()) continue;
    const conf = Number(cols[10]);
    const pKey = `${cols[1]}.${cols[2]}.${cols[3]}`;
    const lKey = `${pKey}.${cols[4]}`;
    if (lKey !== lineKey) {
      flushLine();
      if (paraKey && pKey !== paraKey) out.push("");
      lineKey = lKey;
      paraKey = pKey;
    }
    currentLine = currentLine ? `${currentLine} ${word}` : word;
    wordCount++;
    if (Number.isFinite(conf) && conf >= 0) {
      const len = [...word].length;
      weighted += conf * len;
      weight += len;
      if (conf < lowWordConfidence) lowWords.push(word);
    }
  }
  flushLine();

  return {
    text: out.join("\n"),
    confidence: weight > 0 ? weighted / weight : null,
    wordCount,
    lowConfidenceWords: lowWords,
  };
}

export function parseOsdScript(osd: string): string | null {
  const match = /^Script:\s*(\S+)/m.exec(osd);
  return match ? match[1] : null;
}

/** Language sets are config, but they still reach argv: allow only Tesseract's own name shapes. */
const LANG_SET = /^[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)?(?:\+[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)?)*$/;

let versionLabel: string | null = null;
export function setTesseractVersionLabel(label: string | null): void {
  versionLabel = label;
}

export const tesseractRecognizer: TextRecognizer = {
  get label() {
    return versionLabel ?? "tesseract";
  },

  async detectScript(imagePath, signal) {
    try {
      const { stdout } = await runProcess(ocrConfig.binaries.tesseract, [imagePath, "stdout", "--psm", "0", "-l", "osd"], {
        timeoutMs: ocrConfig.processTimeoutMs,
        signal,
        nice: ocrConfig.niceLevel,
        env: tesseractEnv(),
      });
      return parseOsdScript(stdout.toString("utf8"));
    } catch (err: any) {
      // OSD refuses pages with too little text ("Too few characters"); that is an
      // answer ("unknown script"), not a failure. Cancellation still propagates.
      if (err?.kind === "cancelled" || err?.kind === "missing") throw err;
      return null;
    }
  },

  async recognize(imagePath, languages, signal) {
    if (!LANG_SET.test(languages)) throw new Error(`Invalid Tesseract language set "${languages}".`);
    const { stdout } = await runProcess(
      ocrConfig.binaries.tesseract,
      [imagePath, "stdout", "--psm", "3", "-l", languages, "-c", "tessedit_create_tsv=1"],
      { timeoutMs: ocrConfig.processTimeoutMs, signal, nice: ocrConfig.niceLevel, env: tesseractEnv() },
    );
    return parseTesseractTsv(stdout.toString("utf8"), ocrConfig.lowWordConfidence);
  },
};

export const localEngine: PageEngineDeps = {
  embedded: popplerText,
  rasterizer: popplerRasterizer,
  recognizer: tesseractRecognizer,
};

export function localEngineSettings() {
  return {
    languages: ocrConfig.languages,
    acceptConfidence: ocrConfig.acceptConfidence,
    lowPageConfidence: ocrConfig.lowPageConfidence,
    lowWordConfidence: ocrConfig.lowWordConfidence,
  };
}

export { tesseractEnv };
