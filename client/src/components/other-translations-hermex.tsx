import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { blocksToText, textToBlocks } from "@/lib/strapi-blocks";
import { hermexTranslate, type HermexTranslateMode } from "@/lib/hermex-translate";
import { otherTranslationLanguages, type StrapiBlock, type StrapiTranslation } from "@shared/schema";
import { Loader2, Sparkles } from "lucide-react";

type Props = {
  sectionLabel: string;
  sanskritBlocks?: StrapiBlock[] | string | null;
  englishBlocks?: StrapiBlock[] | string | null;
  existing: StrapiTranslation[];
  onApply: (merged: StrapiTranslation[]) => void;
};

function hasTranslationText(row: StrapiTranslation): boolean {
  return blocksToText(row.TranslationText).trim().length > 0;
}

function mergeHermexIntoExisting(
  existing: StrapiTranslation[],
  incoming: StrapiTranslation[],
  mode: HermexTranslateMode,
): StrapiTranslation[] {
  const byLang = new Map<string, StrapiTranslation>();
  for (const row of existing) {
    const lang = row.LanguageOfTranslation?.trim();
    if (lang) byLang.set(lang, row);
  }
  for (const row of incoming) {
    const lang = row.LanguageOfTranslation?.trim();
    if (!lang) continue;
    const prev = byLang.get(lang);
    if (mode === "all" || !prev || !hasTranslationText(prev)) {
      byLang.set(lang, {
        LanguageOfTranslation: lang,
        TranslationText: textToBlocks(blocksToText(row.TranslationText)),
        isAiTranslated: true,
      });
    }
  }
  return Array.from(byLang.values()).sort((a, b) =>
    (a.LanguageOfTranslation ?? "").localeCompare(b.LanguageOfTranslation ?? ""),
  );
}

export default function OtherTranslationsHermex({
  sectionLabel,
  sanskritBlocks,
  englishBlocks,
  existing,
  onApply,
}: Props) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [sourceLanguage, setSourceLanguage] = useState<"English" | "Sanskrit">("English");

  const englishText = blocksToText(englishBlocks);
  const sanskritText = blocksToText(sanskritBlocks);
  const sourceText = sourceLanguage === "English" ? englishText : sanskritText;

  const existingLangs = new Set(
    existing.filter(hasTranslationText).map((r) => r.LanguageOfTranslation?.trim()).filter(Boolean),
  );
  const missingLanguages = otherTranslationLanguages.filter((l) => !existingLangs.has(l));

  async function run(mode: HermexTranslateMode, targets: string[]) {
    if (!sourceText.trim()) {
      toast({
        variant: "destructive",
        title: "No source text",
        description: `Add ${sourceLanguage} text before running Gemini translation.`,
      });
      return;
    }
    if (targets.length === 0) {
      toast({
        variant: "destructive",
        title: "Nothing to translate",
        description: mode === "missing" ? "All languages already have translations." : "No target languages.",
      });
      return;
    }

    setBusy(true);
    try {
      const incoming = await hermexTranslate({
        sourceText: sourceText.trim(),
        sourceLanguage,
        targetLanguages: targets,
        context: sectionLabel,
        chunkSize: 5,
      });
      const merged = mergeHermexIntoExisting(existing, incoming, mode);
      onApply(merged);
      toast({
        title: "Gemini translation complete",
        description: `Updated ${incoming.length} language(s) for ${sectionLabel}. Review before publish.`,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({
        variant: "destructive",
        title: "Hermex / Gemini failed",
        description: msg,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-dashed border-primary/30 bg-primary/5 p-3 space-y-3">
      <div className="flex items-center gap-2 text-xs font-medium text-primary">
        <Sparkles className="w-3.5 h-3.5" />
        Gemini translation (Hermex)
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label className="text-[10px] text-muted-foreground">Source</Label>
          <Select
            value={sourceLanguage}
            onValueChange={(v) => setSourceLanguage(v as "English" | "Sanskrit")}
            disabled={busy}
          >
            <SelectTrigger className="h-8 text-xs w-32 mt-0.5">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="English">English</SelectItem>
              <SelectItem value="Sanskrit">Sanskrit</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="h-8 text-xs"
          disabled={busy || missingLanguages.length === 0}
          onClick={() => run("missing", [...missingLanguages])}
          data-testid={`hermex-missing-${sectionLabel}`}
        >
          {busy ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Sparkles className="w-3 h-3 mr-1" />}
          Translate missing ({missingLanguages.length})
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          disabled={busy}
          onClick={() => run("all", [...otherTranslationLanguages])}
          data-testid={`hermex-all-${sectionLabel}`}
        >
          {busy ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
          Translate all {otherTranslationLanguages.length} languages
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground leading-snug">
        Uses{" "}
        <a
          href="https://github.com/pseudo-usama/hermex"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          Hermex
        </a>{" "}
        to drive Gemini in Chrome. First run may take several minutes for all languages. Requires{" "}
        <code className="text-[10px]">npm run hermex:setup</code> once.
      </p>
    </div>
  );
}
