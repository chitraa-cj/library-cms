import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { TextAndTranslation } from "@shared/schema";
import { Languages } from "lucide-react";

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
            Sanskrit Text
          </Label>
          <Textarea
            value={value.SanskritTextEntry || ""}
            onChange={(e) =>
              onChange({ ...value, SanskritTextEntry: e.target.value })
            }
            placeholder="Enter Sanskrit text..."
            rows={3}
            className="mt-1.5 font-serif"
            data-testid={`${testIdPrefix}-sanskrit`}
          />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">
            English Translation
          </Label>
          <Textarea
            value={value.EnglishTranslationText || ""}
            onChange={(e) =>
              onChange({ ...value, EnglishTranslationText: e.target.value })
            }
            placeholder="Enter English translation..."
            rows={3}
            className="mt-1.5"
            data-testid={`${testIdPrefix}-english`}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label className="text-xs text-muted-foreground">
              Other Languages Translation
            </Label>
            <Textarea
              value={value.OtherLanguagesTranslation || ""}
              onChange={(e) =>
                onChange({
                  ...value,
                  OtherLanguagesTranslation: e.target.value,
                })
              }
              placeholder="Translation in other languages..."
              rows={2}
              className="mt-1.5"
              data-testid={`${testIdPrefix}-other`}
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">
              Language of Translation
            </Label>
            <Input
              value={value.LanguageOfTranslation || ""}
              onChange={(e) =>
                onChange({
                  ...value,
                  LanguageOfTranslation: e.target.value,
                })
              }
              placeholder="e.g., Hindi, Tamil..."
              className="mt-1.5"
              data-testid={`${testIdPrefix}-language`}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
