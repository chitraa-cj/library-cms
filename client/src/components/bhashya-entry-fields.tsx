import { useQuery } from "@tanstack/react-query";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import TextTranslationFields from "./text-translation-fields";
import type { BhashyaEntry, TextAndTranslation, StrapiTeeka, StrapiResponse } from "@shared/schema";
import { Plus, Trash2, BookText } from "lucide-react";

interface BhashyaEntryFieldsProps {
  title: string;
  entries: BhashyaEntry[];
  onChange: (entries: BhashyaEntry[]) => void;
  testIdPrefix: string;
}

export default function BhashyaEntryFields({
  title,
  entries: entriesProp,
  onChange,
  testIdPrefix,
}: BhashyaEntryFieldsProps) {
  const entries: BhashyaEntry[] = entriesProp ?? [];

  const { data: teekasData } = useQuery<StrapiResponse<StrapiTeeka>>({
    queryKey: ["/api/strapi/teekas"],
    refetchOnWindowFocus: false,
  });
  const allTeekas: StrapiTeeka[] = (teekasData?.data as any) || [];

  const addEntry = () => {
    onChange([
      ...entries,
      { teeka: null, TeekaName: "", TeekaAuthor: "", TeekaEntry: {} },
    ]);
  };

  const removeEntry = (index: number) => {
    onChange(entries.filter((_, i) => i !== index));
  };

  const selectTeeka = (index: number, documentId: string) => {
    const teekaRecord = allTeekas.find((t: any) => t.documentId === documentId);
    if (!teekaRecord) return;
    const updated = [...entries];
    updated[index] = {
      ...updated[index],
      teeka: {
        id: teekaRecord.id!,
        documentId: teekaRecord.documentId!,
        TeekaName: (teekaRecord as any).TeekaName || "",
        TeekaAuthor: (teekaRecord as any).TeekaAuthor || undefined,
      },
      TeekaName: (teekaRecord as any).TeekaName || "",
      TeekaAuthor: (teekaRecord as any).TeekaAuthor || "",
    };
    onChange(updated);
  };

  const updateEntry = (index: number, field: string, value: any) => {
    const updated = [...entries];
    (updated[index] as any)[field] = value;
    onChange(updated);
  };

  const getSelectedDocId = (entry: BhashyaEntry): string => {
    return entry.teeka?.documentId || "";
  };

  const getDisplayLabel = (entry: BhashyaEntry): string => {
    const name = entry.teeka?.TeekaName || entry.TeekaName || "";
    const author = entry.teeka?.TeekaAuthor || entry.TeekaAuthor || "";
    if (name && author) return `${name} — ${author}`;
    return name || author || "";
  };

  return (
    <Card className="border-card-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <BookText className="w-4 h-4 text-primary" />
            {title}
          </CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addEntry}
            data-testid={`${testIdPrefix}-add`}
          >
            <Plus className="w-3 h-3 mr-1" />
            Add Entry
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {entries.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-6">
            No entries yet. Click &quot;Add Entry&quot; to get started.
          </p>
        )}
        {entries.map((entry, index) => (
          <div
            key={index}
            className="border border-border rounded-lg p-4 space-y-4 relative"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Teeka {index + 1}
                {getDisplayLabel(entry) && (
                  <span className="ml-2 normal-case font-normal text-foreground">
                    — {getDisplayLabel(entry)}
                  </span>
                )}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => removeEntry(index)}
                data-testid={`${testIdPrefix}-remove-${index}`}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>

            <div>
              <Label className="text-xs text-muted-foreground">
                Select Teeka
              </Label>
              <Select
                value={getSelectedDocId(entry)}
                onValueChange={(val) => selectTeeka(index, val)}
              >
                <SelectTrigger
                  className="mt-1.5"
                  data-testid={`${testIdPrefix}-select-${index}`}
                >
                  <SelectValue placeholder="Choose a teeka commentary…">
                    {getSelectedDocId(entry) ? getDisplayLabel(entry) : undefined}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {allTeekas.length === 0 && (
                    <SelectItem value="__loading__" disabled>
                      Loading teekas…
                    </SelectItem>
                  )}
                  {allTeekas.map((t: any) => (
                    <SelectItem key={t.documentId} value={t.documentId}>
                      {t.TeekaName || "(unnamed)"}
                      {t.TeekaAuthor ? ` — ${t.TeekaAuthor}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <TextTranslationFields
              title="Teeka Entry"
              value={entry.TeekaEntry || {}}
              onChange={(val: TextAndTranslation) =>
                updateEntry(index, "TeekaEntry", val)
              }
              testIdPrefix={`${testIdPrefix}-entry-${index}`}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
