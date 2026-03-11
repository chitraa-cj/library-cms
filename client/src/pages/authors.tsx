import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useDrafts } from "@/hooks/use-drafts";
import DataTable from "@/components/data-table";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { type StrapiAuthor, type StrapiResponse } from "@shared/schema";
import { Loader2 } from "lucide-react";

export default function AuthorsPage() {
  const { toast } = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [editingDraftId, setEditingDraftId] = useState<number | null>(null);

  const [formData, setFormData] = useState({ name: "", email: "" });

  const { data, isLoading, error } = useQuery<StrapiResponse<StrapiAuthor>>({
    queryKey: ["/api/strapi", "authors"],
  });

  const { unpublishedDrafts, isLoadingDrafts, saveDraft, publishDraft, deleteDraft } = useDrafts("authors");

  const deleteStrapiMutation = useMutation({
    mutationFn: async (documentId: string) => {
      const res = await apiRequest("DELETE", `/api/strapi/authors/${documentId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "authors"] });
      setDeleteTarget(null);
      toast({ title: "Author deleted" });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  function resetForm() {
    setFormData({ name: "", email: "" });
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
      setFormData({ name: d.name || "", email: d.email || "" });
    } else {
      setEditingDraftId(null);
      setFormData({ name: item.name || "", email: item.email || "" });
    }
    setFormOpen(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formData.name.trim()) {
      toast({ variant: "destructive", title: "Name is required" });
      return;
    }
    const payload = {
      name: formData.name,
      email: formData.email || undefined,
    };

    const strapiDocId = editingItem && !editingItem._isDraft ? editingItem.documentId : (editingItem?._strapiDocId || undefined);

    saveDraft.mutate(
      {
        title: formData.name,
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
      deleteStrapiMutation.mutate(deleteTarget.documentId);
    }
  }

  function handlePublish(item: any) {
    if (item._draftId) publishDraft.mutate(item._draftId);
  }

  const mergedData = [
    ...unpublishedDrafts.map((d) => ({
      ...(d.data as any),
      _isDraft: true,
      _draftId: d.id,
      _draftStatus: d.status,
      _strapiDocId: d.strapiDocumentId,
      _draftData: d.data,
    })),
    ...(data?.data || []).map((item) => ({
      ...item,
      _isDraft: false,
      _draftStatus: "published",
    })),
  ];

  const isSaving = saveDraft.isPending;

  const columns = [
    { key: "name", label: "Name" },
    { key: "email", label: "Email" },
    {
      key: "articles",
      label: "Articles",
      render: (val: any[]) => (val ? `${val.length} articles` : "0 articles"),
    },
  ];

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      <DataTable
        title="Authors"
        description="Manage author profiles"
        columns={columns}
        data={mergedData}
        isLoading={isLoading || isLoadingDrafts}
        error={error}
        onAdd={openAdd}
        onEdit={openEdit}
        onDelete={(item) => setDeleteTarget(item)}
        onPublish={handlePublish}
        publishingId={publishDraft.isPending ? (publishDraft.variables as number) : null}
        addLabel="Add Author"
        testIdPrefix="author"
        searchKey="name"
        emptyMessage="No authors found."
      />

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingItem ? "Edit Author" : "Add New Author"}</DialogTitle>
            <DialogDescription>
              {editingItem ? "Update author details. Changes saved as draft." : "Add a new author. It will be saved as a draft."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label>Name *</Label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Author name"
                className="mt-1.5"
                data-testid="input-author-name"
              />
            </div>
            <div>
              <Label>Email</Label>
              <Input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                placeholder="author@example.com"
                className="mt-1.5"
                data-testid="input-author-email"
              />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving} data-testid="button-author-save">
                {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Save as Draft
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?._isDraft ? "Draft" : "Author"}</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{deleteTarget?.name}&quot;?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
