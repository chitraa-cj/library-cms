import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import TextTranslationFields from "./text-translation-fields";
import type { BhashyaEntry, TextAndTranslation } from "@shared/schema";
import { Plus, Trash2, BookText } from "lucide-react";

interface BhashyaEntryFieldsProps {
  title: string;
  entries: BhashyaEntry[];
  onChange: (entries: BhashyaEntry[]) => void;
  testIdPrefix: string;
}

export default function BhashyaEntryFields({
  title,
  entries,
  onChange,
  testIdPrefix,
}: BhashyaEntryFieldsProps) {
  const addEntry = () => {
    onChange([
      ...entries,
      { TeekaName: "", TeekaAuthor: "", TeekaEntry: {} },
    ]);
  };

  const removeEntry = (index: number) => {
    onChange(entries.filter((_, i) => i !== index));
  };

  const updateEntry = (index: number, field: string, value: any) => {
    const updated = [...entries];
    (updated[index] as any)[field] = value;
    onChange(updated);
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
                Entry {index + 1}
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label className="text-xs text-muted-foreground">
                  Teeka Name
                </Label>
                <Input
                  value={entry.TeekaName || ""}
                  onChange={(e) =>
                    updateEntry(index, "TeekaName", e.target.value)
                  }
                  placeholder="Name of the Teeka"
                  className="mt-1.5"
                  data-testid={`${testIdPrefix}-name-${index}`}
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">
                  Teeka Author
                </Label>
                <Input
                  value={entry.TeekaAuthor || ""}
                  onChange={(e) =>
                    updateEntry(index, "TeekaAuthor", e.target.value)
                  }
                  placeholder="Author of the Teeka"
                  className="mt-1.5"
                  data-testid={`${testIdPrefix}-author-${index}`}
                />
              </div>
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
