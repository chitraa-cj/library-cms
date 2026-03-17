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
import {
  type StrapiTeeka,
  type StrapiGrantha,
  type StrapiResponse,
  teekaAuthors,
} from "@shared/schema";
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  Send,
  BookOpen,
} from "lucide-react";
import { STRAPI_POLL_INTERVAL } from "@/hooks/use-strapi-sync";

export default function TeekasPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [editingDraftId, setEditingDraftId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const [formData, setFormData] = useState({
    TeekaName: "",
    TeekaAuthor: "",
    grantha: "",
  });

  const { data, isLoading } = useQuery<StrapiResponse<StrapiTeeka>>({
    queryKey: ["/api/strapi", "teekas"],
    refetchInterval: STRAPI_POLL_INTERVAL,
    refetchOnWindowFocus: true,
  });

  const { data: granthasData } = useQuery<StrapiResponse<StrapiGrantha>>({
    queryKey: ["/api/strapi", "granthas"],
    refetchOnWindowFocus: true,
  });

  const { unpublishedDrafts, isLoadingDrafts, saveDraft, publishDraft, deleteDraft } =
    useDrafts("teekas");

  const deleteMutation = useMutation({
    mutationFn: async (documentId: string) => {
      const res = await apiRequest("DELETE", `/api/strapi/teekas/${documentId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "teekas"] });
      setDeleteTarget(null);
      toast({ title: "Teeka deleted" });
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

  const strapiTeekas = data?.data || [];

  function resetForm() {
    setFormData({ TeekaName: "", TeekaAuthor: "", grantha: "" });
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
        TeekaName: d.TeekaName || "",
        TeekaAuthor: d.TeekaAuthor || "",
        grantha: d._grantha || "",
      });
    } else {
      setEditingDraftId(null);
      setFormData({
        TeekaName: item.TeekaName || "",
        TeekaAuthor: item.TeekaAuthor || "",
        grantha: item.grantha?.documentId || "",
      });
    }
    setFormOpen(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formData.TeekaName.trim()) {
      toast({ variant: "destructive", title: "Teeka Name is required" });
      return;
    }

    const payload: any = {
      _grantha: formData.grantha,
      TeekaName: formData.TeekaName,
    };
    if (formData.TeekaAuthor) payload.TeekaAuthor = formData.TeekaAuthor;
    if (formData.grantha) payload.grantha = formData.grantha;

    const strapiDocId =
      editingItem && !editingItem._isDraft
        ? editingItem.documentId
        : editingItem?._strapiDocId || undefined;

    saveDraft.mutate(
      {
        title: formData.TeekaName,
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
    (d.TeekaName || "").toLowerCase().includes(searchLower)
  );
  const displayedPublished = strapiTeekas.filter((t) =>
    t.TeekaName.toLowerCase().includes(searchLower)
  );

  const isSaving = saveDraft.isPending;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Teekas</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Commentary works linked to a Grantha</p>
        </div>
        <Button onClick={openAdd} data-testid="teeka-add">
          <Plus className="w-4 h-4 mr-2" />
          Add Teeka
        </Button>
      </div>

      <div className="mb-4">
        <Input
          placeholder="Search teekas..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="max-w-sm"
          data-testid="input-search-teekas"
        />
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {isLoading || isLoadingDrafts ? (
          <div className="flex justify-center items-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : displayedDrafts.length === 0 && displayedPublished.length === 0 ? (
          <div className="py-20 text-center text-muted-foreground">
            <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>No teekas found. Add the first teeka above.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Teeka Name</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Author</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Grantha</th>
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
                    <td className="px-4 py-3 font-medium">{draft.TeekaName}</td>
                    <td className="px-4 py-3 text-muted-foreground">{draft.TeekaAuthor || "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{grantha?.GranthaName || "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => openEdit(draft)} data-testid={`button-edit-draft-${draft._draftId}`}><Pencil className="w-3.5 h-3.5" /></Button>
                        <Button size="sm" variant="ghost" className="text-primary hover:text-primary" onClick={() => publishDraft.mutate(draft._draftId)} disabled={isPub} data-testid={`button-publish-draft-${draft._draftId}`}>
                          {isPub ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                        </Button>
                        {(!user?.id || draft._createdBy === user.id) && (
                          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleteTarget(draft)} data-testid={`button-delete-draft-${draft._draftId}`}><Trash2 className="w-3.5 h-3.5" /></Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}

              {displayedPublished.map((teeka) => (
                <tr key={teeka.documentId} className="border-b border-border hover:bg-muted/30 transition-colors" data-testid={`row-teeka-${teeka.documentId}`}>
                  <td className="px-4 py-3"><Badge className="bg-green-100 text-green-800 border-green-200 text-xs">Published</Badge></td>
                  <td className="px-4 py-3 font-medium">{teeka.TeekaName}</td>
                  <td className="px-4 py-3 text-muted-foreground">{teeka.TeekaAuthor || "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">{teeka.grantha?.GranthaName || "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(teeka)} data-testid={`button-edit-${teeka.documentId}`}><Pencil className="w-3.5 h-3.5" /></Button>
                      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleteTarget(teeka)} data-testid={`button-delete-${teeka.documentId}`}><Trash2 className="w-3.5 h-3.5" /></Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Form dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingItem ? "Edit Teeka" : "Add Teeka"}</DialogTitle>
            <DialogDescription>A Teeka is a commentary work on a Grantha.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label>Teeka Name *</Label>
              <Input
                value={formData.TeekaName}
                onChange={(e) => setFormData({ ...formData, TeekaName: e.target.value })}
                placeholder="e.g., Shankarabhashya"
                className="mt-1.5"
                data-testid="input-teeka-name"
              />
            </div>

            <div>
              <Label>Author <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Select value={formData.TeekaAuthor || "__none__"} onValueChange={(v) => setFormData({ ...formData, TeekaAuthor: v === "__none__" ? "" : v })}>
                <SelectTrigger className="mt-1.5" data-testid="select-teeka-author">
                  <SelectValue placeholder="Select author" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__"><span className="text-muted-foreground italic">Not specified</span></SelectItem>
                  {teekaAuthors.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                  <SelectItem value="__custom__">Other</SelectItem>
                </SelectContent>
              </Select>
              {formData.TeekaAuthor && !teekaAuthors.includes(formData.TeekaAuthor as any) && formData.TeekaAuthor !== "__custom__" && (
                <Input
                  value={formData.TeekaAuthor}
                  onChange={(e) => setFormData({ ...formData, TeekaAuthor: e.target.value })}
                  placeholder="Enter author name"
                  className="mt-2"
                  data-testid="input-teeka-author-custom"
                />
              )}
            </div>

            <div>
              <Label>Grantha <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Select value={formData.grantha || "__none__"} onValueChange={(v) => setFormData({ ...formData, grantha: v === "__none__" ? "" : v })}>
                <SelectTrigger className="mt-1.5" data-testid="select-teeka-grantha">
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
              <Button type="submit" disabled={isSaving} data-testid="button-save-teeka">
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
            <AlertDialogTitle>Delete teeka?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &quot;{deleteTarget?.TeekaName || deleteTarget?._draftData?.TeekaName}&quot;.
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
