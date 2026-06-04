import type { StrapiBlock } from "./schema";
import {
  buildArticleJsonLd,
  mergeArticleSeoIntoStrapiPayload,
  stripArticlePortalKeys,
  validateArticleSeoFields,
  slugifyArticleTitle,
} from "./article-seo";

/** Portal-only fields stored on drafts; stripped before Strapi publish. */
export type ArticleDraftMeta = {
  eventDate: string;
  eventTime: string;
  place: string;
  lead?: string;
  body?: StrapiBlock[];
};

export const ARTICLE_EDITORIAL_GUIDELINES = [
  "Always include when, where, and time — readers need concrete context (date, time, place) in every article.",
  "Write like a real news or feature piece: who, what, when, where, why, and how much detail as you have.",
  "Use a question for the title when it fits — it sparks curiosity (e.g. “What drew thousands to the Ganga ghats that morning?”).",
  "Open with a strong lead that hooks the reader; follow with specifics, quotes, and scene details.",
  "Use your own words and verified sources — original, human voice; avoid copied or AI-sounding filler.",
  "Read aloud before publishing: natural rhythm and clear facts build trust.",
] as const;

const DATELINE_PREFIX = "When:";
const DATELINE_SEP = " | ";

export function formatArticleDateline(meta: ArticleDraftMeta): string {
  const datePart = meta.eventDate.trim();
  const timePart = meta.eventTime.trim();
  const placePart = meta.place.trim();
  const when =
    datePart && timePart
      ? `${datePart} at ${timePart}`
      : datePart || timePart || "(date/time not set)";
  return `${DATELINE_PREFIX} ${when}${DATELINE_SEP}Where: ${placePart || "(place not set)"}`;
}

export function paragraphBlock(text: string): StrapiBlock {
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { type: "paragraph", children: [{ type: "text", text: "" }] };
  }
  if (lines.length === 1) {
    return { type: "paragraph", children: [{ type: "text", text: lines[0]! }] };
  }
  return {
    type: "paragraph",
    children: lines.flatMap((line, i) =>
      i === 0 ? [{ type: "text", text: line }] : [{ type: "text", text: `\n${line}` }],
    ),
  };
}

/** Strapi blog dynamic zone entry (shared.rich-text). */
export function richTextZoneBlock(body: StrapiBlock[]): Record<string, unknown> {
  return {
    __component: "shared.rich-text",
    body: body.length > 0 ? body : [paragraphBlock("")],
  };
}

export function buildArticleBlocksForPublish(meta: ArticleDraftMeta): unknown[] {
  const pieces: StrapiBlock[] = [paragraphBlock(formatArticleDateline(meta))];
  const lead = (meta.lead ?? "").trim();
  if (lead) pieces.push(paragraphBlock(lead));
  const body = Array.isArray(meta.body) ? meta.body : [];
  for (const b of body) {
    if (b && typeof b === "object" && b.type) pieces.push(b);
  }
  return [richTextZoneBlock(pieces)];
}

export function validateArticleDraft(data: {
  title?: string;
  eventDate?: string;
  eventTime?: string;
  place?: string;
  body?: StrapiBlock[];
  lead?: string;
  metaTitle?: string;
  metaDescription?: string;
  focusKeyword?: string;
  slug?: string;
}): string | null {
  if (!data.title?.trim()) return "Title is required.";
  if (!data.eventDate?.trim()) return "Event date is required — readers need to know when this happened.";
  if (!data.eventTime?.trim()) return "Event time is required — include time (and timezone if relevant).";
  if (!data.place?.trim()) return "Place is required — include city, venue, or region.";
  const bodyLen = blocksPlainLength(data.body);
  const leadLen = (data.lead ?? "").trim().length;
  if (bodyLen + leadLen < 120) {
    return "Add more article body text (at least a few substantive paragraphs) so readers are fully informed.";
  }
  const seoErr = validateArticleSeoFields(data);
  if (seoErr) return seoErr;
  return null;
}

function blocksPlainLength(blocks: StrapiBlock[] | undefined): number {
  if (!Array.isArray(blocks)) return 0;
  let n = 0;
  for (const block of blocks) {
    const children = (block as { children?: Array<{ text?: string }> }).children;
    if (Array.isArray(children)) {
      for (const c of children) {
        if (typeof c.text === "string") n += c.text.length;
      }
    }
  }
  return n;
}

const DATELINE_RE =
  /^when:\s*(.+?)(?:\s*\|\s*where:\s*(.+))?$/i;

/** Parse dateline from published blocks when reopening an article. */
export function parseArticleMetaFromBlocks(blocks: unknown): Partial<ArticleDraftMeta> {
  const flat = flattenArticleBlocks(blocks);
  if (flat.length === 0) return {};
  const firstText = blockPlainText(flat[0]);
  const m = firstText.match(DATELINE_RE);
  if (!m) {
    return { body: flat };
  }
  const whenRaw = (m[1] ?? "").trim();
  const place = (m[2] ?? "").trim();
  let eventDate = "";
  let eventTime = "";
  const atIdx = whenRaw.toLowerCase().lastIndexOf(" at ");
  if (atIdx >= 0) {
    eventDate = whenRaw.slice(0, atIdx).trim();
    eventTime = whenRaw.slice(atIdx + 4).trim();
  } else {
    eventDate = whenRaw;
  }
  const rest = flat.slice(1);
  const leadText = rest[0] ? blockPlainText(rest[0]) : "";
  const bodyStart =
    leadText.length > 0 && leadText.length < 400 && !leadText.toLowerCase().startsWith("when:")
      ? 1
      : 0;
  return {
    eventDate,
    eventTime,
    place,
    lead: bodyStart === 1 ? leadText : undefined,
    body: rest.slice(bodyStart),
  };
}

function flattenArticleBlocks(blocks: unknown): StrapiBlock[] {
  if (!Array.isArray(blocks)) return [];
  const out: StrapiBlock[] = [];
  for (const item of blocks) {
    if (!item || typeof item !== "object") continue;
    const comp = item as Record<string, unknown>;
    if (comp.__component === "shared.rich-text" && Array.isArray(comp.body)) {
      out.push(...(comp.body as StrapiBlock[]));
      continue;
    }
    if (typeof comp.type === "string") out.push(comp as StrapiBlock);
  }
  return out;
}

export function enrichArticleDraftForSave(
  data: Record<string, unknown>,
  context?: { authorName?: string; categoryName?: string },
): Record<string, unknown> {
  const metaTitle = String(data.metaTitle ?? data.title ?? "").trim();
  const metaDescription = String(data.metaDescription ?? data.description ?? "").trim();
  const slug =
    String(data.slug ?? "").trim() ||
    slugifyArticleTitle(String(data.title ?? metaTitle));
  const seoJsonLd = buildArticleJsonLd({
    title: String(data.title ?? ""),
    metaTitle,
    metaDescription,
    slug,
    eventDate: String(data.eventDate ?? ""),
    place: String(data.place ?? ""),
    focusKeyword: String(data.focusKeyword ?? ""),
    metaKeywords: String(data.metaKeywords ?? ""),
    authorName: context?.authorName,
    categoryName: context?.categoryName,
  });
  return { ...data, seoJsonLd };
}

function blockPlainText(block: StrapiBlock | undefined): string {
  if (!block?.children) return "";
  return block.children.map((c) => c.text ?? "").join("");
}

/** Strapi REST payload for api::article.article */
export function buildArticleStrapiPayload(
  draft: Record<string, unknown>,
  _context?: { authorName?: string; categoryName?: string },
): Record<string, unknown> {
  const meta: ArticleDraftMeta = {
    eventDate: String(draft.eventDate ?? ""),
    eventTime: String(draft.eventTime ?? ""),
    place: String(draft.place ?? ""),
    lead: typeof draft.lead === "string" ? draft.lead : undefined,
    body: Array.isArray(draft.body) ? (draft.body as StrapiBlock[]) : undefined,
  };
  const metaTitle = String(draft.metaTitle ?? draft.title ?? "").trim();
  const metaDescription = String(draft.metaDescription ?? draft.description ?? "").trim();
  const slug =
    String(draft.slug ?? "").trim() ||
    slugifyArticleTitle(String(draft.title ?? metaTitle));

  const {
    eventDate: _ed,
    eventTime: _et,
    place: _pl,
    lead: _ld,
    body: _bd,
    blocks: _oldBlocks,
    focusKeyword: _fk,
    metaKeywords: _mk,
    metaTitle: _mt,
    metaDescription: _md,
    ogTitle: _ogt,
    ogDescription: _ogd,
    seoJsonLd: _jl,
    description: _desc,
    ...rest
  } = draft;

  const zoneBlocks = buildArticleBlocksForPublish(meta);
  const base = stripArticlePortalKeys({
    ...rest,
    title: String(draft.title ?? "").trim(),
    slug,
    blocks: zoneBlocks,
  });

  return mergeArticleSeoIntoStrapiPayload(base, {
    metaTitle,
    metaDescription,
    focusKeyword: String(draft.focusKeyword ?? ""),
    metaKeywords: String(draft.metaKeywords ?? ""),
    ogTitle: String(draft.ogTitle ?? ""),
    ogDescription: String(draft.ogDescription ?? ""),
  });
}
