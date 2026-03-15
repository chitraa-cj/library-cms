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
  SelectItem,
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
import TextTranslationFields from "@/components/text-translation-fields";
import BhashyaEntryFields from "@/components/bhashya-entry-fields";
import {
  type StrapiManthra,
  type StrapiSection,
  type StrapiResponse,
  type TextAndTranslation,
  type BhashyaEntry,
} from "@shared/schema";
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  Send,
  Eye,
  Hash,
  FileText,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";
import { blocksToText } from "@/lib/strapi-blocks";
import { STRAPI_POLL_INTERVAL } from "@/hooks/use-strapi-sync";

const EMPTY_TT: TextAndTranslation = {
  SanskritTextEntry: "",
  EnglishTranslationText: "",
  OtherLanguagesTranslation: "",
  LanguageOfTranslation: "",
};

export default function ManthrasPage() {
  const { toast } = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [editingDraftId, setEditingDraftId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const [formData, setFormData] = useState({
    title: "",
    order: "",
    section: "",
    ShlokaManthraEntry: { ...EMPTY_TT } as TextAndTranslation,
    BhashyamForShlokaManthra: { ...EMPTY_TT } as TextAndTranslation,
    Teekas: [] as BhashyaEntry[],
  });

  const { data, isLoading } = useQuery<StrapiResponse<StrapiManthra>>({
    queryKey: ["/api/strapi", "manthras"],
    refetchInterval: STRAPI_POLL_INTERVAL,
    refetchOnWindowFocus: true,
  });

  const { data: sectionsData } = useQuery<StrapiResponse<StrapiSection>>({
    queryKey: ["/api/strapi", "sections"],
    refetchOnWindowFocus: true,
  });

  const { unpublishedDrafts, isLoadingDrafts, saveDraft, publishDraft, deleteDraft } =
    useDrafts("manthras");

  const deleteMutation = useMutation({
    mutationFn: async (documentId: string) => {
      const res = await apiRequest("DELETE", `/api/strapi/manthras/${documentId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "manthras"] });
      setDeleteTarget(null);
      toast({ title: "Manthra deleted" });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  const allSections = sectionsData?.data || [];
  const strapiManthras = useMemo(
    () => [...(data?.data || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [data]
  );

  function resetForm() {
    setFormData({
      title: "",
      order: "",
      section: "",
      ShlokaManthraEntry: { ...EMPTY_TT },
      BhashyamForShlokaManthra: { ...EMPTY_TT },
      Teekas: [],
    });
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
        order: d.order != null ? String(d.order) : "",
        section: d._section || "",
        ShlokaManthraEntry: d.ShlokaManthraEntry || { ...EMPTY_TT },
        BhashyamForShlokaManthra: d.BhashyamForShlokaManthra || { ...EMPTY_TT },
        Teekas: d.Teekas || [],
      });
    } else {
      setEditingDraftId(null);
      setFormData({
        title: item.title || "",
        order: item.order != null ? String(item.order) : "",
        section: item.section?.documentId || "",
        ShlokaManthraEntry: item.ShlokaManthraEntry || { ...EMPTY_TT },
        BhashyamForShlokaManthra: item.BhashyamForShlokaManthra || { ...EMPTY_TT },
        Teekas: item.Teekas || [],
      });
    }
    setFormOpen(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const payload: any = {
      _section: formData.section,
      ShlokaManthraEntry: formData.ShlokaManthraEntry,
      BhashyamForShlokaManthra: formData.BhashyamForShlokaManthra,
      Teekas: formData.Teekas,
    };
    if (formData.title.trim()) payload.title = formData.title.trim();
    if (formData.order) payload.order = parseInt(formData.order) || 0;
    if (formData.section) payload.section = formData.section;

    const displayTitle =
      formData.title.trim() ||
      blocksToText(formData.ShlokaManthraEntry.SanskritTextEntry)?.slice(0, 40) ||
      `Manthra ${formData.order || ""}`;

    const strapiDocId =
      editingItem && !editingItem._isDraft
        ? editingItem.documentId
        : editingItem?._strapiDocId || undefined;

    saveDraft.mutate(
      {
        title: displayTitle,
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
    (d.title || "").toLowerCase().includes(searchLower) ||
    blocksToText(d.ShlokaManthraEntry?.SanskritTextEntry)?.toLowerCase().includes(searchLower)
  );
  const displayedPublished = strapiManthras.filter((m) => {
    const text = (m.title || blocksToText(m.ShlokaManthraEntry?.SanskritTextEntry) || "").toLowerCase();
    return text.includes(searchLower);
  });

  const isSaving = saveDraft.isPending;
  const selectedSection = formData.section
    ? allSections.find((s) => s.documentId === formData.section)
    : null;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Manthras</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Individual verse / mantra entries within a Section</p>
        </div>
        <Button onClick={openAdd} data-testid="manthra-add">
          <Plus className="w-4 h-4 mr-2" />
          Add Manthra
        </Button>
      </div>

      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 px-4 py-3 flex items-start gap-3 text-sm">
        <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
        <div className="text-amber-800 dark:text-amber-300">
          <span className="font-medium">Read from Strapi via Granthas → Sections — </span>
          the Manthras API route is not yet enabled on the Strapi server. Manthras shown here are live data aggregated through Granthas.
          To create or edit manthras, use the{" "}
          <a href="http://13.53.121.15:1337/admin" target="_blank" rel="noopener noreferrer"
            className="underline font-medium inline-flex items-center gap-1">
            Strapi Content Manager <ExternalLink className="w-3 h-3" />
          </a>.
        </div>
      </div>

      <div className="mb-4">
        <Input
          placeholder="Search manthras..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="max-w-sm"
          data-testid="input-search-manthras"
        />
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {isLoading || isLoadingDrafts ? (
          <div className="flex justify-center items-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : displayedDrafts.length === 0 && displayedPublished.length === 0 ? (
          <div className="py-20 text-center text-muted-foreground">
            <Hash className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>No manthras found. Add the first manthra above.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Title / Sanskrit</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Section</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Order</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayedDrafts.map((draft) => {
                const isPub = publishDraft.isPending && publishDraft.variables === draft._draftId;
                const section = allSections.find((s) => s.documentId === draft._section);
                const sanskrit = blocksToText(draft.ShlokaManthraEntry?.SanskritTextEntry);
                return (
                  <tr key={`draft-${draft._draftId}`} className="border-b border-border hover:bg-muted/30 transition-colors" data-testid={`row-draft-${draft._draftId}`}>
                    <td className="px-4 py-3"><Badge className="bg-amber-100 text-amber-800 border-amber-200 text-xs">Draft</Badge></td>
                    <td className="px-4 py-3">
                      <p className="font-medium">{draft.title || <span className="text-muted-foreground italic">Untitled</span>}</p>
                      {sanskrit && <p className="text-xs text-muted-foreground font-serif line-clamp-1 mt-0.5">{sanskrit}</p>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{section?.title || "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{draft.order ?? "—"}</td>
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

              {displayedPublished.map((m) => {
                const sanskrit = blocksToText(m.ShlokaManthraEntry?.SanskritTextEntry);
                return (
                  <tr key={m.documentId} className="border-b border-border hover:bg-muted/30 transition-colors" data-testid={`row-manthra-${m.documentId}`}>
                    <td className="px-4 py-3"><Badge className="bg-green-100 text-green-800 border-green-200 text-xs">Published</Badge></td>
                    <td className="px-4 py-3">
                      <p className="font-medium">{m.title || <span className="text-muted-foreground italic">Untitled</span>}</p>
                      {sanskrit && <p className="text-xs text-muted-foreground font-serif line-clamp-1 mt-0.5">{sanskrit}</p>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{m.section?.title || "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{m.order ?? "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => openEdit(m)} data-testid={`button-edit-${m.documentId}`}><Pencil className="w-3.5 h-3.5" /></Button>
                        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleteTarget(m)} data-testid={`button-delete-${m.documentId}`}><Trash2 className="w-3.5 h-3.5" /></Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Form dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingItem ? "Edit Manthra" : "Add Manthra"}</DialogTitle>
            <DialogDescription>
              A Manthra is an individual verse or mantra within a Section.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Title <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <Input
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  placeholder="e.g., Manthra 1, Shloka 2.3"
                  className="mt-1.5"
                  data-testid="input-manthra-title"
                />
              </div>
              <div>
                <Label>Order</Label>
                <Input
                  type="number"
                  value={formData.order}
                  onChange={(e) => setFormData({ ...formData, order: e.target.value })}
                  className="mt-1.5"
                  data-testid="input-manthra-order"
                />
              </div>
            </div>

            <div>
              <Label>Section <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Select
                value={formData.section || "__none__"}
                onValueChange={(v) => setFormData({ ...formData, section: v === "__none__" ? "" : v })}
              >
                <SelectTrigger className="mt-1.5" data-testid="select-manthra-section">
                  <SelectValue placeholder="Select Section" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__"><span className="text-muted-foreground italic">No Section</span></SelectItem>
                  {allSections.map((s) => (
                    <SelectItem key={s.documentId} value={s.documentId}>
                      {s.title}{s.type ? ` (${s.type})` : ""}{s.grantha ? ` — ${s.grantha.GranthaName}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedSection && (
                <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm">
                  <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-1">Selected Section</p>
                  <p className="font-medium">{selectedSection.title}</p>
                  {selectedSection.type && <p className="text-xs text-muted-foreground">Type: {selectedSection.type}</p>}
                  {selectedSection.grantha && <p className="text-xs text-muted-foreground">Grantha: {selectedSection.grantha.GranthaName}</p>}
                </div>
              )}
            </div>

            <TextTranslationFields
              label="Shloka / Manthra Entry"
              value={formData.ShlokaManthraEntry}
              onChange={(val) => setFormData({ ...formData, ShlokaManthraEntry: val })}
            />
            <TextTranslationFields
              label="Bhashyam for Shloka / Manthra"
              value={formData.BhashyamForShlokaManthra}
              onChange={(val) => setFormData({ ...formData, BhashyamForShlokaManthra: val })}
            />
            <BhashyaEntryFields
              label="Teekas (Commentaries)"
              value={formData.Teekas}
              onChange={(val) => setFormData({ ...formData, Teekas: val })}
            />

            <div className="flex justify-between pt-2">
              <Button type="button" variant="outline" onClick={() => { setFormOpen(false); resetForm(); setEditingItem(null); }}>Cancel</Button>
              <Button type="submit" disabled={isSaving} data-testid="button-save-manthra">
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
            <AlertDialogTitle>Delete manthra?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &quot;{deleteTarget?.title || deleteTarget?._draftData?.title || "this manthra"}&quot;.
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
