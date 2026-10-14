/**
 * Client side of the OCR → Grantha workflow: the API surface, and the handoff that
 * carries a finished analysis from OCR Docs into the grantha editor.
 *
 * The handoff deliberately carries an ID and nothing else. The CSV of a 2,500-verse
 * grantha is megabytes, sessionStorage is ~5MB per origin and throws when it is full,
 * so the bytes stay on the server and the editor fetches them once it has opened the
 * destination grantha. What crosses the navigation is small enough to survive a refresh,
 * which is what makes the last leg of the workflow resumable.
 */
import { apiRequest, CMS_FETCH_INIT } from "./queryClient";
import type {
  AssembledSection,
  AssembledVerse,
  HierarchyMappingProposal,
  StructureCsvColumn,
  StructureHierarchyConfig,
  StructureItem,
  StructureOverride,
  StructureValidation,
  StructureWorkflowState,
} from "@shared/ocr-structure";
import type { StructureJob } from "@shared/schema";

export const STRUCTURE_BASE = "/api/admin/ocr/structure";

export interface StructureConfigInfo {
  configured: boolean;
  model: string;
  effort: string;
  limits: {
    maxDepth: number;
    maxPages: number;
    pagesPerChunk: number;
    maxInstructionChars: number;
    confidenceThreshold: number;
  };
  usage: StructureUsage;
}

export interface StructureUsage {
  inFlight: number;
  queued: number;
  lastMinute: number;
  perMinuteLimit: number;
  today: number;
  perDayLimit: number;
  concurrency: number;
}

export interface StructureChunkStatus {
  chunkIndex: number;
  startPage: number;
  endPage: number;
  status: "queued" | "running" | "done" | "failed" | "skipped";
  attempts: number;
  model: string | null;
  rejectedItems: number;
  durationMs: number;
  error: string | null;
}

export interface StructureJobDetail {
  job: StructureJob;
  chunks: StructureChunkStatus[];
  active: boolean;
  live: {
    chunkIndex: number;
    attempt: number;
    maxAttempts: number;
    phase: "slot" | "request" | "backoff";
    startedAt: number;
    phaseStartedAt: number;
    nextAttemptAt: number | null;
    lastError: string | null;
  } | null;
  usage: StructureUsage;
  serverNow: number;
}

export interface StructureAmbiguityView {
  id: string;
  question: string;
  evidence: string;
  itemIds: string[];
  page: number;
  options: Array<{ id: string; label: string; recommended?: boolean; apply: StructureOverride[] }>;
}

export interface StructureResultView {
  job: StructureJob;
  config: StructureHierarchyConfig;
  items: StructureItem[];
  sections: AssembledSection[];
  verses: AssembledVerse[];
  unassigned: Array<{ item: StructureItem; reason: string }>;
  ambiguities: StructureAmbiguityView[];
  warnings: string[];
  teekaNames: string[];
  languages: string[];
  stats: {
    items: number;
    sections: number;
    verses: number;
    unassigned: number;
    lowConfidence: number;
    edited: number;
  };
  validation: StructureValidation;
  csv: { columns: StructureCsvColumn[]; rowCount: number; sectionLevels: number };
  workflowState: StructureWorkflowState;
  missingRanges: Array<{ startPage: number; endPage: number; error: string | null }>;
}

export interface StructureCsvPayload {
  csv: string;
  columns: StructureCsvColumn[];
  rowCount: number;
  sectionLevels: number;
  fileName: string;
  config: StructureHierarchyConfig;
  validation: StructureValidation;
}

export interface StructureMappingPayload {
  mapping: HierarchyMappingProposal;
  teekas: Array<{ sourceName: string; targetId: string | null; targetName: string | null; exact: boolean }>;
  sectionLevels: number;
  csvColumns: StructureCsvColumn[];
  rowCount: number;
  alreadyImported: { granthaDocId: string | null; at: string | null; summary: unknown } | null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, CMS_FETCH_INIT);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.message) message = body.message;
      if (body?.validation) {
        const err: any = new Error(message);
        err.validation = body.validation;
        throw err;
      }
    } catch (err: any) {
      if (err?.validation) throw err;
    }
    throw new Error(message);
  }
  return res.json();
}

export function fetchStructureConfig(): Promise<StructureConfigInfo> {
  return getJson(`${STRUCTURE_BASE}/config`);
}

export function fetchStructureJobsForOcr(ocrJobId: string): Promise<{ jobs: StructureJob[] }> {
  return getJson(`${STRUCTURE_BASE}/for-ocr/${ocrJobId}`);
}

export function fetchStructureJob(jobId: string): Promise<StructureJobDetail> {
  return getJson(`${STRUCTURE_BASE}/jobs/${jobId}`);
}

/**
 * The assembled structure. `withItems: false` asks for the counts, the sections, the
 * questions and the validation without the classified passages — the progress poll's
 * shape, which must not re-download the whole transcription every couple of seconds.
 */
export function fetchStructureResult(
  jobId: string,
  opts: { withItems?: boolean } = {},
): Promise<StructureResultView> {
  const query = opts.withItems === false ? "?items=0" : "";
  return getJson(`${STRUCTURE_BASE}/jobs/${jobId}/result${query}`);
}

export function fetchStructureCsv(jobId: string): Promise<StructureCsvPayload> {
  return getJson(`${STRUCTURE_BASE}/jobs/${jobId}/csv`);
}

export function structureCsvDownloadUrl(jobId: string): string {
  return `${STRUCTURE_BASE}/jobs/${jobId}/csv?download=1`;
}

export async function startStructureJob(input: {
  ocrJobId: string;
  depth: number;
  levelNames: string[];
  instructions: string;
  voiceUsed: boolean;
}): Promise<{ job: StructureJob }> {
  const res = await apiRequest("POST", `${STRUCTURE_BASE}/jobs`, input);
  return res.json();
}

export async function saveStructureOverrides(
  jobId: string,
  overrides: StructureOverride[],
): Promise<Partial<StructureResultView>> {
  const res = await apiRequest("PUT", `${STRUCTURE_BASE}/jobs/${jobId}/overrides`, { overrides });
  return res.json();
}

export async function confirmStructureReview(jobId: string): Promise<{ job: StructureJob }> {
  const res = await apiRequest("POST", `${STRUCTURE_BASE}/jobs/${jobId}/review`);
  return res.json();
}

export async function retryStructureJob(jobId: string): Promise<{ requeued: number }> {
  const res = await apiRequest("POST", `${STRUCTURE_BASE}/jobs/${jobId}/retry`);
  return res.json();
}

export async function cancelStructureJob(jobId: string): Promise<void> {
  await apiRequest("POST", `${STRUCTURE_BASE}/jobs/${jobId}/cancel`);
}

export async function deleteStructureJob(jobId: string): Promise<void> {
  await apiRequest("DELETE", `${STRUCTURE_BASE}/jobs/${jobId}`);
}

export interface MappingTarget {
  levelOneEnabled?: boolean;
  levelOneName?: string;
  levelTwoEnabled?: boolean;
  levelTwoName?: string;
  levelThreeEnabled?: boolean;
  levelThreeName?: string;
  leafName?: string;
  teekas?: Array<{ id: string; TeekaName?: string; TeekaAuthor?: string }>;
}

export async function fetchStructureMapping(
  jobId: string,
  target: MappingTarget,
): Promise<StructureMappingPayload> {
  const res = await apiRequest("POST", `${STRUCTURE_BASE}/jobs/${jobId}/mapping`, { target });
  return res.json();
}

export async function reportStructureImport(
  jobId: string,
  body: {
    status: "running" | "done" | "failed";
    granthaDocId?: string | null;
    summary?: Record<string, unknown> | null;
    error?: string | null;
    force?: boolean;
  },
): Promise<{ job: StructureJob }> {
  const res = await apiRequest("POST", `${STRUCTURE_BASE}/jobs/${jobId}/import`, body);
  return res.json();
}

// ───────────────────────────────────────────────── handoff into the editor

const HANDOFF_KEY = "cms.ocrStructureHandoff";

export interface StructureHandoff {
  structureJobId: string;
  /** Destination: an existing grantha's Strapi documentId, a portal draft, or a new one. */
  target:
    | { kind: "grantha"; documentId: string; name: string }
    | { kind: "draft"; draftId: number; name: string }
    | { kind: "new"; name: string };
  /** Shown in the editor so the user knows what is about to be mapped. */
  summary: { verses: number; sectionLevels: number; levelNames: string[]; fileName: string };
  createdAt: number;
}

/**
 * Hand an analysis to the grantha editor. Survives the navigation and a refresh;
 * cleared by the editor as soon as it has opened the import dialog, so a stale handoff
 * cannot re-open it later.
 */
export function setStructureHandoff(handoff: StructureHandoff): void {
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff));
  } catch {
    // Private mode / full storage: the editor simply will not auto-open, and the
    // "Download CSV" path still works.
  }
}

export function readStructureHandoff(): StructureHandoff | null {
  try {
    const raw = sessionStorage.getItem(HANDOFF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StructureHandoff;
    if (!parsed?.structureJobId || !parsed?.target) return null;
    // An hour is long enough to finish a mapping and short enough that a forgotten tab
    // does not hand a half-remembered import to the next session.
    if (Date.now() - (parsed.createdAt ?? 0) > 60 * 60 * 1000) {
      clearStructureHandoff();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearStructureHandoff(): void {
  try {
    sessionStorage.removeItem(HANDOFF_KEY);
  } catch {
    // nothing to do
  }
}
