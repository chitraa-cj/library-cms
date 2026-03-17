import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useDrafts } from "@/hooks/use-drafts";
import { useAuth } from "@/hooks/use-auth";
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
  const { user } = useAuth();
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
    parent: "",
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

  const parentSectionOptions = useMemo(() => {
    const currentDocId = editingItem && !editingItem._isDraft ? editingItem.documentId : null;
    return strapiSections.filter((s) => {
      if (currentDocId && s.documentId === currentDocId) return false;
      if (formData.grantha && s.grantha?.documentId !== formData.grantha) return false;
      return true;
    });
  }, [strapiSections, editingItem, formData.grantha]);

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
    setFormData({ title: "", type: "", order: "", grantha: "", parent: "" });
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
        parent: d._parent || "",
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
        parent: item.parent?.documentId || "",
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
      _parent: formData.parent,
      title: formData.title,
    };
    if (formData.type) payload.type = formData.type;
    if (formData.order) payload.order = parseInt(formData.order) || 0;
    if (formData.grantha) payload.grantha = formData.grantha;
    if (formData.parent) payload.parent = formData.parent;
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
    _createdBy: d.createdBy,
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
                        {(!user?.id || !draft._createdBy || draft._createdBy === user.id) && (
                          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleteTarget(draft)} data-testid={`button-delete-draft-${draft._draftId}`}><Trash2 className="w-3.5 h-3.5" /></Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}

              {/* Published sections — hierarchical grouped by grantha, recursive depth */}
              {(() => {
                // Group sections by grantha documentId
                const byGrantha = new Map<string, { granthaName: string; sections: any[] }>();
                for (const s of displayedPublished) {
                  const gId = s.grantha?.documentId || "__none__";
                  const gName = s.grantha?.GranthaName || "No Grantha";
                  if (!byGrantha.has(gId)) byGrantha.set(gId, { granthaName: gName, sections: [] });
                  byGrantha.get(gId)!.sections.push(s);
                }

                // Recursive row renderer — handles any tree depth
                function renderNode(
                  node: any,
                  childrenOf: Map<string, any[]>,
                  granthaName: string,
                  depth: number,
                  parentTitle: string | null,
                ): JSX.Element[] {
                  const children = (childrenOf.get(node.documentId) || []).sort((a: any, b: any) => (a.order ?? 999) - (b.order ?? 999));
                  const hasChildren = children.length > 0;
                  const manthraCount = Array.isArray(node.manthras) ? node.manthras.length : 0;
                  const isExpanded = expandedSections.has(node.documentId);
                  const indentPx = depth * 24;
                  const py = depth === 0 ? "py-3" : "py-2.5";
                  const px = "px-4";
                  const rowBg = depth === 0
                    ? "hover:bg-muted/20"
                    : depth === 1
                      ? "bg-muted/10 hover:bg-muted/30"
                      : "bg-muted/20 hover:bg-muted/40";

                  const result: JSX.Element[] = [];

                  result.push(
                    <tr
                      key={node.documentId}
                      className={`border-b border-border transition-colors ${rowBg}`}
                      data-testid={`row-section-${node.documentId}`}
                    >
                      <td className={`${px} ${py}`}>
                        <Badge className="bg-green-100 text-green-800 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-800 text-xs">Live</Badge>
                      </td>
                      <td className={`${px} ${py}`}>
                        <div className="flex items-center gap-1.5" style={{ paddingLeft: indentPx }}>
                          {hasChildren ? (
                            <button
                              type="button"
                              onClick={() => toggleSection(node.documentId)}
                              className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                              data-testid={`button-expand-${node.documentId}`}
                            >
                              {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                            </button>
                          ) : depth > 0 ? (
                            <Layers className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                          ) : (
                            <span className="w-4 shrink-0" />
                          )}
                          <span className={depth === 0 ? "font-medium" : "text-sm"}>{node.title}</span>
                        </div>
                      </td>
                      <td className={`${px} ${py}`}>
                        {node.type
                          ? <Badge variant="outline" className="text-xs">{sectionTypeLabels[node.type as keyof typeof sectionTypeLabels] ?? node.type}</Badge>
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className={`${px} ${py} text-muted-foreground text-xs`}>{granthaName}</td>
                      <td className={`${px} ${py} text-muted-foreground text-xs`}>
                        {parentTitle ?? "—"}
                      </td>
                      <td className={`${px} ${py} text-muted-foreground text-xs`}>
                        {hasChildren
                          ? <span>{children.length} sub-section{children.length !== 1 ? "s" : ""}{manthraCount > 0 ? `, ${manthraCount} entr${manthraCount !== 1 ? "ies" : "y"}` : ""}</span>
                          : manthraCount > 0
                            ? <span>{manthraCount} entr{manthraCount !== 1 ? "ies" : "y"}</span>
                            : "—"}
                      </td>
                      <td className={`${px} ${py}`}>
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => openEdit(node)} data-testid={`button-edit-${node.documentId}`}><Pencil className="w-3.5 h-3.5" /></Button>
                          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleteTarget(node)} data-testid={`button-delete-${node.documentId}`}><Trash2 className="w-3.5 h-3.5" /></Button>
                        </div>
                      </td>
                    </tr>
                  );

                  if (isExpanded && hasChildren) {
                    for (const child of children) {
                      result.push(...renderNode(child, childrenOf, granthaName, depth + 1, node.title));
                    }
                  }

                  return result;
                }

                const rows: JSX.Element[] = [];

                for (const [gId, { granthaName, sections: gSections }] of byGrantha) {
                  const sectionById = new Map(gSections.map((s: any) => [s.documentId, s]));

                  // Roots = sections whose parent is null OR parent not in this grantha's section set
                  const roots = gSections
                    .filter((s: any) => !s.parent || !sectionById.has(s.parent?.documentId))
                    .sort((a: any, b: any) => (a.order ?? 999) - (b.order ?? 999));

                  // Build children map
                  const childrenOf = new Map<string, any[]>();
                  for (const s of gSections) {
                    const pid = s.parent?.documentId;
                    if (pid && sectionById.has(pid)) {
                      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
                      childrenOf.get(pid)!.push(s);
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

                  for (const root of roots) {
                    rows.push(...renderNode(root, childrenOf, granthaName, 0, null));
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
            <DialogDescription>
              Sections are structural divisions of a Grantha — Adhyaya, Khanda, Valli, Pada, etc. A section can optionally nest inside a parent section.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-5">

            {/* ── Basic info ── */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Basic Info</p>
              <div>
                <Label>Title *</Label>
                <Input
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  placeholder="e.g., Adhyaya 1, Shanti Patha"
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
                  <Input
                    type="number"
                    value={formData.order}
                    onChange={(e) => setFormData({ ...formData, order: e.target.value })}
                    placeholder="Display order"
                    className="mt-1.5"
                    data-testid="input-section-order"
                  />
                </div>
              </div>
            </div>

            {/* ── Relationships ── */}
            <div className="space-y-3 pt-1">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Relationships</p>
              <div>
                <Label>Grantha <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                <Select
                  value={formData.grantha || "__none__"}
                  onValueChange={(v) => setFormData({ ...formData, grantha: v === "__none__" ? "" : v, parent: "" })}
                >
                  <SelectTrigger className="mt-1.5" data-testid="select-section-grantha">
                    <SelectValue placeholder="Select Grantha" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__"><span className="text-muted-foreground italic">No Grantha</span></SelectItem>
                    {allGranthas.map((g) => <SelectItem key={g.documentId} value={g.documentId}>{g.GranthaName}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Parent Section <span className="text-muted-foreground font-normal text-xs">(optional — for nested Khandas etc.)</span></Label>
                <Select
                  value={formData.parent || "__none__"}
                  onValueChange={(v) => setFormData({ ...formData, parent: v === "__none__" ? "" : v })}
                >
                  <SelectTrigger className="mt-1.5" data-testid="select-section-parent">
                    <SelectValue placeholder="Select parent section" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__"><span className="text-muted-foreground italic">No parent (top-level)</span></SelectItem>
                    {parentSectionOptions.length === 0 && (
                      <SelectItem value="__empty__" disabled>
                        <span className="text-muted-foreground italic">
                          {formData.grantha ? "No other sections in this Grantha" : "Select a Grantha first to filter"}
                        </span>
                      </SelectItem>
                    )}
                    {parentSectionOptions.map((s) => (
                      <SelectItem key={s.documentId} value={s.documentId}>
                        <span className="font-medium">{s.title}</span>
                        {s.type && (
                          <span className="text-muted-foreground ml-1">
                            ({sectionTypeLabels[s.type as keyof typeof sectionTypeLabels] ?? s.type})
                          </span>
                        )}
                        {!formData.grantha && s.grantha && (
                          <span className="text-muted-foreground ml-1">— {s.grantha.GranthaName}</span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!formData.grantha && parentSectionOptions.length > 0 && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Showing all sections. Select a Grantha above to filter.
                  </p>
                )}
              </div>
            </div>

            {/* ── Title Translations ── */}
            <div className="pt-1">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Title Translations</p>
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
