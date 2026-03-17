import type { Express } from "express";
import { type Server } from "http";
import { setupAuth, requireAuth } from "./auth";
import { createStrapiRouter, strapiRequest } from "./strapi";
import { storage } from "./storage";
import type { User } from "@shared/schema";

const STRAPI_INTERNAL_KEYS = new Set(["id", "_id", "__component", "createdAt", "updatedAt", "publishedAt", "documentId", "locale"]);

// Strapi section.type enum — exact values the API accepts
const STRAPI_SECTION_TYPES = new Set([
  "adhyay", "khanda", "valli", "pada", "kanda", "sukta",
  "varga", "anuvaka", "prakarana", "chapter", "part", "section", "book",
]);

// Map portal level names → Strapi section.type enum values (case-insensitive)
const SECTION_TYPE_MAP: Record<string, string> = {
  adhyaya: "adhyay",
  adhyay: "adhyay",
  khanda: "khanda",
  valli: "valli",
  valla: "valli",
  pada: "pada",
  kanda: "kanda",
  sukta: "sukta",
  varga: "varga",
  anuvaka: "anuvaka",
  prakarana: "prakarana",
  chapter: "chapter",
  part: "part",
  section: "section",
  book: "book",
  parichcheda: "section",
  pariccheda: "section",
  prasthanam: "book",
};

function mapSectionType(name: string): string | undefined {
  if (!name) return undefined;
  const key = name.toLowerCase().trim();
  return SECTION_TYPE_MAP[key];
}

// Strapi teekas.TeekaAuthor enum — exact values the API accepts
const STRAPI_TEEKA_AUTHORS = new Set([
  "Anandagiri", "Vachaspati Mishra", "Padmapada", "Sureshvaracharya",
  "Prakasatman", "Govindananda", "Ramananda Saraswati", "Madhusudana Saraswati",
  "Dhanapati Suri", "Amalananda", "Appayya Dikshita", "Shankarananda",
  "Shriharsha", "Chitsukha", "Vidyaranya",
]);

function cleanPayloadForStrapi(data: Record<string, any>): Record<string, any> {
  const cleaned: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "number" && Number.isNaN(value)) continue;
    // Strip string "NaN" — happens when a number input was left blank and serialized
    if (value === "NaN") continue;
    if (STRAPI_INTERNAL_KEYS.has(key)) continue;
    // Strip local-only portal fields (prefixed with _)
    if (key.startsWith("_")) continue;
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
  sections: "sections",
  teekas: "teekas",
  articles: "articles",
  authors: "authors",
  categories: "categories",
  manthras: "manthras",
};

// These content types exist in the portal but have no REST API route in Strapi.
// Drafts can be saved locally but cannot be published to Strapi directly.
const STRAPI_UNROUTED_TYPES = new Set(["prasthana-thraya-screens"]);

async function buildManthraData(
  manthra: Record<string, any>,
  sectionDocId: string | undefined
): Promise<Record<string, any>> {
  const mData: Record<string, any> = {
    ShlokaManthraNumber: manthra.ShlokaManthraNumber || manthra.title || "",
  };
  if (manthra.order != null) {
    const n = Number(manthra.order);
    if (!isNaN(n)) mData.order = n;
  }
  if (sectionDocId) mData.Section = sectionDocId;
  if (manthra.ShlokaManthraEntry) mData.ShlokaManthraEntry = manthra.ShlokaManthraEntry;
  // BhashyamForShlokaManthra is the hierarchy-builder field name; Strapi's actual field is BhashyamEntry
  if (manthra.BhashyamForShlokaManthra) mData.BhashyamEntry = manthra.BhashyamForShlokaManthra;
  else if (manthra.BhashyamEntry) mData.BhashyamEntry = manthra.BhashyamEntry;
  // NOTE: Do NOT send Teekas — Strapi rejects any non-empty key inside manthra Teekas items
  // NOTE: Do NOT send NumberOfTeekas — that field belongs to Grantha, not Manthra
  return cleanPayloadForStrapi(mData);
}

// Helper: find an existing Strapi section by title+grantha+parent, or create it if missing.
// This prevents duplicate sections on repeated publishes of the same grantha draft.
async function findOrCreateSection(
  title: string,
  type: string | undefined,
  order: number | undefined,
  granthaDocId: string,
  parentDocId: string | undefined
): Promise<string | undefined> {
  // Search for an existing section that matches title + grantha + parent
  try {
    const t = encodeURIComponent(title);
    const g = encodeURIComponent(granthaDocId);
    let url = `/api/sections?filters[title][$eq]=${t}&filters[grantha][documentId][$eq]=${g}`;
    if (parentDocId) {
      url += `&filters[parent][documentId][$eq]=${encodeURIComponent(parentDocId)}`;
    } else {
      url += `&filters[parent][$null]=true`;
    }
    const existing = await strapiRequest(url);
    const existingDocId: string | undefined = existing?.data?.[0]?.documentId;
    if (existingDocId) {
      console.log(`[publish] Section "${title}" already exists: ${existingDocId} — reusing`);
      return existingDocId;
    }
  } catch {
    // ignore lookup failure — fall through to create
  }

  // Not found — create a new section
  const payload: Record<string, any> = { title, grantha: granthaDocId };
  if (type) payload.type = type;
  if (order != null) payload.order = order;
  if (parentDocId) payload.parent = parentDocId;
  const r = await strapiRequest("/api/sections", {
    method: "POST",
    body: JSON.stringify({ data: payload }),
  });
  const newDocId: string | undefined = r?.data?.documentId;
  console.log(`[publish] Section "${title}" created: ${newDocId}`);
  return newDocId;
}

// Helper: create a manthra in Strapi if one with the same ShlokaManthraNumber+Section doesn't already exist.
async function createOrSkipManthra(
  mData: Record<string, any>,
  label: string
): Promise<void> {
  const sectionDocId: string | undefined = mData.Section;
  const number: string | undefined = mData.ShlokaManthraNumber;

  // Deduplication: check if this manthra already exists under the same section
  if (sectionDocId && number) {
    try {
      const n = encodeURIComponent(number);
      const s = encodeURIComponent(sectionDocId);
      const existing = await strapiRequest(
        `/api/manthras?filters[ShlokaManthraNumber][$eq]=${n}&filters[Section][documentId][$eq]=${s}&fields[0]=documentId`
      );
      if ((existing?.data?.length ?? 0) > 0) {
        console.log(`[publish] Manthra "${label}" already exists in section — skipping`);
        return;
      }
    } catch {
      // ignore lookup failure — attempt to create anyway
    }
  }

  const mr = await strapiRequest("/api/manthras", {
    method: "POST",
    body: JSON.stringify({ data: mData }),
  });
  console.log(`[publish] Manthra "${label}" created: ${mr?.data?.documentId}`);
}

async function publishGranthaWithHierarchy(
  draft: any
): Promise<any> {
  const rawData = draft.data as Record<string, any>;
  // Strip wizard-only / local-format fields from the Grantha payload
  const {
    teekas: teekaDefinitions,
    hierarchy,
    structureConfig,
    // Always compute NumberOfTeekas from the actual teekas array, never from stored form data
    NumberOfTeekas: _NumberOfTeekas,
    otherTranslations: _otherLocal,
    granthaNameTranslations: granthaNameTranslationsLocal,
    ...granthaDataRaw
  } = rawData;
  const granthaPayload = cleanPayloadForStrapi(granthaDataRaw);

  // Set NumberOfTeekas from the wizard's teeka count (Strapi expects a number, 0 is valid)
  granthaPayload.NumberOfTeekas = Array.isArray(teekaDefinitions) ? teekaDefinitions.length : 0;

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

  // 2. Publish teekas (best-effort) — create each teeka and link to this grantha
  if (Array.isArray(teekaDefinitions) && granthaDocId) {
    for (const teeka of teekaDefinitions) {
      // TeekaAuthor is a Strapi enum — only include if valid
      const validAuthor = teeka.TeekaAuthor && STRAPI_TEEKA_AUTHORS.has(teeka.TeekaAuthor)
        ? teeka.TeekaAuthor : undefined;
      // Use TeekaName if given; fall back to author name; skip if neither
      const effectiveName = (teeka.TeekaName || "").trim() || (validAuthor ? `${validAuthor} Teeka` : "");
      if (!effectiveName) continue;
      try {
        // Dedup: skip if a teeka with the same name already exists for this grantha
        const tName = encodeURIComponent(effectiveName);
        const tGrantha = encodeURIComponent(granthaDocId);
        const existing = await strapiRequest(
          `/api/teekas?filters[TeekaName][$eq]=${tName}&filters[grantha][documentId][$eq]=${tGrantha}&fields[0]=documentId`
        );
        if ((existing?.data?.length ?? 0) > 0) {
          console.log(`[publish] Teeka "${effectiveName}" already exists — skipping`);
          continue;
        }
        await strapiRequest("/api/teekas", {
          method: "POST",
          body: JSON.stringify({
            data: {
              TeekaName: effectiveName,
              ...(validAuthor ? { TeekaAuthor: validAuthor } : {}),
              grantha: granthaDocId,
            },
          }),
        });
        console.log(`[publish] Teeka "${effectiveName}" created`);
      } catch (e: any) {
        console.error(`[publish] Teeka "${effectiveName}" failed:`, e.message);
      }
    }
  }

  // 3. Publish hierarchy as Sections + Manthras (best-effort)
  // Sections → /api/sections (title, type, grantha, parent)
  // Manthras → /api/manthras (ShlokaManthraNumber, Section, content fields)
  const L1name: string = structureConfig?.levelOneName || "Adhyaya";
  const L2name: string = structureConfig?.levelTwoName || "Khanda";
  const L3name: string = structureConfig?.levelThreeName || "Pada";
  const levelTwoEnabled: boolean = structureConfig?.levelTwoEnabled !== false;
  const levelThreeEnabled: boolean = !!structureConfig?.levelThreeEnabled;

  // Map display names → Strapi enum values (undefined = omit type field)
  const L1type = mapSectionType(L1name);
  const L2type = mapSectionType(L2name);
  const L3type = mapSectionType(L3name);

  console.log(`[publish] Hierarchy: L1=${L1name}→${L1type}, L2=${L2name}→${L2type}, L3=${L3name}→${L3type}, levelTwo=${levelTwoEnabled}, levelThree=${levelThreeEnabled}`);
  console.log(`[publish] Adhyayas count: ${Array.isArray(hierarchy) ? hierarchy.length : 0}`);

  if (Array.isArray(hierarchy) && granthaDocId) {
    for (const adhyaya of hierarchy) {
      let adhyayaDocId: string | undefined;
      try {
        adhyayaDocId = await findOrCreateSection(
          adhyaya.title, L1type, adhyaya.order ?? undefined, granthaDocId, undefined
        );
      } catch (e: any) {
        console.error(`[publish] Section L1 "${adhyaya.title}" failed:`, e.message);
        continue;
      }

      for (const khanda of (adhyaya.khandas ?? [])) {
        // When L2 is disabled, khandas[0] is a "_default" container — skip creating a section for it
        const isDefaultKhanda = khanda.title === "_default" || !levelTwoEnabled;
        let khandaDocId: string | undefined;

        if (!isDefaultKhanda) {
          try {
            khandaDocId = await findOrCreateSection(
              khanda.title, L2type, khanda.order ?? undefined, granthaDocId, adhyayaDocId
            );
          } catch (e: any) {
            console.error(`[publish] Section L2 "${khanda.title}" failed:`, e.message);
            continue;
          }
        } else {
          // No L2 — manthras attach directly to the adhyaya section
          khandaDocId = adhyayaDocId;
        }

        // Level 3 (Pada) — if padas array is present and non-empty
        if (levelThreeEnabled && Array.isArray(khanda.padas) && khanda.padas.length > 0) {
          for (const pada of khanda.padas) {
            let padaDocId: string | undefined;
            try {
              padaDocId = await findOrCreateSection(
                pada.title, L3type, pada.order ?? undefined, granthaDocId, khandaDocId
              );
            } catch (e: any) {
              console.warn(`[publish] Pada "${pada.title}" failed:`, e.message);
              continue;
            }

            for (const manthra of (pada.manthras ?? [])) {
              try {
                const mData = await buildManthraData(manthra, padaDocId);
                console.log(`[publish] Manthra payload (L3):`, JSON.stringify(mData).slice(0, 300));
                await createOrSkipManthra(mData, manthra.title);
              } catch (e: any) {
                console.error(`[publish] Manthra "${manthra.title}" (L3) failed:`, e.message);
              }
            }
          }
        } else {
          // No padas — manthras sit directly under the khanda (or adhyaya if L2 disabled)
          for (const manthra of (khanda.manthras ?? [])) {
            try {
              const mData = await buildManthraData(manthra, khandaDocId);
              console.log(`[publish] Manthra payload:`, JSON.stringify(mData).slice(0, 300));
              await createOrSkipManthra(mData, manthra.title);
            } catch (e: any) {
              console.error(`[publish] Manthra "${manthra.title}" FAILED:`, e.message);
            }
          }
        }
      }
    }
  }

  return strapiResult;
}

function buildManthraPayload(data: Record<string, any>): Record<string, any> {
  const {
    section,       // lowercase local field → maps to Strapi's capital-S Section relation
    grantha,       // local tracking only — not a direct field in Strapi Manthra schema
    Teekas: _teekas, // stored as complex objects; omit — set relations manually in Strapi
    ...rest
  } = data;

  const payload = cleanPayloadForStrapi(rest);

  // Map section documentId → Section relation (Strapi v5 accepts raw documentId string)
  if (section && typeof section === "string") {
    payload.Section = section;
  }

  // order must be a number (not string)
  if (payload.order !== undefined && payload.order !== null) {
    const n = Number(payload.order);
    if (!Number.isNaN(n)) payload.order = n;
    else delete payload.order;
  }

  return payload;
}

function buildSectionPayload(data: Record<string, any>): Record<string, any> {
  const {
    _grantha,          // local-prefix copy of grantha documentId
    _parent,           // local-prefix copy of parent section documentId
    grantha,           // documentId string for the parent Grantha
    parent,            // documentId string for the parent Section
    order,
    ...rest
  } = data;

  const payload = cleanPayloadForStrapi(rest);

  // Map grantha → Strapi relation (Strapi v5 accepts raw documentId string)
  const granthaId = grantha || _grantha;
  if (granthaId && typeof granthaId === "string") {
    payload.grantha = granthaId;
  }

  // Map parent → Strapi relation
  const parentId = parent || _parent;
  if (parentId && typeof parentId === "string") {
    payload.parent = parentId;
  }

  // order must be a number
  if (order !== undefined && order !== null && order !== "") {
    const n = Number(order);
    if (!Number.isNaN(n)) payload.order = n;
  }

  return payload;
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
        status: "draft",
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
        const cleanedData =
          draft.contentType === "manthras"
            ? buildManthraPayload(draft.data as Record<string, any>)
            : draft.contentType === "sections"
            ? buildSectionPayload(draft.data as Record<string, any>)
            : cleanPayloadForStrapi(draft.data as Record<string, any>);

        console.log(`[publish] ${draft.contentType} payload:`, JSON.stringify(cleanedData));

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
