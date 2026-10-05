/**
 * Shared Hermex → Strapi sync for any grantha (merge-safe OtherTranslations).
 */
import fs from "node:fs";
import path from "node:path";
import { strapiRequest } from "../../server/strapi";
import { runHermexTranslate, type HermexTranslationRow } from "../../server/hermex-translate";
import { otherTranslationLanguages } from "@shared/schema";

export const MANTRA_FULL_QUERY =
  "?populate[Teekas][populate][TeekaEntry][populate]=*" +
  "&populate[Teekas][populate][teeka][fields][0]=TeekaName" +
  "&populate[Teekas][populate][teeka][fields][1]=documentId" +
  "&populate[ShlokaManthraEntry][populate]=*" +
  "&populate[BhashyamEntry][populate]=*";

export type FieldKind = "ShlokaManthraEntry" | "BhashyamEntry" | "teeka";

export type MantraRef = {
  documentId: string;
  label: string;
};

export type TranslateJob = {
  mantraDocId: string;
  mantraLabel: string;
  context: string;
  field: FieldKind;
  teekaIndex?: number;
  sourceText: string;
  sourceLanguage: "English" | "Sanskrit";
  targetLanguages: string[];
  /**
   * Where the answer is written — which is also which pass this job belongs to.
   *
   * `"others"` — the normal pass: the field's English text fanned out to the
   *   `OtherTranslations` rows.
   * `"english"` — the FIRST pass, for a field that has no English at all: the
   *   Sanskrit original is translated to English and stored in the field's own
   *   `EnglishTranslationText`, which is what the `"others"` pass then reads.
   */
  produces: "english" | "others";
};

export type RunOptions = {
  headless: boolean;
  chunkSize: number;
  chunkDelayMs: number;
  maxRetries: number;
  dryRun: boolean;
  checkpointPath: string;
  resetCheckpoint: boolean;
};

export type CheckpointFile = {
  granthaDocumentId: string;
  granthaName: string;
  updatedAt: string;
  completedChunks: string[];
  failedChunks: Record<string, string>;
  stats: { ok: number; fail: number; mantrasDone: number };
};

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export function chunkKey(job: TranslateJob, langs: string[]): string {
  const teeka = job.teekaIndex ?? -1;
  return `${job.mantraDocId}|${job.field}|${teeka}|${langs.join(",")}`;
}

export function loadCheckpoint(filePath: string): CheckpointFile | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as CheckpointFile;
  } catch {
    return null;
  }
}

export function saveCheckpoint(filePath: string, data: CheckpointFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Recurse into nested block children so a `list` (whose children are `list-item`
// blocks) yields its item text instead of empty — otherwise list-form English
// source would translate as blank. Paragraph-only input is unchanged.
function blockNodeText(node: any): string {
  if (typeof node?.text === "string") return node.text;
  if (!Array.isArray(node?.children)) return "";
  const sep = node?.type === "list" ? "\n" : "";
  return node.children.map(blockNodeText).join(sep);
}

export function blocksToText(blocks: unknown): string {
  if (!blocks) return "";
  if (typeof blocks === "string") return blocks.trim();
  if (!Array.isArray(blocks)) return "";
  return blocks.map(blockNodeText).join("\n").trim();
}

export function textToBlocks(text: string): any[] {
  if (!text.trim()) return [];
  return text.split("\n").map((line) => ({
    type: "paragraph",
    children: [{ type: "text", text: line }],
  }));
}

function omitId(row: Record<string, any>): Record<string, any> {
  const { id, documentId, ...rest } = row;
  return rest;
}

export function mergeOtherTranslations(localOT: any[], strapiOT: any[]): any[] {
  const result = [...strapiOT];
  for (const localEntry of localOT) {
    const lang = localEntry.LanguageOfTranslation;
    if (!lang) continue;
    const idx = result.findIndex((e) => e.LanguageOfTranslation === lang);
    const localFields = omitId(localEntry);
    if (idx >= 0) {
      result[idx] = { ...result[idx], ...localFields };
    } else {
      result.push({ ...localFields });
    }
  }
  return result;
}

export function mergeTeekaEntry(strapiEntry: any, patch: any): any {
  const s = { ...(strapiEntry ?? {}) };
  const strapiOT: any[] = Array.isArray(s.OtherTranslations) ? s.OtherTranslations : [];
  const localOT: any[] = Array.isArray(patch.OtherTranslations) ? patch.OtherTranslations : [];
  const mergedOT =
    strapiOT.length === 0 && localOT.length === 0
      ? undefined
      : mergeOtherTranslations(localOT, strapiOT);
  const out = { ...s };
  if (patch.SanskritTextEntry) out.SanskritTextEntry = patch.SanskritTextEntry;
  if (patch.EnglishTranslationText) out.EnglishTranslationText = patch.EnglishTranslationText;
  if (patch.IASTTransliteration) out.IASTTransliteration = patch.IASTTransliteration;
  if (mergedOT !== undefined) out.OtherTranslations = mergedOT;
  return out;
}

export function stripEntryForPut(entry: any): any {
  if (!entry || typeof entry !== "object") return null;
  const out: Record<string, any> = {};
  for (const f of ["SanskritTextEntry", "EnglishTranslationText", "IASTTransliteration"]) {
    if (Array.isArray(entry[f]) && entry[f].length > 0) out[f] = entry[f];
  }
  const ot = entry.OtherTranslations;
  if (Array.isArray(ot) && ot.length > 0) {
    out.OtherTranslations = ot
      .filter((r: any) => r?.LanguageOfTranslation?.trim())
      .map((r: any) => ({
        LanguageOfTranslation: r.LanguageOfTranslation.trim(),
        TranslationText: Array.isArray(r.TranslationText)
          ? r.TranslationText
          : textToBlocks(blocksToText(r.TranslationText)),
        isAiTranslated: r.isAiTranslated ?? true,
      }));
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Strapi row language — canonical field plus legacy import names. */
export function rowLanguage(row: any): string {
  return (row?.LanguageOfTranslation ?? row?.Language ?? row?.language ?? "").trim();
}

export function rowTranslationContent(row: any): unknown {
  return row?.TranslationText ?? row?.Translation ?? row?.OtherLanguagesTranslation;
}

export function getTextEntryForJob(mantra: any, job: TranslateJob): any {
  if (job.field === "teeka" && job.teekaIndex != null) {
    return mantra.Teekas?.[job.teekaIndex]?.TeekaEntry;
  }
  return mantra[job.field];
}

export function filledLangs(entry: any): Set<string> {
  const set = new Set<string>();
  for (const row of entry?.OtherTranslations ?? []) {
    const lang = rowLanguage(row);
    if (lang && blocksToText(rowTranslationContent(row))) set.add(lang);
  }
  return set;
}

export function missingLangs(entry: any): string[] {
  const have = filledLangs(entry);
  return otherTranslationLanguages.filter((l) => !have.has(l));
}

function hermexRowsToOtherTranslations(rows: HermexTranslationRow[]): any[] {
  return rows.map((r) => ({
    LanguageOfTranslation: r.language,
    TranslationText: textToBlocks(r.text),
    isAiTranslated: true,
  }));
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Strapi/FortiGuard sometimes returns 403 HTML mid-batch — backoff and retry. */
export async function strapiWithRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 6,
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e: unknown) {
      last = e;
      const err = e as { status?: number; code?: string };
      const retriable =
        err?.status === 403 ||
        err?.status === 429 ||
        err?.status === 408 ||
        err?.code === "upstream_policy_block" ||
        err?.code === "upstream_timeout" ||
        (typeof err?.status === "number" && err.status >= 500);
      if (!retriable || attempt >= maxAttempts) {
        if (err?.status === 403) {
          console.error(
            `[strapi] ${label}: persistent 403 — check STRAPI_API_TOKEN in .env or wait (WAF/rate limit).`,
          );
        }
        throw e;
      }
      const waitMs = Math.min(90_000, attempt * 12_000);
      console.warn(
        `[strapi] ${label} failed (${err.status ?? err.code ?? "error"}) — retry ${attempt}/${maxAttempts} in ${waitMs}ms`,
      );
      await sleep(waitMs);
    }
  }
  throw last;
}

/**
 * Token the Python circuit breaker puts in its abort message.
 *
 * Checked BEFORE the generic classification below, which matches the substring
 * "hermex" — the old abort message mentioned HERMEX_MAX_SOURCE_CHARS, so the breaker
 * that exists to STOP wasted Gemini round trips was itself classified as retryable
 * and the whole 6-language subprocess was relaunched three times. Keep in sync with
 * TRANSIENT_ABORT_MARKER in python/hermex_translate/translate_cli.py.
 */
export const NON_RETRYABLE_HERMEX_MARKER = "GEMINI_BACKEND_ERROR_LIMIT";

export function isHermexRetryableError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // Final conditions win over every pattern below.
  if (msg.includes(NON_RETRYABLE_HERMEX_MARKER.toLowerCase())) return false;
  return (
    msg.includes("chrome") ||
    msg.includes("chromedriver") ||
    msg.includes("window") ||
    msg.includes("webview") ||
    msg.includes("timeout") ||
    msg.includes("hermex") ||
    msg.includes("empty gemini") ||
    msg.includes("could not parse") ||
    msg.includes("delimiter") ||
    msg.includes("json") ||
    msg.includes("no such window") ||
    msg.includes("session not created") ||
    msg.includes("cannot connect to chrome") ||
    msg.includes("did not reach state") ||
    msg.includes("state.idle") ||
    msg.includes("neither text") ||
    msg.includes("textnor image") ||
    msg.includes("empty gemini response") ||
    msg.includes("click intercepted") ||
    msg.includes("not clickable at point")
  );
}

function isChromeSessionError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("session not created") ||
    msg.includes("chrome not reachable") ||
    msg.includes("cannot connect to chrome") ||
    msg.includes("invalid session") ||
    msg.includes("no such window")
  );
}

export function queryTimeoutForSource(sourceLen: number, baseSec = 900): number {
  return Math.min(3600, Math.max(baseSec, 900 + Math.floor(sourceLen / 4)));
}

/** Long Teeka/Bhashyam breaks Gemini JSON — translate fewer languages per request. */
export function effectiveChunkSizeForSource(sourceLen: number, defaultSize: number): number {
  if (sourceLen > 3500) return 1;
  if (sourceLen > 1500) return Math.min(defaultSize, 2);
  if (sourceLen > 400) return Math.min(defaultSize, 2);
  return defaultSize;
}

export async function runHermexWithRetry(
  req: Parameters<typeof runHermexTranslate>[0],
  maxRetries: number,
  chunkDelayMs: number,
): Promise<Awaited<ReturnType<typeof runHermexTranslate>>> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await runHermexTranslate(req);
    } catch (e) {
      lastErr = e;
      if (attempt >= maxRetries || !isHermexRetryableError(e)) throw e;
      const baseWait = isChromeSessionError(e) ? Math.max(chunkDelayMs * 2, 8000) : chunkDelayMs;
      const wait = baseWait * attempt;
      console.log(`[retry] attempt ${attempt + 1}/${maxRetries} in ${wait}ms — ${e instanceof Error ? e.message.slice(0, 120) : e}`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

export async function resolveGranthaByName(name: string): Promise<{ documentId: string; GranthaName: string }> {
  // Collapse internal whitespace/newlines so a pasted multi-line arg
  // ("Chandogya \n Upanishad", which a wrapped terminal can produce) still
  // matches "Chandogya Upanishad" in Strapi's $containsi filter.
  const clean = name.replace(/\s+/g, " ").trim();
  const q = encodeURIComponent(clean);
  const res = await strapiRequest(
    `/api/granthas?filters[GranthaName][$containsi]=${q}&pagination[pageSize]=20&fields[0]=documentId&fields[1]=GranthaName`,
  );
  const list: any[] = res?.data ?? [];
  if (!list.length) {
    throw new Error(`No grantha found matching "${clean}"`);
  }
  const exact = list.find((g) => (g.GranthaName ?? "").toLowerCase() === clean.toLowerCase());
  const pick = exact ?? list[0];
  if (list.length > 1 && !exact) {
    console.warn(
      `[warn] Multiple granthas match "${name}" — using "${pick.GranthaName}" (${pick.documentId}). Others: ${list
        .filter((g) => g.documentId !== pick.documentId)
        .map((g) => g.GranthaName)
        .join(", ")}`,
    );
  }
  return { documentId: pick.documentId, GranthaName: pick.GranthaName };
}

export async function listMantrasForGrantha(granthaDocId: string): Promise<MantraRef[]> {
  const out: MantraRef[] = [];
  for (let page = 1; page <= 200; page++) {
    const res = await strapiRequest(
      `/api/manthras?filters[Section][grantha][documentId][$eq]=${granthaDocId}` +
        `&fields[0]=documentId&fields[1]=ShlokaManthraNumber&fields[2]=order` +
        `&sort[0]=order:asc&pagination[page]=${page}&pagination[pageSize]=100`,
    );
    const items: any[] = res?.data ?? [];
    for (const m of items) {
      if (!m.documentId) continue;
      const label = (m.ShlokaManthraNumber ?? m.documentId).toString();
      out.push({ documentId: m.documentId, label });
    }
    const pageCount = res?.meta?.pagination?.pageCount ?? 1;
    if (page >= pageCount) break;
  }
  out.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  return out;
}

export async function fetchMantraFull(mantraDocId: string): Promise<any> {
  return strapiWithRetry(`fetch mantra ${mantraDocId}`, async () => {
    return (await strapiRequest(`/api/manthras/${mantraDocId}${MANTRA_FULL_QUERY}`))?.data;
  });
}

/** One translatable text block of a mantra: Shloka, Bhashyam, or one Teeka. */
export type MantraFieldUnit = {
  field: FieldKind;
  teekaIndex?: number;
  entry: any;
  /** Suffix used in the job context, e.g. "BhashyamEntry" / "Teeka Anandagiri". */
  name: string;
};

/**
 * The field units a mantra expands into, in the order both passes walk them.
 *
 * Shared so pass 1 (Sanskrit → English) and pass 2 (English → everything else)
 * can never disagree about what a mantra contains.
 */
export function mantraFieldUnits(mantra: any): MantraFieldUnit[] {
  const units: MantraFieldUnit[] = [];
  for (const field of ["ShlokaManthraEntry", "BhashyamEntry"] as const) {
    units.push({ field, entry: mantra?.[field], name: field });
  }
  const teekas: any[] = mantra?.Teekas ?? [];
  for (let i = 0; i < teekas.length; i++) {
    units.push({
      field: "teeka",
      teekaIndex: i,
      entry: teekas[i]?.TeekaEntry,
      name: `Teeka ${teekas[i]?.teeka?.TeekaName ?? `Teeka ${i + 1}`}`,
    });
  }
  return units;
}

/**
 * PASS 2 — the normal pass: English source → every OtherTranslations language
 * still missing. A field with no English is skipped here; `buildEnglishJobsForMantra`
 * is what gives it one first.
 */
export function buildJobsForMantra(mantra: any, mantraLabel: string, granthaName: string): TranslateJob[] {
  const jobs: TranslateJob[] = [];
  const base = `${granthaName} — ${mantraLabel}`;

  for (const unit of mantraFieldUnits(mantra)) {
    const missing = missingLangs(unit.entry);
    const english = blocksToText(unit.entry?.EnglishTranslationText);
    if (missing.length === 0 || !english) continue;
    jobs.push({
      mantraDocId: mantra.documentId,
      mantraLabel,
      context: `${base} — ${unit.name}`,
      field: unit.field,
      teekaIndex: unit.teekaIndex,
      sourceText: english,
      sourceLanguage: "English",
      targetLanguages: missing,
      produces: "others",
    });
  }

  return jobs;
}

/**
 * PASS 1 — fields that have no English translation at all.
 *
 * Gemini is asked for the English of the Sanskrit original and the result is
 * written to the field's own `EnglishTranslationText`. Pass 2 then reads that
 * English and fans it out, so a mantra that arrived with only Sanskrit still ends
 * up fully translated — *through* English, never Sanskrit → 42 languages directly,
 * which is the one path this whole pipeline (chunking, source splitting, prompt
 * shape) is tuned for.
 *
 * A field with neither English nor Sanskrit is skipped: there is nothing to
 * translate from, and that is a data-entry gap, not a translation failure.
 */
export function buildEnglishJobsForMantra(
  mantra: any,
  mantraLabel: string,
  granthaName: string,
): TranslateJob[] {
  const jobs: TranslateJob[] = [];
  const base = `${granthaName} — ${mantraLabel}`;

  for (const unit of mantraFieldUnits(mantra)) {
    if (blocksToText(unit.entry?.EnglishTranslationText)) continue;
    const sanskrit = blocksToText(unit.entry?.SanskritTextEntry);
    if (!sanskrit) continue;
    jobs.push({
      mantraDocId: mantra.documentId,
      mantraLabel,
      context: `${base} — ${unit.name} → English`,
      field: unit.field,
      teekaIndex: unit.teekaIndex,
      sourceText: sanskrit,
      sourceLanguage: "Sanskrit",
      targetLanguages: ["English"],
      produces: "english",
    });
  }

  return jobs;
}

/** Keep only the languages a caller asked for (an empty list means "all missing"). */
export function narrowToRequestedLanguages(job: TranslateJob, requested: string[]): TranslateJob {
  if (!requested.length) return job;
  const wanted = new Set(requested);
  return { ...job, targetLanguages: job.targetLanguages.filter((l) => wanted.has(l)) };
}

/**
 * Drop failed-chunk entries for this mantra whose languages are ALL now present
 * in Strapi. failedChunks is keyed by exact language grouping, but the grouping
 * is non-deterministic across runs (effectiveChunkSizeForSource varies by source
 * length; parse failures retry one language at a time), so a key recorded under
 * one grouping is never the key that later succeeds — leaving orphaned entries
 * that "re-run to retry" can never clear once missingLangs hits 0. Re-validating
 * against live Strapi state is the only reliable cleanup. Returns count removed.
 */
export function pruneFailedChunksForMantra(mantra: any, checkpoint: CheckpointFile): number {
  let removed = 0;
  for (const key of Object.keys(checkpoint.failedChunks)) {
    const [docId, field, teeka, langCsv] = key.split("|");
    if (docId !== mantra.documentId) continue;
    const langs = (langCsv ?? "").split(",").filter(Boolean);
    // "English" is never an OtherTranslations language, so a key with it alone can
    // only be a pass-1 chunk — and it is satisfied by the field's own English text.
    const produces: TranslateJob["produces"] =
      langs.length === 1 && langs[0] === "English" ? "english" : "others";
    const job = {
      field: field as FieldKind,
      teekaIndex: field === "teeka" ? parseInt(teeka, 10) : undefined,
      produces,
    } as TranslateJob;
    const entry = getTextEntryForJob(mantra, job);
    if (produces === "english") {
      if (blocksToText(entry?.EnglishTranslationText)) {
        delete checkpoint.failedChunks[key];
        removed++;
      }
      continue;
    }
    const have = filledLangs(entry);
    if (langs.length > 0 && langs.every((l) => have.has(l))) {
      delete checkpoint.failedChunks[key];
      removed++;
    }
  }
  return removed;
}

async function putManthraField(mantraDocId: string, field: "ShlokaManthraEntry" | "BhashyamEntry", mergedEntry: any): Promise<void> {
  const payload = stripEntryForPut(mergedEntry);
  if (!payload) return;
  try {
    await strapiRequest(`/api/manthras/${mantraDocId}`, {
      method: "PUT",
      body: JSON.stringify({ data: { [field]: payload } }),
    });
  } catch (e: any) {
    if (e?.status !== 413) throw e;
    const { OtherTranslations, ...core } = payload;
    if (Object.keys(core).length > 0) {
      await strapiRequest(`/api/manthras/${mantraDocId}`, {
        method: "PUT",
        body: JSON.stringify({ data: { [field]: core } }),
      });
    }
    const rows: any[] = OtherTranslations ?? [];
    for (let i = 0; i < rows.length; i += 6) {
      const batch = rows.slice(i, i + 6);
      const snap = (await strapiRequest(`/api/manthras/${mantraDocId}?populate[${field}][populate]=*`))?.data;
      const current = snap?.[field] ?? {};
      const currentOT: any[] = Array.isArray(current.OtherTranslations) ? current.OtherTranslations : [];
      const mergedOT = mergeOtherTranslations(batch, currentOT);
      const next = mergeTeekaEntry(current, { OtherTranslations: mergedOT });
      await strapiRequest(`/api/manthras/${mantraDocId}`, {
        method: "PUT",
        body: JSON.stringify({ data: { [field]: stripEntryForPut(next) } }),
      });
    }
  }
}

async function putTeekas(mantraDocId: string, teekas: any[]): Promise<void> {
  const stripped = teekas.map((t) => {
    const te = stripEntryForPut(t.TeekaEntry);
    const row: any = { teeka: t.teeka?.documentId ?? t.teeka };
    if (t.id) row.id = t.id;
    if (te) row.TeekaEntry = te;
    return row;
  });
  try {
    await strapiRequest(`/api/manthras/${mantraDocId}`, {
      method: "PUT",
      body: JSON.stringify({ data: { Teekas: stripped } }),
    });
  } catch (e: any) {
    if (e?.status !== 413) throw e;
    const existing = (await fetchMantraFull(mantraDocId))?.Teekas ?? [];
    for (let i = 0; i < stripped.length; i++) {
      const updated = [
        ...existing.slice(0, i).map((et: any) => ({ id: et.id, teeka: et.teeka?.documentId })),
        stripped[i],
        ...existing.slice(i + 1).map((et: any) => ({ id: et.id, teeka: et.teeka?.documentId })),
      ];
      await strapiRequest(`/api/manthras/${mantraDocId}`, {
        method: "PUT",
        body: JSON.stringify({ data: { Teekas: updated } }),
      });
    }
  }
}

/** Re-read Strapi so we never call Gemini for languages already on this field. */
export async function filterLangsStillMissing(job: TranslateJob, langs: string[]): Promise<string[]> {
  const mantra = await fetchMantraFull(job.mantraDocId);
  if (!mantra) return langs;
  const entry = getTextEntryForJob(mantra, job);
  if (job.produces === "english") {
    // Pass 1 has exactly one target, and it lives in the field's own English text
    // — an "English" row in OtherTranslations says nothing about it.
    return blocksToText(entry?.EnglishTranslationText) ? [] : langs;
  }
  const have = filledLangs(entry);
  return langs.filter((l) => !have.has(l));
}

/** Pass-1 write-back: the field's own English text, from the single English row. */
function englishPatchFromRows(rows: HermexTranslationRow[]): Record<string, any> | null {
  const row = rows.find((r) => r.language === "English") ?? rows[0];
  const text = (row?.text ?? "").trim();
  if (!text) return null;
  return { EnglishTranslationText: textToBlocks(text) };
}

export async function syncJobToStrapi(job: TranslateJob, newRows: HermexTranslationRow[]): Promise<void> {
  if (newRows.length === 0) return;
  const langs = newRows.map((r) => r.language).join(", ");
  await strapiWithRetry(`sync ${job.context} (${langs})`, async () => {
    const fresh = await fetchMantraFull(job.mantraDocId);
    if (!fresh) throw new Error(`Mantra ${job.mantraDocId} not found during sync`);

    // Pass 1 fills the field's English text; pass 2 adds OtherTranslations rows.
    const patch =
      job.produces === "english"
        ? englishPatchFromRows(newRows)
        : { OtherTranslations: hermexRowsToOtherTranslations(newRows) };
    if (!patch) throw new Error(`Gemini returned empty English for ${job.context}`);

    if (job.field === "teeka" && job.teekaIndex != null) {
      const teekasOut = [...(fresh.Teekas ?? [])];
      const t = teekasOut[job.teekaIndex];
      const merged = mergeTeekaEntry(t.TeekaEntry, patch);
      teekasOut[job.teekaIndex] = { ...t, TeekaEntry: merged };
      await putTeekas(job.mantraDocId, teekasOut);
    } else {
      // Reached only when field is NOT "teeka" (the branch above owns that case),
      // but TypeScript cannot narrow a FieldKind through the conjunction above.
      const field = job.field as Exclude<FieldKind, "teeka">;
      const strapiEntry = fresh[field] ?? {};
      const merged = mergeTeekaEntry(strapiEntry, patch);
      await putManthraField(job.mantraDocId, field, merged);
    }
  });
}

export async function translateJobIncremental(
  job: TranslateJob,
  opts: RunOptions,
  checkpoint: CheckpointFile,
): Promise<{ ok: number; fail: number }> {
  let ok = 0;
  let fail = 0;
  const effChunk = effectiveChunkSizeForSource(job.sourceText.length, opts.chunkSize);
  const chunks = chunkArray(job.targetLanguages, effChunk);

  console.log(
    `\n[job] ${job.context} | ${job.targetLanguages.length} langs | ${chunks.length} chunks (size ${effChunk}, ${job.sourceText.length} chars source) | headless=${opts.headless}`,
  );

  type ChunkWork = {
    plannedLangs: string[];
    langs: string[];
    key: string;
    chunkId: string;
  };
  const workChunks: ChunkWork[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const plannedLangs = chunks[i];
    const key = chunkKey(job, plannedLangs);
    const chunkId = `${job.context} chunk ${i + 1}/${chunks.length}`;

    const langs = await filterLangsStillMissing(job, plannedLangs);
    const alreadyInStrapi = plannedLangs.filter((l) => !langs.includes(l));
    if (alreadyInStrapi.length > 0) {
      console.log(`[skip] ${chunkId} | already in Strapi (${job.field}): ${alreadyInStrapi.join(", ")}`);
      ok += alreadyInStrapi.length;
      if (langs.length === 0 && !checkpoint.completedChunks.includes(key)) {
        checkpoint.completedChunks.push(key);
        saveCheckpoint(opts.checkpointPath, checkpoint);
      }
    }
    if (langs.length === 0) continue;

    if (checkpoint.completedChunks.includes(key)) {
      const stillMissing = langs.length;
      if (stillMissing === 0) {
        console.log(`[skip] ${chunkId} | checkpoint OK, Strapi complete`);
        continue;
      }
      console.log(
        `[warn] ${chunkId} | checkpoint marked done but Strapi still missing: ${langs.join(", ")} — re-translating`,
      );
      console.log(
        `[warn] If a CMS snapshot still has these langs, restore with: npm run restore:shloka-ot -- --backup-id <id> --grantha "<name>" --suffix <verse> --execute`,
      );
    }

    workChunks.push({ plannedLangs, langs, key, chunkId });
  }

  if (workChunks.length === 0) return { ok, fail };

  if (opts.dryRun) {
    for (const w of workChunks) {
      console.log(`[dry-run] would translate ${w.chunkId}: ${w.langs.join(", ")}`);
    }
    return { ok, fail };
  }

  const seenLangs = new Set<string>();
  const allLangs: string[] = [];
  for (const w of workChunks) {
    for (const lang of w.langs) {
      if (!seenLangs.has(lang)) {
        seenLangs.add(lang);
        allLangs.push(lang);
      }
    }
  }

  const byLang = new Map<string, HermexTranslationRow>();

  const fetchHermexRows = async (
    targetLanguages: string[],
    headless: boolean,
  ): Promise<void> => {
    const result = await runHermexWithRetry(
      {
        sourceText: job.sourceText,
        sourceLanguage: job.sourceLanguage,
        targetLanguages,
        context: job.context,
        chunkSize: effChunk,
        headless,
        queryTimeoutSec: queryTimeoutForSource(job.sourceText.length),
        chunkDelaySec: opts.chunkDelayMs / 1000,
        maxRetries: 3,
      },
      opts.maxRetries,
      opts.chunkDelayMs,
    );
    for (const row of result.translations ?? []) {
      byLang.set(row.language, row);
    }
  };

  // Translate one set of languages in a SINGLE Python/Chrome session, with the
  // same headless→visible fallback and single-language parse-retry as before.
  // A whole-batch failure leaves those langs out of byLang; the per-chunk sync
  // below records them as failed (and the run retries them next time).
  const fetchBatchWithRecovery = async (batchLangs: string[]): Promise<void> => {
    try {
      try {
        await fetchHermexRows(batchLangs, opts.headless);
      } catch (chromeErr: unknown) {
        if (opts.headless && isChromeSessionError(chromeErr)) {
          console.log(
            "[hermex] Chrome session failed headless — retrying this batch with visible Chrome. Keep the window open.",
          );
          await sleep(Math.max(opts.chunkDelayMs * 2, 12000));
          await fetchHermexRows(batchLangs, false);
        } else {
          throw chromeErr;
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const parseFailed =
        msg.toLowerCase().includes("json") ||
        msg.toLowerCase().includes("delimiter") ||
        msg.toLowerCase().includes("could not parse");

      if (parseFailed && batchLangs.length > 1) {
        console.log(`[translate] JSON parse failed — retrying ${batchLangs.length} languages one at a time`);
        for (const lang of batchLangs) {
          if (byLang.has(lang)) continue;
          try {
            await fetchHermexRows([lang], opts.headless);
            console.log(`[translate] OK single-lang retry | ${lang}`);
          } catch (singleErr: unknown) {
            const sm = singleErr instanceof Error ? singleErr.message : String(singleErr);
            console.log(`[translate] FAIL single-lang retry | ${lang} | ${sm}`);
          }
          if (opts.chunkDelayMs > 0) await sleep(opts.chunkDelayMs);
        }
      } else {
        console.log(`[translate] FAIL batch | [${batchLangs.join(", ")}] | ${msg}`);
      }
    }
  };

  // Sync one Strapi workChunk from byLang and update the checkpoint. Extracted so
  // we can persist incrementally after each session batch — a heavy mantra no
  // longer rides on a single all-or-nothing session where a late crash loses
  // every earlier translation.
  const syncWorkChunk = async (w: ChunkWork): Promise<void> => {
    const { plannedLangs, langs, key, chunkId } = w;
    let rows: HermexTranslationRow[] = [];
    let chunkFailed = false;
    let lastError = "";

    const got = new Set<string>();
    for (const lang of langs) {
      const row = byLang.get(lang);
      if (row) {
        rows.push(row);
        got.add(lang);
        ok++;
      } else {
        fail++;
        chunkFailed = true;
        console.log(`[translate] FAIL ${chunkId} | ${lang} | not in Gemini response`);
      }
    }

    if (rows.length > 0) {
      try {
        await syncJobToStrapi(job, rows);
        console.log(`[strapi] OK ${chunkId} | synced: ${rows.map((r) => r.language).join(", ")}`);
      } catch (syncErr: unknown) {
        const sm = syncErr instanceof Error ? syncErr.message : String(syncErr);
        chunkFailed = true;
        lastError = sm;
        for (const r of rows) {
          if (got.has(r.language)) ok = Math.max(0, ok - 1);
          fail++;
        }
        console.log(
          `[strapi] FAIL ${chunkId} | Gemini OK but Strapi save failed: ${rows.map((r) => r.language).join(", ")} | ${sm.slice(0, 120)}`,
        );
        console.log(`[strapi] Re-run the job to retry save only (translations may be re-fetched from Gemini).`);
        rows = [];
      }
      if (chunkFailed) {
        console.log(
          `[translate] partial ${chunkId} | saved ${rows.length}/${langs.length} — retry missing langs on next run`,
        );
      }
    } else if (!chunkFailed) {
      chunkFailed = true;
      lastError = "no rows parsed";
      console.log(`[translate] FAIL ${chunkId} | no rows parsed`);
    }

    let stillMissingAfter = plannedLangs;
    try {
      stillMissingAfter = await filterLangsStillMissing(job, plannedLangs);
    } catch (verifyErr: unknown) {
      const vm = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
      console.warn(`[strapi] Could not verify Strapi after ${chunkId}: ${vm.slice(0, 100)}`);
      const saved = new Set(rows.map((r) => r.language));
      stillMissingAfter = plannedLangs.filter((l) => !saved.has(l));
    }
    if (stillMissingAfter.length === 0) {
      if (!checkpoint.completedChunks.includes(key)) {
        checkpoint.completedChunks.push(key);
      }
      delete checkpoint.failedChunks[key];
    } else if (chunkFailed) {
      checkpoint.failedChunks[key] = lastError || "unknown";
      console.log(`[warn] ${chunkId} | still missing in Strapi: ${stillMissingAfter.join(", ")}`);
    }
    saveCheckpoint(opts.checkpointPath, checkpoint);
  };

  // Group workChunks into session batches of ~HERMEX_SESSION_BATCH languages.
  // Each batch is one fresh Python/Chrome session, after which its chunks are
  // synced. This bounds how much heavy-source work depends on a single browser
  // session (the cause of the all-or-nothing 42-language jobs) and persists
  // progress as it goes.
  const SESSION_BATCH = Math.max(1, parseInt(process.env.HERMEX_SESSION_BATCH || "6", 10) || 6);
  const workBatches: ChunkWork[][] = [];
  {
    let cur: ChunkWork[] = [];
    let curLangs = 0;
    for (const w of workChunks) {
      cur.push(w);
      curLangs += w.langs.length;
      if (curLangs >= SESSION_BATCH) {
        workBatches.push(cur);
        cur = [];
        curLangs = 0;
      }
    }
    if (cur.length) workBatches.push(cur);
  }

  console.log(
    `[hermex] ${allLangs.length} language(s) across ${workChunks.length} Strapi chunk(s) in ${workBatches.length} session batch(es) of ~${SESSION_BATCH} lang(s)`,
  );

  for (let bi = 0; bi < workBatches.length; bi++) {
    const batch = workBatches[bi];
    const batchLangs = [...new Set(batch.flatMap((w) => w.langs))].filter((l) => !byLang.has(l));
    if (batchLangs.length > 0) {
      console.log(
        `[hermex] Session batch ${bi + 1}/${workBatches.length}: ${batchLangs.length} lang(s) in a fresh browser — ${batchLangs.join(", ")}`,
      );
      await fetchBatchWithRecovery(batchLangs);
    }
    for (const w of batch) {
      await syncWorkChunk(w);
    }
    if (bi < workBatches.length - 1 && opts.chunkDelayMs > 0) {
      await sleep(opts.chunkDelayMs);
    }
  }

  return { ok, fail };
}

// ───────────────────────────────────────────────────────── the two-pass driver
export type MantraPassOptions = {
  /** Restrict pass 2 to these languages; empty/omitted = every one still missing. */
  requestedLanguages?: string[];
  /**
   * Pass 1 (Sanskrit → English) on/off. Off reproduces the old behaviour exactly:
   * a field with no English is simply skipped.
   */
  englishFirstPass?: boolean;
  /** Checked between field units; a unit already in flight is allowed to finish. */
  signal?: { aborted: boolean };
  /** Re-read the mantra between the passes. Injectable for tests. */
  refetch?: (mantraDocId: string) => Promise<any>;
};

export type MantraPassResult = {
  /** Language-writes that landed (English counts as one). */
  ok: number;
  fail: number;
  /** Field units each pass actually had work for. */
  englishUnits: number;
  otherUnits: number;
  /** One line per field unit — what the queue stores on the item. */
  lines: string[];
  aborted: boolean;
};

/**
 * Translate ONE mantra in the two passes the pipeline is built around:
 *
 *   pass 1  Sanskrit original → English, for fields with no English yet
 *           (written to the field's own EnglishTranslationText)
 *   re-read the mantra
 *   pass 2  English → every other language still missing
 *
 * Pass 1 only ever touches fields that have **no** English; a hand-written or
 * previously generated English translation is never overwritten. Pass 2 is the
 * unchanged old path, and it reads the English that pass 1 just wrote, which is
 * why the re-read between them is mandatory rather than an optimisation.
 *
 * Shared by the translation worker and the `hermex:grantha` CLI so the two can
 * never drift apart.
 */
export async function translateMantraPasses(
  mantra: any,
  mantraLabel: string,
  granthaName: string,
  opts: RunOptions,
  checkpoint: CheckpointFile,
  passOpts: MantraPassOptions = {},
): Promise<MantraPassResult> {
  const refetch = passOpts.refetch ?? fetchMantraFull;
  const lines: string[] = [];
  let ok = 0;
  let fail = 0;
  let aborted = false;

  /** Run one unit, tally it, and report whether the caller should keep going. */
  const runUnit = async (unit: TranslateJob): Promise<boolean> => {
    if (passOpts.signal?.aborted) {
      aborted = true;
      lines.push(`${unit.context}: skipped (worker shutting down)`);
      return false;
    }
    const result = await translateJobIncremental(unit, opts, checkpoint);
    ok += result.ok;
    fail += result.fail;
    const what =
      unit.produces === "english"
        ? `English ${result.ok > 0 ? "written" : "not written"}`
        : `${result.ok} language(s) written`;
    lines.push(`${unit.context}: ${what}${result.fail ? `, ${result.fail} failed` : ""}`);
    saveCheckpoint(opts.checkpointPath, checkpoint);
    return true;
  };

  const englishUnits =
    passOpts.englishFirstPass === false
      ? []
      : buildEnglishJobsForMantra(mantra, mantraLabel, granthaName);

  let pass2Source = mantra;

  if (englishUnits.length > 0) {
    console.log(
      `\n[pass 1] ${mantraLabel}: ${englishUnits.length} field(s) have no English — translating the Sanskrit original first`,
    );
    let wrote = 0;
    for (const unit of englishUnits) {
      const before = ok;
      if (!(await runUnit(unit))) break;
      if (ok > before) wrote++;
    }
    if (wrote > 0) {
      try {
        const fresh = await refetch(mantra.documentId);
        if (fresh) pass2Source = fresh;
      } catch (e: unknown) {
        // Pass 2 cannot run on a stale copy: it would see no English and skip the
        // very fields pass 1 just filled, completing the mantra with a silent gap.
        // Count it as a failure so the queue retries (pass 1 is then a no-op).
        fail += 1;
        const msg = e instanceof Error ? e.message.slice(0, 120) : String(e);
        lines.push(
          `${mantraLabel}: English written but re-reading the mantra failed (${msg}) — the other languages were not attempted.`,
        );
        console.warn(`[pass 1] could not re-read ${mantraLabel} after the English pass: ${msg}`);
        return { ok, fail, englishUnits: englishUnits.length, otherUnits: 0, lines, aborted };
      }
    }
  }

  if (aborted) {
    return { ok, fail, englishUnits: englishUnits.length, otherUnits: 0, lines, aborted };
  }

  const otherUnits = buildJobsForMantra(pass2Source, mantraLabel, granthaName)
    .map((unit) => narrowToRequestedLanguages(unit, passOpts.requestedLanguages ?? []))
    .filter((unit) => unit.targetLanguages.length > 0);

  for (const unit of otherUnits) {
    if (!(await runUnit(unit))) break;
  }

  return { ok, fail, englishUnits: englishUnits.length, otherUnits: otherUnits.length, lines, aborted };
}

export function printMantraSummary(mantra: any, label: string): void {
  console.log(`  ${label}: Shloka ${filledLangs(mantra.ShlokaManthraEntry).size}/43, Bhashyam ${filledLangs(mantra.BhashyamEntry).size}/43`);
  for (const t of mantra.Teekas ?? []) {
    console.log(`    Teeka ${t.teeka?.TeekaName}: ${filledLangs(t.TeekaEntry).size}/43`);
  }
}
