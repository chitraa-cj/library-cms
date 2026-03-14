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
    { path: "chapters", plural: "chapters" },
    { path: "articles", plural: "articles" },
    { path: "authors", plural: "authors" },
    { path: "categories", plural: "categories" },
    {
      path: "prasthana-thraya-screens",
      plural: "prasthana-thraya-screens",
    },
  ];

  const DEEP_POPULATE: Record<string, string> = {
    granthas: [
      "populate[BhashyakaraIntroduction][populate]=*",
      "populate[GranthaNameTranslations]=*",
    ].join("&"),
  };

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

  return router;
}
