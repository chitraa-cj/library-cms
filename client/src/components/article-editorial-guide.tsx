import { ARTICLE_EDITORIAL_GUIDELINES } from "@shared/article-editorial";
import { Info } from "lucide-react";

export default function ArticleEditorialGuide() {
  return (
    <div
      className="rounded-lg border border-border bg-muted/40 p-4 text-sm"
      data-testid="article-editorial-guide"
    >
      <div className="flex items-start gap-2 font-medium text-foreground mb-2">
        <Info className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
        Editorial standards
      </div>
      <ul className="list-disc pl-5 space-y-1.5 text-muted-foreground">
        {ARTICLE_EDITORIAL_GUIDELINES.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
