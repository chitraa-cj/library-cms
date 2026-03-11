import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useDrafts } from "@/hooks/use-drafts";
import DataTable from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  type StrapiArticle,
  type StrapiAuthor,
  type StrapiCategory,
  type StrapiResponse,
} from "@shared/schema";
import { Loader2 } from "lucide-react";

export default function ArticlesPage() {
  const { toast } = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [editingDraftId, setEditingDraftId] = useState<number | null>(null);

  const [formData, setFormData] = useState({
    title: "",
    description: "",
    slug: "",
    author: "",
    category: "",
  });

  const { data, isLoading, error } = useQuery<StrapiResponse<StrapiArticle>>({
    queryKey: ["/api/strapi", "articles"],
  });

  const { data: authorsData } = useQuery<StrapiResponse<StrapiAuthor>>({
    queryKey: ["/api/strapi", "authors"],
  });

  const { data: categoriesData } = useQuery<StrapiResponse<StrapiCategory>>({
    queryKey: ["/api/strapi", "categories"],
  });

  const { unpublishedDrafts, isLoadingDrafts, saveDraft, publishDraft, deleteDraft } = useDrafts("articles");

  const deleteStrapiMutation = useMutation({
    mutationFn: async (documentId: string) => {
      const res = await apiRequest("DELETE", `/api/strapi/articles/${documentId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "articles"] });
      setDeleteTarget(null);
      toast({ title: "Article deleted" });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  function resetForm() {
    setFormData({ title: "", description: "", slug: "", author: "", category: "" });
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
        description: d.description || "",
        slug: d.slug || "",
        author: d.author || "",
        category: d.category || "",
      });
    } else {
      setEditingDraftId(null);
      setFormData({
        title: item.title || "",
        description: item.description || "",
        slug: item.slug || "",
        author: item.author?.documentId || "",
        category: item.category?.documentId || "",
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
      title: formData.title,
      description: formData.description || undefined,
      slug: formData.slug || formData.title.toLowerCase().replace(/\s+/g, "-"),
    };
    if (formData.author) payload.author = formData.author;
    if (formData.category) payload.category = formData.category;

    const strapiDocId = editingItem && !editingItem._isDraft ? editingItem.documentId : (editingItem?._strapiDocId || undefined);

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
    { key: "title", label: "Title" },
    {
      key: "description",
      label: "Description",
      render: (val: string) =>
        val ? (
          <span className="text-sm text-muted-foreground line-clamp-1 max-w-[200px]">
            {val}
          </span>
        ) : null,
    },
    {
      key: "author",
      label: "Author",
      render: (_: any, row: any) =>
        row.author?.name ? (
          <Badge variant="secondary">{row.author.name}</Badge>
        ) : null,
    },
    {
      key: "category",
      label: "Category",
      render: (_: any, row: any) =>
        row.category?.name ? (
          <Badge variant="outline">{row.category.name}</Badge>
        ) : null,
    },
  ];

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      <DataTable
        title="Articles"
        description="Manage blog articles and content"
        columns={columns}
        data={mergedData}
        isLoading={isLoading || isLoadingDrafts}
        error={error}
        onAdd={openAdd}
        onEdit={openEdit}
        onDelete={(item) => setDeleteTarget(item)}
        onPublish={handlePublish}
        publishingId={publishDraft.isPending ? (publishDraft.variables as number) : null}
        addLabel="Add Article"
        testIdPrefix="article"
        searchKey="title"
        emptyMessage="No articles found."
      />

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingItem ? "Edit Article" : "Add New Article"}
            </DialogTitle>
            <DialogDescription>
              {editingItem ? "Update article details. Changes saved as draft." : "Create a new article. It will be saved as a draft."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label>Title *</Label>
              <Input
                value={formData.title}
                onChange={(e) =>
                  setFormData({ ...formData, title: e.target.value })
                }
                placeholder="Article title"
                className="mt-1.5"
                data-testid="input-article-title"
              />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea
                value={formData.description}
                onChange={(e) =>
                  setFormData({ ...formData, description: e.target.value })
                }
                placeholder="Brief description (max 80 chars)"
                maxLength={80}
                rows={2}
                className="mt-1.5"
                data-testid="input-article-description"
              />
            </div>
            <div>
              <Label>Slug</Label>
              <Input
                value={formData.slug}
                onChange={(e) =>
                  setFormData({ ...formData, slug: e.target.value })
                }
                placeholder="auto-generated-from-title"
                className="mt-1.5"
                data-testid="input-article-slug"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Author</Label>
                <Select
                  value={formData.author}
                  onValueChange={(val) =>
                    setFormData({ ...formData, author: val })
                  }
                >
                  <SelectTrigger className="mt-1.5" data-testid="select-article-author">
                    <SelectValue placeholder="Select author" />
                  </SelectTrigger>
                  <SelectContent>
                    {(authorsData?.data || []).map((a) => (
                      <SelectItem key={a.documentId} value={a.documentId}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Category</Label>
                <Select
                  value={formData.category}
                  onValueChange={(val) =>
                    setFormData({ ...formData, category: val })
                  }
                >
                  <SelectTrigger className="mt-1.5" data-testid="select-article-category">
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent>
                    {(categoriesData?.data || []).map((c) => (
                      <SelectItem key={c.documentId} value={c.documentId}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving} data-testid="button-article-save">
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
            <AlertDialogTitle>Delete {deleteTarget?._isDraft ? "Draft" : "Article"}</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{deleteTarget?.title}&quot;?
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
