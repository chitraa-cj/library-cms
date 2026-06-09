import { Router } from "express";
import { requireAuth } from "./auth";
import { storage } from "./storage";
import {
  sortKeyBetween,
  STRAPI_SORT_GAP,
  portalIndexToStrapiSortKey,
} from "@shared/mantra-sort-key";
import {
  assertConfiguredLeafOnLabel,
  assertVerseSuffixStable,
  isPublishIntegrityEnabled,
  mantraNumberSuffix,
  portalMantraTitleForConfiguredLeaf,
  flatMantraLabelFromSpacedSortKey,
  isBareLeafCounterTitle,
  sectionSuffixCollision,
} from "@shared/grantha-publish-integrity";
import { validateMantraLabelForCmsCreate } from "@shared/mantra-cms-guard";

const STRAPI_URL = process.env.STRAPI_URL || "http://13.53.121.15:1337";
const STRAPI_ADMIN_NOTE =
  "This collection type is not available via the CMS portal REST proxy. Manage it in Strapi Content Manager.";

/**
 * Per-section serialization for read-modify-write operations on Strapi mantra `order`
 * (insert-between, recompaction, sibling reorder publish). Concurrent inserts that race
 * on the same section pick identical fractional keys and silently corrupt sort order;
 * this in-process mutex chain ensures one writer per section at a time. Mirrors the
 * withDraftLock pattern in routes.ts.
 */
const sectionOperationQueues = new Map<string, Promise<void>>();
export async function withSectionLock<T>(
  sectionDocId: string,
  op: () => Promise<T>,
): Promise<T> {
  const previous = sectionOperationQueues.get(sectionDocId) ?? Promise.resolve();
  const running = previous.then(op, op);
  const settled = running.then(
    () => undefined,
    () => undefined,
  );
  sectionOperationQueues.set(sectionDocId, settled);
  try {
    return await running;
  } finally {
    if (sectionOperationQueues.get(sectionDocId) === settled) {
      sectionOperationQueues.delete(sectionDocId);
    }
  }
}

async function listSectionMantraOrders(sectionDocId: string): Promise<
  Array<{ documentId: string; order: number; ShlokaManthraNumber?: string }>
> {
  const sectionFilter = encodeURIComponent(sectionDocId);
  const listQuery = [
    `filters[Section][documentId][$eq]=${sectionFilter}`,
    "fields[0]=documentId",
    "fields[1]=order",
    "fields[2]=ShlokaManthraNumber",
    "pagination[pageSize]=100",
    "sort=order:asc",
  ].join("&");

  const all: Array<{ documentId: string; order: number; ShlokaManthraNumber?: string }> = [];
  let page = 1;
  while (true) {
    const r = await strapiRequest(`/api/manthras?${listQuery}&pagination[page]=${page}`);
    for (const row of r.data ?? []) {
      if (typeof row.documentId === "string") {
        all.push({
          documentId: row.documentId,
          order: typeof row.order === "number" ? row.order : 0,
          ShlokaManthraNumber: row.ShlokaManthraNumber,
        });
      }
    }
    if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  all.sort((a, b) => a.order - b.order);
  return all;
}

/**
 * Reassign spaced sort keys (GAP, 2*GAP, 3*GAP …) for every row in a section.
 * Rare: only triggered when the fractional gap between two siblings collapses to
 * MIN_STRAPI_SORT_GAP. Runs with bounded concurrency; fractional keys do not
 * collide so descending order is unnecessary.
 */
const RECOMPACT_CONCURRENCY = 12;
async function recompactSectionSortKeys(
  sectionDocId: string,
  documentIdsInDisplayOrder: string[],
): Promise<void> {
  const updates = documentIdsInDisplayOrder.map((documentId, idx) => ({
    documentId,
    order: portalIndexToStrapiSortKey(idx + 1),
  }));
  console.warn(
    `[sort-key] recompact triggered section=${sectionDocId} rows=${updates.length}`,
  );
  for (let i = 0; i < updates.length; i += RECOMPACT_CONCURRENCY) {
    const batch = updates.slice(i, i + RECOMPACT_CONCURRENCY);
    await Promise.all(
      batch.map((u) =>
        strapiRequest(`/api/manthras/${u.documentId}`, {
          method: "PUT",
          body: JSON.stringify({ data: { order: u.order } }),
        }),
      ),
    );
  }
}
const STRAPI_TOKEN = () => process.env.STRAPI_API_TOKEN || "";

/**
 * Make a Strapi media URL loadable from anywhere. Strapi's local upload provider
 * returns root-relative paths (e.g. `/uploads/cover_3f2a.jpg`); prefix them with
 * STRAPI_URL so the CMS (served from a different origin) and any external consumer
 * can load the asset directly. URLs that are already absolute (S3/CDN providers)
 * are returned unchanged.
 */
export function absolutizeMediaUrl(url?: string | null): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return `${STRAPI_URL}${url.startsWith("/") ? "" : "/"}${url}`;
}

/** Normalize a grantha's `coverImage` media so its `url` is absolute. Mutates in place. */
export function absolutizeGranthaCover(grantha: any): any {
  if (grantha?.coverImage?.url) {
    grantha.coverImage = { ...grantha.coverImage, url: absolutizeMediaUrl(grantha.coverImage.url) };
  }
  return grantha;
}

/**
 * Upload a single file to the Strapi media library (POST {STRAPI_URL}/api/upload,
 * multipart field `files`). Returns Strapi's media array. Used to store grantha
 * cover images so they live in Strapi and are loadable from anywhere. The shared
 * `fetchRequest` can't be reused here because it hardcodes a JSON Content-Type;
 * multipart needs fetch to set its own boundary, so this is a dedicated path.
 */
export async function uploadToStrapi(
  fileBuffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<Array<{ id: number; documentId?: string; url: string; alternativeText: string | null; width?: number; height?: number; name?: string }>> {
  const form = new FormData();
  form.append("files", new Blob([fileBuffer], { type: mimeType }), filename);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("max-time exceeded")), STRAPI_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${STRAPI_URL}/api/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${STRAPI_TOKEN()}` },
      body: form,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Strapi upload failed (${res.status}): ${text.slice(0, 500)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function classifyStrapiError(status?: number, body?: string): string {
  if (status === 401 || status === 403) return "upstream_auth";
  if (status === 408 || status === 429) return "upstream_timeout";
  if (status && status >= 500) return "upstream_server";
  if (body?.includes("FortiGuard") || body?.includes("Access Blocked")) return "upstream_policy_block";
  return "upstream_unknown";
}

/**
 * HTTP transport. Previously spawned `curl` per request (process fork + temp-file
 * write); for a grantha publish with 1000+ mantras × 3-5 Strapi calls each, that
 * was the dominant cost (~30-50ms overhead per call).
 *
 * Switched to native global fetch (Node 18+ undici) which keeps connections alive
 * via the default Agent. Large bodies are streamed, so the E2BIG / temp-file
 * workaround is no longer needed. Errors are normalized to the same "curl failed"
 * / "curl no-status" / "max-time" phrases that strapiRequest's retry classifier
 * already understands, so backoff behavior is preserved.
 */
// Per-request timeout for standard Strapi calls. Env-tunable so heavy CLI runs (e.g. the
// hermex translator's full-populate per-mantra GETs against a slow remote Strapi) can raise
// it without changing the web app's default. Set STRAPI_HTTP_TIMEOUT_MS in that run's env.
const STRAPI_HTTP_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.STRAPI_HTTP_TIMEOUT_MS) || 40_000,
);
async function fetchRequest(
  url: string,
  method = "GET",
  body?: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("max-time exceeded")), STRAPI_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${STRAPI_TOKEN()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text };
  } catch (e: any) {
    if (e?.name === "AbortError" || e?.message?.includes("max-time")) {
      throw new Error(`curl failed: max-time exceeded after ${STRAPI_HTTP_TIMEOUT_MS}ms`);
    }
    // Normalize to "curl failed:" prefix so the existing transient-error matcher fires.
    throw new Error(`curl failed: ${e?.message || String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function strapiRequest(
  path: string,
  options: { method?: string; body?: string } = {},
  _maxRetries = 3
) {
  const url = `${STRAPI_URL}${path}`;
  const method = options.method || "GET";
  let lastErr: any;
  const requestId = Math.random().toString(36).slice(2, 10);

  for (let attempt = 1; attempt <= _maxRetries; attempt++) {
    try {
      const res = await fetchRequest(url, method, options.body);

      if (!res.ok) {
        const err = new Error(`Strapi error ${res.status}: ${res.body.slice(0, 300)}`) as any;
        err.status = res.status;
        err.code = classifyStrapiError(res.status, res.body);
        err.requestId = requestId;

        // Most 4xx are permanent; retry WAF/rate-limit style blocks
        const isHtmlBlock =
          res.body?.includes("<!DOCTYPE") ||
          res.body?.includes("FortiGuard") ||
          res.body?.includes("Access Blocked");
        const retriable4xx =
          res.status === 429 ||
          res.status === 408 ||
          (res.status === 403 && isHtmlBlock);
        if (res.status >= 400 && res.status < 500 && !retriable4xx) throw err;

        // 5xx → server-side transient failure, worth retrying
        lastErr = err;
      } else {
        if (!res.body.trim()) return { data: null };
        try { return JSON.parse(res.body); }
        catch { return { data: null }; }
      }
    } catch (e: any) {
      // Network/timeout errors from curl (no HTTP status) → retryable
      const isNetwork = e?.message?.includes("curl failed") ||
                        e?.message?.includes("curl no-status") ||
                        e?.message?.includes("max-time");
      if (!isNetwork) throw e; // propagate non-transient errors immediately
      e.code = e.code || "upstream_timeout";
      e.requestId = e.requestId || requestId;
      lastErr = e;
    }

    if (attempt < _maxRetries) {
      const waitMs = attempt * 1500; // bounded backoff
      console.warn(`[strapi][${requestId}] ${method} ${path} attempt ${attempt}/${_maxRetries} failed (${lastErr?.code || "unknown"}) — retrying in ${waitMs}ms…`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  throw lastErr;
}

/** Max Strapi list pages fetched concurrently. Firing every page at once (Promise.all over
 *  dozens of pages) makes the remote Strapi queue/throttle them — slower and flakier than a
 *  steady stream of small batches. Tune with STRAPI_PAGE_BATCH_SIZE. */
const STRAPI_PAGE_BATCH_SIZE = Math.max(
  1,
  Number(process.env.STRAPI_PAGE_BATCH_SIZE) || 5,
);

/**
 * Fetch every page of a paginated Strapi list with bounded concurrency.
 * Page 1 is fetched first to learn the page count; remaining pages are fetched in batches of
 * `batchSize` (default STRAPI_PAGE_BATCH_SIZE) instead of all at once.
 * Returns the flattened `data`, plus the first page and its pagination meta for callers that
 * need `total` / `pageCount` (e.g. to report completeness or rebuild the response envelope).
 */
async function fetchAllStrapiPages(
  buildUrl: (page: number) => string,
  opts?: { batchSize?: number },
): Promise<{ data: any[]; firstPage: any; pageCount: number; total: number }> {
  const batchSize = Math.max(1, opts?.batchSize ?? STRAPI_PAGE_BATCH_SIZE);
  const firstPage = await strapiRequest(buildUrl(1));
  const pageCount: number = firstPage?.meta?.pagination?.pageCount ?? 1;
  const total: number = firstPage?.meta?.pagination?.total ?? (firstPage?.data?.length ?? 0);
  const data: any[] = [...(firstPage?.data ?? [])];
  for (let start = 2; start <= pageCount; start += batchSize) {
    const end = Math.min(start + batchSize - 1, pageCount);
    const batch = await Promise.all(
      Array.from({ length: end - start + 1 }, (_, i) => strapiRequest(buildUrl(start + i))),
    );
    for (const p of batch) data.push(...(p?.data ?? []));
  }
  return { data, firstPage, pageCount, total };
}

/** Full-populate mantra/backup pages can exceed 30s — allow 2 min per page. */
const STRAPI_LARGE_HTTP_TIMEOUT_MS = 120_000;

async function fetchLargeOnce(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("max-time exceeded")), STRAPI_LARGE_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${STRAPI_TOKEN()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    const rawBody = await res.text();
    if (!res.ok) {
      const e = new Error(`Strapi error ${res.status}: ${rawBody.slice(0, 300)}`) as any;
      e.status = res.status;
      throw e;
    }
    if (!rawBody.trim()) return { data: null };
    try {
      return JSON.parse(rawBody);
    } catch {
      return { data: null };
    }
  } catch (e: any) {
    if (e?.status) throw e;
    if (e?.name === "AbortError" || e?.message?.includes("max-time")) {
      throw new Error(
        `curl large failed: max-time exceeded after ${STRAPI_LARGE_HTTP_TIMEOUT_MS}ms`,
      );
    }
    throw new Error(`curl large failed: ${e?.message || String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET endpoints that can return very large payloads (e.g. full populate of manthras
 * with rich-text blocks). Native fetch streams the response body — no maxBuffer
 * limit and no temp-file round-trip required.
 */
export async function strapiRequestLarge(path: string, maxRetries = 3): Promise<any> {
  const url = `${STRAPI_URL}${path}`;
  let lastErr: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fetchLargeOnce(url);
    } catch (e: any) {
      const isNetwork =
        e?.message?.includes("curl large failed") && !e?.status;
      if (!isNetwork) throw e;
      lastErr = e;
      if (attempt < maxRetries) {
        const waitMs = attempt * 2000;
        console.warn(
          `[strapi] large GET attempt ${attempt}/${maxRetries} failed — retrying in ${waitMs}ms…`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
  throw lastErr;
}

export function createStrapiRouter() {
  const router = Router();

  router.use(requireAuth);

  const contentTypes = [
    { path: "granthas", plural: "granthas" },
    { path: "teekas", plural: "teekas" },
    { path: "articles", plural: "articles" },
    { path: "authors", plural: "authors" },
    { path: "categories", plural: "categories" },
    { path: "chapters", plural: "chapters" },
  ];

  const DEEP_POPULATE: Record<string, string> = {
    granthas: [
      "populate[BhashyakaraIntroduction][populate]=*",
      "populate[GranthaNameTranslations]=*",
      "populate[coverImage][fields][0]=url&populate[coverImage][fields][1]=alternativeText&populate[coverImage][fields][2]=width&populate[coverImage][fields][3]=height",
      "populate[teekas][fields][0]=documentId&populate[teekas][fields][1]=TeekaName&populate[teekas][fields][2]=TeekaAuthor",
      "pagination[pageSize]=100",
      "sort=GranthaName:asc",
    ].join("&"),
    teekas: [
      "populate[grantha][fields][0]=documentId&populate[grantha][fields][1]=GranthaName",
      "pagination[pageSize]=100",
      "sort=TeekaName:asc",
    ].join("&"),
    chapters: [
      "populate[grantha][fields][0]=documentId&populate[grantha][fields][1]=GranthaName",
      "populate[parent][fields][0]=documentId&populate[parent][fields][1]=ChapterTitle",
      "populate[children][fields][0]=documentId&populate[children][fields][1]=ChapterTitle&populate[children][fields][2]=order",
      "populate[ShlokaManthraEntry]=*",
      "populate[BhashyamForShlokaManthra]=*",
      "populate[Teekas]=*",
      "pagination[pageSize]=100",
    ].join("&"),
    articles: [
      "populate=*",
      "pagination[pageSize]=100",
      "sort=createdAt:desc",
    ].join("&"),
    authors: [
      "populate=*",
      "pagination[pageSize]=100",
      "sort=name:asc",
    ].join("&"),
    categories: [
      "populate=*",
      "pagination[pageSize]=100",
      "sort=name:asc",
    ].join("&"),
  };

  // ── Sections: fetch directly from /api/sections ──
  // Strapi v5 does NOT support `populate[relation][pagination]` or
  // `populate[relation][sort]` for direct relation populates. Those keys are only
  // valid inside the deep-populate `[populate]` nesting syntax. Using them causes
  // a 400 ValidationError. Both section populate configs below intentionally omit
  // those keys. The default Strapi relation limit (25) applies for inline manthras;
  // the by-grantha endpoint supplements with a separate paginated manthra fetch to
  // guarantee completeness.

  // Metadata-only section populate — used by the sections list page and by-grantha.
  // Manthra count for the list is derived from the (up to 25) inline manthras;
  // by-grantha supplements with a separate complete manthra fetch.
  const SECTION_POPULATE = [
    "populate[grantha][fields][0]=id",
    "populate[grantha][fields][1]=documentId",
    "populate[grantha][fields][2]=GranthaName",
    "populate[parent][fields][0]=documentId",
    "populate[parent][fields][1]=title",
    "populate[parent][fields][2]=type",
    "populate[sub_sections][fields][0]=documentId",
    "populate[sub_sections][fields][1]=title",
    "populate[manthras][fields][0]=documentId",
    "populate[manthras][fields][1]=ShlokaManthraNumber",
    "populate[manthras][fields][2]=order",
    "populate[titleTranslations]=*",
    "pagination[pageSize]=100",
  ].join("&");

  // Lightweight populate for the sections list page (same as SECTION_POPULATE —
  // manthra ids only, no ShlokaManthraNumber/order needed for the list count).
  const SECTION_LIST_POPULATE = [
    "populate[grantha][fields][0]=id",
    "populate[grantha][fields][1]=documentId",
    "populate[grantha][fields][2]=GranthaName",
    "populate[parent][fields][0]=documentId",
    "populate[parent][fields][1]=title",
    "populate[parent][fields][2]=type",
    "populate[sub_sections][fields][0]=documentId",
    "populate[sub_sections][fields][1]=title",
    "populate[manthras][fields][0]=id",
    "populate[titleTranslations]=*",
    "pagination[pageSize]=100",
  ].join("&");

  router.get("/sections", async (req, res) => {
    try {
      const queryString = req.url.includes("?") ? req.url.substring(req.url.indexOf("?") + 1) : "";
      // Passthrough: if caller supplies their own params (e.g. dashboard count query),
      // use those as-is. Otherwise paginate through all sections with the lightweight populate.
      if (queryString) {
        const data = await strapiRequest(`/api/sections?${queryString}`);
        return res.json(data);
      }

      // Multi-page fetch: collect all sections across every page (in bounded batches).
      const { data: allData, firstPage, pageCount } = await fetchAllStrapiPages(
        (page) => `/api/sections?${SECTION_LIST_POPULATE}&pagination[page]=${page}`,
      );

      if (pageCount <= 1) {
        return res.json(firstPage);
      }

      return res.json({
        data: allData,
        meta: { pagination: { page: 1, pageSize: allData.length, pageCount: 1, total: allData.length } },
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch sections" });
    }
  });

  // Fetch all sections + all manthras for a specific grantha.
  // Called on-demand when opening the grantha edit dialog.
  // Two-step strategy:
  //   1. Fetch sections for this grantha (metadata only, paginated)
  //   2. Fetch ALL manthras for this grantha separately (paginated, unaffected by the
  //      Strapi v5 25-item relation cap), then attach them to their sections server-side.
  router.get("/sections/by-grantha/:granthaDocId", async (req, res) => {
    try {
      const g = encodeURIComponent(req.params.granthaDocId);

      // Section metadata populate — no manthras inline (avoids the 25-item cap issue).
      const sectionMeta = [
        "populate[grantha][fields][0]=id",
        "populate[grantha][fields][1]=documentId",
        "populate[grantha][fields][2]=GranthaName",
        "populate[parent][fields][0]=documentId",
        "populate[parent][fields][1]=title",
        "populate[parent][fields][2]=type",
        "populate[sub_sections][fields][0]=documentId",
        "populate[sub_sections][fields][1]=title",
        "populate[titleTranslations]=*",
        "pagination[pageSize]=100",
      ].join("&");

      const sectionFilter = `filters[grantha][documentId][$eq]=${g}`;

      const manthraQuery = [
        "fields[0]=documentId",
        "fields[1]=ShlokaManthraNumber",
        "fields[2]=order",
        "fields[3]=id",
        "populate[Section][fields][0]=documentId",
        "populate[ShlokaManthraEntry][fields][0]=SanskritTextEntry",
        "populate[ShlokaManthraEntry][fields][1]=EnglishTranslationText",
        `filters[Section][grantha][documentId][$eq]=${g}`,
        "sort[0]=order:asc",
        "pagination[pageSize]=100",
      ].join("&");

      // Sections and manthras are independent fetches — run both phases concurrently so the
      // grantha editor load is bounded by the slower of the two, not their sum. Each phase
      // still fetches its own remaining pages in parallel.
      // Sections and manthras are independent — run both phases concurrently so editor load
      // is bounded by the slower of the two, not their sum. Each phase fetches its own pages
      // in bounded batches (not all at once) to avoid overwhelming the remote Strapi.
      const [{ data: allSections }, { data: allManthras }] = await Promise.all([
        fetchAllStrapiPages(
          (page) => `/api/sections?${sectionFilter}&${sectionMeta}&pagination[page]=${page}`,
        ),
        fetchAllStrapiPages(
          (page) => `/api/manthras?${manthraQuery}&pagination[page]=${page}`,
        ),
      ]);

      // ── Step 3: group manthras by section documentId ──
      const manthrasBySection = new Map<string, any[]>();
      for (const m of allManthras) {
        const sectionDocId = m.Section?.documentId;
        if (!sectionDocId) continue;
        if (!manthrasBySection.has(sectionDocId)) manthrasBySection.set(sectionDocId, []);
        manthrasBySection.get(sectionDocId)!.push({
          id: m.id,
          documentId: m.documentId,
          ShlokaManthraNumber: m.ShlokaManthraNumber,
          order: m.order,
          ShlokaManthraEntry: m.ShlokaManthraEntry ?? null,
        });
      }

      // ── Step 4: attach manthras to sections ──
      const enrichedSections = allSections.map((s: any) => ({
        ...s,
        manthras: manthrasBySection.get(s.documentId) ?? [],
      }));

      res.json({
        data: enrichedSections,
        meta: { pagination: { page: 1, pageSize: enrichedSections.length, pageCount: 1, total: enrichedSections.length } },
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch sections for grantha" });
    }
  });

  router.get("/sections/:documentId", async (req, res) => {
    try {
      const data = await strapiRequest(`/api/sections/${req.params.documentId}?${SECTION_POPULATE}`);
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch section" });
    }
  });

  router.post("/sections", async (req, res) => {
    try {
      const data = await strapiRequest("/api/sections", { method: "POST", body: JSON.stringify(req.body) });
      res.json(data);
    } catch (error: any) {
      res.status(error.status || 500).json({ message: error.message });
    }
  });
  router.put("/sections/:documentId", async (req, res) => {
    try {
      const data = await strapiRequest(`/api/sections/${req.params.documentId}`, { method: "PUT", body: JSON.stringify(req.body) });
      res.json(data);
    } catch (error: any) {
      res.status(error.status || 500).json({ message: error.message });
    }
  });
  router.delete("/sections/:documentId", async (req, res) => {
    try {
      const data = await strapiRequest(`/api/sections/${req.params.documentId}`, { method: "DELETE" });
      res.json(data);
    } catch (error: any) {
      res.status(error.status || 500).json({ message: error.message });
    }
  });

  // ── Manthras: fetch directly from /api/manthras ──

  // Lightweight populate — only what's needed to render the list rows.
  // Omits heavy bhashyam / teeka / OtherTranslations content so that all
  // pages fit well within response-size limits and Section.grantha is
  // reliably populated for every record (Strapi v5 silently drops nested
  // sub-relations when individual record payloads are very large).
  const MANTHRA_LIST_POPULATE = [
    "populate[Section][fields][0]=id",
    "populate[Section][fields][1]=documentId",
    "populate[Section][fields][2]=title",
    "populate[Section][fields][3]=type",
    "populate[Section][populate][grantha][fields][0]=id",
    "populate[Section][populate][grantha][fields][1]=documentId",
    "populate[Section][populate][grantha][fields][2]=GranthaName",
    "populate[ShlokaManthraEntry][fields][0]=SanskritTextEntry",
    "populate[ShlokaManthraEntry][fields][1]=EnglishTranslationText",
    "pagination[pageSize]=100",
  ].join("&");

  // Full populate — used only for the single-manthra detail fetch (edit form).
  const MANTHRA_POPULATE = [
    "populate[Section][fields][0]=id",
    "populate[Section][fields][1]=documentId",
    "populate[Section][fields][2]=title",
    "populate[Section][fields][3]=type",
    "populate[Section][populate][grantha][fields][0]=id",
    "populate[Section][populate][grantha][fields][1]=documentId",
    "populate[Section][populate][grantha][fields][2]=GranthaName",
    "populate[ShlokaManthraEntry][populate]=*",
    "populate[BhashyamEntry][populate]=*",
    "populate[Teekas][populate][teeka][fields][0]=documentId&populate[Teekas][populate][teeka][fields][1]=TeekaName&populate[Teekas][populate][teeka][fields][2]=TeekaAuthor&populate[Teekas][populate][TeekaEntry][populate][OtherTranslations]=*",
    "populate[wordMeanings]=*",
    "pagination[pageSize]=100",
  ].join("&");

  router.get("/manthras", async (_req, res) => {
    try {
      // Fetch all pages — Strapi hard-caps pageSize at 100, so we loop until we
      // have collected every manthra rather than silently dropping page 2+.
      function normaliseManthra(m: any) {
        const sec = m.Section;
        return {
          ...m,
          section: sec ? { id: sec.id, documentId: sec.documentId, title: sec.title, type: sec.type } : null,
          grantha: sec?.grantha ?? null,
        };
      }

      // Fetch every page in bounded batches (not all at once) so the remote Strapi isn't
      // hit with dozens of simultaneous requests — that throttles and slows the whole load.
      const { data: rawManthras, firstPage, pageCount, total: strapiTotal } =
        await fetchAllStrapiPages(
          (page) => `/api/manthras?${MANTHRA_LIST_POPULATE}&pagination[page]=${page}`,
        );
      const allManthras: any[] = rawManthras.map(normaliseManthra);

      const fetchComplete = allManthras.length >= strapiTotal;
      if (!fetchComplete) {
        console.warn(
          `[strapi] Manthras list incomplete: fetched ${allManthras.length}/${strapiTotal} (${pageCount} pages)`,
        );
      }

      res.json({
        ...firstPage,
        data: allManthras,
        meta: {
          ...(firstPage.meta ?? {}),
          pagination: {
            ...(firstPage.meta?.pagination ?? {}),
            total: strapiTotal,
            pageCount,
            pageSize: allManthras.length,
          },
          cmsFetch: {
            rowsReturned: allManthras.length,
            strapiTotal,
            pagesExpected: pageCount,
            pagesFetched: pageCount,
            complete: fetchComplete,
          },
        },
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch manthras" });
    }
  });

  // ── Bulk teeka fetch for all manthras in a grantha ──
  // Called once during grantha load to pre-populate teeka data into the portal
  // hierarchy state. This ensures teeka content is ALWAYS present in state and
  // can never be accidentally cleared by saving before opening each dialog.
  router.get("/manthras/teekas-by-grantha/:granthaDocId", async (req, res) => {
    try {
      const { granthaDocId } = req.params;
      const BULK_TEEKA_POPULATE = [
        `filters[Section][grantha][documentId][$eq]=${granthaDocId}`,
        "populate[Teekas][populate][teeka][fields][0]=documentId",
        "populate[Teekas][populate][teeka][fields][1]=TeekaName",
        "populate[Teekas][populate][teeka][fields][2]=TeekaAuthor",
        "populate[Teekas][populate][TeekaEntry][populate]=*",
        "fields[0]=documentId",
        "pagination[pageSize]=100",
      ].join("&");

      // Bounded-batch pagination — avoid firing every page at the remote Strapi at once.
      const { data: allManthras } = await fetchAllStrapiPages(
        (page) => `/api/manthras?${BULK_TEEKA_POPULATE}&pagination[page]=${page}`,
      );

      // Return map: manthraDocumentId → teekas[] (only where teeka has content)
      const result: Record<string, any[]> = {};
      for (const m of allManthras) {
        if (!m.documentId || !Array.isArray(m.Teekas) || !m.Teekas.length) continue;
        const withContent = m.Teekas.filter((t: any) => {
          const te = t.TeekaEntry;
          return te && (
            (Array.isArray(te.SanskritTextEntry) && te.SanskritTextEntry.length > 0) ||
            (Array.isArray(te.OtherTranslations) && te.OtherTranslations.length > 0)
          );
        });
        if (withContent.length > 0) result[m.documentId] = withContent;
      }

      res.json({ data: result });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch bulk teekas" });
    }
  });

  // ── Bulk FULL-content fetch for every manthra in a grantha ──
  // Used by the grantha editor to fully hydrate the draft on open so editing is
  // entirely draft-driven (no per-verse Strapi fetch/merge — that label-matched
  // merge is what grafted a neighbour's bhashyam onto the wrong verse after a "+"
  // insert renumber). Returns content keyed STRICTLY by the verse's own
  // documentId — never by label/ShlokaManthraNumber.
  router.get("/manthras/full-by-grantha/:granthaDocId", async (req, res) => {
    try {
      const { granthaDocId } = req.params;
      const BULK_FULL_POPULATE = [
        `filters[Section][grantha][documentId][$eq]=${granthaDocId}`,
        "fields[0]=documentId",
        "fields[1]=ShlokaManthraNumber",
        "populate[ShlokaManthraEntry][populate]=*",
        "populate[BhashyamEntry][populate]=*",
        "populate[Teekas][populate][teeka][fields][0]=documentId",
        "populate[Teekas][populate][teeka][fields][1]=TeekaName",
        "populate[Teekas][populate][teeka][fields][2]=TeekaAuthor",
        "populate[Teekas][populate][TeekaEntry][populate]=*",
        // Heavy rich-text populate — keep pages small so payloads stay well under
        // Strapi v5's sub-relation drop threshold.
        "pagination[pageSize]=50",
      ].join("&");

      // Bounded-batch pagination — avoid firing every page at the remote Strapi at once.
      const { data: allManthras } = await fetchAllStrapiPages(
        (page) => `/api/manthras?${BULK_FULL_POPULATE}&pagination[page]=${page}`,
      );

      // Map: manthra documentId → { ShlokaManthraEntry, BhashyamEntry, Teekas }.
      const result: Record<string, { ShlokaManthraEntry: any; BhashyamEntry: any; Teekas: any[] }> = {};
      for (const m of allManthras) {
        if (!m.documentId) continue;
        result[m.documentId] = {
          ShlokaManthraEntry: m.ShlokaManthraEntry ?? null,
          BhashyamEntry: m.BhashyamEntry ?? null,
          Teekas: Array.isArray(m.Teekas) ? m.Teekas : [],
        };
      }

      res.json({ data: result });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch full mantra content for grantha" });
    }
  });

  function mantraNumberSuffix(label: string): string | null {
    const m = String(label || "")
      .trim()
      .match(/([\d]+(?:\.[\d]+)*)\s*$/);
    return m ? m[1] : null;
  }

  function blocksPlainTextForScore(v: any): string {
    if (!v) return "";
    if (typeof v === "string") return v;
    if (!Array.isArray(v)) return "";
    return v
      .map((block: any) =>
        (block?.children ?? [])
          .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
          .join(""),
      )
      .join("\n")
      .trim();
  }

  function mantraEntryContentScore(entry: any): number {
    if (!entry || typeof entry !== "object") return 0;
    return (
      blocksPlainTextForScore(entry.SanskritTextEntry).length +
      blocksPlainTextForScore(entry.EnglishTranslationText).length
    );
  }

  /** Total publishable text on a fully-populated mantra — Shloka + Bhashyam + every Teeka.
   *  Scoring only the verse text wrongly treats a commentary-only mantra as "empty" and lets
   *  resolve-for-edit swap it for a content-bearing sibling. Section-list candidates only
   *  populate ShlokaManthraEntry, so for those this degrades to the verse-text score. */
  function mantraRowContentScore(m: any): number {
    if (!m || typeof m !== "object") return 0;
    let score = mantraEntryContentScore(m.ShlokaManthraEntry) + mantraEntryContentScore(m.BhashyamEntry);
    if (Array.isArray(m.Teekas)) {
      for (const t of m.Teekas) score += mantraEntryContentScore(t?.TeekaEntry);
    }
    return score;
  }

  function labelsShareVerseSuffix(a: string, b: string): boolean {
    const sa = mantraNumberSuffix(a);
    const sb = mantraNumberSuffix(b);
    return !!(sa && sb && sa === sb);
  }

  const MANTHRA_RESOLVE_LIST_POPULATE = [
    "fields[0]=documentId",
    "fields[1]=ShlokaManthraNumber",
    "fields[2]=order",
    "populate[Section][fields][0]=documentId",
    "populate[ShlokaManthraEntry][populate]=*",
  ].join("&");

  /** Section-scoped list for duplicate verse resolution (never loads the whole grantha). */
  async function fetchSectionMantrasForResolve(sectionDocId: string): Promise<any[]> {
    const s = encodeURIComponent(sectionDocId);
    const base = `filters[Section][documentId][$eq]=${s}&${MANTHRA_RESOLVE_LIST_POPULATE}`;
    const all: any[] = [];
    let page = 1;
    while (true) {
      const r = await strapiRequest(
        `/api/manthras?${base}&pagination[pageSize]=100&pagination[page]=${page}`,
      );
      all.push(...(r?.data ?? []));
      if (page >= (r?.meta?.pagination?.pageCount ?? 1)) break;
      page++;
    }
    return all;
  }

  /** Pick the CMS row with verse text for a label — same logic for Grantha editor and Mantras tab. */
  router.get("/manthras/resolve-for-edit", async (req, res) => {
    try {
      const label = String(req.query.label || "").trim();
      const preferredDocId = String(req.query.preferredDocId || "").trim();
      const sectionDocId = String(req.query.sectionDocId || "").trim();

      if (!label && !preferredDocId) {
        return res.status(400).json({ message: "label or preferredDocId is required" });
      }

      const candidates: any[] = [];
      const seen = new Set<string>();
      let preferredRow: any | null = null;

      const addCandidate = (row: any) => {
        const id = row?.documentId;
        if (!id || seen.has(id)) return;
        seen.add(id);
        candidates.push(row);
      };

      if (preferredDocId) {
        try {
          const one = await strapiRequest(`/api/manthras/${preferredDocId}?${MANTHRA_POPULATE}`);
          if (one?.data) {
            preferredRow = one.data;
            addCandidate(preferredRow);
          }
        } catch {
          /* preferred id may be orphaned */
        }
      }

      const preferredScore = preferredRow ? mantraRowContentScore(preferredRow) : 0;
      const preferredLabel = String(preferredRow?.ShlokaManthraNumber ?? "").trim();
      const labelMatchesPreferred =
        !label || !preferredLabel || labelsShareVerseSuffix(label, preferredLabel);

      // Fast path: substantive verse on the linked CMS row — do not re-resolve by portal label during renumber.
      if (preferredRow && preferredDocId && preferredScore >= 12) {
        const sec = preferredRow.Section;
        return res.json({
          data: {
            ...preferredRow,
            section: sec
              ? { id: sec.id, documentId: sec.documentId, title: sec.title, type: sec.type }
              : null,
            grantha: sec?.grantha ?? null,
          },
          documentId: preferredDocId,
          corrected: false,
          contentScore: preferredScore,
        });
      }

      if (sectionDocId) {
        for (const row of await fetchSectionMantrasForResolve(sectionDocId)) addCandidate(row);
      }

      const matchLabel =
        label ||
        String(
          candidates.find((c) => c.documentId === preferredDocId)?.ShlokaManthraNumber ?? "",
        ).trim();

      let hits = matchLabel
        ? candidates.filter((c) =>
            labelsShareVerseSuffix(matchLabel, String(c.ShlokaManthraNumber ?? "")),
          )
        : [];

      // Prefer the mantra row in the editor's section — avoid swapping verse content from a sibling section.
      if (sectionDocId && hits.length > 1) {
        const inSection = hits.filter((c) => c.Section?.documentId === sectionDocId);
        if (inSection.length > 0) hits = inSection;
      }

      if (hits.length === 0 && preferredDocId) {
        hits = candidates.filter((c) => c.documentId === preferredDocId);
      }

      const scored = hits.map((row) => ({
        row,
        score: mantraEntryContentScore(row.ShlokaManthraEntry),
        order: row.order ?? Number.MAX_SAFE_INTEGER,
      }));

      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (preferredDocId) {
          if (a.row.documentId === preferredDocId) return -1;
          if (b.row.documentId === preferredDocId) return 1;
        }
        if (a.order !== b.order) return a.order - b.order;
        return String(a.row.documentId).localeCompare(String(b.row.documentId));
      });

      const winner = scored[0]?.row;
      if (!winner?.documentId) {
        return res.status(404).json({ message: "No matching manthra found for this verse" });
      }

      const corrected = !!(preferredDocId && winner.documentId !== preferredDocId);
      const m =
        !corrected && preferredRow && winner.documentId === preferredDocId
          ? preferredRow
          : (await strapiRequest(`/api/manthras/${winner.documentId}?${MANTHRA_POPULATE}`))?.data;

      if (!m) {
        return res.status(404).json({ message: "Manthra not found in CMS" });
      }

      const sec = m.Section;
      return res.json({
        data: {
          ...m,
          section: sec
            ? { id: sec.id, documentId: sec.documentId, title: sec.title, type: sec.type }
            : null,
          grantha: sec?.grantha ?? null,
        },
        documentId: winner.documentId,
        corrected,
        contentScore: mantraRowContentScore(m),
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to resolve manthra for edit" });
    }
  });

  router.get("/manthras/:documentId", async (req, res) => {
    try {
      const data = await strapiRequest(`/api/manthras/${req.params.documentId}?${MANTHRA_POPULATE}`);
      const m = data.data;
      if (m) {
        const sec = m.Section;
        data.data = {
          ...m,
          section: sec ? { id: sec.id, documentId: sec.documentId, title: sec.title, type: sec.type } : null,
          grantha: sec?.grantha ?? null,
        };
      }
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch manthra" });
    }
  });

  // ── Insert blank manthra: O(1) fractional sort key (no sibling order shifts) ──
  // Serialized per section: concurrent inserts on the same section would otherwise
  // observe the same prev/next snapshot and pick the same fractional key.
  router.post("/manthras/insert-between", async (req, res) => {
    try {
      const { afterDocumentId, sectionDocId, afterNum, ShlokaManthraNumber } = req.body as {
        afterDocumentId: string;
        sectionDocId: string;
        afterNum?: string;
        ShlokaManthraNumber?: string;
      };
      if (!afterDocumentId || !sectionDocId) {
        res.status(400).json({ message: "afterDocumentId and sectionDocId are required" });
        return;
      }
      const insertLabel = (ShlokaManthraNumber ?? "").trim();
      const insertLabelErr = validateMantraLabelForCmsCreate(insertLabel);
      if (insertLabelErr) {
        res.status(400).json({
          message: insertLabelErr,
          code: "blank_mantra_label",
        });
        return;
      }

      const result = await withSectionLock(sectionDocId, async () => {
        const all = await listSectionMantraOrders(sectionDocId);
        const anchorIdx = all.findIndex((m) => m.documentId === afterDocumentId);
        if (anchorIdx === -1) {
          const err: any = new Error(`Manthra ${afterDocumentId} not found in section`);
          err.status = 404;
          throw err;
        }

        const prevSort = all[anchorIdx].order;
        const nextSort = all[anchorIdx + 1]?.order;
        let { sortKey: newSortKey, needsRecompact } = sortKeyBetween(prevSort, nextSort);
        let recompacted = false;

        if (needsRecompact) {
          await recompactSectionSortKeys(
            sectionDocId,
            all.map((m) => m.documentId),
          );
          const refreshed = await listSectionMantraOrders(sectionDocId);
          const anchorIdx2 = refreshed.findIndex((m) => m.documentId === afterDocumentId);
          const again = sortKeyBetween(
            refreshed[anchorIdx2]?.order,
            refreshed[anchorIdx2 + 1]?.order,
          );
          newSortKey = again.sortKey;
          recompacted = true;
        }

        const created = await strapiRequest("/api/manthras", {
          method: "POST",
          body: JSON.stringify({
            data: {
              ShlokaManthraNumber: insertLabel,
              order: newSortKey,
              Section: sectionDocId,
            },
          }),
        });
        return { data: created.data, sortKey: newSortKey, recompacted };
      });

      res.json({ ...result, shiftedCount: 0 });
    } catch (error: any) {
      res.status(error.status || 500).json({ message: error.message });
    }
  });

  // Batch PUT order + ShlokaManthraNumber only (Strapi v5 merges; omits rich fields).
  router.post("/manthras/batch-identity-sync", async (req, res) => {
    try {
      const { updates, sortKeysOnly, configuredLeaf, allowRenumber } = req.body as {
        updates?: Array<{ documentId?: string; order?: number; ShlokaManthraNumber?: string }>;
        /** When true, only PUT `order` (fractional sort key) — labels unchanged. */
        sortKeysOnly?: boolean;
        configuredLeaf?: string;
        /** Insert/delete renumber: allow ShlokaManthraNumber suffix changes on existing rows. */
        allowRenumber?: boolean;
      };
      if (!Array.isArray(updates) || updates.length === 0) {
        res.status(400).json({ message: "updates must be a non-empty array" });
        return;
      }
      if (updates.length > 500) {
        res.status(400).json({ message: "updates array exceeds maximum (500)" });
        return;
      }

      const CONCURRENCY = 12;
      const results: Array<{ documentId: string; ok: boolean; error?: string; labelSkipped?: boolean; orphan?: boolean }> = [];

      // One PUT per Strapi documentId (after insert/renumber every sibling needs its own update).
      const byDocumentId = new Map<string, { documentId: string; order: number; ShlokaManthraNumber: string }>();
      for (const u of updates) {
        const documentId = (u.documentId ?? "").trim();
        if (!documentId || documentId.length < 10) continue;
        const label = (u.ShlokaManthraNumber ?? "").trim();
        byDocumentId.set(documentId, {
          documentId,
          order: typeof u.order === "number" && !Number.isNaN(u.order) ? u.order : 0,
          ShlokaManthraNumber: label,
        });
      }
      const dedupedUpdates = [...byDocumentId.values()];

      const orderToDocIds = new Map<number, string[]>();
      for (const u of dedupedUpdates) {
        if (!u.order) continue;
        const ids = orderToDocIds.get(u.order) ?? [];
        ids.push(u.documentId);
        orderToDocIds.set(u.order, ids);
      }
      const duplicateOrders = [...orderToDocIds.entries()].filter(([, ids]) => ids.length > 1);
      if (duplicateOrders.length > 0) {
        res.status(409).json({
          message: `Batch contains duplicate order values: ${duplicateOrders
            .map(([order, ids]) => `${order} (${ids.join(", ")})`)
            .join("; ")}`,
          code: "duplicate_order_in_batch",
        });
        return;
      }

      const sortedUpdates = dedupedUpdates.sort(
        (a, b) => (Number(b?.order) || 0) - (Number(a?.order) || 0),
      );

      const labelCache = new Map<string, string>();
      const integrityOn = isPublishIntegrityEnabled() && !sortKeysOnly;
      const renumberAllowed = !!allowRenumber;
      const leaf = (configuredLeaf || "Mantra").trim() || "Mantra";

      async function runChunk(chunk: typeof sortedUpdates) {
        for (const u of chunk) {
          const documentId = u?.documentId?.trim() || "";
          if (!documentId || documentId.length < 10) {
            results.push({ documentId: documentId || "(missing)", ok: false, error: "invalid documentId" });
            continue;
          }
          const order = typeof u.order === "number" && !Number.isNaN(u.order) ? u.order : 0;
          const rawLabel = (u.ShlokaManthraNumber ?? "").trim();
          let ShlokaManthraNumber = rawLabel
            ? portalMantraTitleForConfiguredLeaf(rawLabel, leaf)
            : "";
          if (isBareLeafCounterTitle(ShlokaManthraNumber)) ShlokaManthraNumber = "";
          if (!mantraNumberSuffix(ShlokaManthraNumber)) {
            const fromOrder = flatMantraLabelFromSpacedSortKey(order, leaf);
            if (fromOrder) ShlokaManthraNumber = fromOrder;
          }
          if (integrityOn && ShlokaManthraNumber.trim()) {
            const leafViolation = assertConfiguredLeafOnLabel(ShlokaManthraNumber, leaf);
            if (leafViolation) {
              results.push({ documentId, ok: false, error: leafViolation.message });
              continue;
            }
            // The existing label is consumed only by the suffix-stability guard below,
            // which is skipped entirely under allowRenumber. Fetching it otherwise adds
            // a GET per row — doubling Strapi round-trips on full label syncs (which run
            // with allowRenumber=true) and making large-grantha publishes crawl. Only
            // read it when the guard can actually use it.
            if (!renumberAllowed) {
              let existing = labelCache.get(documentId);
              if (existing === undefined) {
                try {
                  const one = await strapiRequest(
                    `/api/manthras/${documentId}?fields[0]=ShlokaManthraNumber`,
                  );
                  existing = String(one?.data?.ShlokaManthraNumber ?? "").trim();
                } catch {
                  existing = "";
                }
                labelCache.set(documentId, existing);
              }
              if (existing) {
                const suffixViolation = assertVerseSuffixStable(existing, ShlokaManthraNumber);
                if (suffixViolation) {
                  // Portal renumbered (insert/delete) but Strapi row still has the old verse id —
                  // update fractional sort key only; do not rewrite ShlokaManthraNumber.
                  try {
                    await strapiRequest(`/api/manthras/${documentId}`, {
                      method: "PUT",
                      body: JSON.stringify({ data: { order } }),
                    });
                    results.push({ documentId, ok: true, labelSkipped: true });
                  } catch (e: any) {
                    if (e?.status === 404) {
                      // Mantra was deleted in Strapi since this draft linked it —
                      // nothing to update. Treat as an orphan skip so one stale link
                      // can't fail the whole sync/publish.
                      results.push({ documentId, ok: true, orphan: true });
                    } else {
                      results.push({ documentId, ok: false, error: e?.message || String(e) });
                    }
                  }
                  continue;
                }
              }
            }
          }
          const data =
            sortKeysOnly || !ShlokaManthraNumber.trim()
              ? { order }
              : { order, ShlokaManthraNumber };
          try {
            await strapiRequest(`/api/manthras/${documentId}`, {
              method: "PUT",
              body: JSON.stringify({ data }),
            });
            results.push({ documentId, ok: true });
          } catch (e: any) {
            if (e?.status === 404) {
              // Mantra was deleted in Strapi since this draft linked it — nothing to
              // update. Treat as an orphan skip so one stale link can't fail the whole
              // sync/publish (mirrors how section sync tolerates 404s).
              results.push({ documentId, ok: true, orphan: true });
            } else {
              results.push({ documentId, ok: false, error: e?.message || String(e) });
            }
          }
        }
      }

      for (let i = 0; i < sortedUpdates.length; i += CONCURRENCY) {
        await runChunk(sortedUpdates.slice(i, i + CONCURRENCY));
      }

      res.json({ results });
    } catch (error: any) {
      res.status(error.status || 500).json({ message: error.message });
    }
  });

  /** Append blank mantra at end of section (max sort key + GAP). */
  router.post("/manthras/create-blank-in-section", async (req, res) => {
    try {
      const { sectionDocumentId, ShlokaManthraNumber } = req.body as {
        sectionDocumentId?: string;
        order?: number;
        ShlokaManthraNumber?: string;
      };
      const sid = (sectionDocumentId || "").trim();
      if (!sid || sid.length < 10) {
        res.status(400).json({ message: "sectionDocumentId is required" });
        return;
      }
      const label = (ShlokaManthraNumber ?? "").trim();
      const labelErr = validateMantraLabelForCmsCreate(label);
      if (labelErr) {
        res.status(400).json({ message: labelErr, code: "blank_mantra_label" });
        return;
      }

      const { created, sortKey } = await withSectionLock(sid, async () => {
        const all = await listSectionMantraOrders(sid);
        if (isPublishIntegrityEnabled() && label && isBareLeafCounterTitle(label)) {
          const err: any = new Error(
            `Bare verse labels like "${label}" are not allowed — use a dotted suffix (e.g. Vaakhyaa 1.1.1).`,
          );
          err.status = 400;
          err.code = "bare_leaf_counter_label";
          throw err;
        }
        if (isPublishIntegrityEnabled() && label) {
          const suf = mantraNumberSuffix(label);
          if (suf) {
            const collision = sectionSuffixCollision(
              all.map((r) => r.ShlokaManthraNumber),
              label,
            );
            if (collision) {
              const err: any = new Error(collision.message);
              err.status = 409;
              err.code = "duplicate_suffix_in_section";
              throw err;
            }
          }
        }
        const maxOrder = all.length > 0 ? Math.max(...all.map((r) => r.order)) : 0;
        const newSortKey = maxOrder > 0 ? maxOrder + STRAPI_SORT_GAP : STRAPI_SORT_GAP;
        const created = await strapiRequest("/api/manthras", {
          method: "POST",
          body: JSON.stringify({
            data: {
              Section: sid,
              order: newSortKey,
              ShlokaManthraNumber: label,
            },
          }),
        });
        return { created, sortKey: newSortKey };
      });

      res.json({ data: created.data, sortKey });
    } catch (error: any) {
      const status = error.status || 500;
      res.status(status).json({
        message: error.message,
        ...(error.code ? { code: error.code } : {}),
      });
    }
  });

  router.post("/manthras", async (req, res) => {
    try {
      const data = await strapiRequest("/api/manthras", { method: "POST", body: JSON.stringify(req.body) });
      res.json(data);
    } catch (error: any) {
      res.status(error.status || 500).json({ message: error.message });
    }
  });
  router.put("/manthras/:documentId", async (req, res) => {
    try {
      const data = await strapiRequest(`/api/manthras/${req.params.documentId}`, { method: "PUT", body: JSON.stringify(req.body) });
      res.json(data);
    } catch (error: any) {
      res.status(error.status || 500).json({ message: error.message });
    }
  });
  router.delete("/manthras/:documentId", async (req, res) => {
    try {
      const data = await strapiRequest(`/api/manthras/${req.params.documentId}`, { method: "DELETE" });
      res.json(data);
    } catch (error: any) {
      res.status(error.status || 500).json({ message: error.message });
    }
  });

  // ── Teekas: fetch all teekas for a specific grantha ──
  // Used by the grantha editor to load teeka definitions so the manthra
  // entry form can show teeka sections for each mantra.
  router.get("/teekas/by-grantha/:granthaDocId", async (req, res) => {
    try {
      const g = encodeURIComponent(req.params.granthaDocId);
      const query = [
        `filters[grantha][documentId][$eq]=${g}`,
        "fields[0]=documentId",
        "fields[1]=TeekaName",
        "fields[2]=TeekaAuthor",
        "sort=TeekaName:asc",
        "pagination[pageSize]=100",
      ].join("&");
      const data = await strapiRequest(`/api/teekas?${query}`);
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch teekas for grantha" });
    }
  });

  // ── Prasthana Thraya Screens: portal-only, no Strapi collection ──
  router.get("/prasthana-thraya-screens", (_req, res) => {
    res.json({ data: [], meta: { pagination: { page: 1, pageSize: 25, pageCount: 0, total: 0 } } });
  });
  router.post("/prasthana-thraya-screens", (_req, res) => {
    res.status(501).json({ message: STRAPI_ADMIN_NOTE });
  });
  router.put("/prasthana-thraya-screens/:documentId", (_req, res) => {
    res.status(501).json({ message: STRAPI_ADMIN_NOTE });
  });
  router.delete("/prasthana-thraya-screens/:documentId", (_req, res) => {
    res.status(501).json({ message: STRAPI_ADMIN_NOTE });
  });

  // ── Media upload: store a file in the Strapi media library so it lives in Strapi
  // and is loadable from anywhere. The client posts JSON { filename, mimeType,
  // dataBase64 } (the shared json body parser already handles this — no multipart
  // middleware on the CMS), and we forward it to Strapi's /api/upload. Returns the
  // uploaded media with an absolute URL for immediate preview.
  router.post("/upload", async (req, res) => {
    try {
      const { filename, mimeType, dataBase64 } = req.body ?? {};
      if (!dataBase64 || typeof dataBase64 !== "string") {
        return res.status(400).json({ message: "dataBase64 (base64-encoded file) is required" });
      }
      const buffer = Buffer.from(dataBase64, "base64");
      if (buffer.length === 0) {
        return res.status(400).json({ message: "Uploaded file is empty or not valid base64" });
      }
      const uploaded = await uploadToStrapi(
        buffer,
        typeof filename === "string" && filename.trim() ? filename.trim() : "upload",
        typeof mimeType === "string" && mimeType ? mimeType : "application/octet-stream",
      );
      const media = uploaded?.[0];
      if (!media) {
        return res.status(502).json({ message: "Strapi upload returned no media" });
      }
      return res.json({
        id: media.id,
        documentId: media.documentId,
        url: absolutizeMediaUrl(media.url),
        alternativeText: media.alternativeText ?? null,
        width: media.width,
        height: media.height,
        name: media.name,
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to upload media" });
    }
  });

  // ── Granthas list: augment with full sections metadata so the card on the
  // granthas page can display section names (e.g. "Viyada Adhikaranam" for
  // Brahma Sutra). We fetch sections separately (paginated, no 25-item cap)
  // and attach them to each grantha before returning.
  router.get("/granthas", async (req, res) => {
    try {
      const queryString = req.url.includes("?") ? req.url.substring(req.url.indexOf("?") + 1) : "";

      if (queryString) {
        const data = await strapiRequest(`/api/granthas?${queryString}`);
        return res.json(data);
      }

      const granthaPopulate = DEEP_POPULATE["granthas"];

      // Fetch granthas and sections metadata in parallel
      const SECTION_META = [
        "fields[0]=documentId",
        "fields[1]=title",
        "fields[2]=type",
        "fields[3]=order",
        "populate[grantha][fields][0]=documentId",
        "populate[parent][fields][0]=documentId",
        "pagination[pageSize]=100",
      ].join("&");

      const [firstGranthaPage, firstSectionPage] = await Promise.all([
        strapiRequest(`/api/granthas?${granthaPopulate}&pagination[page]=1`),
        strapiRequest(`/api/sections?${SECTION_META}&pagination[page]=1`),
      ]);

      // Paginate granthas if needed
      const granthaTotal: number = firstGranthaPage?.meta?.pagination?.total ?? 0;
      const granthaPageSize: number = firstGranthaPage?.meta?.pagination?.pageSize ?? 100;
      const granthaPageCount = Math.ceil(granthaTotal / granthaPageSize) || 1;

      let allGranthas: any[] = [...(firstGranthaPage?.data ?? [])];
      if (granthaPageCount > 1) {
        const restPages = await Promise.all(
          Array.from({ length: granthaPageCount - 1 }, (_, i) =>
            strapiRequest(`/api/granthas?${granthaPopulate}&pagination[page]=${i + 2}`)
          )
        );
        allGranthas = allGranthas.concat(restPages.flatMap((p: any) => p?.data ?? []));
      }

      // Paginate sections if needed
      const sectionTotal: number = firstSectionPage?.meta?.pagination?.total ?? 0;
      const sectionPageSize: number = firstSectionPage?.meta?.pagination?.pageSize ?? 100;
      const sectionPageCount = Math.ceil(sectionTotal / sectionPageSize) || 1;

      let allSectionsMeta: any[] = [...(firstSectionPage?.data ?? [])];
      if (sectionPageCount > 1) {
        const restSectionPages = await Promise.all(
          Array.from({ length: sectionPageCount - 1 }, (_, i) =>
            strapiRequest(`/api/sections?${SECTION_META}&pagination[page]=${i + 2}`)
          )
        );
        allSectionsMeta = allSectionsMeta.concat(restSectionPages.flatMap((p: any) => p?.data ?? []));
      }

      // Group sections by grantha documentId
      const sectionsByGrantha = new Map<string, any[]>();
      for (const s of allSectionsMeta) {
        const gDocId = s.grantha?.documentId;
        if (!gDocId) continue;
        if (!sectionsByGrantha.has(gDocId)) sectionsByGrantha.set(gDocId, []);
        sectionsByGrantha.get(gDocId)!.push({
          documentId: s.documentId,
          title: s.title,
          type: s.type,
          order: s.order,
          parent: s.parent ? { documentId: s.parent.documentId } : null,
        });
      }

      // Attach sections to granthas. Also make each cover image URL absolute so the
      // CMS (different origin than Strapi) and any external consumer can load it.
      const enriched = allGranthas.map((g: any) => absolutizeGranthaCover({
        ...g,
        sections: sectionsByGrantha.get(g.documentId) ?? [],
      }));

      return res.json({
        data: enriched,
        meta: { pagination: { page: 1, pageSize: enriched.length, pageCount: 1, total: enriched.length } },
      });
    } catch (error: any) {
      if (error.status === 404) {
        return res.json({ data: [], meta: { pagination: { page: 1, pageSize: 25, pageCount: 0, total: 0 } } });
      }
      res.status(500).json({ message: error.message || "Failed to fetch granthas" });
    }
  });

  for (const ct of contentTypes) {
    router.get(`/${ct.path}`, async (req, res) => {
      try {
        const queryString = req.url.includes("?") ? req.url.substring(req.url.indexOf("?") + 1) : "";
        const defaultPopulate = DEEP_POPULATE[ct.path] ?? "populate=*&pagination[pageSize]=100";

        if (queryString) {
          // Passthrough: caller supplied their own params (e.g. dashboard count query)
          const data = await strapiRequest(`/api/${ct.plural}?${queryString}`);
          return res.json(data);
        }

        // No custom query: paginate through ALL pages so we never silently drop records
        // when a collection has more than Strapi's default 25-item page limit.
        const firstPage = await strapiRequest(
          `/api/${ct.plural}?${defaultPopulate}&pagination[page]=1`
        );
        const total: number = firstPage?.meta?.pagination?.total ?? 0;
        const pageSize: number = firstPage?.meta?.pagination?.pageSize ?? 25;
        const pageCount = Math.ceil(total / pageSize) || 1;

        if (pageCount <= 1) {
          return res.json(firstPage);
        }

        const restPages = await Promise.all(
          Array.from({ length: pageCount - 1 }, (_, i) =>
            strapiRequest(
              `/api/${ct.plural}?${defaultPopulate}&pagination[page]=${i + 2}`
            )
          )
        );

        const allData = [
          ...(firstPage?.data ?? []),
          ...restPages.flatMap((p: any) => p?.data ?? []),
        ];

        return res.json({
          data: allData,
          meta: { pagination: { page: 1, pageSize: allData.length, pageCount: 1, total: allData.length } },
        });
      } catch (error: any) {
        if (error.status === 404) {
          return res.json({ data: [], meta: { pagination: { page: 1, pageSize: 25, pageCount: 0, total: 0 } } });
        }
        res.status(500).json({ message: error.message || "Failed to fetch data" });
      }
    });

    router.get(`/${ct.path}/:documentId`, async (req, res) => {
      try {
        const data = await strapiRequest(
          `/api/${ct.plural}/${req.params.documentId}?populate=*`
        );
        res.json(data);
      } catch (error: any) {
        res.status(500).json({ message: error.message || "Failed to fetch entry" });
      }
    });

    router.post(`/${ct.path}`, async (req, res) => {
      try {
        const data = await strapiRequest(`/api/${ct.plural}`, {
          method: "POST",
          body: JSON.stringify({ data: req.body }),
        });
        res.status(201).json(data);
      } catch (error: any) {
        res.status(500).json({ message: error.message || "Failed to create entry" });
      }
    });

    router.put(`/${ct.path}/:documentId`, async (req, res) => {
      try {
        const data = await strapiRequest(
          `/api/${ct.plural}/${req.params.documentId}`,
          {
            method: "PUT",
            body: JSON.stringify({ data: req.body }),
          }
        );
        res.json(data);
      } catch (error: any) {
        res.status(500).json({ message: error.message || "Failed to update entry" });
      }
    });

    router.delete(`/${ct.path}/:documentId`, async (req, res) => {
      const user = (req as any).user;
      const { documentId } = req.params;
      try {
        // Ownership check: look up the portal draft linked to this Strapi entry
        const draft = await storage.getDraftByStrapiDocId(documentId);
        if (draft) {
          if (!user?.id || draft.createdBy !== user.id) {
            return res.status(403).json({ message: "You can only delete entries you created" });
          }
        }
        // If no portal draft found, the item was created directly in Strapi — allow only if
        // there is no createdBy tracking (legacy/admin items). Still delete from Strapi.
        const data = await strapiRequest(
          `/api/${ct.plural}/${documentId}`,
          { method: "DELETE" }
        );
        // Clean up the linked portal draft now that the Strapi entry is gone
        if (draft) {
          await storage.deleteDraftById(draft.id);
        }
        res.json(data);
      } catch (error: any) {
        res.status(500).json({ message: error.message || "Failed to delete entry" });
      }
    });
  }

  // Single types: About and Global (one record each, no documentId)
  const singleTypes = [
    { path: "about", plural: "about" },
    { path: "global", plural: "global" },
  ];

  for (const st of singleTypes) {
    router.get(`/${st.path}`, async (req, res) => {
      try {
        const data = await strapiRequest(`/api/${st.plural}?populate=*`);
        res.json(data);
      } catch (error: any) {
        if (error.status === 404) return res.json({ data: null });
        res.status(500).json({ message: error.message || "Failed to fetch" });
      }
    });

    router.put(`/${st.path}`, async (req, res) => {
      try {
        const data = await strapiRequest(`/api/${st.plural}`, {
          method: "PUT",
          body: JSON.stringify({ data: req.body }),
        });
        res.json(data);
      } catch (error: any) {
        res.status(500).json({ message: error.message || "Failed to update" });
      }
    });
  }

  return router;
}
