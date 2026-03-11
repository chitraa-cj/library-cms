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
import TextTranslationFields from "@/components/text-translation-fields";
import BhashyaEntryFields from "@/components/bhashya-entry-fields";
import {
  prasthanaGranthaTypes,
  prasthanaBhashyamAuthors,
  type StrapiPrasthanaScreen,
  type StrapiResponse,
  type TextAndTranslation,
  type BhashyaEntry,
} from "@shared/schema";
import { Loader2 } from "lucide-react";

const EMPTY_TT: TextAndTranslation = {
  SanskritTextEntry: "",
  EnglishTranslationText: "",
  OtherLanguagesTranslation: "",
  LanguageOfTranslation: "",
};

export default function PrasthanaThraya() {
  const { toast } = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StrapiPrasthanaScreen | null>(null);
  const [editingItem, setEditingItem] = useState<StrapiPrasthanaScreen | null>(null);

  const [formData, setFormData] = useState({
    GranthaName: "",
    GranthaType: "" as string,
    BhashyamName: "",
    BhashyamAuthor: "" as string,
    EnglishIntroductionToText: "",
    BhashyakaraIntroduction: { ...EMPTY_TT } as TextAndTranslation,
    BhashyaEntryCollection: [] as BhashyaEntry[],
  });

  const { data, isLoading, error } = useQuery<StrapiResponse<StrapiPrasthanaScreen>>({
    queryKey: ["/api/strapi", "prasthana-thraya-screens"],
  });

  const createMutation = useMutation({
    mutationFn: async (payload: any) => {
      const res = await apiRequest("POST", "/api/strapi/prasthana-thraya-screens", payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "prasthana-thraya-screens"] });
      setFormOpen(false);
      resetForm();
      toast({ title: "Entry created" });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, payload }: { id: string; payload: any }) => {
      const res = await apiRequest("PUT", `/api/strapi/prasthana-thraya-screens/${id}`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "prasthana-thraya-screens"] });
      setFormOpen(false);
      setEditingItem(null);
      resetForm();
      toast({ title: "Entry updated" });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (documentId: string) => {
      const res = await apiRequest("DELETE", `/api/strapi/prasthana-thraya-screens/${documentId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "prasthana-thraya-screens"] });
      setDeleteTarget(null);
      toast({ title: "Entry deleted" });
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
      EnglishIntroductionToText: "",
      BhashyakaraIntroduction: { ...EMPTY_TT },
      BhashyaEntryCollection: [],
    });
  }

  function openAdd() {
    setEditingItem(null);
    resetForm();
    setFormOpen(true);
  }

  function openEdit(item: StrapiPrasthanaScreen) {
    setEditingItem(item);
    setFormData({
      GranthaName: item.GranthaName || "",
      GranthaType: item.GranthaType || "",
      BhashyamName: item.BhashyamName || "",
      BhashyamAuthor: item.BhashyamAuthor || "",
      EnglishIntroductionToText: item.EnglishIntroductionToText || "",
      BhashyakaraIntroduction: item.BhashyakaraIntroduction || { ...EMPTY_TT },
      BhashyaEntryCollection: item.BhashyaEntryCollection || [],
    });
    setFormOpen(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload: any = {
      GranthaName: formData.GranthaName || undefined,
      GranthaType: formData.GranthaType || undefined,
      BhashyamName: formData.BhashyamName || undefined,
      BhashyamAuthor: formData.BhashyamAuthor || undefined,
      EnglishIntroductionToText: formData.EnglishIntroductionToText || undefined,
      BhashyakaraIntroduction: formData.BhashyakaraIntroduction,
      BhashyaEntryCollection: formData.BhashyaEntryCollection,
    };
    if (editingItem) {
      updateMutation.mutate({ id: editingItem.documentId, payload });
    } else {
      createMutation.mutate(payload);
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  const columns = [
    { key: "GranthaName", label: "Grantha Name" },
    {
      key: "GranthaType",
      label: "Type",
      render: (val: string) => val ? <Badge variant="secondary">{val}</Badge> : null,
    },
    { key: "BhashyamName", label: "Bhashyam" },
    {
      key: "BhashyamAuthor",
      label: "Author",
      render: (val: string) => val ? <span className="text-sm">{val}</span> : null,
    },
  ];

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      <DataTable
        title="Prasthana Thraya"
        description="Manage Prasthana Thraya screen entries"
        columns={columns}
        data={data?.data || []}
        isLoading={isLoading}
        error={error}
        onAdd={openAdd}
        onEdit={openEdit}
        onDelete={(item) => setDeleteTarget(item)}
        addLabel="Add Entry"
        testIdPrefix="prasthana"
        searchKey="GranthaName"
        emptyMessage="No Prasthana Thraya entries found."
      />

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingItem ? "Edit Entry" : "Add Prasthana Thraya Entry"}
            </DialogTitle>
            <DialogDescription>
              {editingItem ? "Update the entry details." : "Create a new Prasthana Thraya screen entry."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>Grantha Name</Label>
                <Input
                  value={formData.GranthaName}
                  onChange={(e) => setFormData({ ...formData, GranthaName: e.target.value })}
                  placeholder="Name of the grantha"
                  className="mt-1.5"
                  data-testid="input-prasthana-name"
                />
              </div>
              <div>
                <Label>Grantha Type</Label>
                <Select
                  value={formData.GranthaType}
                  onValueChange={(val) => setFormData({ ...formData, GranthaType: val })}
                >
                  <SelectTrigger className="mt-1.5" data-testid="select-prasthana-type">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {prasthanaGranthaTypes.map((type) => (
                      <SelectItem key={type} value={type}>{type}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>Bhashyam Name</Label>
                <Input
                  value={formData.BhashyamName}
                  onChange={(e) => setFormData({ ...formData, BhashyamName: e.target.value })}
                  placeholder="Name of the bhashyam"
                  className="mt-1.5"
                  data-testid="input-prasthana-bhashyam"
                />
              </div>
              <div>
                <Label>Bhashyam Author</Label>
                <Select
                  value={formData.BhashyamAuthor}
                  onValueChange={(val) => setFormData({ ...formData, BhashyamAuthor: val })}
                >
                  <SelectTrigger className="mt-1.5" data-testid="select-prasthana-author">
                    <SelectValue placeholder="Select author" />
                  </SelectTrigger>
                  <SelectContent>
                    {prasthanaBhashyamAuthors.map((author) => (
                      <SelectItem key={author} value={author}>{author}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>English Introduction to Text</Label>
              <Textarea
                value={formData.EnglishIntroductionToText}
                onChange={(e) => setFormData({ ...formData, EnglishIntroductionToText: e.target.value })}
                placeholder="English introduction to the text..."
                rows={4}
                className="mt-1.5"
                data-testid="input-prasthana-intro"
              />
            </div>

            <TextTranslationFields
              title="Bhashyakara Introduction"
              value={formData.BhashyakaraIntroduction}
              onChange={(val) => setFormData({ ...formData, BhashyakaraIntroduction: val })}
              testIdPrefix="prasthana-bhashyakara"
            />

            <BhashyaEntryFields
              title="Bhashya Entry Collection"
              entries={formData.BhashyaEntryCollection}
              onChange={(entries) => setFormData({ ...formData, BhashyaEntryCollection: entries })}
              testIdPrefix="prasthana-bhashya"
            />

            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving} data-testid="button-prasthana-save">
                {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {editingItem ? "Save Changes" : "Create Entry"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Entry</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{deleteTarget?.GranthaName}&quot;?
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
