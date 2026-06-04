import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  ARTICLE_SEO_GUIDELINES,
  SEO_META_DESC_MAX,
  SEO_META_DESC_MIN,
  SEO_META_TITLE_MAX,
  SEO_META_TITLE_MIN,
  charCountStatus,
  evaluateArticleSeo,
  suggestMetaDescription,
  suggestMetaTitle,
  slugifyArticleTitle,
} from "@shared/article-seo";
import type { StrapiBlock } from "@shared/schema";
import { Sparkles, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export type ArticleSeoFormSlice = {
  title: string;
  slug: string;
  metaTitle: string;
  metaDescription: string;
  focusKeyword: string;
  metaKeywords: string;
  ogTitle: string;
  ogDescription: string;
  lead: string;
  body: StrapiBlock[];
  place: string;
  eventDate: string;
};

type Props = {
  value: ArticleSeoFormSlice;
  onChange: (patch: Partial<ArticleSeoFormSlice>) => void;
  siteBaseUrl?: string;
};

function CharHint({
  length,
  min,
  max,
}: {
  length: number;
  min: number;
  max: number;
}) {
  const status = charCountStatus(length, min, max);
  return (
    <span
      className={cn(
        "text-xs tabular-nums",
        status === "good" && "text-green-600 dark:text-green-500",
        status === "warn" && "text-amber-600 dark:text-amber-500",
        status === "bad" && "text-destructive",
      )}
    >
      {length}/{max} {status === "good" ? "✓" : status === "warn" ? "·" : "!"}
    </span>
  );
}

export default function ArticleSeoPanel({
  value,
  onChange,
  siteBaseUrl = "https://ekatmdhamlibrary.xoidlabs.com/articles",
}: Props) {
  const { score, checks } = useMemo(
    () =>
      evaluateArticleSeo({
        title: value.title,
        slug: value.slug,
        metaTitle: value.metaTitle,
        metaDescription: value.metaDescription,
        focusKeyword: value.focusKeyword,
        lead: value.lead,
        body: value.body,
        place: value.place,
      }),
    [value],
  );

  const serpUrl = `${siteBaseUrl.replace(/\/$/, "")}/${value.slug || "your-article-slug"}`;

  function autoFillSeo() {
    const metaTitle = suggestMetaTitle(value.title, value.place);
    const metaDescription = suggestMetaDescription({
      title: value.title,
      lead: value.lead,
      place: value.place,
      eventDate: value.eventDate,
      focusKeyword: value.focusKeyword,
    });
    const slug =
      value.slug.trim() || slugifyArticleTitle(value.title || value.metaTitle);
    const focusKeyword =
      value.focusKeyword.trim() ||
      value.place.split(",")[0]?.trim().toLowerCase() ||
      value.title.split(/\s+/).slice(0, 3).join(" ").toLowerCase();
    onChange({
      metaTitle,
      metaDescription,
      slug,
      focusKeyword,
      ogTitle: metaTitle,
      ogDescription: metaDescription,
      metaKeywords: value.metaKeywords || focusKeyword,
    });
  }

  return (
    <div
      className="rounded-lg border border-border bg-card p-4 space-y-4"
      data-testid="article-seo-panel"
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 font-medium">
          <Search className="w-4 h-4 text-primary" />
          SEO optimization
        </div>
        <div className="flex items-center gap-3">
          <Badge
            variant={score >= 85 ? "default" : score >= 60 ? "secondary" : "destructive"}
          >
            SEO score {score}%
          </Badge>
          <Button type="button" variant="outline" size="sm" onClick={autoFillSeo}>
            <Sparkles className="w-3.5 h-3.5 mr-1.5" />
            Auto-fill SEO
          </Button>
        </div>
      </div>

      <Progress value={score} className="h-2" />

      <ul className="grid sm:grid-cols-2 gap-1 text-xs text-muted-foreground">
        {checks.map((c) => (
          <li key={c.id} className={cn("flex gap-1.5", c.pass ? "text-green-700 dark:text-green-400" : "")}>
            <span>{c.pass ? "✓" : "○"}</span>
            <span>{c.label}</span>
          </li>
        ))}
      </ul>

      <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Google preview
        </p>
        <p className="text-[#1a0dab] dark:text-blue-400 text-lg leading-snug line-clamp-1">
          {value.metaTitle || value.title || "Meta title preview"}
        </p>
        <p className="text-[#006621] dark:text-green-600 text-xs truncate">{serpUrl}</p>
        <p className="text-sm text-muted-foreground line-clamp-2">
          {value.metaDescription || "Meta description preview — write 150–160 characters with keyword and place."}
        </p>
      </div>

      <div>
        <Label>Focus keyword *</Label>
        <Input
          value={value.focusKeyword}
          onChange={(e) => onChange({ focusKeyword: e.target.value })}
          placeholder="Primary phrase to rank for (e.g. ganga aarti varanasi)"
          className="mt-1.5"
          data-testid="input-article-focus-keyword"
        />
      </div>

      <div>
        <div className="flex items-center justify-between">
          <Label>Meta title *</Label>
          <CharHint
            length={value.metaTitle.length}
            min={SEO_META_TITLE_MIN}
            max={SEO_META_TITLE_MAX}
          />
        </div>
        <Input
          value={value.metaTitle}
          onChange={(e) => onChange({ metaTitle: e.target.value })}
          placeholder={`${SEO_META_TITLE_MIN}–${SEO_META_TITLE_MAX} characters — may differ slightly from H1`}
          maxLength={70}
          className="mt-1.5"
          data-testid="input-article-meta-title"
        />
      </div>

      <div>
        <div className="flex items-center justify-between">
          <Label>Meta description *</Label>
          <CharHint
            length={value.metaDescription.length}
            min={SEO_META_DESC_MIN}
            max={SEO_META_DESC_MAX}
          />
        </div>
        <Textarea
          value={value.metaDescription}
          onChange={(e) => onChange({ metaDescription: e.target.value })}
          placeholder={`${SEO_META_DESC_MIN}–${SEO_META_DESC_MAX} characters — keyword, hook, and place`}
          maxLength={170}
          rows={3}
          className="mt-1.5"
          data-testid="input-article-meta-description"
        />
      </div>

      <div>
        <Label>URL slug *</Label>
        <Input
          value={value.slug}
          onChange={(e) =>
            onChange({
              slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
            })
          }
          placeholder="keyword-rich-url-slug"
          className="mt-1.5 font-mono text-sm"
          data-testid="input-article-slug-seo"
        />
        <p className="text-xs text-muted-foreground mt-1 truncate">{serpUrl}</p>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <Label>Additional keywords</Label>
          <Input
            value={value.metaKeywords}
            onChange={(e) => onChange({ metaKeywords: e.target.value })}
            placeholder="comma, separated, terms"
            className="mt-1.5"
            data-testid="input-article-meta-keywords"
          />
        </div>
        <div>
          <Label>Open Graph title</Label>
          <Input
            value={value.ogTitle}
            onChange={(e) => onChange({ ogTitle: e.target.value })}
            placeholder="Defaults to meta title for social shares"
            className="mt-1.5"
            data-testid="input-article-og-title"
          />
        </div>
      </div>

      <div>
        <Label>Open Graph description</Label>
        <Textarea
          value={value.ogDescription}
          onChange={(e) => onChange({ ogDescription: e.target.value })}
          placeholder="Defaults to meta description — used when shared on social media"
          rows={2}
          className="mt-1.5"
          data-testid="input-article-og-description"
        />
      </div>

      <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-1">
        {ARTICLE_SEO_GUIDELINES.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
