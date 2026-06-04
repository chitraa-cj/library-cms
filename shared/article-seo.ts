import type { StrapiBlock } from "./schema";

/** Draft-only fields — never sent as top-level Strapi article keys. */
export const ARTICLE_PORTAL_ONLY_KEYS = [
  "eventDate",
  "eventTime",
  "place",
  "lead",
  "body",
  "focusKeyword",
  "metaKeywords",
  "seoJsonLd",
  "metaTitle",
  "metaDescription",
  "ogTitle",
  "ogDescription",
  "seoJsonLd",
] as const;

export type ArticleSeoDraft = {
  metaTitle: string;
  metaDescription: string;
  focusKeyword: string;
  metaKeywords?: string;
  ogTitle?: string;
  ogDescription?: string;
};

export const SEO_META_TITLE_MIN = 30;
export const SEO_META_TITLE_MAX = 60;
export const SEO_META_DESC_MIN = 120;
export const SEO_META_DESC_MAX = 160;

export const ARTICLE_SEO_GUIDELINES = [
  "Meta title: 50–60 characters, include the focus keyword near the start.",
  "Meta description: 150–160 characters — compelling summary with keyword and place.",
  "URL slug: short, lowercase, hyphenated; include primary keyword when natural.",
  "One H1 only (the article title); use H2/H3 in the body for sections.",
  "Use the focus keyword in the title, meta description, first paragraph, and one subheading.",
  "Include place and date context in the meta description for local/news relevance.",
] as const;

export function slugifyArticleTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80)
    .replace(/-+$/, "");
}

export function truncateAtWord(text: string, maxLen: number): string {
  const t = text.trim();
  if (t.length <= maxLen) return t;
  const cut = t.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

export function suggestMetaTitle(title: string, place?: string): string {
  const base = title.trim();
  if (!base) return "";
  if (base.length <= SEO_META_TITLE_MAX) return base;
  let shortened = truncateAtWord(base, SEO_META_TITLE_MAX);
  if (place && shortened.length < SEO_META_TITLE_MAX - 5) {
    const withPlace = truncateAtWord(`${shortened} | ${place}`, SEO_META_TITLE_MAX);
    if (withPlace.length >= SEO_META_TITLE_MIN) shortened = withPlace;
  }
  return shortened;
}

export function suggestMetaDescription(input: {
  title?: string;
  lead?: string;
  place?: string;
  eventDate?: string;
  focusKeyword?: string;
}): string {
  const lead = (input.lead ?? "").trim();
  const place = (input.place ?? "").trim();
  const kw = (input.focusKeyword ?? "").trim();
  let desc = lead;
  if (!desc && input.title) desc = input.title.trim();
  if (place && !desc.toLowerCase().includes(place.toLowerCase())) {
    desc = desc ? `${desc} — ${place}` : `Coverage from ${place}.`;
  }
  if (input.eventDate && !desc.includes(input.eventDate)) {
    const dateShort = input.eventDate;
    desc = truncateAtWord(`${desc} (${dateShort})`, SEO_META_DESC_MAX);
  }
  if (kw && !desc.toLowerCase().includes(kw.toLowerCase())) {
    desc = truncateAtWord(`${kw}: ${desc}`, SEO_META_DESC_MAX);
  }
  return truncateAtWord(desc, SEO_META_DESC_MAX);
}

export function blocksPlainText(blocks: StrapiBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    const children = (block as { children?: Array<{ text?: string }> }).children;
    if (Array.isArray(children)) {
      for (const c of children) {
        if (typeof c.text === "string") parts.push(c.text);
      }
    }
  }
  return parts.join(" ");
}

export type SeoCheckItem = {
  id: string;
  label: string;
  pass: boolean;
  weight: number;
};

export function evaluateArticleSeo(input: {
  title?: string;
  slug?: string;
  metaTitle?: string;
  metaDescription?: string;
  focusKeyword?: string;
  lead?: string;
  body?: StrapiBlock[];
  place?: string;
}): { score: number; checks: SeoCheckItem[] } {
  const title = (input.title ?? "").trim();
  const slug = (input.slug ?? "").trim();
  const metaTitle = (input.metaTitle ?? "").trim();
  const metaDescription = (input.metaDescription ?? "").trim();
  const focusKeyword = (input.focusKeyword ?? "").trim().toLowerCase();
  const lead = (input.lead ?? "").trim();
  const bodyText = blocksPlainText(input.body);
  const firstChunk = `${lead} ${bodyText}`.trim().slice(0, 600).toLowerCase();
  const place = (input.place ?? "").trim().toLowerCase();

  const kwInTitle = focusKeyword
    ? title.toLowerCase().includes(focusKeyword) || metaTitle.toLowerCase().includes(focusKeyword)
    : true;
  const kwInMeta = focusKeyword ? metaDescription.toLowerCase().includes(focusKeyword) : true;
  const kwInIntro = focusKeyword ? firstChunk.includes(focusKeyword) : true;

  const checks: SeoCheckItem[] = [
    {
      id: "meta-title-len",
      label: `Meta title length (${SEO_META_TITLE_MIN}–${SEO_META_TITLE_MAX} chars)`,
      pass: metaTitle.length >= SEO_META_TITLE_MIN && metaTitle.length <= SEO_META_TITLE_MAX,
      weight: 15,
    },
    {
      id: "meta-desc-len",
      label: `Meta description length (${SEO_META_DESC_MIN}–${SEO_META_DESC_MAX} chars)`,
      pass:
        metaDescription.length >= SEO_META_DESC_MIN &&
        metaDescription.length <= SEO_META_DESC_MAX,
      weight: 15,
    },
    {
      id: "slug",
      label: "URL slug is lowercase, hyphenated, and set",
      pass: slug.length >= 3 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug),
      weight: 10,
    },
    {
      id: "focus-keyword",
      label: "Focus keyword is set",
      pass: focusKeyword.length >= 2,
      weight: 10,
    },
    {
      id: "kw-title",
      label: "Focus keyword appears in title or meta title",
      pass: kwInTitle,
      weight: 15,
    },
    {
      id: "kw-meta",
      label: "Focus keyword appears in meta description",
      pass: kwInMeta,
      weight: 15,
    },
    {
      id: "kw-intro",
      label: "Focus keyword appears in opening content",
      pass: kwInIntro,
      weight: 10,
    },
    {
      id: "place-meta",
      label: "Place appears in meta description (local relevance)",
      pass: !place || metaDescription.toLowerCase().includes(place),
      weight: 5,
    },
    {
      id: "title-h1",
      label: "Article title (H1) is set and distinct from meta title when needed",
      pass: title.length >= 10,
      weight: 5,
    },
  ];

  const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
  const earned = checks.filter((c) => c.pass).reduce((s, c) => s + c.weight, 0);
  const score = totalWeight > 0 ? Math.round((earned / totalWeight) * 100) : 0;
  return { score, checks };
}

export function validateArticleSeoFields(data: {
  metaTitle?: string;
  metaDescription?: string;
  focusKeyword?: string;
  slug?: string;
}): string | null {
  const metaTitle = (data.metaTitle ?? "").trim();
  const metaDescription = (data.metaDescription ?? "").trim();
  const focusKeyword = (data.focusKeyword ?? "").trim();
  const slug = (data.slug ?? "").trim();

  if (!metaTitle) return "SEO meta title is required (50–60 characters ideal).";
  if (metaTitle.length < SEO_META_TITLE_MIN) {
    return `Meta title is too short (${metaTitle.length} chars). Aim for ${SEO_META_TITLE_MIN}–${SEO_META_TITLE_MAX} characters.`;
  }
  if (metaTitle.length > SEO_META_TITLE_MAX) {
    return `Meta title is too long (${metaTitle.length} chars). Keep it under ${SEO_META_TITLE_MAX} characters.`;
  }
  if (!metaDescription) return "SEO meta description is required (150–160 characters ideal).";
  if (metaDescription.length < SEO_META_DESC_MIN) {
    return `Meta description is too short (${metaDescription.length} chars). Aim for ${SEO_META_DESC_MIN}–${SEO_META_DESC_MAX} characters.`;
  }
  if (metaDescription.length > SEO_META_DESC_MAX) {
    return `Meta description is too long (${metaDescription.length} chars). Keep it under ${SEO_META_DESC_MAX} characters.`;
  }
  if (!focusKeyword || focusKeyword.length < 2) {
    return "Focus keyword is required — the primary phrase this article should rank for.";
  }
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return "URL slug must be lowercase letters, numbers, and hyphens only.";
  }
  return null;
}

export type NewsArticleJsonLd = {
  "@context": "https://schema.org";
  "@type": "NewsArticle";
  headline: string;
  description: string;
  datePublished?: string;
  dateModified?: string;
  author?: { "@type": "Person"; name: string };
  keywords?: string;
  articleSection?: string;
  contentLocation?: { "@type": "Place"; name: string };
};

export function buildArticleJsonLd(input: {
  title: string;
  metaDescription: string;
  metaTitle?: string;
  slug?: string;
  eventDate?: string;
  place?: string;
  focusKeyword?: string;
  metaKeywords?: string;
  authorName?: string;
  categoryName?: string;
  publishedAt?: string;
  updatedAt?: string;
}): NewsArticleJsonLd {
  const keywords = [input.focusKeyword, input.metaKeywords]
    .filter(Boolean)
    .join(", ")
    .trim();
  const jsonLd: NewsArticleJsonLd = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: input.metaTitle?.trim() || input.title.trim(),
    description: input.metaDescription.trim(),
  };
  if (input.eventDate || input.publishedAt) {
    jsonLd.datePublished = input.publishedAt || input.eventDate;
  }
  if (input.updatedAt) jsonLd.dateModified = input.updatedAt;
  if (input.authorName) {
    jsonLd.author = { "@type": "Person", name: input.authorName };
  }
  if (keywords) jsonLd.keywords = keywords;
  if (input.categoryName) jsonLd.articleSection = input.categoryName;
  if (input.place?.trim()) {
    jsonLd.contentLocation = { "@type": "Place", name: input.place.trim() };
  }
  return jsonLd;
}

/** Map portal draft → Strapi article fields + optional seo component. */
export function mergeArticleSeoIntoStrapiPayload(
  payload: Record<string, unknown>,
  seo: ArticleSeoDraft,
): Record<string, unknown> {
  const metaTitle = seo.metaTitle.trim();
  const metaDescription = seo.metaDescription.trim();

  return {
    ...payload,
    description: metaDescription,
    seo: {
      metaTitle,
      metaDescription,
    },
  };
}

export function stripArticlePortalKeys(payload: Record<string, unknown>): Record<string, unknown> {
  const out = { ...payload };
  for (const key of ARTICLE_PORTAL_ONLY_KEYS) {
    delete out[key];
  }
  delete out._ogTitle;
  delete out._ogDescription;
  delete out.seoJsonLd;
  return out;
}

export function charCountStatus(
  length: number,
  min: number,
  max: number,
): "good" | "warn" | "bad" {
  if (length >= min && length <= max) return "good";
  if (length === 0 || length > max) return "bad";
  return "warn";
}
