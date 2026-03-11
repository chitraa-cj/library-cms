import type { Express } from "express";
import { type Server } from "http";
import { setupAuth, requireAuth } from "./auth";
import { createStrapiRouter, strapiRequest } from "./strapi";
import { storage } from "./storage";
import type { User } from "@shared/schema";

const STRAPI_INTERNAL_KEYS = new Set(["id", "__component", "createdAt", "updatedAt", "publishedAt", "documentId", "locale"]);

function cleanPayloadForStrapi(data: Record<string, any>): Record<string, any> {
  const cleaned: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === "") continue;
    if (STRAPI_INTERNAL_KEYS.has(key)) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      const sub = cleanPayloadForStrapi(value as Record<string, any>);
      if (Object.keys(sub).length > 0) {
        cleaned[key] = sub;
      }
    } else if (Array.isArray(value)) {
      const cleanedArr = value
        .map((item) =>
          typeof item === "object" && item !== null
            ? cleanPayloadForStrapi(item)
            : item
        )
        .filter((item) =>
          typeof item === "object" && item !== null
            ? Object.keys(item).length > 0
            : item !== "" && item !== null && item !== undefined
        );
      if (cleanedArr.length > 0) {
        cleaned[key] = cleanedArr;
      }
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

const CONTENT_TYPE_MAP: Record<string, string> = {
  granthas: "granthas",
  chapters: "chapters",
  articles: "articles",
  authors: "authors",
  categories: "categories",
  "prasthana-thraya-screens": "prasthana-thraya-screens",
};

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  setupAuth(app);

  const strapiRouter = createStrapiRouter();
  app.use("/api/strapi", strapiRouter);

  const VALID_CONTENT_TYPES = Object.keys(CONTENT_TYPE_MAP);

  app.get("/api/drafts", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const { contentType } = req.query;
      if (contentType && !VALID_CONTENT_TYPES.includes(contentType as string)) {
        return res.status(400).json({ message: "Invalid content type" });
      }
      const drafts = contentType
        ? await storage.getDraftsByType(contentType as string, user.id)
        : await storage.getDrafts(user.id);
      res.json(drafts);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch drafts" });
    }
  });

  app.get("/api/drafts/:id", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid draft ID" });
      const draft = await storage.getDraft(id, user.id);
      if (!draft) return res.status(404).json({ message: "Draft not found" });
      res.json(draft);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch draft" });
    }
  });

  app.post("/api/drafts", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const { contentType, title, data, strapiDocumentId } = req.body;
      if (!contentType || !title || !data) {
        return res.status(400).json({ message: "contentType, title, and data are required" });
      }
      if (!VALID_CONTENT_TYPES.includes(contentType)) {
        return res.status(400).json({ message: "Invalid content type" });
      }
      const draft = await storage.createDraft({
        contentType,
        title,
        data,
        strapiDocumentId: strapiDocumentId || null,
        status: "draft",
        createdBy: user.id,
      });
      res.status(201).json(draft);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to create draft" });
    }
  });

  app.put("/api/drafts/:id", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid draft ID" });
      const { title, data } = req.body;
      const draft = await storage.updateDraft(id, user.id, {
        ...(title && { title }),
        ...(data && { data }),
      });
      if (!draft) return res.status(404).json({ message: "Draft not found" });
      res.json(draft);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to update draft" });
    }
  });

  app.delete("/api/drafts/:id", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid draft ID" });
      const success = await storage.deleteDraft(id, user.id);
      if (!success) return res.status(404).json({ message: "Draft not found" });
      res.json({ message: "Draft deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to delete draft" });
    }
  });

  app.post("/api/drafts/:id/publish", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid draft ID" });
      const draft = await storage.getDraft(id, user.id);
      if (!draft) return res.status(404).json({ message: "Draft not found" });
      if (draft.status === "published") {
        return res.status(400).json({ message: "Draft is already published" });
      }

      const strapiPlural = CONTENT_TYPE_MAP[draft.contentType];
      if (!strapiPlural) {
        return res.status(400).json({ message: `Unknown content type: ${draft.contentType}` });
      }

      const cleanedData = cleanPayloadForStrapi(draft.data as Record<string, any>);

      let strapiResult;
      if (draft.strapiDocumentId) {
        strapiResult = await strapiRequest(
          `/api/${strapiPlural}/${draft.strapiDocumentId}`,
          {
            method: "PUT",
            body: JSON.stringify({ data: cleanedData }),
          }
        );
      } else {
        strapiResult = await strapiRequest(`/api/${strapiPlural}`, {
          method: "POST",
          body: JSON.stringify({ data: cleanedData }),
        });
      }

      const newDocumentId = strapiResult?.data?.documentId || draft.strapiDocumentId;
      const updated = await storage.markDraftPublished(id, user.id, newDocumentId);

      res.json({ draft: updated, strapi: strapiResult });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to publish draft" });
    }
  });

  return httpServer;
}
