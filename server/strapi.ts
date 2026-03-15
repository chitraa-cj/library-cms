import { Router } from "express";
import { requireAuth } from "./auth";
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
  ];

  const DEEP_POPULATE: Record<string, string> = {
    granthas: [
      "populate[BhashyakaraIntroduction][populate]=*",
      "populate[GranthaNameTranslations]=*",
      "populate[sections][populate][manthras][fields][0]=documentId&populate[sections][populate][manthras][fields][1]=ShlokaManthraNumber&populate[sections][populate][manthras][fields][2]=order",
      "populate[teekas][fields][0]=documentId&populate[teekas][fields][1]=TeekaName&populate[teekas][fields][2]=TeekaAuthor",
    ].join("&"),
    teekas: [
      "populate[grantha][fields][0]=documentId&populate[grantha][fields][1]=GranthaName",
    ].join("&"),
  };

  // ── Sections: aggregate from granthas since /api/sections route is not enabled on the Strapi server ──
  router.get("/sections", async (_req, res) => {
    try {
      const granthasData = await strapiRequest(
        `/api/granthas?${[
          "populate[sections][populate][manthras][fields][0]=documentId",
          "populate[sections][populate][manthras][fields][1]=ShlokaManthraNumber",
          "populate[sections][populate][manthras][fields][2]=order",
          "pagination[pageSize]=200",
        ].join("&")}`
      );
      const sections: any[] = [];
      for (const g of granthasData.data || []) {
        for (const s of g.sections || []) {
          sections.push({
            ...s,
            grantha: { id: g.id, documentId: g.documentId, GranthaName: g.GranthaName },
          });
        }
      }
      sections.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
      res.json({ data: sections, meta: { pagination: { page: 1, pageSize: sections.length, pageCount: 1, total: sections.length } } });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch sections" });
    }
  });

  router.get("/sections/:documentId", async (req, res) => {
    try {
      const granthasData = await strapiRequest(`/api/granthas?populate[sections][populate]=*&pagination[pageSize]=200`);
      for (const g of granthasData.data || []) {
        const s = (g.sections || []).find((s: any) => s.documentId === req.params.documentId);
        if (s) {
          return res.json({ data: { ...s, grantha: { id: g.id, documentId: g.documentId, GranthaName: g.GranthaName } } });
        }
      }
      res.status(404).json({ message: "Section not found" });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch section" });
    }
  });

  const STRAPI_ADMIN_NOTE = "The Strapi server does not have REST API routes generated for this collection type. Please manage this record directly in the Strapi Content Manager at http://13.53.121.15:1337/admin";

  router.post("/sections", (_req, res) => {
    res.status(501).json({ message: STRAPI_ADMIN_NOTE });
  });
  router.put("/sections/:documentId", (_req, res) => {
    res.status(501).json({ message: STRAPI_ADMIN_NOTE });
  });
  router.delete("/sections/:documentId", (_req, res) => {
    res.status(501).json({ message: STRAPI_ADMIN_NOTE });
  });

  // ── Manthras: aggregate from granthas → sections since /api/manthras is not enabled ──
  router.get("/manthras", async (_req, res) => {
    try {
      const granthasData = await strapiRequest(
        `/api/granthas?${[
          "populate[sections][populate][manthras][populate]=*",
          "pagination[pageSize]=200",
        ].join("&")}`
      );
      const manthras: any[] = [];
      for (const g of granthasData.data || []) {
        for (const s of g.sections || []) {
          for (const m of s.manthras || []) {
            manthras.push({
              ...m,
              section: { id: s.id, documentId: s.documentId, title: s.title, type: s.type },
              grantha: { id: g.id, documentId: g.documentId, GranthaName: g.GranthaName },
            });
          }
        }
      }
      manthras.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
      res.json({ data: manthras, meta: { pagination: { page: 1, pageSize: manthras.length, pageCount: 1, total: manthras.length } } });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch manthras" });
    }
  });

  router.get("/manthras/:documentId", async (req, res) => {
    try {
      const granthasData = await strapiRequest(`/api/granthas?populate[sections][populate][manthras][populate]=*&pagination[pageSize]=200`);
      for (const g of granthasData.data || []) {
        for (const s of g.sections || []) {
          const m = (s.manthras || []).find((m: any) => m.documentId === req.params.documentId);
          if (m) {
            return res.json({ data: {
              ...m,
              section: { id: s.id, documentId: s.documentId, title: s.title, type: s.type },
              grantha: { id: g.id, documentId: g.documentId, GranthaName: g.GranthaName },
            }});
          }
        }
      }
      res.status(404).json({ message: "Manthra not found" });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch manthra" });
    }
  });

  router.post("/manthras", (_req, res) => {
    res.status(501).json({ message: STRAPI_ADMIN_NOTE });
  });
  router.put("/manthras/:documentId", (_req, res) => {
    res.status(501).json({ message: STRAPI_ADMIN_NOTE });
  });
  router.delete("/manthras/:documentId", (_req, res) => {
    res.status(501).json({ message: STRAPI_ADMIN_NOTE });
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
      try {
        const data = await strapiRequest(
          `/api/${ct.plural}/${req.params.documentId}`,
          { method: "DELETE" }
        );
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
