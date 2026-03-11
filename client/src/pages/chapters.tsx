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
  type StrapiChapter,
  type StrapiGrantha,
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

export default function ChaptersPage() {
  const { toast } = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [editingDraftId, setEditingDraftId] = useState<number | null>(null);

  const [formData, setFormData] = useState({
    ChapterTitle: "",
    order: 0,
    grantha: "" as string,
    parent: "" as string,
    ShlokaManthraEntry: { ...EMPTY_TT } as TextAndTranslation,
    BhashyamForShlokaManthra: { ...EMPTY_TT } as TextAndTranslation,
    Teekas: [] as BhashyaEntry[],
  });

  const { data, isLoading, error } = useQuery<StrapiResponse<StrapiChapter>>({
    queryKey: ["/api/strapi", "chapters"],
  });

  const { data: granthasData } = useQuery<StrapiResponse<StrapiGrantha>>({
    queryKey: ["/api/strapi", "granthas"],
  });

  const { data: chaptersData } = useQuery<StrapiResponse<StrapiChapter>>({
    queryKey: ["/api/strapi", "chapters"],
  });

  const { unpublishedDrafts, isLoadingDrafts, saveDraft, publishDraft, deleteDraft } = useDrafts("chapters");

  const deleteStrapiMutation = useMutation({
    mutationFn: async (documentId: string) => {
      const res = await apiRequest("DELETE", `/api/strapi/chapters/${documentId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "chapters"] });
      setDeleteTarget(null);
      toast({ title: "Chapter deleted" });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  function resetForm() {
    setFormData({
      ChapterTitle: "",
      order: 0,
      grantha: "",
      parent: "",
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
        ChapterTitle: d.ChapterTitle || "",
        order: d.order || 0,
        grantha: d.grantha || "",
        parent: d.parent || "",
        ShlokaManthraEntry: d.ShlokaManthraEntry || { ...EMPTY_TT },
        BhashyamForShlokaManthra: d.BhashyamForShlokaManthra || { ...EMPTY_TT },
        Teekas: d.Teekas || [],
      });
    } else {
      setEditingDraftId(null);
      setFormData({
        ChapterTitle: item.ChapterTitle || "",
        order: item.order || 0,
        grantha: item.grantha?.documentId || "",
        parent: item.parent?.documentId || "",
        ShlokaManthraEntry: item.ShlokaManthraEntry || { ...EMPTY_TT },
        BhashyamForShlokaManthra: item.BhashyamForShlokaManthra || { ...EMPTY_TT },
        Teekas: item.Teekas || [],
      });
    }
    setFormOpen(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formData.ChapterTitle.trim()) {
      toast({ variant: "destructive", title: "Chapter Title is required" });
      return;
    }
    const payload: any = {
      ChapterTitle: formData.ChapterTitle,
      order: formData.order,
      ShlokaManthraEntry: formData.ShlokaManthraEntry,
      BhashyamForShlokaManthra: formData.BhashyamForShlokaManthra,
      Teekas: formData.Teekas,
    };
    if (formData.grantha) payload.grantha = formData.grantha;
    if (formData.parent) payload.parent = formData.parent;

    const strapiDocId = editingItem && !editingItem._isDraft ? editingItem.documentId : (editingItem?._strapiDocId || undefined);

    saveDraft.mutate(
      {
        title: formData.ChapterTitle,
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
    { key: "ChapterTitle", label: "Title" },
    { key: "order", label: "Order", render: (val: number) => <Badge variant="outline">{val}</Badge> },
    {
      key: "grantha",
      label: "Grantha",
      render: (_: any, row: any) =>
        row.grantha?.GranthaName ? (
          <Badge variant="secondary">{row.grantha.GranthaName}</Badge>
        ) : null,
    },
    {
      key: "parent",
      label: "Parent Chapter",
      render: (_: any, row: any) => row.parent?.ChapterTitle || null,
    },
  ];

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      <DataTable
        title="Chapters"
        description="Manage chapters within granthas"
        columns={columns}
        data={mergedData}
        isLoading={isLoading || isLoadingDrafts}
        error={error}
        onAdd={openAdd}
        onEdit={openEdit}
        onDelete={(item) => setDeleteTarget(item)}
        onPublish={handlePublish}
        publishingId={publishDraft.isPending ? (publishDraft.variables as number) : null}
        addLabel="Add Chapter"
        testIdPrefix="chapter"
        searchKey="ChapterTitle"
        emptyMessage="No chapters found. Add chapters to your granthas."
      />

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingItem ? "Edit Chapter" : "Add New Chapter"}
            </DialogTitle>
            <DialogDescription>
              {editingItem
                ? "Update the chapter details. Changes will be saved as a draft."
                : "Create a new chapter. It will be saved as a draft until you publish it."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>Chapter Title *</Label>
                <Input
                  value={formData.ChapterTitle}
                  onChange={(e) =>
                    setFormData({ ...formData, ChapterTitle: e.target.value })
                  }
                  placeholder="e.g., Chapter 1: Introduction"
                  className="mt-1.5"
                  data-testid="input-chapter-title"
                />
              </div>
              <div>
                <Label>Order</Label>
                <Input
                  type="number"
                  value={formData.order}
                  onChange={(e) =>
                    setFormData({ ...formData, order: parseInt(e.target.value) || 0 })
                  }
                  className="mt-1.5"
                  data-testid="input-chapter-order"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>Grantha</Label>
                <Select
                  value={formData.grantha}
                  onValueChange={(val) =>
                    setFormData({ ...formData, grantha: val })
                  }
                >
                  <SelectTrigger className="mt-1.5" data-testid="select-chapter-grantha">
                    <SelectValue placeholder="Select grantha" />
                  </SelectTrigger>
                  <SelectContent>
                    {(granthasData?.data || []).map((g) => (
                      <SelectItem key={g.documentId} value={g.documentId}>
                        {g.GranthaName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Parent Chapter</Label>
                <Select
                  value={formData.parent}
                  onValueChange={(val) =>
                    setFormData({ ...formData, parent: val })
                  }
                >
                  <SelectTrigger className="mt-1.5" data-testid="select-chapter-parent">
                    <SelectValue placeholder="Select parent (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    {(chaptersData?.data || [])
                      .filter((c) => c.documentId !== editingItem?.documentId)
                      .map((c) => (
                        <SelectItem key={c.documentId} value={c.documentId}>
                          {c.ChapterTitle}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <TextTranslationFields
              title="Shloka / Manthra Entry"
              value={formData.ShlokaManthraEntry}
              onChange={(val) =>
                setFormData({ ...formData, ShlokaManthraEntry: val })
              }
              testIdPrefix="chapter-shloka"
            />

            <TextTranslationFields
              title="Bhashyam for Shloka / Manthra"
              value={formData.BhashyamForShlokaManthra}
              onChange={(val) =>
                setFormData({ ...formData, BhashyamForShlokaManthra: val })
              }
              testIdPrefix="chapter-bhashyam"
            />

            <BhashyaEntryFields
              title="Teekas (Commentaries)"
              entries={formData.Teekas}
              onChange={(entries) =>
                setFormData({ ...formData, Teekas: entries })
              }
              testIdPrefix="chapter-teeka"
            />

            <div className="flex justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setFormOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving} data-testid="button-chapter-save">
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
            <AlertDialogTitle>Delete {deleteTarget?._isDraft ? "Draft" : "Chapter"}</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{deleteTarget?.ChapterTitle}&quot;?
              {!deleteTarget?._isDraft && " This will remove it from the CMS."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
