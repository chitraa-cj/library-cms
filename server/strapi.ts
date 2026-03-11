import { Router } from "express";
import { requireAuth } from "./auth";

const STRAPI_URL = process.env.STRAPI_URL || "http://13.60.173.218:1337";
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN;

export async function strapiRequest(path: string, options: RequestInit = {}) {
  const url = `${STRAPI_URL}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${STRAPI_TOKEN}`,
    ...((options.headers as Record<string, string>) || {}),
  };

  if (
    options.body &&
    typeof options.body === "string" &&
    !headers["Content-Type"]
  ) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Strapi error ${res.status}: ${errorText}`);
  }

  return res.json();
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

  for (const ct of contentTypes) {
    router.get(`/${ct.path}`, async (req, res) => {
      try {
        const queryString = new URLSearchParams(
          req.query as Record<string, string>
        ).toString();
        const populateParam = queryString
          ? `?${queryString}`
          : "?populate=*";
        const data = await strapiRequest(
          `/api/${ct.plural}${populateParam}`
        );
        res.json(data);
      } catch (error: any) {
        res
          .status(500)
          .json({ message: error.message || "Failed to fetch data" });
      }
    });

    router.get(`/${ct.path}/:documentId`, async (req, res) => {
      try {
        const data = await strapiRequest(
          `/api/${ct.plural}/${req.params.documentId}?populate=*`
        );
        res.json(data);
      } catch (error: any) {
        res
          .status(500)
          .json({ message: error.message || "Failed to fetch entry" });
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
        res
          .status(500)
          .json({ message: error.message || "Failed to create entry" });
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
        res
          .status(500)
          .json({ message: error.message || "Failed to update entry" });
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
        res
          .status(500)
          .json({ message: error.message || "Failed to delete entry" });
      }
    });
  }

  return router;
}
