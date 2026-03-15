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
    if (typeof value === "number" && Number.isNaN(value)) continue;
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
  teekas: "teekas",
  articles: "articles",
  authors: "authors",
  categories: "categories",
};

// These content types exist in the portal but have no REST API route in Strapi.
// Drafts can be saved locally but cannot be published to Strapi directly.
const STRAPI_UNROUTED_TYPES = new Set(["sections", "manthras", "prasthana-thraya-screens"]);

async function publishGranthaWithHierarchy(
  draft: any
): Promise<any> {
  const rawData = draft.data as Record<string, any>;
  // Strip wizard-only / local-format fields from the Grantha payload
  const {
    teekas: teekaDefinitions,
    hierarchy,
    otherTranslations: _otherLocal,
    granthaNameTranslations: granthaNameTranslationsLocal,
    ...granthaDataRaw
  } = rawData;
  const granthaPayload = cleanPayloadForStrapi(granthaDataRaw);

  // Set NumberOfTeekas from the wizard's teeka count (Strapi expects a number)
  if (Array.isArray(teekaDefinitions) && teekaDefinitions.length > 0) {
    granthaPayload.NumberOfTeekas = teekaDefinitions.length;
  } else {
    // Remove if present and invalid to avoid Strapi validation error
    delete granthaPayload.NumberOfTeekas;
  }

  // Convert local granthaNameTranslations → Strapi GranthaNameTranslations format
  if (Array.isArray(granthaNameTranslationsLocal) && granthaNameTranslationsLocal.length > 0) {
    granthaPayload.GranthaNameTranslations = granthaNameTranslationsLocal.map((t: any) => ({
      LanguageOfTranslation: t.language || "",
      GranthaNameTranslation: t.name || "",
    }));
  }

  // 1. Create or update the Grantha record
  let strapiResult: any;
  if (draft.strapiDocumentId) {
    // We already know the Strapi record — update it
    strapiResult = await strapiRequest(`/api/granthas/${draft.strapiDocumentId}`, {
      method: "PUT",
      body: JSON.stringify({ data: granthaPayload }),
    });
  } else {
    // Check whether a Grantha with the same name already exists in Strapi
    // to avoid creating duplicates when the same text is published more than once.
    let existingDocId: string | undefined;
    if (granthaPayload.GranthaName) {
      try {
        const searchName = encodeURIComponent(granthaPayload.GranthaName as string);
        const existing = await strapiRequest(
          `/api/granthas?filters[GranthaName][$eq]=${searchName}`
        );
        existingDocId = existing?.data?.[0]?.documentId;
      } catch {
        // ignore — fall back to creating
      }
    }

    if (existingDocId) {
      strapiResult = await strapiRequest(`/api/granthas/${existingDocId}`, {
        method: "PUT",
        body: JSON.stringify({ data: granthaPayload }),
      });
    } else {
      strapiResult = await strapiRequest("/api/granthas", {
        method: "POST",
        body: JSON.stringify({ data: granthaPayload }),
      });
    }
  }

  const granthaDocId: string | undefined = strapiResult?.data?.documentId;

  // 2. Publish hierarchy as separate Chapter records (best-effort)
  if (Array.isArray(hierarchy) && granthaDocId) {
    for (const adhyaya of hierarchy) {
      let adhyayaDocId: string | undefined;
      try {
        const ar = await strapiRequest("/api/chapters", {
          method: "POST",
          body: JSON.stringify({
            data: {
              ChapterTitle: adhyaya.title,
              order: adhyaya.order,
              grantha: { connect: [{ documentId: granthaDocId }] },
            },
          }),
        });
        adhyayaDocId = ar?.data?.documentId;
      } catch (e: any) {
        console.warn(`[publish] Adhyaya "${adhyaya.title}" failed:`, e.message);
        continue;
      }

      for (const khanda of (adhyaya.khandas ?? [])) {
        let khandaDocId: string | undefined;
        try {
          const kr = await strapiRequest("/api/chapters", {
            method: "POST",
            body: JSON.stringify({
              data: {
                ChapterTitle: khanda.title,
                order: khanda.order,
                grantha: { connect: [{ documentId: granthaDocId }] },
                ...(adhyayaDocId
                  ? { parent: { connect: [{ documentId: adhyayaDocId }] } }
                  : {}),
              },
            }),
          });
          khandaDocId = kr?.data?.documentId;
        } catch (e: any) {
          console.warn(`[publish] Khanda "${khanda.title}" failed:`, e.message);
          continue;
        }

        for (const manthra of (khanda.manthras ?? [])) {
          try {
            const mData: Record<string, any> = {
              ChapterTitle: manthra.title,
              order: manthra.order,
              grantha: { connect: [{ documentId: granthaDocId }] },
              ...(khandaDocId
                ? { parent: { connect: [{ documentId: khandaDocId }] } }
                : {}),
            };

            if (manthra.ShlokaManthraEntry) {
              mData.ShlokaManthraEntry = manthra.ShlokaManthraEntry;
            }
            if (manthra.BhashyamForShlokaManthra) {
              mData.BhashyamForShlokaManthra = manthra.BhashyamForShlokaManthra;
            }
            if (Array.isArray(manthra.Teekas) && manthra.Teekas.length > 0) {
              mData.Teekas = manthra.Teekas.map((t: any) => ({
                TeekaName: t.TeekaName || "",
                TeekaAuthor: t.TeekaAuthor || "",
                ...(t.TeekaEntry ? { TeekaEntry: t.TeekaEntry } : {}),
              }));
            }

            await strapiRequest("/api/chapters", {
              method: "POST",
              body: JSON.stringify({ data: mData }),
            });
          } catch (e: any) {
            console.warn(`[publish] Manthra "${manthra.title}" failed:`, e.message);
          }
        }
      }
    }
  }

  return strapiResult;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  setupAuth(app);

  const strapiRouter = createStrapiRouter();
  app.use("/api/strapi", strapiRouter);

  const VALID_CONTENT_TYPES = [...Object.keys(CONTENT_TYPE_MAP), ...Array.from(STRAPI_UNROUTED_TYPES)];

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

      if (STRAPI_UNROUTED_TYPES.has(draft.contentType)) {
        return res.status(501).json({
          message: `Cannot publish ${draft.contentType} directly to Strapi — the REST API route for this collection type is not enabled on the Strapi server. Please create or edit this record in the Strapi Content Manager: http://13.53.121.15:1337/admin`,
        });
      }

      const strapiPlural = CONTENT_TYPE_MAP[draft.contentType];
      if (!strapiPlural) {
        return res.status(400).json({ message: `Unknown content type: ${draft.contentType}` });
      }

      let strapiResult: any;

      if (draft.contentType === "granthas") {
        // Granthas need special handling: strip wizard-only fields and
        // create chapter records separately in the correct order.
        strapiResult = await publishGranthaWithHierarchy(draft);
      } else {
        const cleanedData = cleanPayloadForStrapi(draft.data as Record<string, any>);
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
