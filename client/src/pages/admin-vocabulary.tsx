import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { PORTAL_VOCABULARY_QUERY_KEY, usePortalVocabulary } from "@/hooks/use-portal-vocabulary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ListPlus, Loader2, Trash2, BookMarked } from "lucide-react";
import {
  portalVocabularyKeys,
  type PortalVocabularyKey,
  teekaAuthors,
  bhashyamAuthors,
  prasthanaBhashyamAuthors,
  defaultStructureLevelOneNames,
  defaultStructureLevelTwoNames,
  defaultStructureLevelThreeNames,
  defaultStructureLeafNames,
} from "@shared/schema";

const SECTIONS: {
  key: PortalVocabularyKey;
  title: string;
  description: string;
  defaults: readonly string[];
}[] = [
  {
    key: "teekaAuthors",
    title: "Teeka authors (Teekakara)",
    description: "Shown in teeka author dropdowns across granthas, teekas, and mantras.",
    defaults: teekaAuthors,
  },
  {
    key: "bhashyamAuthors",
    title: "Bhashyam authors",
    description:
      "Shown in Bhashyam Author dropdowns on grantha and prasthana forms. Names added here publish directly — this list is the guardrail.",
    defaults: [...new Set([...bhashyamAuthors, ...prasthanaBhashyamAuthors])],
  },
  {
    key: "structureLevelOneNames",
    title: "Top-level division names",
    description: "Section headings in the grantha structure wizard (e.g. Adhyaya, Kanda).",
    defaults: defaultStructureLevelOneNames,
  },
  {
    key: "structureLevelTwoNames",
    title: "Sub-section names",
    description: "Second-level headings (e.g. Khanda, Valli, Anuvaka).",
    defaults: defaultStructureLevelTwoNames,
  },
  {
    key: "structureLevelThreeNames",
    title: "Sub-sub-section names",
    description: "Third-level headings (e.g. Pada, Varga).",
    defaults: defaultStructureLevelThreeNames,
  },
  {
    key: "structureLeafNames",
    title: "Entry types (leaf level)",
    description: "Labels for individual verses (e.g. Mantra, Shloka, Sutra).",
    defaults: defaultStructureLeafNames,
  },
];

function VocabularySection({
  section,
  values,
  customOnly,
  onAdd,
  onRemove,
  pending,
}: {
  section: (typeof SECTIONS)[number];
  values: string[];
  customOnly: string[];
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
  pending: boolean;
}) {
  const [draft, setDraft] = useState("");

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{section.title}</CardTitle>
        <CardDescription>{section.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a new name…"
            disabled={pending}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) {
                e.preventDefault();
                onAdd(draft.trim());
                setDraft("");
              }
            }}
            data-testid={`input-vocab-${section.key}`}
          />
          <Button
            type="button"
            disabled={pending || !draft.trim()}
            onClick={() => {
              onAdd(draft.trim());
              setDraft("");
            }}
            data-testid={`button-add-vocab-${section.key}`}
          >
            {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ListPlus className="w-4 h-4" />}
            <span className="ml-2 hidden sm:inline">Add</span>
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {values.map((name) => {
            const isCustom = customOnly.some((c) => c.toLowerCase() === name.toLowerCase());
            return (
              <Badge
                key={name}
                variant={isCustom ? "default" : "secondary"}
                className="text-xs font-normal gap-1 pr-1"
              >
                {name}
                {isCustom && (
                  <button
                    type="button"
                    className="ml-0.5 rounded hover:bg-black/10 p-0.5"
                    title="Remove custom entry"
                    disabled={pending}
                    onClick={() => onRemove(name)}
                    data-testid={`remove-vocab-${section.key}-${name}`}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </Badge>
            );
          })}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Built-in defaults cannot be removed. Custom names (highlighted) are shared with all editors.
        </p>
      </CardContent>
    </Card>
  );
}

export default function AdminVocabularyPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const { vocabulary } = usePortalVocabulary();
  const [activeKey, setActiveKey] = useState<PortalVocabularyKey | null>(null);

  const customByKey = (key: PortalVocabularyKey): string[] => {
    const defaults = new Set(
      (SECTIONS.find((s) => s.key === key)?.defaults ?? []).map((d) => d.toLowerCase()),
    );
    return (vocabulary[key] ?? []).filter((v) => !defaults.has(v.toLowerCase()));
  };

  const mutation = useMutation({
    mutationFn: async (params: { action: "add" | "remove"; key: PortalVocabularyKey; value: string }) => {
      setActiveKey(params.key);
      const method = params.action === "add" ? "POST" : "DELETE";
      const res = await apiRequest(method, "/api/admin/cms/vocabulary", {
        key: params.key,
        value: params.value,
      });
      return res.json();
    },
    onSuccess: (_data, params) => {
      queryClient.invalidateQueries({ queryKey: [...PORTAL_VOCABULARY_QUERY_KEY] });
      toast({
        title: params.action === "add" ? "Name added" : "Name removed",
        description: `"${params.value}" is now updated for everyone.`,
      });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Could not save", description: err.message });
    },
    onSettled: () => setActiveKey(null),
  });

  if (user?.role !== "admin") {
    return (
      <div className="max-w-2xl mx-auto p-6 text-sm text-muted-foreground">
        Admin access required to manage shared vocabulary.
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <BookMarked className="w-5 h-5 text-primary" />
          <h1 className="text-xl font-semibold" data-testid="page-title-vocabulary">
            Shared lists
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Add teeka author names and structure heading labels once — they appear in dropdowns for every
          editor and publish directly. This list is the guardrail; no Strapi change is needed to add a name.
        </p>
      </div>

      {SECTIONS.map((section) => (
        <VocabularySection
          key={section.key}
          section={section}
          values={vocabulary[section.key] ?? []}
          customOnly={customByKey(section.key)}
          pending={mutation.isPending && activeKey === section.key}
          onAdd={(value) => mutation.mutate({ action: "add", key: section.key, value })}
          onRemove={(value) => mutation.mutate({ action: "remove", key: section.key, value })}
        />
      ))}
    </div>
  );
}
