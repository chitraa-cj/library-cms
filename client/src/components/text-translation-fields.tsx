import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TextAndTranslation } from "@shared/schema";
import { translationLanguages } from "@shared/schema";
import { Languages } from "lucide-react";
import RichTextEditor from "@/components/rich-text-editor";
import type { StrapiBlock } from "@shared/schema";

interface TextTranslationFieldsProps {
  title: string;
  value: TextAndTranslation;
  onChange: (value: TextAndTranslation) => void;
  testIdPrefix: string;
}

export default function TextTranslationFields({
  title,
  value,
  onChange,
  testIdPrefix,
}: TextTranslationFieldsProps) {
  const handleChange = (
    field: keyof TextAndTranslation,
    blocks: StrapiBlock[]
  ) => {
    onChange({ ...value, [field]: blocks });
  };

  return (
    <Card className="border-card-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Languages className="w-4 h-4 text-primary" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label className="text-xs text-muted-foreground">
            Sanskrit Text (Devanagari)
          </Label>
          <RichTextEditor
            value={value.SanskritTextEntry}
            onChange={(v) => handleChange("SanskritTextEntry", v)}
            placeholder="Enter Sanskrit text in Devanagari script..."
            className="mt-1.5"
            minHeight={80}
            data-testid={`${testIdPrefix}-sanskrit`}
          />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">
            English Translation
          </Label>
          <RichTextEditor
            value={value.EnglishTranslationText}
            onChange={(v) => handleChange("EnglishTranslationText", v)}
            placeholder="Enter English translation..."
            className="mt-1.5"
            minHeight={80}
            data-testid={`${testIdPrefix}-english`}
          />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">
            Language of Translation
          </Label>
          <Select
            value={
              typeof value.LanguageOfTranslation === "string"
                ? value.LanguageOfTranslation
                : ""
            }
            onValueChange={(val) =>
              onChange({ ...value, LanguageOfTranslation: val })
            }
          >
            <SelectTrigger
              className="mt-1.5"
              data-testid={`${testIdPrefix}-language`}
            >
              <SelectValue placeholder="Select language for translation" />
            </SelectTrigger>
            <SelectContent className="max-h-60">
              {translationLanguages.map((lang) => (
                <SelectItem key={lang} value={lang}>
                  {lang}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">
            Translation in Selected Language
          </Label>
          <RichTextEditor
            value={value.OtherLanguagesTranslation}
            onChange={(v) => handleChange("OtherLanguagesTranslation", v)}
            placeholder={
              value.LanguageOfTranslation
                ? `Enter translation in ${value.LanguageOfTranslation}...`
                : "Select a language above, then enter the translation..."
            }
            className="mt-1.5"
            minHeight={80}
            data-testid={`${testIdPrefix}-other`}
          />
        </div>
      </CardContent>
    </Card>
  );
}
