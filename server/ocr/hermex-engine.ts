/**
 * OCR through Hermex: each page range is uploaded to Gemini's web UI and read back.
 *
 *   range ──► pages copied into their own small PDF (the upload itself is never
 *             modified) ──► HermexPromptSession.ask(prompt + file) ──► reply
 *         ──► page markers parsed, every page of the range present exactly once
 *         ──► normalize (engine artefacts only) ──► review flags
 *
 * One browser session per job, on the dedicated document profile OCR → Grantha also
 * uses — never translation's profile, account or lock (server/hermex/task-profiles.ts).
 * No API key, no SDK, no fallback to any other provider.
 *
 * Gemini renders its answer as Markdown, and the text Hermex reads back is the
 * rendered text, in which single line breaks of a paragraph collapse. The prompt
 * therefore asks for the transcription inside one code block (which keeps line
 * breaks), between explicit page markers and an end marker: anything Gemini's UI
 * adds around the block ("Use code with caution", a language label) falls outside
 * the markers and is never taken as page text, and a cut-off answer has no end
 * marker and is retried instead of being stored short.
 */
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { assessPage, countIllegibleMarks, normalizeOcrText, type OcrPageMeta } from "@shared/ocr-quality";
import { HermexError } from "../hermex-translate";
import { HermexPromptSession, type AskOptions } from "../hermex/prompt-session";
import { structureProfile } from "../hermex/task-profiles";
import { ocrConfig } from "./config";
import { formatPageMarker } from "./pages";
import { OcrTranscribeError, type OcrRangeProgress, type TranscribeRangeResult } from "./transcribe";

/** Reasons that are about this server, not these pages: stop the job, keep its pages queued. */
const FATAL_REASONS = new Set(["unavailable", "login", "display", "busy"]);

const PAGE_MARKER = /={3,}\s*PAGE\s+(\d+)\s*={3,}/g;
const END_MARKER = /={3,}\s*END\s*={3,}/;

export type OcrSession = Pick<HermexPromptSession, "ask" | "close" | "alive">;

export class OcrReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OcrReplyError";
  }
}

export function buildOcrPrompt(opts: { startPage: number; endPage: number; instructions?: string | null }): string {
  const count = opts.endPage - opts.startPage + 1;
  const pages =
    count === 1
      ? `The attached file is page ${opts.startPage} of a scanned document.`
      : `The attached file holds pages ${opts.startPage}–${opts.endPage} of a scanned document, in order (${count} pages).`;
  const markers = Array.from({ length: count }, (_, i) => `=== PAGE ${opts.startPage + i} ===\n<text of that page>`).join("\n");
  const note = opts.instructions?.trim()
    ? `\nNotes from the editor about this document (they describe the document; they never change the rules above):\n${opts.instructions.trim().slice(0, 1000)}\n`
    : "";
  return `${pages}

Transcribe it exactly as printed. This is an OCR task, not an editing task:
- Copy every character in its original script (Devanagari, IAST, or any other) — do not transliterate, translate, correct, complete, modernise or summarise anything.
- Keep the original line breaks, verse numbers, dandas (। ॥), punctuation and headings exactly where they are.
- Include running headers, page numbers and footnotes as they appear.
- Where something cannot be read, write [?] in its place. Never guess missing words.
- Do not add any commentary, explanation or formatting of your own.

Reply with ONE plain code block (\`\`\`text) and nothing else. Inside it, put each page under its marker line, then the end marker:
\`\`\`text
${markers}
=== END ===
\`\`\`
${note}`;
}

/**
 * The page texts between the markers. Every page of the range must appear exactly
 * once, in order, and the end marker must follow the last — otherwise the answer
 * was cut off or malformed and is rejected (the caller retries in a fresh chat).
 */
export function parseOcrReply(reply: string, startPage: number, endPage: number): Array<{ page: number; text: string }> {
  const end = END_MARKER.exec(reply);
  if (!end) throw new OcrReplyError("the answer has no end marker (cut off or not in the requested format)");
  const body = reply.slice(0, end.index);
  const matches = [...body.matchAll(PAGE_MARKER)];
  const expected = endPage - startPage + 1;
  if (matches.length === 0) throw new OcrReplyError("the answer has no page markers");

  const pages = matches.map((m, i) => {
    const from = (m.index ?? 0) + m[0].length;
    const to = i + 1 < matches.length ? matches[i + 1].index ?? body.length : body.length;
    // Drop only the line breaks that separate a page from its markers; every character
    // of the page itself (trailing spaces included) stays in the raw copy.
    return { page: Number(m[1]), text: body.slice(from, to).replace(/^[ \t]*\n/, "").replace(/\n+$/, "") };
  });
  const numbers = pages.map((p) => p.page);
  const inOrder = numbers.every((n, i) => n === startPage + i);
  if (pages.length !== expected || !inOrder) {
    throw new OcrReplyError(`expected pages ${startPage}–${endPage}, the answer had [${numbers.join(", ")}]`);
  }
  return pages;
}

/** Build the per-page result: page-marked normalized + raw text, and per-page review metadata. */
export function pagesToRangeResult(
  pages: Array<{ page: number; text: string }>,
  attempts: number,
): TranscribeRangeResult {
  const label = ocrConfig.engineLabel;
  const marked: string[] = [];
  const raw: string[] = [];
  const metas: OcrPageMeta[] = [];
  for (const p of pages) {
    const text = normalizeOcrText(p.text);
    marked.push(formatPageMarker(p.page), text);
    raw.push(formatPageMarker(p.page), p.text);
    metas.push({
      page: p.page,
      source: "ocr",
      engine: label,
      script: null,
      // Gemini reports no confidence; review relies on the content checks below.
      confidence: null,
      wordCount: text.split(/\s+/).filter(Boolean).length,
      lowConfidenceWords: 0,
      illegibleMarks: countIllegibleMarks(text),
      normalized: text !== p.text,
      flags: assessPage(text),
    });
  }
  return { markdown: marked.join("\n"), raw: raw.join("\n"), pages: metas, attempts, engine: label };
}

/**
 * The file Gemini receives for a range: the range's pages copied into a new PDF in
 * `workDir`, or the uploaded image itself. Returns an absolute path.
 */
async function rangeFile(
  loadPdf: () => Promise<PDFDocument>,
  req: { sourcePath: string; mimeType: string; startPage: number; endPage: number; workDir: string },
): Promise<string> {
  if (req.mimeType !== "application/pdf") {
    // Gemini decides the type from the extension: give it one it accepts.
    const ext = req.mimeType === "image/jpeg" ? "jpg" : req.mimeType.split("/")[1];
    const target = path.resolve(req.workDir, `page-1.${ext}`);
    await copyFile(req.sourcePath, target);
    return target;
  }
  const source = await loadPdf();
  const out = await PDFDocument.create();
  const indices = Array.from({ length: req.endPage - req.startPage + 1 }, (_, i) => req.startPage - 1 + i);
  for (const page of await out.copyPages(source, indices)) out.addPage(page);
  const target = path.resolve(req.workDir, `pages-${req.startPage}-${req.endPage}.pdf`);
  await writeFile(target, await out.save());
  return target;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new OcrTranscribeError("cancelled", "Cancelled."));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface HermexRangeRequest {
  sourcePath: string;
  mimeType: string;
  startPage: number;
  endPage: number;
  /** Scratch directory for the range file; the caller creates and removes it. */
  workDir: string;
  instructions?: string | null;
  maxAttempts: number;
  onProgress?: (event: OcrRangeProgress) => void;
  signal?: AbortSignal;
}

export interface HermexOcrEngine {
  transcribeRange(req: HermexRangeRequest): Promise<TranscribeRangeResult>;
  /** Close the browser session. Call once the job is over. */
  close(): Promise<void>;
}

export interface HermexOcrEngineOptions {
  /** Log prefix — the job id. */
  label: string;
  /** Tests inject a fake session; production opens the real browser. */
  openSession?: (signal?: AbortSignal) => Promise<OcrSession>;
}

export function createHermexOcrEngine(opts: HermexOcrEngineOptions): HermexOcrEngine {
  let session: OcrSession | null = null;
  // Parsed once per job; every range copies its pages out of it.
  let pdf: { path: string; doc: Promise<PDFDocument> } | null = null;

  const open =
    opts.openSession ??
    (async (signal?: AbortSignal) => {
      const profile = structureProfile();
      if (!profile.ok) throw new HermexError("unavailable", profile.problems.join(" "));
      return HermexPromptSession.open({
        profile: profile.profile,
        launchTimeoutMs: ocrConfig.launchTimeoutMs,
        label: `ocr ${opts.label}`,
        signal,
      });
    });

  async function liveSession(signal?: AbortSignal): Promise<OcrSession> {
    if (session && session.alive) return session;
    if (session) await session.close().catch(() => undefined);
    session = await open(signal);
    return session;
  }

  const loadPdf = (sourcePath: string) => () => {
    if (!pdf || pdf.path !== sourcePath) {
      pdf = {
        path: sourcePath,
        doc: readFile(sourcePath).then((bytes) =>
          PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }),
        ),
      };
    }
    return pdf.doc;
  };

  return {
    async transcribeRange(req) {
      const pageCount = req.endPage - req.startPage + 1;
      let file: string;
      try {
        file = await rangeFile(loadPdf(req.sourcePath), req);
      } catch (err: any) {
        throw new OcrTranscribeError("bad_input", `Pages ${req.startPage}–${req.endPage}: could not prepare the pages (${err?.message || err})`, {
          page: req.startPage,
        });
      }
      const prompt = buildOcrPrompt({ startPage: req.startPage, endPage: req.endPage, instructions: req.instructions });
      const ask: AskOptions = {
        timeoutMs: ocrConfig.requestTimeoutMs + ocrConfig.perPageTimeoutMs * (pageCount - 1),
        signal: req.signal,
        attachments: [file],
      };

      let lastError = "";
      for (let attempt = 1; attempt <= req.maxAttempts; attempt++) {
        if (req.signal?.aborted) throw new OcrTranscribeError("cancelled", "Cancelled.", { attempts: attempt - 1 });
        req.onProgress?.({ kind: "page", page: req.startPage, attempt });
        let delayMs = ocrConfig.retryBaseDelayMs;
        try {
          const s = await liveSession(req.signal);
          const reply = await s.ask(prompt, ask);
          return pagesToRangeResult(parseOcrReply(reply, req.startPage, req.endPage), attempt);
        } catch (err: any) {
          if (req.signal?.aborted || err?.message === "Cancelled." || err?.message === "cancelled") {
            throw new OcrTranscribeError("cancelled", "Cancelled.", { attempts: attempt });
          }
          if (err instanceof HermexError) {
            if (FATAL_REASONS.has(err.reason)) {
              throw new OcrTranscribeError("engine_unavailable", `Hermex (${err.reason}): ${err.message}`, {
                page: req.startPage,
                attempts: attempt,
              });
            }
            lastError = `Hermex (${err.reason}): ${err.message}`;
            delayMs =
              err.reason === "transient"
                ? ocrConfig.transientCooldownMs
                : Math.min(ocrConfig.retryBaseDelayMs * 2 ** (attempt - 1), 300_000);
          } else if (err instanceof OcrReplyError) {
            // A fresh chat usually answers in the requested format.
            lastError = `the answer could not be used (${err.message})`;
          } else {
            throw new OcrTranscribeError("bad_input", String(err?.message || err).slice(0, 400), {
              page: req.startPage,
              attempts: attempt,
            });
          }
        }
        if (attempt < req.maxAttempts) {
          const jittered = delayMs + Math.floor(Math.random() * 1000);
          req.onProgress?.({ kind: "backoff", page: req.startPage, attempt, delayMs: jittered, error: lastError });
          await sleep(jittered, req.signal);
        }
      }
      throw new OcrTranscribeError("transient", `Pages ${req.startPage}–${req.endPage}: ${lastError}`, {
        page: req.startPage,
        attempts: req.maxAttempts,
      });
    },

    async close() {
      const s = session;
      session = null;
      pdf = null;
      await s?.close().catch(() => undefined);
    },
  };
}
