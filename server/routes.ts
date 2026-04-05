import type { Express } from "express";
import { type Server } from "http";
import { setupAuth, requireAuth, requireAdmin, hashPassword } from "./auth";
import { createStrapiRouter, strapiRequest, strapiRequestLarge } from "./strapi";
import { storage } from "./storage";
import type { User } from "@shared/schema";

const STRAPI_INTERNAL_KEYS = new Set(["id", "_id", "__component", "createdAt", "updatedAt", "publishedAt", "documentId", "locale"]);

// Strapi section.type enum — exact values the API accepts
const STRAPI_SECTION_TYPES = new Set([
  "adhyay", "khanda", "valli", "pada", "kanda", "sukta",
  "varga", "anuvaka", "prakarana", "brahmana", "chapter", "part", "section", "book",
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
  brahmana: "brahmana",
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
  "Shriharsha", "Chitsukha", "Vidyaranya", "Achyutakrishnananda Tirtha",
]);

function cleanPayloadForStrapi(data: Record<string, any>): Record<string, any> {
  const cleaned: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    // Preserve `text` field on Strapi blocks text nodes — even when empty or null.
    // If text is null/undefined, convert it to "" so Strapi never sees a missing text field.
    if (key === "text" && (value === "" || value === null || value === undefined)) {
      cleaned[key] = "";
      continue;
    }
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
      let cleanedArr = value
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
      // If this looks like a Strapi blocks array, run a final sanitization pass
      // to guarantee every text node has a `text` field and every paragraph
      // has a valid children array — regardless of how the data arrived.
      if (cleanedArr.some((item: any) => item?.type === "paragraph" || item?.type === "heading")) {
        cleanedArr = sanitizeBlocksField(cleanedArr);
      }
      if (cleanedArr.length > 0) {
        cleaned[key] = cleanedArr;
      }
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

/** Ensure every node in a Strapi blocks array has valid structure.
 *  - Every {type:"text"} child must have a `text` field (defaults to "")
 *  - Every paragraph/heading must have a non-empty `children` array
 *  Applied automatically by cleanPayloadForStrapi to any array that looks
 *  like a blocks field (contains paragraph/heading nodes).
 */
function sanitizeBlocksField(blocks: any[]): any[] {
  return blocks.map((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return block;
    if (block.type !== "paragraph" && block.type !== "heading") return block;

    const rawChildren = Array.isArray(block.children) ? block.children : [];
    const children =
      rawChildren.length === 0
        ? [{ type: "text", text: "" }]
        : rawChildren.map((child: any) => {
            if (!child || typeof child !== "object") {
              return { type: "text", text: "" };
            }
            if (child.type === "text") {
              // text field must always be a string
              const t = child.text;
              return { ...child, text: typeof t === "string" ? t : "" };
            }
            return child;
          });

    return { ...block, children };
  });
}

const CONTENT_TYPE_MAP: Record<string, string> = {
  granthas: "granthas",
  sections: "sections",
  teekas: "teekas",
  articles: "articles",
  authors: "authors",
  categories: "categories",
  manthras: "manthras",
  chapters: "chapters",
};

// These content types exist in the portal but have no REST API route in Strapi.
// Drafts can be saved locally but cannot be published to Strapi directly.
const STRAPI_UNROUTED_TYPES = new Set(["prasthana-thraya-screens"]);

async function buildManthraData(
  manthra: Record<string, any>,
  sectionDocId: string | undefined,
  granthaDocId?: string,
  teekaNameToDocId?: Map<string, string>
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

  const cleaned = cleanPayloadForStrapi(mData);

  // Normalize TextAndTranslation fields so OtherTranslations is always in Strapi's
  // repeatable-component format regardless of which format the draft stored them in.
  for (const key of ["ShlokaManthraEntry", "BhashyamEntry"] as const) {
    if (cleaned[key] && typeof cleaned[key] === "object" && !Array.isArray(cleaned[key])) {
      cleaned[key] = normalizeTextAndTranslation(cleaned[key]);
    }
  }

  // Resolve Teekas — grantha-wizard manthras store { TeekaName, TeekaAuthor, TeekaEntry }.
  // resolveManthraTeekas looks up each Teeka record in Strapi and converts to the
  // { teeka: documentId, TeekaEntry: {...} } format Strapi's bhashya-entries component expects.
  //
  // IMPORTANT: when the manthra has a Teekas array (even if empty or unresolvable),
  // always include Teekas in the PUT payload — even as [].  Strapi v5 validates ALL
  // existing relations on every PUT, so if the manthra's stored Teekas relation in
  // Strapi points to a deleted teeka document, omitting Teekas from the PUT body causes
  // Strapi to return 400 "Document with id X not found" for that stale relation.
  // By explicitly sending Teekas: [] we force Strapi to clear the broken relation.
  const rawTeekas = manthra.Teekas;
  if (Array.isArray(rawTeekas)) {
    const resolvedTeekas = rawTeekas.length > 0
      ? await resolveManthraTeekas(rawTeekas, granthaDocId, teekaNameToDocId)
      : [];
    // Always set — even [] — so Strapi clears stale/broken teeka relations
    cleaned.Teekas = resolvedTeekas;
  }

  return cleaned;
}

// Strapi's sections collection only accepts these values for the `type` field.
// Any portal-side type label that isn't in this set must be mapped to "section"
// (a safe generic fallback) before being sent to the API — otherwise Strapi
// returns a 400 ValidationError and the section (and all its manthras) fails silently.
const VALID_STRAPI_SECTION_TYPES = new Set([
  "adhyay", "khanda", "valli", "pada", "kanda", "sukta", "varga",
  "anuvaka", "prakarana", "chapter", "part", "section", "book",
]);

// Helper: find an existing Strapi section by title+grantha+parent, or create it if missing.
// This prevents duplicate sections on repeated publishes of the same grantha draft.
async function findOrCreateSection(
  title: string,
  type: string | undefined,
  order: number | undefined,
  granthaDocId: string,
  parentDocId: string | undefined
): Promise<string | undefined> {
  // Guard: never create or look up a section with a blank title.
  // Blank-titled sections corrupt the hierarchy and are impossible to reliably dedup.
  if (!title || !title.trim()) {
    console.warn(`[publish] Skipping section with blank title (type=${type}, order=${order}) — not publishing to Strapi`);
    return undefined;
  }

  // Normalise the section type: if the portal label isn't in Strapi's allowed enum
  // (e.g. "brahmana", "adhikarana", etc.) use "section" as a safe generic fallback.
  // This prevents 400 ValidationErrors when creating new sections and also avoids
  // futile type-correction PUTs that would just fail with the same 400.
  const effectiveType = type
    ? (VALID_STRAPI_SECTION_TYPES.has(type) ? type : "section")
    : undefined;
  if (type && effectiveType !== type) {
    console.warn(`[publish] Section type "${type}" is not a valid Strapi type — using "section" instead`);
  }

  // Search for an existing section that matches title + grantha + parent.
  // Use $eqi (case-insensitive) so "Prathama Adhyaya" and "prathama adhyaya" are treated as the same section.
  try {
    const t = encodeURIComponent(title.trim());
    const g = encodeURIComponent(granthaDocId);
    let url = `/api/sections?filters[title][$eqi]=${t}&filters[grantha][documentId][$eq]=${g}&fields[0]=documentId&fields[1]=type`;
    if (parentDocId) {
      url += `&filters[parent][documentId][$eq]=${encodeURIComponent(parentDocId)}`;
    } else {
      url += `&filters[parent][$null]=true`;
    }
    const existing = await strapiRequest(url);
    const existingRecord = existing?.data?.[0];
    const existingDocId: string | undefined = existingRecord?.documentId;
    if (existingDocId) {
      // Correct the type whenever it doesn't match — not just when it's missing.
      // This repairs sections that were created with the wrong type in an earlier publish.
      // Only attempt correction when effectiveType is a valid Strapi value.
      if (effectiveType && existingRecord?.type !== effectiveType) {
        try {
          await strapiRequest(`/api/sections/${existingDocId}`, {
            method: "PUT",
            body: JSON.stringify({ data: { type: effectiveType } }),
          });
          console.log(`[publish] Section "${title}" (${existingDocId}) type corrected: ${existingRecord?.type || "(none)"} → ${effectiveType}`);
        } catch (e: any) {
          console.warn(`[publish] Section "${title}" type correction failed: ${e.message}`);
        }
      } else {
        console.log(`[publish] Section "${title}" already exists: ${existingDocId} — reusing`);
      }
      return existingDocId;
    }
  } catch {
    // ignore lookup failure — fall through to create
  }

  // Not found — create a new section
  const payload: Record<string, any> = { title: title.trim(), grantha: granthaDocId };
  if (effectiveType) payload.type = effectiveType;
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

// Helper: resolve a section to its Strapi documentId.
// If the node already has a known Strapi docId (from a previous publish),
// use it directly (PUT to update order/type) — skipping the expensive dedup
// API lookup. Falls back to findOrCreateSection when no prior docId is known.
async function resolveSection(
  knownDocId: string | undefined,
  title: string,
  type: string | undefined,
  order: number | undefined,
  granthaDocId: string,
  parentDocId: string | undefined
): Promise<string | undefined> {
  // Normalise type to a valid Strapi enum value (same logic as findOrCreateSection).
  const effectiveType = type
    ? (VALID_STRAPI_SECTION_TYPES.has(type) ? type : "section")
    : undefined;

  if (knownDocId) {
    // Fast path: we already know this section's Strapi ID — update it in place
    try {
      const payload: Record<string, any> = {};
      if (effectiveType) payload.type = effectiveType;
      if (order != null) payload.order = order;
      if (Object.keys(payload).length > 0) {
        await strapiRequest(`/api/sections/${knownDocId}`, {
          method: "PUT",
          body: JSON.stringify({ data: payload }),
        });
      }
      console.log(`[publish] Section "${title}" fast-path (known docId ${knownDocId})`);
      return knownDocId;
    } catch (e: any) {
      // 404 means the section was deleted from Strapi since last publish — fall through to recreate
      if (e?.status === 404) {
        console.warn(`[publish] Section "${title}" docId ${knownDocId} is 404 in Strapi — recreating`);
      } else {
        console.warn(`[publish] Section "${title}" fast-path PUT failed (${e.message}), falling back to dedup`);
      }
    }
  }
  // Slow path: dedup lookup + create
  return findOrCreateSection(title, type, order, granthaDocId, parentDocId);
}

// Send a single Strapi request, splitting payload into chunks when 413.
// Strapi v5 PUT merges fields — omitted fields are preserved on the record.
// This lets us split large manthras into: core + BhashyamEntry + Teekas
// so ALL content is synced even when the combined payload exceeds the body limit.
async function strapiManthraRequest(
  endpoint: string,
  method: "PUT" | "POST",
  mData: Record<string, any>,
  label: string,
  warnings?: Array<{ manthra: string; error: string }>
): Promise<any> {
  // --- Fast path: single request ---
  try {
    const res = await strapiRequest(endpoint, { method, body: JSON.stringify({ data: mData }) });
    console.log(`[publish] Manthra "${label}" ${method === "PUT" ? "updated" : "created"} (single request)`);
    return res;
  } catch (e: any) {
    if (e?.status !== 413) throw e;
  }

  // --- Split path: payload too large, split into up to 3 smaller requests ---
  console.warn(`[publish] Manthra "${label}" 413 — splitting into chunked requests to sync all content`);

  // Separate the three large sections — each will be PUT independently.
  // Teekas are sent ONCE in their own chunk (never partial) to prevent duplicates,
  // because Teekas is a repeatable component: sending it twice would create doubles.
  const { BhashyamEntry, Teekas, ...coreData } = mData;

  let putEndpoint = endpoint;
  let mainRes: any;

  // Chunk 1: identity + ShlokaManthraEntry only (no BhashyamEntry, no Teekas)
  if (method === "POST") {
    // POST creates the record; subsequent chunks use PUT on the returned docId
    mainRes = await strapiRequest(endpoint, { method: "POST", body: JSON.stringify({ data: coreData }) });
    const newDocId: string | undefined = mainRes?.data?.documentId;
    if (!newDocId) throw new Error(`[publish] Manthra "${label}" POST succeeded but returned no documentId`);
    putEndpoint = `/api/manthras/${newDocId}`;
  } else {
    await strapiRequest(endpoint, { method: "PUT", body: JSON.stringify({ data: coreData }) });
    mainRes = { data: { documentId: endpoint.split("/").pop() } };
  }

  // Chunk 2: BhashyamEntry (separate PUT — Strapi preserves other fields when omitted)
  if (BhashyamEntry && Object.keys(BhashyamEntry).some((k) => BhashyamEntry[k])) {
    try {
      await strapiRequest(putEndpoint, { method: "PUT", body: JSON.stringify({ data: { BhashyamEntry } }) });
    } catch (e2: any) {
      if (e2?.status !== 413) throw e2;
      // BhashyamEntry itself is too large — split it further: Sanskrit first, then OtherTranslations
      const { OtherTranslations: bhashyamOtherTr, ...bhashyamCore } = BhashyamEntry;
      await strapiRequest(putEndpoint, { method: "PUT", body: JSON.stringify({ data: { BhashyamEntry: bhashyamCore } }) });
      // Now try to sync just the OtherTranslations by merging into BhashyamEntry
      if (bhashyamOtherTr) {
        try {
          await strapiRequest(putEndpoint, { method: "PUT", body: JSON.stringify({ data: { BhashyamEntry: { ...bhashyamCore, OtherTranslations: bhashyamOtherTr } } }) });
        } catch (e2b: any) {
          if (e2b?.status !== 413) throw e2b;
          warnings?.push({ manthra: label, error: `[WARNING] BhashyamEntry OtherTranslations could not be synced — too large even as a separate request. All other BhashyamEntry content was synced.` });
        }
      }
    }
  }

  // Chunk 3: Full Teekas array sent once — includes all TeekaEntry content
  if (Array.isArray(Teekas) && Teekas.length > 0) {
    try {
      await strapiRequest(putEndpoint, { method: "PUT", body: JSON.stringify({ data: { Teekas } }) });
    } catch (e3: any) {
      if (e3?.status !== 413) throw e3;
      // Teekas combined are too large — send each teeka individually
      // Fetch the current teekas so we can merge (avoids losing existing teeka IDs)
      let currentTeekas: any[] = [];
      try {
        const existing = await strapiRequest(`${putEndpoint}?populate[Teekas][populate]=*`, { method: "GET" });
        currentTeekas = existing?.data?.Teekas ?? [];
      } catch { /* if fetch fails, start fresh */ }

      let warnedTeekaOtherTr = false;
      for (let i = 0; i < (Teekas as any[]).length; i++) {
        const teeka = (Teekas as any[])[i];
        // Build a Teekas array: existing teekas up to this point + this teeka + remaining without TeekaEntry
        const updatedTeekas = [
          ...currentTeekas.slice(0, i),
          teeka,
          ...(Teekas as any[]).slice(i + 1).map((t: any) => { const { TeekaEntry: _te, ...ref } = t; return ref; }),
        ];
        try {
          await strapiRequest(putEndpoint, { method: "PUT", body: JSON.stringify({ data: { Teekas: updatedTeekas } }) });
          currentTeekas = updatedTeekas;
        } catch (e3b: any) {
          if (e3b?.status !== 413) throw e3b;
          // This individual teeka is too large — strip its OtherTranslations
          const { TeekaEntry, ...teekaRef } = teeka;
          const { OtherTranslations: _to, ...teEntryCore } = TeekaEntry ?? {};
          const slimTeeka = TeekaEntry ? { ...teekaRef, TeekaEntry: teEntryCore } : teekaRef;
          const updatedSlim = [
            ...currentTeekas.slice(0, i),
            slimTeeka,
            ...(Teekas as any[]).slice(i + 1).map((t: any) => { const { TeekaEntry: _te, ...ref } = t; return ref; }),
          ];
          await strapiRequest(putEndpoint, { method: "PUT", body: JSON.stringify({ data: { Teekas: updatedSlim } }) });
          currentTeekas = updatedSlim;
          if (!warnedTeekaOtherTr) {
            warnings?.push({ manthra: label, error: `[WARNING] One or more TeekaEntry OtherTranslations could not be synced — too large even as individual requests. All other Teeka content was synced.` });
            warnedTeekaOtherTr = true;
          }
        }
      }
    }
  }

  console.log(`[publish] Manthra "${label}" fully synced via chunked requests`);
  return mainRes;
}

// Helper: update an existing Strapi manthra (PUT).
// On 413, automatically splits the payload into multiple requests so all
// content is synced without any data loss.
async function updateExistingManthra(
  strapiDocumentId: string,
  mData: Record<string, any>,
  label: string,
  warnings?: Array<{ manthra: string; error: string }>
): Promise<string> {
  await strapiManthraRequest(`/api/manthras/${strapiDocumentId}`, "PUT", mData, label, warnings);
  return strapiDocumentId;
}

// Helper: create a manthra in Strapi if one with the same ShlokaManthraNumber+Section doesn't exist.
// If one IS found, UPDATE it so that content changes (teeka entries, shloka text, etc.)
// are never silently discarded.  A manthra can end up here without a stored strapiDocumentId
// when the draft was created before Strapi IDs were synced back, but the manthra already
// exists in Strapi — skipping it would throw away the user's edits.
// Returns the Strapi documentId of the manthra that was created or updated,
// so callers can sync it back into the portal draft hierarchy.
async function createOrUpdateManthra(
  mData: Record<string, any>,
  label: string,
  warnings?: Array<{ manthra: string; error: string }>
): Promise<string | undefined> {
  const sectionDocId: string | undefined = mData.Section;
  const number: string | undefined = mData.ShlokaManthraNumber;

  if (sectionDocId) {
    const s = encodeURIComponent(sectionDocId);

    // 1) ShlokaManthraNumber match within the same section — case-insensitive + trimmed
    //    so "Mantra 1.1.2" and "mantra 1.1.2 " are treated as the same manthra.
    if (number) {
      try {
        const n = encodeURIComponent(number.trim());
        const existing = await strapiRequest(
          `/api/manthras?filters[ShlokaManthraNumber][$eqi]=${n}&filters[Section][documentId][$eq]=${s}&fields[0]=documentId`
        );
        const existingDocId: string | undefined = existing?.data?.[0]?.documentId;
        if (existingDocId) {
          console.log(`[publish] Manthra "${label}" already exists (by name) — updating instead of skipping`);
          return await updateExistingManthra(existingDocId, mData, label + " [auto-update]", warnings);
        }
      } catch { /* ignore lookup failure — fall through to create */ }
    }

    // 2) Order match — same position → likely the same manthra entered under a slightly different label
    if (mData.order != null) {
      try {
        const o = encodeURIComponent(String(mData.order));
        const existingByOrder = await strapiRequest(
          `/api/manthras?filters[order][$eq]=${o}&filters[Section][documentId][$eq]=${s}&fields[0]=documentId`
        );
        const existingDocId: string | undefined = existingByOrder?.data?.[0]?.documentId;
        if (existingDocId) {
          console.log(`[publish] Manthra "${label}" already exists (by order=${mData.order}) — updating instead of skipping`);
          return await updateExistingManthra(existingDocId, mData, label + " [auto-update by order]", warnings);
        }
      } catch { /* ignore */ }
    }
  }

  const mr = await strapiManthraRequest("/api/manthras", "POST", mData, label, warnings);
  const createdDocId: string | undefined = mr?.data?.documentId;
  console.log(`[publish] Manthra "${label}" created: ${createdDocId}`);
  return createdDocId;
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
    deletedStrapiSectionDocIds,
    ...granthaDataRaw
  } = rawData;
  const granthaPayload = cleanPayloadForStrapi(granthaDataRaw);

  // Strapi requires BhashyakaraIntroduction.SanskritTextEntry to always be present
  // when BhashyakaraIntroduction is included. cleanPayloadForStrapi may have stripped
  // it out if it was empty (empty array → dropped). Ensure it exists with a default.
  if (
    granthaPayload.BhashyakaraIntroduction &&
    !granthaPayload.BhashyakaraIntroduction.SanskritTextEntry
  ) {
    granthaPayload.BhashyakaraIntroduction.SanskritTextEntry = [
      { type: "paragraph", children: [{ type: "text", text: "" }] },
    ];
  }

  // Set NumberOfTeekas from the wizard's teeka count (Strapi expects a number, 0 is valid)
  granthaPayload.NumberOfTeekas = Array.isArray(teekaDefinitions) ? teekaDefinitions.length : 0;

  // Convert local granthaNameTranslations → Strapi GranthaNameTranslations format.
  // The shared.translations component uses TranslationText (blocks) not GranthaNameTranslation.
  if (Array.isArray(granthaNameTranslationsLocal) && granthaNameTranslationsLocal.length > 0) {
    granthaPayload.GranthaNameTranslations = granthaNameTranslationsLocal.map((t: any) => ({
      LanguageOfTranslation: t.language || "",
      TranslationText: t.name
        ? [{ type: "paragraph", children: [{ type: "text", text: t.name }] }]
        : [{ type: "paragraph", children: [{ type: "text", text: "" }] }],
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
    // Uses case-insensitive ($eqi) matching and normalizes trailing whitespace.
    let existingDocId: string | undefined;
    if (granthaPayload.GranthaName) {
      try {
        const trimmedName = (granthaPayload.GranthaName as string).trim();
        const searchName = encodeURIComponent(trimmedName);
        // First try case-insensitive exact match ($eqi supported in Strapi v5)
        const existing = await strapiRequest(
          `/api/granthas?filters[GranthaName][$eqi]=${searchName}&fields[0]=documentId&fields[1]=GranthaName`
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

  // 2. Publish teekas (best-effort) — create each teeka and link to this grantha.
  // Also build a TeekaName→Strapi-documentId map so step 3 can resolve teekas instantly
  // without extra API lookups, even for teekas created for the first time right now.
  const teekaNameToDocId: Map<string, string> = new Map();
  if (Array.isArray(teekaDefinitions) && granthaDocId) {
    for (const teeka of teekaDefinitions) {
      // TeekaAuthor is a Strapi enum — only include if valid
      const validAuthor = teeka.TeekaAuthor && STRAPI_TEEKA_AUTHORS.has(teeka.TeekaAuthor)
        ? teeka.TeekaAuthor : undefined;
      // Use TeekaName if given; fall back to author name; skip if neither
      const effectiveName = (teeka.TeekaName || "").trim() || (validAuthor ? `${validAuthor} Teeka` : "");
      if (!effectiveName) continue;
      try {
        // Dedup: if a teeka with the same name already exists for this grantha, reuse it
        const tName = encodeURIComponent(effectiveName);
        const tGrantha = encodeURIComponent(granthaDocId);
        const existing = await strapiRequest(
          `/api/teekas?filters[TeekaName][$eqi]=${tName}&filters[grantha][documentId][$eq]=${tGrantha}&fields[0]=documentId`
        );
        const existingDocId: string | undefined = existing?.data?.[0]?.documentId;
        if (existingDocId) {
          console.log(`[publish] Teeka "${effectiveName}" already exists (${existingDocId}) — reusing`);
          teekaNameToDocId.set(effectiveName.toLowerCase(), existingDocId);
          continue;
        }
        const created = await strapiRequest("/api/teekas", {
          method: "POST",
          body: JSON.stringify({
            data: {
              TeekaName: effectiveName,
              ...(validAuthor ? { TeekaAuthor: validAuthor } : {}),
              grantha: granthaDocId,
            },
          }),
        });
        const createdDocId: string | undefined = created?.data?.documentId;
        if (createdDocId) {
          teekaNameToDocId.set(effectiveName.toLowerCase(), createdDocId);
          console.log(`[publish] Teeka "${effectiveName}" created (${createdDocId})`);
        } else {
          console.warn(`[publish] Teeka "${effectiveName}" created but no documentId returned`);
        }
      } catch (e: any) {
        console.error(`[publish] Teeka "${effectiveName}" failed:`, e.message);
      }
    }
  }
  console.log(`[publish] teekaNameToDocId map: ${[...teekaNameToDocId.entries()].map(([k, v]) => `"${k}"→${v}`).join(", ") || "(empty)"}`);

  // 2b. Delete explicitly removed sections from Strapi (best-effort).
  // The client tracks removed sections in deletedStrapiSectionDocIds.
  // We delete them here so they don't reappear on the next load.
  if (Array.isArray(deletedStrapiSectionDocIds) && deletedStrapiSectionDocIds.length > 0) {
    console.log(`[publish] Deleting ${deletedStrapiSectionDocIds.length} removed sections from Strapi: ${deletedStrapiSectionDocIds.join(", ")}`);
    for (const sectionDocId of deletedStrapiSectionDocIds) {
      try {
        await strapiRequest(`/api/sections/${sectionDocId}`, { method: "DELETE" });
        console.log(`[publish] Deleted section ${sectionDocId}`);
      } catch (e: any) {
        // 404 means already gone — that's fine
        if (e?.status !== 404) {
          console.error(`[publish] Failed to delete section ${sectionDocId}:`, e.message);
        }
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

  // manthraIdToDocId: local portal manthra id → Strapi documentId
  // Built during the traversal below; used to sync Strapi docIds back into the
  // draft hierarchy after publish so that the NEXT publish can do a direct PUT
  // (no dedup API calls) for every manthra whose docId is now known.
  const manthraIdToDocId: Map<string, string> = new Map();

  // Collect manthra publish failures so they can be surfaced to the user.
  // Each entry: { manthra: string (number/title), error: string }
  const publishFailures: Array<{ manthra: string; error: string }> = [];

  // Keys that carry no rich content — only identify/position the manthra.
  // A cleaned mData that only has these keys is a "Strapi-only" node: the user
  // never entered any content for it in the portal (it was supplemented from Strapi
  // to show context). Publishing a PUT on such a node would overwrite a collaborator's
  // content with an empty payload, so we skip the update entirely.
  const IDENTITY_ONLY_KEYS = new Set(["ShlokaManthraNumber", "order", "Section"]);

  async function publishManthra(
    manthra: any,
    sectionDocId: string | undefined
  ): Promise<void> {
    try {
      const mData = await buildManthraData(manthra, sectionDocId, granthaDocId, teekaNameToDocId);

      // ── Sanitise stored Strapi documentId ────────────────────────────────────
      // Strapi v5 documentIds are 20+ characters (e.g. "nljnhc539t2q4z7im448nznm").
      // Portal-generated UIDs (e.g. "k2tz7vh" — 7 chars) are local IDs that were
      // accidentally stored as strapiDocumentId due to a data-corruption bug.
      // Reject any stored ID shorter than 10 chars so we never fire a doomed PUT
      // and never perpetuate the wrong ID in the draft.
      const storedDocId =
        manthra.strapiDocumentId && manthra.strapiDocumentId.length >= 10
          ? manthra.strapiDocumentId
          : undefined;
      if (!storedDocId && manthra.strapiDocumentId) {
        console.warn(
          `[publish] Manthra "${manthra.ShlokaManthraNumber || manthra.title}" — strapiDocumentId "${manthra.strapiDocumentId}" looks like a local portal UID (too short), ignoring it and using create-or-update`
        );
      }

      // ── Collaborative-publish guard ──────────────────────────────────────────
      // If this manthra has a valid Strapi docId but the cleaned payload has NO
      // content beyond identity/position fields, the current user never edited it
      // locally. Skip the PUT so we don't silently erase another collaborator's work.
      // We still record the docId so the next draft open can reference it directly.
      const hasLocalContent = Object.keys(mData).some((k) => !IDENTITY_ONLY_KEYS.has(k));
      if (storedDocId && !hasLocalContent) {
        console.log(`[publish] Manthra "${manthra.title}" — Strapi-only node (no local content), skipping PUT, syncing docId`);
        if (manthra.id) manthraIdToDocId.set(manthra.id, storedDocId);
        return;
      }

      console.log(`[publish] Manthra payload:`, JSON.stringify(mData).slice(0, 300));
      let returnedDocId: string | undefined;
      if (storedDocId) {
        try {
          returnedDocId = await updateExistingManthra(storedDocId, mData, manthra.title, publishFailures);
        } catch (putErr: any) {
          const isOrphaned =
            putErr?.status === 404 ||
            // Strapi v5 returns 400 ValidationError (not 404) for documents that
            // exist in the DB but whose locale entry is missing — e.g. the message
            // "Document with id \"k2tz7vh\", locale \"null\" not found".
            // Treat these the same as a 404 so the manthra is re-created rather
            // than permanently failing.
            (putErr?.status === 400 && typeof putErr?.message === "string" && putErr.message.toLowerCase().includes("not found"));
          if (isOrphaned) {
            // The stored Strapi docId is orphaned (manthra was deleted in Strapi).
            // Fall back to create-or-update so the manthra is not silently lost.
            console.warn(
              `[publish] Manthra "${manthra.ShlokaManthraNumber || manthra.title}" — PUT ${putErr?.status} orphaned (docId ${storedDocId}), falling back to create`
            );
            returnedDocId = await createOrUpdateManthra(mData, manthra.title, publishFailures);
          } else {
            throw putErr;
          }
        }
      } else {
        returnedDocId = await createOrUpdateManthra(mData, manthra.title, publishFailures);
      }
      if (returnedDocId && manthra.id) {
        manthraIdToDocId.set(manthra.id, returnedDocId);
      }
    } catch (e: any) {
      const label = manthra.ShlokaManthraNumber || manthra.title || "(unknown)";
      const msg: string = e?.message || String(e);
      console.error(`[publish] Manthra "${label}" failed:`, msg);
      publishFailures.push({ manthra: label, error: msg });
    }
  }

  // Maps: local node .id → Strapi documentId, collected during traversal.
  // All three section levels + manthras are tracked so the next publish can
  // use the fast-path (direct PUT) without any dedup API lookups.
  const adhyayaIdToDocId: Map<string, string> = new Map();
  const khandaIdToDocId: Map<string, string> = new Map();
  const padaIdToDocId: Map<string, string> = new Map();

  if (Array.isArray(hierarchy) && granthaDocId) {
    for (const adhyaya of hierarchy) {
      // Guard: skip L1 sections with blank titles — they cannot be deduped and corrupt Strapi
      if (!adhyaya.title?.trim()) {
        console.warn(`[publish] Skipping L1 section with blank title (order=${adhyaya.order}) — fix the title in the portal before publishing`);
        continue;
      }

      let adhyayaDocId: string | undefined;
      try {
        adhyayaDocId = await resolveSection(
          adhyaya.documentId, adhyaya.title, L1type, adhyaya.order ?? undefined, granthaDocId, undefined
        );
      } catch (e: any) {
        const msg = e?.message || String(e);
        console.error(`[publish] Section L1 "${adhyaya.title}" failed:`, msg);
        publishFailures.push({ manthra: `[Section] ${adhyaya.title}`, error: msg });
        continue;
      }
      if (!adhyayaDocId) continue;
      if (adhyaya.id) adhyayaIdToDocId.set(adhyaya.id, adhyayaDocId);

      for (const khanda of (adhyaya.khandas ?? [])) {
        const isDefaultKhanda = khanda.title === "_default" || !levelTwoEnabled;
        let khandaDocId: string | undefined;

        if (!isDefaultKhanda) {
          // Guard: skip L2 sections with blank titles
          if (!khanda.title?.trim()) {
            console.warn(`[publish] Skipping L2 section with blank title under "${adhyaya.title}" (order=${khanda.order}) — fix the title in the portal before publishing`);
            continue;
          }
          try {
            khandaDocId = await resolveSection(
              khanda.documentId, khanda.title, L2type, khanda.order ?? undefined, granthaDocId, adhyayaDocId
            );
          } catch (e: any) {
            const msg = e?.message || String(e);
            console.error(`[publish] Section L2 "${khanda.title}" failed:`, msg);
            publishFailures.push({ manthra: `[Section] ${khanda.title}`, error: msg });
            continue;
          }
          if (!khandaDocId) continue;
          if (khanda.id) khandaIdToDocId.set(khanda.id, khandaDocId);
        } else {
          khandaDocId = adhyayaDocId;
        }

        if (levelThreeEnabled && Array.isArray(khanda.padas) && khanda.padas.length > 0) {
          for (const pada of khanda.padas) {
            // Guard: skip L3 sections with blank titles
            if (!pada.title?.trim()) {
              console.warn(`[publish] Skipping L3 section with blank title under "${khanda.title}" (order=${pada.order}) — fix the title in the portal before publishing`);
              continue;
            }
            let padaDocId: string | undefined;
            try {
              padaDocId = await resolveSection(
                pada.documentId, pada.title, L3type, pada.order ?? undefined, granthaDocId, khandaDocId
              );
            } catch (e: any) {
              const msg = e?.message || String(e);
              console.warn(`[publish] Pada "${pada.title}" failed:`, msg);
              publishFailures.push({ manthra: `[Section] ${pada.title}`, error: msg });
              continue;
            }
            if (!padaDocId) continue;
            if (pada.id) padaIdToDocId.set(pada.id, padaDocId);
            for (const manthra of (pada.manthras ?? [])) {
              await publishManthra(manthra, padaDocId);
            }
          }
        } else {
          for (const manthra of (khanda.manthras ?? [])) {
            await publishManthra(manthra, khandaDocId);
          }
        }
      }
    }
  }

  // Sync ALL Strapi documentIds (sections at every level + manthras) back into the
  // hierarchy so the next publish uses the fast-path for every known record.
  // Always generate updatedHierarchy (even when no new IDs were obtained) so the
  // draft is always a complete, authoritative snapshot of what's in Strapi.
  const hasSectionIds = adhyayaIdToDocId.size > 0 || khandaIdToDocId.size > 0 || padaIdToDocId.size > 0;
  const updatedHierarchy: any[] | undefined = Array.isArray(hierarchy)
    ? hierarchy.map((adhyaya: any) => ({
        ...adhyaya,
        ...(adhyayaIdToDocId.has(adhyaya.id) ? { documentId: adhyayaIdToDocId.get(adhyaya.id) } : {}),
        khandas: (adhyaya.khandas ?? []).map((khanda: any) => ({
          ...khanda,
          ...(khandaIdToDocId.has(khanda.id) ? { documentId: khandaIdToDocId.get(khanda.id) } : {}),
          padas: (khanda.padas ?? []).map((pada: any) => ({
            ...pada,
            ...(padaIdToDocId.has(pada.id) ? { documentId: padaIdToDocId.get(pada.id) } : {}),
            manthras: (pada.manthras ?? []).map((m: any) =>
              manthraIdToDocId.has(m.id) ? { ...m, strapiDocumentId: manthraIdToDocId.get(m.id) } : m
            ),
          })),
          manthras: (khanda.manthras ?? []).map((m: any) =>
            manthraIdToDocId.has(m.id) ? { ...m, strapiDocumentId: manthraIdToDocId.get(m.id) } : m
          ),
        })),
      }))
    : undefined;

  console.log(
    `[publish] Syncing back: ${adhyayaIdToDocId.size} adhyaya, ${khandaIdToDocId.size} khanda, ` +
    `${padaIdToDocId.size} pada, ${manthraIdToDocId.size} manthra docId(s) into draft hierarchy`
  );
  if (publishFailures.length > 0) {
    console.warn(`[publish] ${publishFailures.length} manthra(s) failed to publish:`,
      publishFailures.map(f => `"${f.manthra}": ${f.error}`).join("; ")
    );
  }

  return { strapiResult, updatedHierarchy, publishFailures };
}

/**
 * Normalize a TextAndTranslation object so Strapi always receives OtherTranslations
 * as a repeatable component array — even when the portal stored it in the legacy
 * flat-field format (LanguageOfTranslation + OtherLanguagesTranslation).
 *
 * Legacy (TextTranslationFields / Manthras page):
 *   { LanguageOfTranslation: "Kannada", OtherLanguagesTranslation: [...blocks] }
 *
 * Strapi expected format (shared.translations component):
 *   { OtherTranslations: [{ LanguageOfTranslation: "Kannada", TranslationText: [...blocks] }] }
 */
function normalizeTextAndTranslation(field: Record<string, any>): Record<string, any> {
  const {
    LanguageOfTranslation,
    OtherLanguagesTranslation,
    OtherTranslations,
    ...rest
  } = field;

  // Start with any already-correct OtherTranslations entries
  const existing: Array<Record<string, any>> = Array.isArray(OtherTranslations) ? OtherTranslations : [];

  // Promote legacy flat fields into the array if both language and text are present
  const legacyText = Array.isArray(OtherLanguagesTranslation) && OtherLanguagesTranslation.length > 0
    ? OtherLanguagesTranslation : null;
  if (LanguageOfTranslation && legacyText) {
    const alreadyCovered = existing.some(
      (t) => t.LanguageOfTranslation === LanguageOfTranslation
    );
    if (!alreadyCovered) {
      existing.push({ LanguageOfTranslation, TranslationText: legacyText });
    }
  }

  return {
    ...rest,
    ...(existing.length > 0 ? { OtherTranslations: existing } : {}),
  };
}

// Resolve raw Teeka entries (stored as { TeekaName, TeekaAuthor, TeekaEntry })
// into the format Strapi's default.bhashya-entries component expects:
//   { teeka: teekaDocumentId, TeekaEntry: {...} }
// The `teeka` field is a relation to the Teeka collection type — we look up the
// record by TeekaName. Entries whose Teeka record cannot be found are skipped.
//
// Resolution priority:
//   1. teekaNameToDocId map (built during this publish run — most reliable for newly-created teekas)
//   2. Stored teekaDocId / teeka.documentId — BUT only if it's a real Strapi documentId
//      (not a local portal UUID which contains hyphens and has never been saved to Strapi)
//   3. Strapi API name lookup (fallback)
async function resolveManthraTeekas(
  rawTeekas: any[],
  granthaDocId?: string,
  teekaNameToDocId?: Map<string, string>
): Promise<any[]> {
  console.log(`[resolveManthraTeekas] Processing ${rawTeekas.length} raw teeka(s):`,
    rawTeekas.map((t, i) => `[${i}] teekaDocId=${t.teekaDocId || t.teeka?.documentId || "(none)"} TeekaName="${t.TeekaName || ""}" hasTeekaEntry=${!!t.TeekaEntry}`));

  const resolved: any[] = [];
  for (const t of rawTeekas) {
    const TeekaName = (t.TeekaName || "").trim();

    // Priority 1: check the publish-run map (TeekaName→Strapi-docId built in step 2).
    // This is the most reliable source for teekas created during THIS publish operation.
    let teekaDocId: string | undefined;
    if (teekaNameToDocId && TeekaName) {
      teekaDocId = teekaNameToDocId.get(TeekaName.toLowerCase());
      if (teekaDocId) {
        console.log(`[resolveManthraTeekas] Resolved "${TeekaName}" via publish-run map → ${teekaDocId}`);
      }
    }

    // Priority 2: stored teekaDocId — only trust it if it looks like a real Strapi documentId.
    // Real Strapi v5 documentIds are 20+ character alphanumeric strings.
    // Portal-local IDs (nanoid) are typically 7 characters — far too short.
    // We use a minimum length of 20 chars to distinguish them.
    if (!teekaDocId) {
      const stored = t.teekaDocId || t.teeka?.documentId || undefined;
      if (stored && stored.length >= 20) {
        teekaDocId = stored;
        console.log(`[resolveManthraTeekas] Using stored Strapi documentId="${teekaDocId}"`);
      } else if (stored) {
        console.log(`[resolveManthraTeekas] Ignoring short/local ID "${stored}" (${stored.length} chars) — will use name lookup instead`);
      }
    }

    // Priority 3: Strapi API lookup by TeekaName
    if (!teekaDocId) {
      if (!TeekaName) {
        console.warn(`[resolveManthraTeekas] Entry has no teeka documentId and no TeekaName — skipping`);
        continue;
      }
      console.log(`[resolveManthraTeekas] No documentId; looking up by TeekaName="${TeekaName}"${granthaDocId ? ` grantha=${granthaDocId}` : ""}`);
      try {
        let url = `/api/teekas?filters[TeekaName][$eqi]=${encodeURIComponent(TeekaName)}&fields[0]=documentId&pagination[pageSize]=5`;
        if (granthaDocId) url += `&filters[grantha][documentId][$eq]=${encodeURIComponent(granthaDocId)}`;
        const found = await strapiRequest(url);
        console.log(`[resolveManthraTeekas] Lookup result for "${TeekaName}":`, JSON.stringify(found?.data || []));
        teekaDocId = found?.data?.[0]?.documentId;
      } catch (e: any) {
        console.error(`[resolveManthraTeekas] Lookup error for "${TeekaName}": ${e.message}`);
      }
      if (!teekaDocId) {
        console.warn(`[resolveManthraTeekas] Teeka record not found in Strapi: "${TeekaName}" — skipping this teeka entry`);
        continue;
      }
    }

    const item: any = { teeka: teekaDocId };
    if (t.TeekaEntry && typeof t.TeekaEntry === "object") {
      item.TeekaEntry = normalizeTextAndTranslation(t.TeekaEntry);
      console.log(`[resolveManthraTeekas] TeekaEntry keys: ${Object.keys(t.TeekaEntry).join(", ")}`);
    } else {
      console.warn(`[resolveManthraTeekas] No TeekaEntry for teeka documentId="${teekaDocId}" — teeka relation will be linked but entry content will be empty`);
    }
    resolved.push(item);
  }
  console.log(`[resolveManthraTeekas] Resolved ${resolved.length}/${rawTeekas.length} teeka(s)`);
  return resolved;
}

async function buildManthraPayloadAsync(data: Record<string, any>): Promise<Record<string, any>> {
  const {
    section,       // lowercase local field → maps to Strapi's capital-S Section relation
    grantha,       // local tracking only — not a direct field in Strapi Manthra schema
    Teekas: rawTeekas,
    _section,      // also local tracking
    ...rest
  } = data;

  const payload = cleanPayloadForStrapi(rest);

  // Normalize ShlokaManthraEntry and BhashyamEntry so OtherTranslations is always
  // in the repeatable-component format Strapi expects, not the legacy flat fields.
  for (const key of ["ShlokaManthraEntry", "BhashyamEntry"] as const) {
    if (payload[key] && typeof payload[key] === "object" && !Array.isArray(payload[key])) {
      payload[key] = normalizeTextAndTranslation(payload[key]);
    }
  }

  // Map section documentId → Section relation (Strapi v5 accepts raw documentId string)
  const sectionDocId = section || _section;
  if (sectionDocId && typeof sectionDocId === "string") {
    payload.Section = sectionDocId;
  }

  // order must be a number (not string)
  if (payload.order !== undefined && payload.order !== null) {
    const n = Number(payload.order);
    if (!Number.isNaN(n)) payload.order = n;
    else delete payload.order;
  }

  // Resolve teekas: look up each Teeka record by name and build the component array
  if (Array.isArray(rawTeekas) && rawTeekas.length > 0) {
    const resolvedTeekas = await resolveManthraTeekas(rawTeekas);
    if (resolvedTeekas.length > 0) {
      payload.Teekas = resolvedTeekas;
    }
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

async function buildChapterPayload(data: Record<string, any>): Promise<Record<string, any>> {
  const {
    _grantha,                // local-only prefix copy
    _parentDocId,            // local-only prefix copy
    grantha,                 // documentId string for the Grantha relation
    parent,                  // documentId string for the parent Chapter relation
    Teekas: rawTeekas,
    order,
    ...rest
  } = data;

  const payload = cleanPayloadForStrapi(rest);

  // Normalize TextAndTranslation fields so OtherTranslations is always
  // in the repeatable-component format Strapi expects.
  for (const key of ["ShlokaManthraEntry", "BhashyamForShlokaManthra"] as const) {
    if (payload[key] && typeof payload[key] === "object" && !Array.isArray(payload[key])) {
      payload[key] = normalizeTextAndTranslation(payload[key]);
    }
  }

  // Map grantha → Strapi relation
  const granthaId = grantha || _grantha;
  if (granthaId && typeof granthaId === "string") {
    payload.grantha = granthaId;
  }

  // Map parent → Strapi relation
  const parentId = parent || _parentDocId;
  if (parentId && typeof parentId === "string") {
    payload.parent = parentId;
  }

  // order must be a number
  if (order !== undefined && order !== null && order !== "") {
    const n = Number(order);
    if (!Number.isNaN(n)) payload.order = n;
  }

  // Resolve Teekas (same format as manthras)
  if (Array.isArray(rawTeekas) && rawTeekas.length > 0) {
    const resolvedTeekas = await resolveManthraTeekas(rawTeekas, granthaId || _grantha);
    if (resolvedTeekas.length > 0) {
      payload.Teekas = resolvedTeekas;
    }
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

  // ── Per-manthra publish ─────────────────────────────────────────────────────
  // Publishes (or updates) a single manthra from a grantha draft to Strapi.
  // Requires the grantha itself to already have a strapiDocumentId.
  // Body: { adhyayaId, khandaId, padaId?, manthraId }
  app.post("/api/drafts/:id/publish-manthra", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid draft ID" });

      const { adhyayaId, khandaId, padaId, manthraId } = req.body;
      if (!adhyayaId || !khandaId || !manthraId) {
        return res.status(400).json({ message: "adhyayaId, khandaId, and manthraId are required" });
      }

      const draft = await storage.getDraft(id, user.id);
      if (!draft) return res.status(404).json({ message: "Draft not found" });

      const granthaDocId: string | undefined = draft.strapiDocumentId;
      if (!granthaDocId) {
        return res.status(400).json({ message: "The grantha must be published to Strapi first before publishing individual mantras. Use 'Save & Publish' on the grantha to publish it, then try again." });
      }

      const data = draft.data as any;
      const hierarchy: any[] = data?.hierarchy || [];
      const structureConfig = data?.structureConfig || {};
      const teekaDefinitions: any[] = data?.teekas || [];

      // Locate the manthra node in the hierarchy
      const adhyaya = hierarchy.find((a: any) => a.id === adhyayaId);
      if (!adhyaya) return res.status(404).json({ message: "Adhyaya not found in draft" });
      const khanda = (adhyaya.khandas || []).find((k: any) => k.id === khandaId);
      if (!khanda) return res.status(404).json({ message: "Khanda not found in draft" });

      let manthraNode: any;
      let padaNode: any;
      if (padaId) {
        padaNode = (khanda.padas || []).find((p: any) => p.id === padaId);
        if (!padaNode) return res.status(404).json({ message: "Pada not found in draft" });
        manthraNode = (padaNode.manthras || []).find((m: any) => m.id === manthraId);
      } else {
        manthraNode = (khanda.manthras || []).find((m: any) => m.id === manthraId);
      }
      if (!manthraNode) return res.status(404).json({ message: "Manthra not found in draft" });

      // Build teekaNameToDocId by querying Strapi for existing teekas on this grantha
      const teekaNameToDocId: Map<string, string> = new Map();
      for (const teeka of teekaDefinitions) {
        const validAuthor = teeka.TeekaAuthor && STRAPI_TEEKA_AUTHORS.has(teeka.TeekaAuthor)
          ? teeka.TeekaAuthor : undefined;
        const effectiveName = (teeka.TeekaName || "").trim() || (validAuthor ? `${validAuthor} Teeka` : "");
        if (!effectiveName) continue;
        // Use stored teeka documentId if available
        if (teeka.documentId && teeka.documentId.length >= 10) {
          teekaNameToDocId.set(effectiveName.toLowerCase(), teeka.documentId);
          continue;
        }
        try {
          const tName = encodeURIComponent(effectiveName);
          const tGrantha = encodeURIComponent(granthaDocId);
          const existing = await strapiRequest(
            `/api/teekas?filters[TeekaName][$eqi]=${tName}&filters[grantha][documentId][$eq]=${tGrantha}&fields[0]=documentId`
          );
          const existingDocId: string | undefined = existing?.data?.[0]?.documentId;
          if (existingDocId) teekaNameToDocId.set(effectiveName.toLowerCase(), existingDocId);
        } catch (e: any) {
          console.warn(`[publish-manthra] Teeka "${effectiveName}" lookup failed:`, e.message);
        }
      }

      // Resolve section hierarchy in Strapi
      const L1name: string = structureConfig?.levelOneName || "Adhyaya";
      const L2name: string = structureConfig?.levelTwoName || "Khanda";
      const L3name: string = structureConfig?.levelThreeName || "Pada";
      const levelTwoEnabled: boolean = structureConfig?.levelTwoEnabled !== false;
      const levelThreeEnabled: boolean = !!structureConfig?.levelThreeEnabled;
      const L1type = mapSectionType(L1name);
      const L2type = mapSectionType(L2name);
      const L3type = mapSectionType(L3name);

      // L1: Adhyaya
      const adhyayaDocId = await resolveSection(
        adhyaya.documentId, adhyaya.title, L1type, adhyaya.order ?? undefined, granthaDocId, undefined
      );
      if (!adhyayaDocId) {
        return res.status(500).json({ message: `Could not resolve section "${adhyaya.title}" in Strapi` });
      }

      // L2: Khanda
      const isDefaultKhanda = khanda.title === "_default" || !levelTwoEnabled;
      let khandaDocId: string | undefined;
      if (isDefaultKhanda) {
        khandaDocId = adhyayaDocId;
      } else {
        khandaDocId = await resolveSection(
          khanda.documentId, khanda.title, L2type, khanda.order ?? undefined, granthaDocId, adhyayaDocId
        );
        if (!khandaDocId) {
          return res.status(500).json({ message: `Could not resolve section "${khanda.title}" in Strapi` });
        }
      }

      // L3: Pada (if applicable)
      let sectionDocId = khandaDocId;
      if (levelThreeEnabled && padaId && padaNode) {
        sectionDocId = await resolveSection(
          padaNode.documentId, padaNode.title, L3type, padaNode.order ?? undefined, granthaDocId, khandaDocId
        );
        if (!sectionDocId) {
          return res.status(500).json({ message: `Could not resolve section "${padaNode.title}" in Strapi` });
        }
      }

      // Build and publish the single manthra
      const publishFailures: Array<{ manthra: string; error: string }> = [];
      const mData = await buildManthraData(manthraNode, sectionDocId, granthaDocId, teekaNameToDocId);

      const storedDocId = manthraNode.strapiDocumentId && manthraNode.strapiDocumentId.length >= 10
        ? manthraNode.strapiDocumentId : undefined;

      let returnedDocId: string | undefined;
      if (storedDocId) {
        try {
          returnedDocId = await updateExistingManthra(storedDocId, mData, manthraNode.title, publishFailures);
        } catch (putErr: any) {
          const isOrphaned =
            putErr?.status === 404 ||
            (putErr?.status === 400 && typeof putErr?.message === "string" && putErr.message.toLowerCase().includes("not found"));
          if (isOrphaned) {
            console.warn(`[publish-manthra] PUT ${putErr?.status} — orphaned docId ${storedDocId}, recreating`);
            returnedDocId = await createOrUpdateManthra(mData, manthraNode.title, publishFailures);
          } else {
            throw putErr;
          }
        }
      } else {
        returnedDocId = await createOrUpdateManthra(mData, manthraNode.title, publishFailures);
      }

      // Update the draft hierarchy with the new strapiDocumentId so the next save persists it
      if (returnedDocId && manthraNode.id) {
        try {
          const updatedHierarchy = hierarchy.map((a: any) => {
            if (a.id !== adhyayaId) return a;
            return {
              ...a,
              khandas: (a.khandas || []).map((k: any) => {
                if (k.id !== khandaId) return k;
                if (padaId) {
                  return {
                    ...k,
                    padas: (k.padas || []).map((p: any) => {
                      if (p.id !== padaId) return p;
                      return {
                        ...p,
                        manthras: (p.manthras || []).map((m: any) =>
                          m.id === manthraId ? { ...m, strapiDocumentId: returnedDocId } : m
                        ),
                      };
                    }),
                  };
                }
                return {
                  ...k,
                  manthras: (k.manthras || []).map((m: any) =>
                    m.id === manthraId ? { ...m, strapiDocumentId: returnedDocId } : m
                  ),
                };
              }),
            };
          });
          await storage.updateDraft(id, user.id, { data: { ...data, hierarchy: updatedHierarchy } });
        } catch (saveErr: any) {
          console.warn(`[publish-manthra] Could not save updated docId back to draft:`, saveErr.message);
        }
      }

      const errors = publishFailures.filter(f => !f.error.startsWith("[WARNING]"));
      if (errors.length > 0) {
        return res.status(500).json({ message: errors[0].error, publishFailures });
      }

      res.json({
        strapiDocumentId: returnedDocId,
        warnings: publishFailures.filter(f => f.error.startsWith("[WARNING]")),
      });
    } catch (error: any) {
      console.error("[publish-manthra]", error);
      res.status(500).json({ message: error.message || "Failed to publish mantra" });
    }
  });

  app.post("/api/drafts/:id/publish", requireAuth, async (req, res) => {
    try {
      const user = req.user as User;
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid draft ID" });
      let draft = await storage.getDraft(id, user.id);
      if (!draft) return res.status(404).json({ message: "Draft not found" });
      if (draft.status === "published") {
        // Allow re-publishing: reset to "draft" so the publish route proceeds.
        // This handles the race window where the UI still shows the Publish button
        // after a successful publish (stale cache) and the user clicks again.
        const reset = await storage.updateDraft(id, user.id, { status: "draft" });
        if (reset) draft = reset;
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
      let updatedHierarchy: any[] | undefined;
      let publishFailures: Array<{ manthra: string; error: string }> | undefined;

      if (draft.contentType === "granthas") {
        // Granthas need special handling: strip wizard-only fields and
        // create chapter records separately in the correct order.
        const result = await publishGranthaWithHierarchy(draft);
        strapiResult = result.strapiResult;
        updatedHierarchy = result.updatedHierarchy;
        publishFailures = result.publishFailures;
      } else {
        const cleanedData =
          draft.contentType === "manthras"
            ? await buildManthraPayloadAsync(draft.data as Record<string, any>)
            : draft.contentType === "sections"
            ? buildSectionPayload(draft.data as Record<string, any>)
            : draft.contentType === "chapters"
            ? await buildChapterPayload(draft.data as Record<string, any>)
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

      // Sync Strapi documentIds back into the draft hierarchy so subsequent
      // publishes skip dedup API lookups and do direct PUTs for known manthras.
      if (updatedHierarchy) {
        const existingData = (draft.data as Record<string, any>) ?? {};
        await storage.updateDraft(id, user.id, {
          data: { ...existingData, hierarchy: updatedHierarchy },
        });
      }

      const newDocumentId = strapiResult?.data?.documentId || draft.strapiDocumentId;
      const updated = await storage.markDraftPublished(id, user.id, newDocumentId);

      const responseBody: Record<string, any> = { draft: updated, strapi: strapiResult };
      if (publishFailures && publishFailures.length > 0) {
        responseBody.warnings = publishFailures;
      }
      res.json(responseBody);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to publish draft" });
    }
  });

  // ───────────────── Admin: User Management ─────────────────

  // List all users (admin only)
  app.get("/api/admin/users", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      const safe = allUsers.map(({ password: _, ...u }) => u);
      res.json(safe);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to fetch users" });
    }
  });

  // Create a new user (admin only)
  app.post("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { username, password, displayName, role } = req.body;
      if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required" });
      }
      if (password.length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters" });
      }
      const existing = await storage.getUserByUsername(username);
      if (existing) {
        return res.status(409).json({ message: "Username already exists" });
      }
      const hashed = await hashPassword(password);
      const user = await storage.createUser({
        username,
        password: hashed,
        displayName: displayName || username,
        role: role === "admin" ? "admin" : "editor",
      });
      const { password: _, ...safe } = user;
      res.status(201).json(safe);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to create user" });
    }
  });

  // Update user role (admin only)
  app.patch("/api/admin/users/:id/role", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { role } = req.body;
      if (!role || !["admin", "editor"].includes(role)) {
        return res.status(400).json({ message: "Role must be 'admin' or 'editor'" });
      }
      const updated = await storage.updateUserRole(id, role);
      if (!updated) return res.status(404).json({ message: "User not found" });
      const { password: _, ...safe } = updated;
      res.json(safe);
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to update role" });
    }
  });

  // Reset user password (admin only)
  app.patch("/api/admin/users/:id/password", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { password } = req.body;
      if (!password || password.length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters" });
      }
      const hashed = await hashPassword(password);
      const updated = await storage.updateUserPassword(id, hashed);
      if (!updated) return res.status(404).json({ message: "User not found" });
      res.json({ message: "Password updated" });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to reset password" });
    }
  });

  // ── Backup routes (admin only — read-only snapshots of all Strapi content) ──
  // Backups are immutable: no update or delete routes exist.

  async function fetchAllStrapiPages(basePath: string): Promise<any[]> {
    const all: any[] = [];
    let page = 1;
    while (true) {
      const sep = basePath.includes("?") ? "&" : "?";
      const url = `${basePath}${sep}pagination[page]=${page}&pagination[pageSize]=100`;
      const result = await strapiRequest(url);
      if (!result?.data || !Array.isArray(result.data)) break;
      all.push(...result.data);
      const { pageCount } = result.meta?.pagination ?? {};
      if (!pageCount || page >= pageCount) break;
      page++;
    }
    return all;
  }

  async function fetchAllStrapiPagesLarge(basePath: string): Promise<any[]> {
    const all: any[] = [];
    let page = 1;
    while (true) {
      const sep = basePath.includes("?") ? "&" : "?";
      const url = `${basePath}${sep}pagination[page]=${page}&pagination[pageSize]=100`;
      const result = await strapiRequestLarge(url);
      if (!result?.data || !Array.isArray(result.data)) break;
      all.push(...result.data);
      const { pageCount } = result.meta?.pagination ?? {};
      if (!pageCount || page >= pageCount) break;
      page++;
    }
    return all;
  }

  app.get("/api/admin/backups", requireAuth, async (_req, res) => {
    try {
      const backups = await storage.listBackups();
      res.json(backups);
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to list backups" });
    }
  });

  // Full data dump (kept for download; not used by Browse UI).
  app.get("/api/admin/backups/:id/data", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid backup ID" });
      const backup = await storage.getBackup(id);
      if (!backup) return res.status(404).json({ message: "Backup not found" });
      res.json({
        id: backup.id,
        label: backup.label,
        createdAt: backup.createdAt,
        granthaCount: backup.granthaCount,
        sectionCount: backup.sectionCount,
        manthraCount: backup.manthraCount,
        data: backup.data,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to load backup" });
    }
  });

  // Lightweight summary: metadata + granthas + sections (no manthra text).
  // Used by the Browse UI to populate the sidebar without fetching the full blob.
  app.get("/api/admin/backups/:id/summary", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid backup ID" });
      const backup = await storage.getBackup(id);
      if (!backup) return res.status(404).json({ message: "Backup not found" });
      const d = backup.data as any;

      // Build per-section manthra count from the manthras array.
      const manthraCountBySection: Record<number, number> = {};
      for (const m of (d.manthras ?? [])) {
        const sid = m?.Section?.id;
        if (sid != null) manthraCountBySection[sid] = (manthraCountBySection[sid] ?? 0) + 1;
      }

      res.json({
        id: backup.id,
        label: backup.label,
        createdAt: backup.createdAt,
        granthaCount: backup.granthaCount,
        sectionCount: backup.sectionCount,
        manthraCount: backup.manthraCount,
        granthas: d.granthas ?? [],
        sections: (d.sections ?? []).map((s: any) => ({
          id: s.id,
          documentId: s.documentId,
          title: s.title,
          type: s.type,
          order: s.order,
          grantha: s.grantha,
          parent: s.parent,
          manthraCount: manthraCountBySection[s.id] ?? 0,
        })),
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to load backup summary" });
    }
  });

  // Manthras for a specific section — fetched on demand by the Browse UI.
  app.get("/api/admin/backups/:id/sections/:sectionId/manthras", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const sectionId = parseInt(req.params.sectionId);
      if (isNaN(id) || isNaN(sectionId)) return res.status(400).json({ message: "Invalid ID" });
      const backup = await storage.getBackup(id);
      if (!backup) return res.status(404).json({ message: "Backup not found" });
      const d = backup.data as any;
      const manthras = (d.manthras ?? []).filter((m: any) => m?.Section?.id === sectionId);
      manthras.sort((a: any, b: any) => (a.order ?? 999) - (b.order ?? 999));
      res.json(manthras);
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to load manthras" });
    }
  });

  app.get("/api/admin/backups/:id/download", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid backup ID" });
      const backup = await storage.getBackup(id);
      if (!backup) return res.status(404).json({ message: "Backup not found" });
      const label = (backup.label as string).replace(/[^a-z0-9_\-]/gi, "_");
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="ekatmadham-backup-${label}-${backup.id}.json"`);
      res.json(backup.data);
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Failed to download backup" });
    }
  });

  // Import a backup snapshot from another environment (e.g. copy dev → prod).
  // Body: { label, granthaCount, sectionCount, manthraCount, data }
  app.post("/api/admin/backups/import", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { label, granthaCount, sectionCount, manthraCount, data } = req.body;
      if (!data || typeof data !== "object") return res.status(400).json({ message: "Missing data payload" });
      const backup = await storage.createBackup(
        label ?? new Date().toISOString(),
        data,
        Number(granthaCount ?? 0),
        Number(sectionCount ?? 0),
        Number(manthraCount ?? 0),
      );
      res.status(201).json({ id: backup.id, label: backup.label });
    } catch (e: any) {
      res.status(500).json({ message: e.message || "Import failed" });
    }
  });

  // Track in-progress backup to prevent duplicate requests.
  let backupInProgress = false;

  app.post("/api/admin/backup", requireAuth, requireAdmin, (_req, res) => {
    if (backupInProgress) {
      return res.status(409).json({ message: "A snapshot is already being created. Please wait." });
    }

    // Respond immediately so the HTTP connection never times out.
    backupInProgress = true;
    res.status(202).json({ status: "started" });

    // Run the heavy Strapi fetches in the background.
    (async () => {
      try {
        console.log("[backup] Starting full Strapi snapshot...");

        const granthaFields =
          "/api/granthas?" +
          "populate[BhashyakaraIntroduction][populate][OtherTranslations]=true" +
          "&populate[GranthaNameTranslations]=true" +
          "&populate[teekas]=true";

        const sectionFields =
          "/api/sections?" +
          "populate[grantha][fields][0]=documentId&populate[grantha][fields][1]=GranthaName" +
          "&populate[parent][fields][0]=documentId&populate[parent][fields][1]=title" +
          "&populate[titleTranslations]=true";

        const manthraFields =
          "/api/manthras?" +
          "populate[ShlokaManthraEntry][populate][OtherTranslations]=true" +
          "&populate[BhashyamEntry][populate][OtherTranslations]=true" +
          "&populate[Teekas][populate][teeka]=true" +
          "&populate[Teekas][populate][TeekaEntry][populate][OtherTranslations]=true" +
          "&populate[wordMeanings]=true" +
          "&populate[Section][populate][grantha][fields][0]=documentId" +
          "&populate[Section][populate][grantha][fields][1]=GranthaName";

        const [granthas, sections, manthras] = await Promise.all([
          fetchAllStrapiPages(granthaFields),
          fetchAllStrapiPages(sectionFields),
          fetchAllStrapiPagesLarge(manthraFields),
        ]);

        console.log(`[backup] Fetched: ${granthas.length} granthas, ${sections.length} sections, ${manthras.length} manthras`);

        const label = new Date().toISOString().slice(0, 19).replace("T", " ");
        const snapshotData = {
          timestamp: new Date().toISOString(),
          granthaCount: granthas.length,
          sectionCount: sections.length,
          manthraCount: manthras.length,
          granthas,
          sections,
          manthras,
        };

        const backup = await storage.createBackup(
          label,
          snapshotData,
          granthas.length,
          sections.length,
          manthras.length
        );

        console.log(`[backup] Saved as backup #${backup.id}`);
      } catch (e: any) {
        console.error("[backup] Failed:", e.message);
      } finally {
        backupInProgress = false;
      }
    })();
  });

  app.get("/api/admin/backup/status", requireAuth, (_req, res) => {
    res.json({ inProgress: backupInProgress });
  });

  // Delete user (admin only — cannot delete yourself)
  app.delete("/api/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const me = req.user as User;
      if (id === me.id) {
        return res.status(400).json({ message: "You cannot delete your own account" });
      }
      const deleted = await storage.deleteUser(id);
      if (!deleted) return res.status(404).json({ message: "User not found" });
      res.json({ message: "User deleted" });
    } catch (error: any) {
      res.status(500).json({ message: error.message || "Failed to delete user" });
    }
  });

  return httpServer;
}
