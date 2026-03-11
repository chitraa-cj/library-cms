import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
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
  const [deleteTarget, setDeleteTarget] = useState<StrapiAuthor | null>(null);
  const [editingItem, setEditingItem] = useState<StrapiAuthor | null>(null);

  const [formData, setFormData] = useState({ name: "", email: "" });

  const { data, isLoading, error } = useQuery<StrapiResponse<StrapiAuthor>>({
    queryKey: ["/api/strapi", "authors"],
  });

  const createMutation = useMutation({
    mutationFn: async (payload: any) => {
      const res = await apiRequest("POST", "/api/strapi/authors", payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "authors"] });
      setFormOpen(false);
      resetForm();
      toast({ title: "Author created" });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, payload }: { id: string; payload: any }) => {
      const res = await apiRequest("PUT", `/api/strapi/authors/${id}`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "authors"] });
      setFormOpen(false);
      setEditingItem(null);
      resetForm();
      toast({ title: "Author updated" });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  const deleteMutation = useMutation({
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
  }

  function openAdd() {
    setEditingItem(null);
    resetForm();
    setFormOpen(true);
  }

  function openEdit(item: StrapiAuthor) {
    setEditingItem(item);
    setFormData({ name: item.name || "", email: item.email || "" });
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
    if (editingItem) {
      updateMutation.mutate({ id: editingItem.documentId, payload });
    } else {
      createMutation.mutate(payload);
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

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
        data={data?.data || []}
        isLoading={isLoading}
        error={error}
        onAdd={openAdd}
        onEdit={openEdit}
        onDelete={(item) => setDeleteTarget(item)}
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
              {editingItem ? "Update author details." : "Add a new author profile."}
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
                {editingItem ? "Save Changes" : "Create Author"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Author</AlertDialogTitle>
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
