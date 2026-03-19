import { Router } from "express";
import { requireAuth } from "./auth";
import { storage } from "./storage";
import { execFile } from "node:child_process";

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

    if (body) {
      args.push("-d", body);
    }

    args.push(url);

    execFile("curl", args, { timeout: 25000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
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
      "populate[sections][populate][manthras][fields][0]=documentId&populate[sections][populate][manthras][fields][1]=ShlokaManthraNumber&populate[sections][populate][manthras][fields][2]=order&populate[sections][populate][parent][fields][0]=id&populate[sections][populate][parent][fields][1]=documentId",
      "populate[teekas][fields][0]=documentId&populate[teekas][fields][1]=TeekaName&populate[teekas][fields][2]=TeekaAuthor",
    ].join("&"),
    teekas: [
      "populate[grantha][fields][0]=documentId&populate[grantha][fields][1]=GranthaName",
    ].join("&"),
    chapters: [
      "populate[grantha][fields][0]=documentId&populate[grantha][fields][1]=GranthaName",
      "populate[parent][fields][0]=documentId&populate[parent][fields][1]=ChapterTitle",
      "populate[children][fields][0]=documentId&populate[children][fields][1]=ChapterTitle&populate[children][fields][2]=order",
      "populate[ShlokaManthraEntry]=*",
      "populate[BhashyamForShlokaManthra]=*",
      "populate[Teekas]=*",
    ].join("&"),
  };

  // ── Sections: fetch directly from /api/sections ──
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
    "pagination[pageSize]=200",
  ].join("&");

  router.get("/sections", async (_req, res) => {
    try {
      const data = await strapiRequest(`/api/sections?${SECTION_POPULATE}`);
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch sections" });
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
    "populate[wordMeanings]=*",
    "pagination[pageSize]=200",
  ].join("&");

  router.get("/manthras", async (_req, res) => {
    try {
      const data = await strapiRequest(`/api/manthras?${MANTHRA_POPULATE}`);
      // Normalise: expose section (lowercase) and grantha for frontend compatibility
      const manthras = (data.data || []).map((m: any) => {
        const sec = m.Section;
        return {
          ...m,
          section: sec ? { id: sec.id, documentId: sec.documentId, title: sec.title, type: sec.type } : null,
          grantha: sec?.grantha ?? null,
        };
      });
      res.json({ ...data, data: manthras });
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
        const queryString = new URLSearchParams(
          req.query as Record<string, string>
        ).toString();
        const defaultPopulate = DEEP_POPULATE[ct.path] ?? "populate=*";
        const populateParam = queryString ? `?${queryString}` : `?${defaultPopulate}`;
        const data = await strapiRequest(`/api/${ct.plural}${populateParam}`);
        res.json(data);
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
