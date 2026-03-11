import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import DataTable from "@/components/data-table";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { type StrapiCategory, type StrapiResponse } from "@shared/schema";
import { Loader2 } from "lucide-react";

export default function CategoriesPage() {
  const { toast } = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StrapiCategory | null>(null);
  const [editingItem, setEditingItem] = useState<StrapiCategory | null>(null);

  const [formData, setFormData] = useState({ name: "", slug: "", description: "" });

  const { data, isLoading, error } = useQuery<StrapiResponse<StrapiCategory>>({
    queryKey: ["/api/strapi", "categories"],
  });

  const createMutation = useMutation({
    mutationFn: async (payload: any) => {
      const res = await apiRequest("POST", "/api/strapi/categories", payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "categories"] });
      setFormOpen(false);
      resetForm();
      toast({ title: "Category created" });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, payload }: { id: string; payload: any }) => {
      const res = await apiRequest("PUT", `/api/strapi/categories/${id}`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "categories"] });
      setFormOpen(false);
      setEditingItem(null);
      resetForm();
      toast({ title: "Category updated" });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (documentId: string) => {
      const res = await apiRequest("DELETE", `/api/strapi/categories/${documentId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "categories"] });
      setDeleteTarget(null);
      toast({ title: "Category deleted" });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  function resetForm() {
    setFormData({ name: "", slug: "", description: "" });
  }

  function openAdd() {
    setEditingItem(null);
    resetForm();
    setFormOpen(true);
  }

  function openEdit(item: StrapiCategory) {
    setEditingItem(item);
    setFormData({
      name: item.name || "",
      slug: item.slug || "",
      description: item.description || "",
    });
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
      slug: formData.slug || formData.name.toLowerCase().replace(/\s+/g, "-"),
      description: formData.description || undefined,
    };
    if (editingItem) {
      updateMutation.mutate({ id: editingItem.documentId, payload });
    } else {
      createMutation.mutate(payload);
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  const columns = [
    { key: "name", label: "Name" },
    { key: "slug", label: "Slug", render: (val: string) => val ? <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{val}</code> : null },
    {
      key: "description",
      label: "Description",
      render: (val: string) =>
        val ? <span className="text-sm text-muted-foreground line-clamp-1 max-w-[200px]">{val}</span> : null,
    },
  ];

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      <DataTable
        title="Categories"
        description="Manage content categories"
        columns={columns}
        data={data?.data || []}
        isLoading={isLoading}
        error={error}
        onAdd={openAdd}
        onEdit={openEdit}
        onDelete={(item) => setDeleteTarget(item)}
        addLabel="Add Category"
        testIdPrefix="category"
        searchKey="name"
        emptyMessage="No categories found."
      />

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingItem ? "Edit Category" : "Add New Category"}</DialogTitle>
            <DialogDescription>
              {editingItem ? "Update category details." : "Create a new category."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label>Name *</Label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Category name"
                className="mt-1.5"
                data-testid="input-category-name"
              />
            </div>
            <div>
              <Label>Slug</Label>
              <Input
                value={formData.slug}
                onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
                placeholder="auto-generated-from-name"
                className="mt-1.5"
                data-testid="input-category-slug"
              />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Brief description of this category"
                rows={3}
                className="mt-1.5"
                data-testid="input-category-description"
              />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving} data-testid="button-category-save">
                {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {editingItem ? "Save Changes" : "Create Category"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Category</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{deleteTarget?.name}&quot;?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.documentId)}
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
