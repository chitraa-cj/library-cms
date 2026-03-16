import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { STRAPI_POLL_INTERVAL } from "@/hooks/use-strapi-sync";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Save, RefreshCw, Info } from "lucide-react";
import RichTextEditor from "@/components/rich-text-editor";
import type { StrapiBlock } from "@shared/schema";

const SYSTEM_KEYS = new Set([
  "id", "documentId", "createdAt", "updatedAt", "publishedAt", "locale",
]);

type FieldValue = string | number | boolean | null | undefined | object;
type EditValue = string | StrapiBlock[];

function isRichText(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    typeof (v[0] as any)?.type === "string" &&
    Array.isArray((v[0] as any)?.children)
  );
}

function isNestedObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface EditableField {
  key: string;
  rawValue: FieldValue;
  displayValue: string;
  kind: "text" | "richtext" | "number" | "boolean" | "relation" | "unknown";
}

function parseFields(data: Record<string, FieldValue>): EditableField[] {
  return Object.entries(data)
    .filter(([k]) => !SYSTEM_KEYS.has(k))
    .map(([key, rawValue]) => {
      if (typeof rawValue === "number") {
        return { key, rawValue, displayValue: String(rawValue), kind: "number" as const };
      }
      if (typeof rawValue === "boolean") {
        return { key, rawValue, displayValue: String(rawValue), kind: "boolean" as const };
      }
      if (typeof rawValue === "string") {
        return { key, rawValue, displayValue: rawValue, kind: "text" as const };
      }
      if (isRichText(rawValue)) {
        return { key, rawValue, displayValue: "", kind: "richtext" as const };
      }
      if (isNestedObject(rawValue)) {
        return { key, rawValue, displayValue: JSON.stringify(rawValue, null, 2), kind: "unknown" as const };
      }
      if (Array.isArray(rawValue)) {
        return { key, rawValue, displayValue: JSON.stringify(rawValue, null, 2), kind: "unknown" as const };
      }
      if (rawValue === null || rawValue === undefined) {
        return { key, rawValue, displayValue: "", kind: "text" as const };
      }
      return { key, rawValue, displayValue: String(rawValue), kind: "unknown" as const };
    });
}

function friendlyLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

export default function SingleTypeEditor({
  apiPath,
  title,
  description,
}: {
  apiPath: string;
  title: string;
  description?: string;
}) {
  const { toast } = useToast();
  const [edits, setEdits] = useState<Record<string, EditValue>>({});
  const [dirty, setDirty] = useState(false);

  const { data, isLoading, error, refetch } = useQuery<{ data: Record<string, FieldValue> | null }>({
    queryKey: [`/api/strapi/${apiPath}`],
    refetchInterval: STRAPI_POLL_INTERVAL,
    refetchOnWindowFocus: true,
  });

  const record = data?.data;
  const fields = record ? parseFields(record) : [];

  useEffect(() => {
    if (record && !dirty) {
      const initial: Record<string, EditValue> = {};
      parseFields(record).forEach((f) => {
        if (f.kind === "richtext") {
          initial[f.key] = (f.rawValue as StrapiBlock[]) ?? [];
        } else if (f.kind === "text" || f.kind === "number") {
          initial[f.key] = f.displayValue;
        }
      });
      setEdits(initial);
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: async (payload: Record<string, EditValue | number>) => {
      const res = await apiRequest("PUT", `/api/strapi/${apiPath}`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/strapi/${apiPath}`] });
      setDirty(false);
      toast({ title: "Saved to Strapi" });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Save failed", description: err.message });
    },
  });

  function handleSave() {
    const payload: Record<string, EditValue | number> = {};
    Object.entries(edits).forEach(([key, val]) => {
      const field = fields.find((f) => f.key === key);
      if (field?.kind === "number") {
        payload[key] = parseFloat(val as string) || 0;
      } else {
        payload[key] = val;
      }
    });
    saveMutation.mutate(payload);
  }

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{title}</h1>
          {description && (
            <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh">
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!dirty || saveMutation.isPending}
            data-testid="button-save"
          >
            {saveMutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5 mr-1.5" />
            )}
            Save to Strapi
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center items-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-6 text-sm text-destructive">
          Failed to load: {(error as any).message}
        </div>
      ) : !record ? (
        <div className="rounded-lg border border-border bg-muted/30 p-10 text-center text-sm text-muted-foreground">
          <Info className="w-8 h-8 mx-auto mb-3 opacity-40" />
          <p>No record found in Strapi for this single type.</p>
          <p className="mt-1 text-xs">Create it first in the Strapi admin panel.</p>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex items-center gap-2">
            <Badge className="bg-green-100 text-green-800 border-green-200 text-xs">Published in Strapi</Badge>
            {dirty && <Badge className="bg-amber-100 text-amber-800 border-amber-200 text-xs">Unsaved changes</Badge>}
          </div>

          {fields.map((field) => {
            if (field.kind === "unknown") {
              return (
                <div key={field.key} className="rounded-lg border border-border bg-muted/20 p-4">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                    {friendlyLabel(field.key)}
                    <span className="ml-2 font-normal normal-case text-muted-foreground/60">
                      (complex field — edit in Strapi admin)
                    </span>
                  </p>
                  <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono leading-relaxed max-h-40 overflow-y-auto">
                    {field.displayValue || "—"}
                  </pre>
                </div>
              );
            }

            if (field.kind === "boolean") {
              return (
                <div key={field.key} className="flex items-center justify-between rounded-lg border border-border p-4">
                  <Label className="text-sm font-medium">{friendlyLabel(field.key)}</Label>
                  <Badge variant={field.rawValue ? "default" : "secondary"}>
                    {field.rawValue ? "true" : "false"}
                  </Badge>
                </div>
              );
            }

            if (field.kind === "richtext") {
              return (
                <div key={field.key}>
                  <Label className="text-sm font-medium">{friendlyLabel(field.key)}</Label>
                  <RichTextEditor
                    value={edits[field.key] as StrapiBlock[] | undefined}
                    onChange={(v) => {
                      setEdits({ ...edits, [field.key]: v });
                      setDirty(true);
                    }}
                    placeholder={`Enter ${friendlyLabel(field.key).toLowerCase()}...`}
                    className="mt-1.5"
                    minHeight={120}
                    data-testid={`richtext-${field.key}`}
                  />
                </div>
              );
            }

            return (
              <div key={field.key}>
                <Label className="text-sm font-medium">{friendlyLabel(field.key)}</Label>
                <Input
                  type={field.kind === "number" ? "number" : "text"}
                  value={(edits[field.key] as string) ?? field.displayValue}
                  onChange={(e) => {
                    setEdits({ ...edits, [field.key]: e.target.value });
                    setDirty(true);
                  }}
                  className="mt-1.5"
                  data-testid={`input-${field.key}`}
                />
              </div>
            );
          })}

          <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground flex items-start gap-2">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              Text and rich text fields can be edited here and saved directly to Strapi.
              Media uploads and relations should be managed in the Strapi admin panel.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
