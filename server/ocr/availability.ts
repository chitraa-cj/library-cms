/**
 * Is the local OCR engine installed on this host?
 *
 * Probes the three binaries and Tesseract's installed languages, never a model or
 * a network. Cached for a minute: the health endpoint and the scheduler both ask.
 * A missing piece makes the feature report itself unavailable with the exact
 * package to install; it never takes the CMS down.
 */
import { runProcess } from "../lib/run-process";
import { ocrConfig } from "./config";
import { setTesseractVersionLabel, tesseractEnv } from "./local-engine";

export interface OcrEngineAvailability {
  ok: boolean;
  tesseractVersion: string | null;
  installedLanguages: string[];
  requiredLanguages: string[];
  missingLanguages: string[];
  /** Blocking. */
  problems: string[];
  /** Worth knowing; OCR still works. */
  warnings: string[];
  checkedAt: number;
}

const UBUNTU_PACKAGE: Record<string, string> = {
  san: "tesseract-ocr-san",
  hin: "tesseract-ocr-hin",
  eng: "tesseract-ocr-eng",
  osd: "tesseract-ocr-osd",
  "script/Latin": "tesseract-ocr-script-latn",
  "script/Devanagari": "tesseract-ocr-script-deva",
};

export function requiredLanguages(): string[] {
  const sets = Object.values(ocrConfig.languages);
  return [...new Set(sets.flatMap((s) => s.split("+")).filter(Boolean))].sort();
}

async function version(bin: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await runProcess(bin, args, { timeoutMs: 15_000, env: tesseractEnv() });
    const text = `${stdout.toString("utf8")}\n${stderr}`;
    return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  } catch (err: any) {
    // pdftotext -v prints to stderr and some builds exit 99; only "missing" means absent.
    if (err?.kind === "missing") return null;
    return (err?.stderr || "").split("\n")[0]?.trim() || "installed";
  }
}

let cached: OcrEngineAvailability | null = null;
let inflight: Promise<OcrEngineAvailability> | null = null;

export async function ocrEngineAvailability(force = false): Promise<OcrEngineAvailability> {
  if (!force && cached && Date.now() - cached.checkedAt < 60_000) return cached;
  if (inflight) return inflight;
  inflight = probe()
    .then((result) => {
      cached = result;
      return result;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function probe(): Promise<OcrEngineAvailability> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const bins = ocrConfig.binaries;

  const [tess, pdftotext, pdftoppm] = await Promise.all([
    version(bins.tesseract, ["--version"]),
    version(bins.pdftotext, ["-v"]),
    version(bins.pdftoppm, ["-v"]),
  ]);
  if (tess == null) problems.push(`Tesseract not found (${bins.tesseract}). Install: sudo apt install tesseract-ocr`);
  if (pdftotext == null) problems.push(`pdftotext not found (${bins.pdftotext}). Install: sudo apt install poppler-utils`);
  if (pdftoppm == null) problems.push(`pdftoppm not found (${bins.pdftoppm}). Install: sudo apt install poppler-utils`);

  let installed: string[] = [];
  if (tess != null) {
    try {
      const { stdout } = await runProcess(bins.tesseract, ["--list-langs"], { timeoutMs: 15_000, env: tesseractEnv() });
      installed = stdout
        .toString("utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !/^List of available languages/i.test(l));
    } catch (err: any) {
      problems.push(`Could not list Tesseract languages: ${err?.message || err}`);
    }
  }

  const required = requiredLanguages();
  const missing = tess == null ? required : required.filter((l) => !installed.includes(l));
  if (tess != null && missing.length > 0) {
    const pkgs = missing.map((l) => UBUNTU_PACKAGE[l] ?? `traineddata for "${l}"`).join(" ");
    problems.push(
      `Tesseract language data missing: ${missing.join(", ")}. Install: sudo apt install ${pkgs}` +
        (ocrConfig.tessdataDir ? ` (or add it to OCR_TESSDATA_DIR=${ocrConfig.tessdataDir})` : ""),
    );
  }
  if (tess != null && !installed.includes("osd")) {
    warnings.push("Tesseract OSD data (osd) is missing: script detection is off and every page tries the fallback language set first. Install tesseract-ocr-osd.");
  }

  const label = tess ? tess.replace(/^tesseract\s+v?/i, "tesseract ").split(/\s+/).slice(0, 2).join(" ") : null;
  setTesseractVersionLabel(label);

  return {
    ok: problems.length === 0,
    tesseractVersion: label,
    installedLanguages: installed,
    requiredLanguages: required,
    missingLanguages: missing,
    problems,
    warnings,
    checkedAt: Date.now(),
  };
}

export async function isOcrConfigured(): Promise<boolean> {
  return (await ocrEngineAvailability()).ok;
}
