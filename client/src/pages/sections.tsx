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
  sectionTypes,
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
} from "lucide-react";
import { STRAPI_POLL_INTERVAL } from "@/hooks/use-strapi-sync";

export default function SectionsPage() {
  const { toast } = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [editingDraftId, setEditingDraftId] = useState<number | null>(null);
  const [viewingItem, setViewingItem] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState("");

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

  function resetForm() {
    setFormData({ title: "", type: "", order: "", grantha: "" });
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
    } else {
      setEditingDraftId(null);
      setFormData({
        title: item.title || "",
        type: item.type || "",
        order: item.order != null ? String(item.order) : "",
        grantha: item.grantha?.documentId || "",
      });
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
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Order</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayedDrafts.map((draft) => {
                const isPub = publishDraft.isPending && publishDraft.variables === draft._draftId;
                const grantha = allGranthas.find((g) => g.documentId === draft._grantha);
                return (
                  <tr key={`draft-${draft._draftId}`} className="border-b border-border hover:bg-muted/30 transition-colors" data-testid={`row-draft-${draft._draftId}`}>
                    <td className="px-4 py-3"><Badge className="bg-amber-100 text-amber-800 border-amber-200 text-xs">Draft</Badge></td>
                    <td className="px-4 py-3 font-medium">{draft.title}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{draft.type || "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{grantha?.GranthaName || "—"}</td>
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

              {displayedPublished.map((section) => {
                return (
                  <tr key={section.documentId} className="border-b border-border hover:bg-muted/30 transition-colors" data-testid={`row-section-${section.documentId}`}>
                    <td className="px-4 py-3"><Badge className="bg-green-100 text-green-800 border-green-200 text-xs">Published</Badge></td>
                    <td className="px-4 py-3 font-medium">{section.title}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{section.type || "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{section.grantha?.GranthaName || "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{section.order ?? "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => openEdit(section)} data-testid={`button-edit-${section.documentId}`}><Pencil className="w-3.5 h-3.5" /></Button>
                        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleteTarget(section)} data-testid={`button-delete-${section.documentId}`}><Trash2 className="w-3.5 h-3.5" /></Button>
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
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingItem ? "Edit Section" : "Add Section"}</DialogTitle>
            <DialogDescription>A Section is a top-level division of a Grantha (e.g., Adhyaya, Valli, Brahmana). It groups Manthras under it.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
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
                    {sectionTypes.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
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
