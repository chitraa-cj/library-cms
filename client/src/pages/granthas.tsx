import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
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
import TextTranslationFields, {
  blocksToText,
  textToBlocks,
} from "@/components/text-translation-fields";
import {
  granthaTypes,
  bhashyamAuthors,
  type StrapiGrantha,
  type StrapiResponse,
  type TextAndTranslation,
} from "@shared/schema";
import { Loader2 } from "lucide-react";

const EMPTY_TEXT_TRANSLATION: TextAndTranslation = {
  SanskritTextEntry: "",
  EnglishTranslationText: "",
  OtherLanguagesTranslation: "",
  LanguageOfTranslation: "",
};

export default function GranthasPage() {
  const { toast } = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StrapiGrantha | null>(null);
  const [editingItem, setEditingItem] = useState<StrapiGrantha | null>(null);

  const [formData, setFormData] = useState({
    GranthaName: "",
    GranthaType: "" as string,
    BhashyamName: "",
    BhashyamAuthor: "" as string,
    IntroductionToTextEnglish: "",
    BhashyakaraIntroduction: { ...EMPTY_TEXT_TRANSLATION } as TextAndTranslation,
  });

  const { data, isLoading, error } = useQuery<StrapiResponse<StrapiGrantha>>({
    queryKey: ["/api/strapi", "granthas"],
  });

  const createMutation = useMutation({
    mutationFn: async (payload: any) => {
      const res = await apiRequest("POST", "/api/strapi/granthas", payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "granthas"] });
      setFormOpen(false);
      resetForm();
      toast({ title: "Grantha created", description: "Entry saved to Strapi CMS." });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, payload }: { id: string; payload: any }) => {
      const res = await apiRequest("PUT", `/api/strapi/granthas/${id}`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "granthas"] });
      setFormOpen(false);
      setEditingItem(null);
      resetForm();
      toast({ title: "Grantha updated", description: "Changes saved." });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (documentId: string) => {
      const res = await apiRequest("DELETE", `/api/strapi/granthas/${documentId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "granthas"] });
      setDeleteTarget(null);
      toast({ title: "Grantha deleted" });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  function resetForm() {
    setFormData({
      GranthaName: "",
      GranthaType: "",
      BhashyamName: "",
      BhashyamAuthor: "",
      IntroductionToTextEnglish: "",
      BhashyakaraIntroduction: { ...EMPTY_TEXT_TRANSLATION },
    });
  }

  function openAdd() {
    setEditingItem(null);
    resetForm();
    setFormOpen(true);
  }

  function openEdit(item: StrapiGrantha) {
    setEditingItem(item);
    setFormData({
      GranthaName: item.GranthaName || "",
      GranthaType: item.GranthaType || "",
      BhashyamName: item.BhashyamName || "",
      BhashyamAuthor: item.BhashyamAuthor || "",
      IntroductionToTextEnglish: blocksToText(item.IntroductionToTextEnglish),
      BhashyakaraIntroduction: item.BhashyakaraIntroduction || { ...EMPTY_TEXT_TRANSLATION },
    });
    setFormOpen(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formData.GranthaName.trim()) {
      toast({ variant: "destructive", title: "Grantha Name is required" });
      return;
    }
    const payload: any = {
      GranthaName: formData.GranthaName,
      GranthaType: formData.GranthaType || undefined,
      BhashyamName: formData.BhashyamName || undefined,
      BhashyamAuthor: formData.BhashyamAuthor || undefined,
      IntroductionToTextEnglish: formData.IntroductionToTextEnglish
        ? textToBlocks(formData.IntroductionToTextEnglish)
        : undefined,
      BhashyakaraIntroduction: formData.BhashyakaraIntroduction,
    };
    if (editingItem) {
      updateMutation.mutate({ id: editingItem.documentId, payload });
    } else {
      createMutation.mutate(payload);
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  const columns = [
    { key: "GranthaName", label: "Name" },
    {
      key: "GranthaType",
      label: "Type",
      render: (val: string) =>
        val ? <Badge variant="secondary">{val}</Badge> : null,
    },
    { key: "BhashyamName", label: "Bhashyam" },
    {
      key: "BhashyamAuthor",
      label: "Bhashyam Author",
      render: (val: string) =>
        val ? <span className="text-sm">{val}</span> : null,
    },
  ];

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      <DataTable
        title="Granthas"
        description="Manage sacred texts and scriptures"
        columns={columns}
        data={data?.data || []}
        isLoading={isLoading}
        error={error}
        onAdd={openAdd}
        onEdit={openEdit}
        onDelete={(item) => setDeleteTarget(item)}
        addLabel="Add Grantha"
        testIdPrefix="grantha"
        searchKey="GranthaName"
        emptyMessage="No granthas found. Start by adding a sacred text."
      />

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingItem ? "Edit Grantha" : "Add New Grantha"}
            </DialogTitle>
            <DialogDescription>
              {editingItem
                ? "Update the grantha details below."
                : "Fill in the details to create a new grantha entry."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <Label>Grantha Name *</Label>
              <Input
                value={formData.GranthaName}
                onChange={(e) =>
                  setFormData({ ...formData, GranthaName: e.target.value })
                }
                placeholder="e.g., Isha Upanishad"
                className="mt-1.5"
                data-testid="input-grantha-name"
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>Grantha Type</Label>
                <Select
                  value={formData.GranthaType}
                  onValueChange={(val) =>
                    setFormData({ ...formData, GranthaType: val })
                  }
                >
                  <SelectTrigger className="mt-1.5" data-testid="select-grantha-type">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {granthaTypes.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Bhashyam Author</Label>
                <Select
                  value={formData.BhashyamAuthor}
                  onValueChange={(val) =>
                    setFormData({ ...formData, BhashyamAuthor: val })
                  }
                >
                  <SelectTrigger className="mt-1.5" data-testid="select-bhashyam-author">
                    <SelectValue placeholder="Select author" />
                  </SelectTrigger>
                  <SelectContent>
                    {bhashyamAuthors.map((author) => (
                      <SelectItem key={author} value={author}>
                        {author}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Bhashyam Name</Label>
              <Input
                value={formData.BhashyamName}
                onChange={(e) =>
                  setFormData({ ...formData, BhashyamName: e.target.value })
                }
                placeholder="Name of the bhashyam"
                className="mt-1.5"
                data-testid="input-bhashyam-name"
              />
            </div>
            <div>
              <Label>Introduction to Text (English)</Label>
              <Textarea
                value={formData.IntroductionToTextEnglish}
                onChange={(e) =>
                  setFormData({ ...formData, IntroductionToTextEnglish: e.target.value })
                }
                placeholder="English introduction to this text..."
                rows={4}
                className="mt-1.5"
                data-testid="input-grantha-intro"
              />
            </div>
            <TextTranslationFields
              title="Bhashyakara Introduction"
              value={formData.BhashyakaraIntroduction}
              onChange={(val) =>
                setFormData({ ...formData, BhashyakaraIntroduction: val })
              }
              testIdPrefix="grantha-bhashyakara"
            />
            <div className="flex justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setFormOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving} data-testid="button-grantha-save">
                {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {editingItem ? "Save Changes" : "Create Grantha"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={() => setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Grantha</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{deleteTarget?.GranthaName}&quot;?
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                deleteTarget && deleteMutation.mutate(deleteTarget.documentId)
              }
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
