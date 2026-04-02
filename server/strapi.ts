import { Router } from "express";
import { requireAuth } from "./auth";
import { storage } from "./storage";
import { execFile } from "node:child_process";
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STRAPI_URL = process.env.STRAPI_URL || "http://13.53.121.15:1337";
const STRAPI_TOKEN = () => process.env.STRAPI_API_TOKEN || "";

function curlRequest(
  url: string,
  method = "GET",
  body?: string
): Promise<{ ok: boolean; status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const args = [
      "-g",
      "-s",
      "-k",
      "--max-time", "20",
      "-w", "|||HTTPSTATUS|||%{http_code}",
      "-X", method,
      "-H", `Authorization: Bearer ${STRAPI_TOKEN()}`,
      "-H", "Content-Type: application/json",
    ];

    // Write the body to a temp file to avoid E2BIG when the payload is large
    // (e.g. manthras with many teeka entries containing long Sanskrit blocks).
    // curl's `--data @filepath` reads from file, bypassing the OS ARG_MAX limit.
    let tmpFile: string | undefined;
    if (body) {
      tmpFile = join(tmpdir(), `strapi_body_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(tmpFile, body, "utf8");
      args.push("--data", `@${tmpFile}`);
    }

    args.push(url);

    execFile("curl", args, { timeout: 25000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      // Always clean up the temp file
      if (tmpFile) {
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
      }

      if (err && !stdout) {
        return reject(new Error(`curl failed: ${err.message} | stderr: ${stderr?.slice(0, 200)}`));
      }

      const output = stdout || "";
      const sep = "|||HTTPSTATUS|||";
      const sepIdx = output.lastIndexOf(sep);
      if (sepIdx === -1) {
        return reject(new Error(`curl no-status (exit ${(err as any)?.code}): "${output.slice(0, 100)}"`));
      }
      const status = parseInt(output.slice(sepIdx + sep.length), 10) || 0;
      const responseBody = output.slice(0, sepIdx);

      resolve({
        ok: status >= 200 && status < 300,
        status,
        body: responseBody,
      });
    });
  });
}

export async function strapiRequest(path: string, options: { method?: string; body?: string } = {}) {
  const url = `${STRAPI_URL}${path}`;
  const res = await curlRequest(url, options.method || "GET", options.body);

  if (!res.ok) {
    const err = new Error(`Strapi error ${res.status}: ${res.body.slice(0, 300)}`) as any;
    err.status = res.status;
    throw err;
  }

  if (!res.body.trim()) return { data: null };

  try {
    return JSON.parse(res.body);
  } catch {
    return { data: null };
  }
}

/**
 * Like strapiRequest but writes the response body to a temp file first,
 * bypassing the execFile maxBuffer limit. Use for endpoints that can return
 * very large payloads (e.g., full populate of manthras with rich-text blocks).
 */
export function strapiRequestLarge(path: string): Promise<any> {
  const url = `${STRAPI_URL}${path}`;
  const outFile = join(tmpdir(), `strapi_large_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);

  return new Promise((resolve, reject) => {
    const args = [
      "-g", "-s", "-k",
      "--max-time", "30",
      "-H", `Authorization: Bearer ${STRAPI_TOKEN()}`,
      "-H", "Content-Type: application/json",
      "-o", outFile,
      "-w", `%{http_code}`,
      url,
    ];

    execFile("curl", args, { timeout: 35000, maxBuffer: 64 * 1024 }, (err, stdout) => {
      const status = parseInt(stdout?.trim() || "0", 10);
      let rawBody = "";
      try { rawBody = readFileSync(outFile, "utf8"); } catch { /* empty */ }
      try { unlinkSync(outFile); } catch { /* ignore */ }

      if (err && !rawBody) {
        return reject(new Error(`curl large failed: ${err.message}`));
      }
      if (status < 200 || status >= 300) {
        const errBody = rawBody.slice(0, 300);
        const e = new Error(`Strapi error ${status}: ${errBody}`) as any;
        e.status = status;
        return reject(e);
      }
      if (!rawBody.trim()) return resolve({ data: null });
      try {
        resolve(JSON.parse(rawBody));
      } catch {
        resolve({ data: null });
      }
    });
  });
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
      // Sections are intentionally excluded from the list populate to keep
      // the response small. Section hierarchy (with manthras) is fetched
      // on-demand via /sections/by-grantha/:granthaDocId when editing.
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

      // Multi-page fetch: collect all sections across every page.
      const firstPage = await strapiRequest(`/api/sections?${SECTION_LIST_POPULATE}&pagination[page]=1`);
      const total: number = firstPage?.meta?.pagination?.total ?? 0;
      const pageSize: number = firstPage?.meta?.pagination?.pageSize ?? 100;
      const pageCount = Math.ceil(total / pageSize);

      if (pageCount <= 1) {
        return res.json(firstPage);
      }

      const restPages = await Promise.all(
        Array.from({ length: pageCount - 1 }, (_, i) =>
          strapiRequest(`/api/sections?${SECTION_LIST_POPULATE}&pagination[page]=${i + 2}`)
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

      // ── Step 1: collect all sections ──
      const firstSectionPage = await strapiRequest(
        `/api/sections?${sectionFilter}&${sectionMeta}&pagination[page]=1`
      );
      const sectionTotal: number = firstSectionPage?.meta?.pagination?.total ?? 0;
      const sectionPageSize: number = firstSectionPage?.meta?.pagination?.pageSize ?? 100;
      const sectionPageCount = Math.ceil(sectionTotal / sectionPageSize);

      let allSections: any[] = [...(firstSectionPage?.data ?? [])];
      if (sectionPageCount > 1) {
        const restSectionPages = await Promise.all(
          Array.from({ length: sectionPageCount - 1 }, (_, i) =>
            strapiRequest(`/api/sections?${sectionFilter}&${sectionMeta}&pagination[page]=${i + 2}`)
          )
        );
        allSections = allSections.concat(restSectionPages.flatMap((p: any) => p?.data ?? []));
      }

      // ── Step 2: collect all manthras for this grantha (paginated) ──
      const manthraQuery = [
        "fields[0]=documentId",
        "fields[1]=ShlokaManthraNumber",
        "fields[2]=order",
        "fields[3]=id",
        "populate[Section][fields][0]=documentId",
        `filters[Section][grantha][documentId][$eq]=${g}`,
        "sort[0]=order:asc",
        "pagination[pageSize]=100",
      ].join("&");

      const firstManthraPage = await strapiRequest(`/api/manthras?${manthraQuery}&pagination[page]=1`);
      const manthraTotal: number = firstManthraPage?.meta?.pagination?.total ?? 0;
      const manthraPageSize: number = firstManthraPage?.meta?.pagination?.pageSize ?? 100;
      const manthraPageCount = Math.ceil(manthraTotal / manthraPageSize);

      let allManthras: any[] = [...(firstManthraPage?.data ?? [])];
      if (manthraPageCount > 1) {
        const restManthraPages = await Promise.all(
          Array.from({ length: manthraPageCount - 1 }, (_, i) =>
            strapiRequest(`/api/manthras?${manthraQuery}&pagination[page]=${i + 2}`)
          )
        );
        allManthras = allManthras.concat(restManthraPages.flatMap((p: any) => p?.data ?? []));
      }

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
    "populate[Teekas][populate][teeka][fields][0]=documentId&populate[Teekas][populate][teeka][fields][1]=TeekaName&populate[Teekas][populate][teeka][fields][2]=TeekaAuthor&populate[Teekas][populate][TeekaEntry][populate]=*",
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

      const firstPage = await strapiRequest(`/api/manthras?${MANTHRA_LIST_POPULATE}&pagination[page]=1`);
      const allManthras: any[] = (firstPage.data || []).map(normaliseManthra);
      const pageCount: number = firstPage.meta?.pagination?.pageCount ?? 1;

      // Fetch remaining pages in parallel if there are more
      if (pageCount > 1) {
        const pageNumbers = Array.from({ length: pageCount - 1 }, (_, i) => i + 2);
        const extraPages = await Promise.all(
          pageNumbers.map((p) =>
            strapiRequest(`/api/manthras?${MANTHRA_LIST_POPULATE}&pagination[page]=${p}`)
          )
        );
        for (const page of extraPages) {
          allManthras.push(...(page.data || []).map(normaliseManthra));
        }
      }

      res.json({ ...firstPage, data: allManthras });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch manthras" });
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
