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
import { Loader2, AlertTriangle } from "lucide-react";
import StrapiSyncBar from "@/components/strapi-sync-bar";
import { STRAPI_POLL_INTERVAL } from "@/hooks/use-strapi-sync";

const EMPTY_TT: TextAndTranslation = {
  SanskritTextEntry: "",
  EnglishTranslationText: "",
  OtherLanguagesTranslation: "",
  LanguageOfTranslation: "",
};

export default function PrasthanaThraya() {
  const { toast } = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [editingDraftId, setEditingDraftId] = useState<number | null>(null);

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
    refetchInterval: STRAPI_POLL_INTERVAL,
    refetchOnWindowFocus: true,
  });

  const { unpublishedDrafts, isLoadingDrafts, saveDraft, publishDraft, deleteDraft } = useDrafts("prasthana-thraya-screens");

  const deleteStrapiMutation = useMutation({
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
        GranthaName: d.GranthaName || "",
        GranthaType: d.GranthaType || "",
        BhashyamName: d.BhashyamName || "",
        BhashyamAuthor: d.BhashyamAuthor || "",
        EnglishIntroductionToText: d.EnglishIntroductionToText || "",
        BhashyakaraIntroduction: d.BhashyakaraIntroduction || { ...EMPTY_TT },
        BhashyaEntryCollection: d.BhashyaEntryCollection || [],
      });
    } else {
      setEditingDraftId(null);
      setFormData({
        GranthaName: item.GranthaName || "",
        GranthaType: item.GranthaType || "",
        BhashyamName: item.BhashyamName || "",
        BhashyamAuthor: item.BhashyamAuthor || "",
        EnglishIntroductionToText: item.EnglishIntroductionToText || "",
        BhashyakaraIntroduction: item.BhashyakaraIntroduction || { ...EMPTY_TT },
        BhashyaEntryCollection: item.BhashyaEntryCollection || [],
      });
    }
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

    const strapiDocId = editingItem && !editingItem._isDraft ? editingItem.documentId : (editingItem?._strapiDocId || undefined);

    saveDraft.mutate(
      {
        title: formData.GranthaName || "Prasthana Thraya Entry",
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
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-4">
      <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <div>
          <span className="font-semibold">Note:</span> Prasthana Thraya entries are stored locally as drafts only. This content type does not have a REST API route enabled on the Strapi server. To publish or edit records, use the{" "}
          <a
            href="http://13.53.121.15:1337/admin"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 font-medium"
          >
            Strapi Content Manager
          </a>
          {" "}directly.
        </div>
      </div>
      <DataTable
        title="Prasthana Thraya"
        description="Manage Prasthana Thraya screen entries"
        headerContent={<StrapiSyncBar />}
        columns={columns}
        data={mergedData}
        isLoading={isLoading || isLoadingDrafts}
        error={error}
        onAdd={openAdd}
        onEdit={openEdit}
        onDelete={(item) => setDeleteTarget(item)}
        onPublish={handlePublish}
        publishingId={publishDraft.isPending ? (publishDraft.variables as number) : null}
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
              {editingItem ? "Update the entry. Changes saved as draft." : "Create a new entry. It will be saved as a draft."}
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
                Save as Draft
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?._isDraft ? "Draft" : "Entry"}</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{deleteTarget?.GranthaName}&quot;?
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
