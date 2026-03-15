import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useDrafts } from "@/hooks/use-drafts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  type StrapiSection,
  type StrapiGrantha,
  type StrapiResponse,
  type SectionTitleTranslation,
  sectionTypes,
  sectionTypeLabels,
  translationLanguages,
} from "@shared/schema";
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  Send,
  Eye,
  FileText,
  Hash,
  ExternalLink,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
  Layers,
} from "lucide-react";
import { STRAPI_POLL_INTERVAL } from "@/hooks/use-strapi-sync";

let _uid = 0;
function uid() { return `tt-${++_uid}`; }

interface TitleTranslationRow {
  id: string;
  text: string;
  language: string;
  isAiTranslated: boolean;
}

export default function SectionsPage() {
  const { toast } = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [editingDraftId, setEditingDraftId] = useState<number | null>(null);
  const [viewingItem, setViewingItem] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [titleTranslations, setTitleTranslations] = useState<TitleTranslationRow[]>([]);

  function toggleSection(documentId: string) {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(documentId)) next.delete(documentId);
      else next.add(documentId);
      return next;
    });
  }

  const [formData, setFormData] = useState({
    title: "",
    type: "",
    order: "",
    grantha: "",
  });

  const { data, isLoading } = useQuery<StrapiResponse<StrapiSection>>({
    queryKey: ["/api/strapi", "sections"],
    refetchInterval: STRAPI_POLL_INTERVAL,
    refetchOnWindowFocus: true,
  });

  const { data: granthasData } = useQuery<StrapiResponse<StrapiGrantha>>({
    queryKey: ["/api/strapi", "granthas"],
    refetchOnWindowFocus: true,
  });

  const { unpublishedDrafts, isLoadingDrafts, saveDraft, publishDraft, deleteDraft } =
    useDrafts("sections");

  const deleteMutation = useMutation({
    mutationFn: async (documentId: string) => {
      const res = await apiRequest("DELETE", `/api/strapi/sections/${documentId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "sections"] });
      setDeleteTarget(null);
      toast({ title: "Section deleted" });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  const allGranthas = useMemo(() => {
    const seen = new Set<string>();
    return (granthasData?.data || []).filter((g) => {
      const key = g.GranthaName.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [granthasData]);

  const strapiSections = data?.data || [];

  function addTitleTranslation() {
    setTitleTranslations((prev) => [...prev, { id: uid(), text: "", language: "", isAiTranslated: false }]);
  }
  function updateTitleTranslation(id: string, field: keyof Omit<TitleTranslationRow, "id">, value: any) {
    setTitleTranslations((prev) => prev.map((t) => t.id === id ? { ...t, [field]: value } : t));
  }
  function removeTitleTranslation(id: string) {
    setTitleTranslations((prev) => prev.filter((t) => t.id !== id));
  }

  function resetForm() {
    setFormData({ title: "", type: "", order: "", grantha: "" });
    setTitleTranslations([]);
    setEditingDraftId(null);
  }

  function openAdd() {
    setEditingItem(null);
    resetForm();
    setFormOpen(true);
  }

  function openEdit(item: any) {
    setEditingItem(item);
    if (item._isDraft) {
      setEditingDraftId(item._draftId);
      const d = item._draftData;
      setFormData({
        title: d.title || "",
        type: d.type || "",
        order: d.order != null ? String(d.order) : "",
        grantha: d._grantha || "",
      });
      setTitleTranslations(
        (d.titleTranslations || []).map((t: any) => ({
          id: uid(),
          text: t.TranslationText || "",
          language: t.LanguageOfTranslation || "",
          isAiTranslated: t.isAiTranslated ?? false,
        }))
      );
    } else {
      setEditingDraftId(null);
      setFormData({
        title: item.title || "",
        type: item.type || "",
        order: item.order != null ? String(item.order) : "",
        grantha: item.grantha?.documentId || "",
      });
      setTitleTranslations(
        (item.titleTranslations || []).map((t: any) => ({
          id: uid(),
          text: t.TranslationText || "",
          language: t.LanguageOfTranslation || "",
          isAiTranslated: t.isAiTranslated ?? false,
        }))
      );
    }
    setFormOpen(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formData.title.trim()) {
      toast({ variant: "destructive", title: "Title is required" });
      return;
    }

    const payload: any = {
      _grantha: formData.grantha,
      title: formData.title,
    };
    if (formData.type) payload.type = formData.type;
    if (formData.order) payload.order = parseInt(formData.order) || 0;
    if (formData.grantha) payload.grantha = formData.grantha;
    if (titleTranslations.length > 0) {
      payload.titleTranslations = titleTranslations
        .filter((t) => t.text.trim() || t.language.trim())
        .map((t) => ({
          TranslationText: t.text,
          LanguageOfTranslation: t.language,
          isAiTranslated: t.isAiTranslated,
        }));
    }

    const strapiDocId =
      editingItem && !editingItem._isDraft
        ? editingItem.documentId
        : editingItem?._strapiDocId || undefined;

    saveDraft.mutate(
      {
        title: formData.title,
        data: payload,
        strapiDocumentId: strapiDocId,
        draftId: editingDraftId || undefined,
      },
      {
        onSuccess: () => {
          setFormOpen(false);
          resetForm();
          setEditingItem(null);
        },
      }
    );
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    if (deleteTarget._isDraft) {
      deleteDraft.mutate(deleteTarget._draftId, { onSuccess: () => setDeleteTarget(null) });
    } else {
      deleteMutation.mutate(deleteTarget.documentId);
    }
  }

  const draftRows = unpublishedDrafts.map((d) => ({
    ...(d.data as any),
    _isDraft: true,
    _draftId: d.id,
    _draftStatus: d.status,
    _strapiDocId: d.strapiDocumentId,
    _draftData: d.data,
  }));

  const searchLower = searchQuery.toLowerCase();
  const displayedDrafts = draftRows.filter((d) =>
    (d.title || "").toLowerCase().includes(searchLower)
  );
  const displayedPublished = strapiSections
    .filter((s) => s.title.toLowerCase().includes(searchLower))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const isSaving = saveDraft.isPending;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Sections</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Top-level divisions of a Grantha (Adhyaya, Valli, Brahmana, etc.)</p>
        </div>
        <Button onClick={openAdd} data-testid="section-add">
          <Plus className="w-4 h-4 mr-2" />
          Add Section
        </Button>
      </div>

      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 px-4 py-3 flex items-start gap-3 text-sm">
        <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
        <div className="text-amber-800 dark:text-amber-300">
          <span className="font-medium">Read from Strapi via Granthas — </span>
          the Sections API route is not yet enabled on the Strapi server. Sections shown here are live data aggregated from Granthas.
          To create or edit sections, use the{" "}
          <a href="http://13.53.121.15:1337/admin" target="_blank" rel="noopener noreferrer"
            className="underline font-medium inline-flex items-center gap-1">
            Strapi Content Manager <ExternalLink className="w-3 h-3" />
          </a>.
        </div>
      </div>

      <div className="mb-4">
        <Input
          placeholder="Search sections..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="max-w-sm"
          data-testid="input-search-sections"
        />
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {isLoading || isLoadingDrafts ? (
          <div className="flex justify-center items-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : displayedDrafts.length === 0 && displayedPublished.length === 0 ? (
          <div className="py-20 text-center text-muted-foreground">
            <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>No sections found. Add the first section above.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground w-8">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Title</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Type</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Grantha</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Parent</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Entries</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {/* Draft rows (flat) */}
              {displayedDrafts.map((draft) => {
                const isPub = publishDraft.isPending && publishDraft.variables === draft._draftId;
                const grantha = allGranthas.find((g) => g.documentId === draft._grantha);
                return (
                  <tr key={`draft-${draft._draftId}`} className="border-b border-border hover:bg-muted/30 transition-colors" data-testid={`row-draft-${draft._draftId}`}>
                    <td className="px-4 py-3"><Badge className="bg-amber-100 text-amber-800 border-amber-200 text-xs">Draft</Badge></td>
                    <td className="px-4 py-3 font-medium">{draft.title}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{draft.type || "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{grantha?.GranthaName || "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">—</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">—</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => openEdit(draft)} data-testid={`button-edit-draft-${draft._draftId}`}><Pencil className="w-3.5 h-3.5" /></Button>
                        <Button size="sm" variant="ghost" className="text-primary hover:text-primary" onClick={() => publishDraft.mutate(draft._draftId)} disabled={isPub} data-testid={`button-publish-draft-${draft._draftId}`}>
                          {isPub ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                        </Button>
                        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleteTarget(draft)} data-testid={`button-delete-draft-${draft._draftId}`}><Trash2 className="w-3.5 h-3.5" /></Button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {/* Published sections — hierarchical grouped by grantha */}
              {(() => {
                // Group sections by grantha documentId
                const byGrantha = new Map<string, { granthaName: string; sections: any[] }>();
                for (const s of displayedPublished) {
                  const gId = s.grantha?.documentId || "__none__";
                  const gName = s.grantha?.GranthaName || "No Grantha";
                  if (!byGrantha.has(gId)) byGrantha.set(gId, { granthaName: gName, sections: [] });
                  byGrantha.get(gId)!.sections.push(s);
                }

                const rows: JSX.Element[] = [];

                for (const [gId, { granthaName, sections: gSections }] of byGrantha) {
                  // Build a lookup map for this grantha's sections
                  const sectionById = new Map(gSections.map((s) => [s.documentId, s]));

                  // Root sections = those whose parent is null OR whose parent is not in this grantha
                  const roots = gSections.filter((s) => !s.parent || !sectionById.has(s.parent?.documentId));
                  // Child map: parentDocId → children[]
                  const childrenOf = new Map<string, any[]>();
                  for (const s of gSections) {
                    if (s.parent?.documentId && sectionById.has(s.parent.documentId)) {
                      if (!childrenOf.has(s.parent.documentId)) childrenOf.set(s.parent.documentId, []);
                      childrenOf.get(s.parent.documentId)!.push(s);
                    }
                  }

                  // Grantha group header
                  rows.push(
                    <tr key={`grantha-${gId}`} className="bg-muted/60 border-b border-border">
                      <td colSpan={7} className="px-4 py-2">
                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{granthaName}</span>
                        <span className="ml-2 text-xs text-muted-foreground">({gSections.length} section{gSections.length !== 1 ? "s" : ""})</span>
                      </td>
                    </tr>
                  );

                  // Sort roots by order
                  roots.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

                  for (const root of roots) {
                    const children = (childrenOf.get(root.documentId) || []).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
                    const isExpanded = expandedSections.has(root.documentId);
                    const hasChildren = children.length > 0;
                    const manthraCount = Array.isArray(root.manthras) ? root.manthras.length : 0;

                    // Root section row
                    rows.push(
                      <tr
                        key={root.documentId}
                        className="border-b border-border hover:bg-muted/20 transition-colors"
                        data-testid={`row-section-${root.documentId}`}
                      >
                        <td className="px-4 py-3">
                          <Badge className="bg-green-100 text-green-800 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-800 text-xs">Live</Badge>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            {hasChildren ? (
                              <button
                                type="button"
                                onClick={() => toggleSection(root.documentId)}
                                className="text-muted-foreground hover:text-foreground transition-colors"
                                data-testid={`button-expand-${root.documentId}`}
                              >
                                {isExpanded
                                  ? <ChevronDown className="w-4 h-4" />
                                  : <ChevronRight className="w-4 h-4" />}
                              </button>
                            ) : (
                              <span className="w-4" />
                            )}
                            <span className="font-medium">{root.title}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          {root.type ? <Badge variant="outline" className="text-xs">{sectionTypeLabels[root.type as keyof typeof sectionTypeLabels] ?? root.type}</Badge> : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">{granthaName}</td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">—</td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">
                          {hasChildren
                            ? <span className="text-xs">{children.length} sub-section{children.length !== 1 ? "s" : ""}{manthraCount > 0 ? `, ${manthraCount} entr${manthraCount !== 1 ? "ies" : "y"}` : ""}</span>
                            : manthraCount > 0 ? <span>{manthraCount} entr{manthraCount !== 1 ? "ies" : "y"}</span> : "—"
                          }
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="ghost" onClick={() => openEdit(root)} data-testid={`button-edit-${root.documentId}`}><Pencil className="w-3.5 h-3.5" /></Button>
                            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleteTarget(root)} data-testid={`button-delete-${root.documentId}`}><Trash2 className="w-3.5 h-3.5" /></Button>
                          </div>
                        </td>
                      </tr>
                    );

                    // Child section rows (only shown when expanded)
                    if (isExpanded) {
                      for (const child of children) {
                        const childManthraCount = Array.isArray(child.manthras) ? child.manthras.length : 0;
                        rows.push(
                          <tr
                            key={child.documentId}
                            className="border-b border-border bg-muted/10 hover:bg-muted/30 transition-colors"
                            data-testid={`row-section-${child.documentId}`}
                          >
                            <td className="px-4 py-2.5">
                              <Badge className="bg-green-100 text-green-800 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-800 text-xs">Live</Badge>
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-1.5 pl-6">
                                <Layers className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                <span className="text-sm">{child.title}</span>
                              </div>
                            </td>
                            <td className="px-4 py-2.5">
                              {child.type ? <Badge variant="outline" className="text-xs">{sectionTypeLabels[child.type as keyof typeof sectionTypeLabels] ?? child.type}</Badge> : <span className="text-muted-foreground">—</span>}
                            </td>
                            <td className="px-4 py-2.5 text-muted-foreground text-xs">{granthaName}</td>
                            <td className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-foreground/70">{root.title}</td>
                            <td className="px-4 py-2.5 text-muted-foreground text-xs">
                              {childManthraCount > 0 ? `${childManthraCount} entr${childManthraCount !== 1 ? "ies" : "y"}` : "—"}
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="flex justify-end gap-1">
                                <Button size="sm" variant="ghost" onClick={() => openEdit(child)} data-testid={`button-edit-${child.documentId}`}><Pencil className="w-3.5 h-3.5" /></Button>
                                <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleteTarget(child)} data-testid={`button-delete-${child.documentId}`}><Trash2 className="w-3.5 h-3.5" /></Button>
                              </div>
                            </td>
                          </tr>
                        );
                      }
                    }
                  }
                }

                return rows;
              })()}
            </tbody>
          </table>
        )}
      </div>

      {/* Form dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingItem ? "Edit Section" : "Add Section"}</DialogTitle>
            <DialogDescription>A Section is a top-level division of a Grantha (e.g., Adhyaya, Valli, Brahmana). It groups Manthras under it.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <Label>Title *</Label>
              <Input
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="e.g., Adhyaya 1, Valli 3"
                className="mt-1.5"
                data-testid="input-section-title"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Section Type</Label>
                <Select value={formData.type || "__none__"} onValueChange={(v) => setFormData({ ...formData, type: v === "__none__" ? "" : v })}>
                  <SelectTrigger className="mt-1.5" data-testid="select-section-type">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__"><span className="text-muted-foreground italic">No type</span></SelectItem>
                    {sectionTypes.map((t) => <SelectItem key={t} value={t}>{sectionTypeLabels[t]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Order</Label>
                <Input type="number" value={formData.order} onChange={(e) => setFormData({ ...formData, order: e.target.value })} className="mt-1.5" data-testid="input-section-order" />
              </div>
            </div>

            <div>
              <Label>Grantha <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Select value={formData.grantha || "__none__"} onValueChange={(v) => setFormData({ ...formData, grantha: v === "__none__" ? "" : v })}>
                <SelectTrigger className="mt-1.5" data-testid="select-section-grantha">
                  <SelectValue placeholder="Select Grantha" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__"><span className="text-muted-foreground italic">No Grantha</span></SelectItem>
                  {allGranthas.map((g) => <SelectItem key={g.documentId} value={g.documentId}>{g.GranthaName}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {/* Title Translations */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>Title Translations</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={addTitleTranslation}
                  data-testid="button-add-title-translation"
                >
                  <Plus className="w-3.5 h-3.5 mr-1" /> Add Translation
                </Button>
              </div>

              {titleTranslations.length === 0 ? (
                <p className="text-xs text-muted-foreground italic py-2">No title translations added.</p>
              ) : (
                <div className="space-y-3">
                  {titleTranslations.map((tt, idx) => (
                    <div key={tt.id} className="border border-border rounded-lg p-3 bg-muted/20 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">Translation {idx + 1}</span>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive h-6 w-6 p-0"
                          onClick={() => removeTitleTranslation(tt.id)}
                          data-testid={`button-remove-tt-${idx}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>

                      <div>
                        <Label className="text-xs">Translation Text</Label>
                        <Input
                          value={tt.text}
                          onChange={(e) => updateTitleTranslation(tt.id, "text", e.target.value)}
                          placeholder="Translated title text"
                          className="mt-1 text-sm"
                          data-testid={`input-tt-text-${idx}`}
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <Label className="text-xs">Language</Label>
                          <Select
                            value={tt.language || "__none__"}
                            onValueChange={(v) => updateTitleTranslation(tt.id, "language", v === "__none__" ? "" : v)}
                          >
                            <SelectTrigger className="mt-1 text-sm h-9" data-testid={`select-tt-lang-${idx}`}>
                              <SelectValue placeholder="Select language" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__"><span className="text-muted-foreground italic">Select language</span></SelectItem>
                              {translationLanguages.map((lang) => (
                                <SelectItem key={lang} value={lang}>{lang}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <Label className="text-xs">AI Translated?</Label>
                          <Select
                            value={tt.isAiTranslated ? "true" : "false"}
                            onValueChange={(v) => updateTitleTranslation(tt.id, "isAiTranslated", v === "true")}
                          >
                            <SelectTrigger className="mt-1 text-sm h-9" data-testid={`select-tt-ai-${idx}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="false">No</SelectItem>
                              <SelectItem value="true">Yes (AI)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-between pt-2">
              <Button type="button" variant="outline" onClick={() => { setFormOpen(false); resetForm(); setEditingItem(null); }}>Cancel</Button>
              <Button type="submit" disabled={isSaving} data-testid="button-save-section">
                {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Save as Draft
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete section?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &quot;{deleteTarget?.title || deleteTarget?._draftData?.title}&quot;.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="button-confirm-delete">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
