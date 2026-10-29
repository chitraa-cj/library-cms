/**
 * Is OCR usable on this host? OCR runs only through Hermex, so this is the
 * dedicated document profile's readiness: configured, not translation's, logged in
 * once, Python and the session script present, a display (or headless).
 *
 * Filesystem checks only — it never opens a browser or sends a prompt. Cached for
 * a minute: the health endpoint and the scheduler both ask. A missing piece makes
 * the feature report itself unavailable with the exact fix; it never takes the CMS
 * down, and nothing else is ever tried instead.
 */
import { structureHermexAvailability } from "../hermex/task-profiles";
import { ocrConfig } from "./config";

export interface OcrEngineAvailability {
  ok: boolean;
  /** What jobs record as their engine. */
  engineLabel: string;
  /** Blocking. */
  problems: string[];
  /** Worth knowing; OCR still works. */
  warnings: string[];
  checkedAt: number;
}

let cached: OcrEngineAvailability | null = null;

export async function ocrEngineAvailability(force = false): Promise<OcrEngineAvailability> {
  if (!force && cached && Date.now() - cached.checkedAt < 60_000) return cached;
  const hermex = structureHermexAvailability();
  cached = {
    ok: hermex.ok,
    engineLabel: ocrConfig.engineLabel,
    problems: hermex.problems,
    warnings: hermex.warnings,
    checkedAt: Date.now(),
  };
  return cached;
}

export async function isOcrConfigured(): Promise<boolean> {
  return (await ocrEngineAvailability()).ok;
}
