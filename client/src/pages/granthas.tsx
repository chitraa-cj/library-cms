import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useDrafts } from "@/hooks/use-drafts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  granthaTypes,
  bhashyamAuthors,
  teekaAuthors,
  type StrapiGrantha,
  type StrapiResponse,
} from "@shared/schema";
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  ChevronRight,
  ChevronDown,
  BookOpen,
  ArrowLeft,
  Check,
  X,
  Hash,
  Layers,
  Send,
} from "lucide-react";

// ---------- Local Types ----------

interface TeekaDefinition {
  id: string;
  TeekaName: string;
  TeekaAuthor: string;
}

interface ManthraNode {
  id: string;
  title: string;
  order: number;
}

interface KhandaNode {
  id: string;
  title: string;
  order: number;
  manthras: ManthraNode[];
  expanded: boolean;
}

interface AdhyayaNode {
  id: string;
  title: string;
  order: number;
  khandas: KhandaNode[];
  expanded: boolean;
}

// ---------- Helpers ----------

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

const ORDINALS = [
  "Prathama", "Dvitiya", "Tritiya", "Chaturtha", "Panchama",
  "Shashthi", "Saptama", "Ashtama", "Navama", "Dashama",
];

function ordinal(n: number) {
  return ORDINALS[n - 1] ?? `${n}`;
}

// ---------- Card sub-component ----------

function GranthaCard({
  item,
  onEdit,
  onDelete,
  onPublish,
  isPublishing,
}: {
  item: any;
  onEdit: () => void;
  onDelete: () => void;
  onPublish: () => void;
  isPublishing: boolean;
}) {
  const isDraft = item._isDraft;

  return (
    <div
      className="group relative border rounded-xl bg-card p-5 cursor-pointer hover:border-primary/50 hover:shadow-sm transition-all"
      onClick={onEdit}
      data-testid={`card-grantha-${item.documentId || item._draftId}`}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex flex-wrap gap-1.5">
          {item.GranthaType && (
            <Badge variant="secondary" className="text-xs">
              {item.GranthaType}
            </Badge>
          )}
          <Badge
            variant="outline"
            className={`text-xs ${
              isDraft
                ? "border-amber-300 text-amber-700 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-400"
                : "border-green-300 text-green-700 bg-green-50 dark:bg-green-950/30 dark:text-green-400"
            }`}
          >
            {isDraft ? "Draft" : "Published"}
          </Badge>
        </div>

        <div
          className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onEdit}
            data-testid={`button-edit-${item.documentId || item._draftId}`}
          >
            <Pencil className="w-3.5 h-3.5" />
          </Button>
          {isDraft && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-primary hover:text-primary"
              onClick={onPublish}
              disabled={isPublishing}
              data-testid={`button-publish-${item._draftId}`}
              title="Publish to Strapi"
            >
              {isPublishing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-destructive hover:text-destructive"
            onClick={onDelete}
            data-testid={`button-delete-${item.documentId || item._draftId}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      <h3
        className="font-semibold text-base leading-tight"
        data-testid={`text-grantha-name-${item.documentId || item._draftId}`}
      >
        {item.GranthaName}
      </h3>
      {item.BhashyamName && (
        <p className="text-xs text-muted-foreground mt-1">{item.BhashyamName}</p>
      )}
      <p className="text-xs text-muted-foreground mt-3 pt-3 border-t">
        Edited recently
      </p>
    </div>
  );
}

// ---------- Step indicator ----------

function StepDot({
  n,
  active,
  done,
  label,
}: {
  n: number;
  active: boolean;
  done: boolean;
  label: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        className={`flex items-center justify-center w-8 h-8 rounded-full border-2 text-sm font-semibold transition-colors ${
          done
            ? "bg-primary border-primary text-primary-foreground"
            : active
            ? "border-primary text-primary"
            : "border-muted-foreground/30 text-muted-foreground"
        }`}
      >
        {done ? <Check className="w-4 h-4" /> : n}
      </div>
      <span
        className={`text-xs whitespace-nowrap ${
          active || done ? "text-foreground font-medium" : "text-muted-foreground"
        }`}
      >
        {label}
      </span>
    </div>
  );
}

// ---------- Main Page ----------

export default function GranthasPage() {
  const { toast } = useToast();

  // View management
  const [view, setView] = useState<"list" | "form">("list");
  const [step, setStep] = useState<1 | 2>(1);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [editingDraftId, setEditingDraftId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);

  // Step 1 form fields
  const [formData, setFormData] = useState({
    GranthaName: "",
    GranthaType: "",
    BhashyamName: "",
    BhashyamAuthor: "",
  });

  // Step 1 teekas
  const [teekas, setTeekas] = useState<TeekaDefinition[]>([]);

  // Step 2 hierarchy
  const [adhyayas, setAdhyayas] = useState<AdhyayaNode[]>([]);

  // Data
  const { data, isLoading } = useQuery<StrapiResponse<StrapiGrantha>>({
    queryKey: ["/api/strapi", "granthas"],
  });

  const {
    unpublishedDrafts,
    isLoadingDrafts,
    saveDraft,
    publishDraft,
    deleteDraft,
  } = useDrafts("granthas");

  const deleteStrapiMutation = useMutation({
    mutationFn: async (documentId: string) => {
      const res = await apiRequest(
        "DELETE",
        `/api/strapi/granthas/${documentId}`
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "granthas"] });
      setDeleteTarget(null);
      toast({ title: "Grantha deleted" });
    },
    onError: (err: any) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: err.message,
      });
    },
  });

  // ---------- Helpers ----------

  function resetForm() {
    setFormData({
      GranthaName: "",
      GranthaType: "",
      BhashyamName: "",
      BhashyamAuthor: "",
    });
    setTeekas([]);
    setAdhyayas([]);
    setEditingDraftId(null);
    setEditingItem(null);
  }

  function openAdd() {
    resetForm();
    setStep(1);
    setView("form");
  }

  function openEdit(item: any) {
    setEditingItem(item);
    if (item._isDraft) {
      setEditingDraftId(item._draftId);
      const d = item._draftData as any;
      setFormData({
        GranthaName: d.GranthaName || "",
        GranthaType: d.GranthaType || "",
        BhashyamName: d.BhashyamName || "",
        BhashyamAuthor: d.BhashyamAuthor || "",
      });
      setTeekas(d.teekas || []);
      setAdhyayas(d.hierarchy || []);
    } else {
      setEditingDraftId(null);
      setFormData({
        GranthaName: item.GranthaName || "",
        GranthaType: item.GranthaType || "",
        BhashyamName: item.BhashyamName || "",
        BhashyamAuthor: item.BhashyamAuthor || "",
      });
      setTeekas([]);
      setAdhyayas([]);
    }
    setStep(1);
    setView("form");
  }

  // ---------- Teeka handlers ----------

  function addTeeka() {
    setTeekas([
      ...teekas,
      { id: uid(), TeekaName: "", TeekaAuthor: "" },
    ]);
  }

  function updateTeeka(
    id: string,
    field: keyof Omit<TeekaDefinition, "id">,
    value: string
  ) {
    setTeekas(teekas.map((t) => (t.id === id ? { ...t, [field]: value } : t)));
  }

  function removeTeeka(id: string) {
    setTeekas(teekas.filter((t) => t.id !== id));
  }

  // ---------- Hierarchy handlers ----------

  function addAdhyaya() {
    const n = adhyayas.length + 1;
    setAdhyayas([
      ...adhyayas,
      {
        id: uid(),
        title: `${ordinal(n)} Adhyaya (Chapter ${n})`,
        order: n,
        khandas: [],
        expanded: true,
      },
    ]);
  }

  function updateAdhyaya(id: string, title: string) {
    setAdhyayas(adhyayas.map((a) => (a.id === id ? { ...a, title } : a)));
  }

  function removeAdhyaya(id: string) {
    setAdhyayas(adhyayas.filter((a) => a.id !== id));
  }

  function toggleAdhyaya(id: string) {
    setAdhyayas(
      adhyayas.map((a) =>
        a.id === id ? { ...a, expanded: !a.expanded } : a
      )
    );
  }

  function addKhanda(adhyayaId: string) {
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        const n = a.khandas.length + 1;
        return {
          ...a,
          khandas: [
            ...a.khandas,
            {
              id: uid(),
              title: `${ordinal(n)} Khanda (Section ${n})`,
              order: n,
              manthras: [],
              expanded: true,
            },
          ],
        };
      })
    );
  }

  function updateKhanda(adhyayaId: string, khandaId: string, title: string) {
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        return {
          ...a,
          khandas: a.khandas.map((k) =>
            k.id === khandaId ? { ...k, title } : k
          ),
        };
      })
    );
  }

  function removeKhanda(adhyayaId: string, khandaId: string) {
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        return { ...a, khandas: a.khandas.filter((k) => k.id !== khandaId) };
      })
    );
  }

  function toggleKhanda(adhyayaId: string, khandaId: string) {
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        return {
          ...a,
          khandas: a.khandas.map((k) =>
            k.id === khandaId ? { ...k, expanded: !k.expanded } : k
          ),
        };
      })
    );
  }

  function addManthra(adhyayaId: string, khandaId: string) {
    const aIdx = adhyayas.findIndex((x) => x.id === adhyayaId) + 1;
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        const kIdx = a.khandas.findIndex((x) => x.id === khandaId) + 1;
        return {
          ...a,
          khandas: a.khandas.map((k) => {
            if (k.id !== khandaId) return k;
            const mIdx = k.manthras.length + 1;
            return {
              ...k,
              manthras: [
                ...k.manthras,
                {
                  id: uid(),
                  title: `Manthra ${aIdx}.${kIdx}.${mIdx}`,
                  order: mIdx,
                },
              ],
            };
          }),
        };
      })
    );
  }

  function removeManthra(
    adhyayaId: string,
    khandaId: string,
    manthraId: string
  ) {
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        return {
          ...a,
          khandas: a.khandas.map((k) => {
            if (k.id !== khandaId) return k;
            return {
              ...k,
              manthras: k.manthras.filter((m) => m.id !== manthraId),
            };
          }),
        };
      })
    );
  }

  // ---------- Save / Delete / Publish ----------

  function handleSaveAndExit() {
    if (!formData.GranthaName.trim()) {
      toast({ variant: "destructive", title: "Grantha Name is required" });
      return;
    }

    const payload = {
      GranthaName: formData.GranthaName,
      GranthaType: formData.GranthaType || undefined,
      BhashyamName: formData.BhashyamName || undefined,
      BhashyamAuthor: formData.BhashyamAuthor || undefined,
      teekas,
      hierarchy: adhyayas,
    };

    const strapiDocId =
      editingItem && !editingItem._isDraft
        ? editingItem.documentId
        : editingItem?._strapiDocId || undefined;

    saveDraft.mutate(
      {
        title: formData.GranthaName,
        data: payload,
        strapiDocumentId: strapiDocId,
        draftId: editingDraftId ?? undefined,
      },
      {
        onSuccess: () => {
          setView("list");
          resetForm();
          toast({ title: "Saved as draft" });
        },
      }
    );
  }

  function handleDelete(item: any) {
    setDeleteTarget(item);
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    if (deleteTarget._isDraft) {
      deleteDraft.mutate(deleteTarget._draftId, {
        onSuccess: () => setDeleteTarget(null),
      });
    } else {
      deleteStrapiMutation.mutate(deleteTarget.documentId);
    }
  }

  function handlePublish(item: any) {
    if (item._draftId) publishDraft.mutate(item._draftId);
  }

  // Merged list
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

  // ---------- Render: List ----------

  if (view === "list") {
    return (
      <div className="p-6 lg:p-8 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Granthas</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Browse library to update existing content
            </p>
          </div>
          <Button onClick={openAdd} data-testid="button-new-grantha">
            <Plus className="w-4 h-4 mr-2" />
            New Entry
          </Button>
        </div>

        {isLoading || isLoadingDrafts ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="rounded-xl border bg-card p-5 h-36 animate-pulse"
              />
            ))}
          </div>
        ) : mergedData.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-muted-foreground gap-4">
            <BookOpen className="w-14 h-14 opacity-20" />
            <p className="text-sm">
              No granthas yet — create your first entry.
            </p>
            <Button onClick={openAdd} variant="outline">
              <Plus className="w-4 h-4 mr-2" />
              New Entry
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {mergedData.map((item, idx) => (
              <GranthaCard
                key={item.documentId || item._draftId || idx}
                item={item}
                onEdit={() => openEdit(item)}
                onDelete={() => handleDelete(item)}
                onPublish={() => handlePublish(item)}
                isPublishing={
                  publishDraft.isPending &&
                  (publishDraft.variables as number) === item._draftId
                }
              />
            ))}
          </div>
        )}

        <AlertDialog
          open={!!deleteTarget}
          onOpenChange={() => setDeleteTarget(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Delete {deleteTarget?._isDraft ? "Draft" : "Grantha"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete &quot;
                {deleteTarget?.GranthaName}&quot;?
                {!deleteTarget?._isDraft && " This will remove it from the CMS."}
                {deleteTarget?._isDraft &&
                  " This draft has not been published yet."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                data-testid="button-confirm-delete"
              >
                {(deleteStrapiMutation.isPending || deleteDraft.isPending) && (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                )}
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  // ---------- Render: Form (steps 1 & 2) ----------

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto">
      {/* Step indicator */}
      <div className="flex items-end gap-0 mb-10">
        <StepDot n={1} active={step === 1} done={step > 1} label="Configuration" />
        <div
          className={`flex-1 h-0.5 mb-5 transition-colors ${
            step > 1 ? "bg-primary" : "bg-border"
          }`}
        />
        <StepDot n={2} active={step === 2} done={false} label="Build Hierarchy" />
      </div>

      {step === 1 ? (
        /* ====== STEP 1: Configuration ====== */
        <div className="space-y-6">
          <div>
            <h2 className="text-xl font-semibold">Grantha Configuration</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Set up the basic details of the sacred text
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>Grantha Name *</Label>
              <Input
                value={formData.GranthaName}
                onChange={(e) =>
                  setFormData({ ...formData, GranthaName: e.target.value })
                }
                placeholder="e.g., Chandogya Upanishad"
                className="mt-1.5"
                data-testid="input-grantha-name"
              />
            </div>
            <div>
              <Label>Grantha Type</Label>
              <Select
                value={formData.GranthaType}
                onValueChange={(val) =>
                  setFormData({ ...formData, GranthaType: val })
                }
              >
                <SelectTrigger
                  className="mt-1.5"
                  data-testid="select-grantha-type"
                >
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {granthaTypes.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Bhashyam Name</Label>
              <Input
                value={formData.BhashyamName}
                onChange={(e) =>
                  setFormData({ ...formData, BhashyamName: e.target.value })
                }
                placeholder="e.g., Chandogya Bhashyam"
                className="mt-1.5"
                data-testid="input-bhashyam-name"
              />
            </div>
            <div>
              <Label>Bhashyam Author</Label>
              <Select
                value={formData.BhashyamAuthor}
                onValueChange={(val) =>
                  setFormData({ ...formData, BhashyamAuthor: val })
                }
              >
                <SelectTrigger
                  className="mt-1.5"
                  data-testid="select-bhashyam-author"
                >
                  <SelectValue placeholder="Select author" />
                </SelectTrigger>
                <SelectContent>
                  {bhashyamAuthors.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Teeka Management */}
          <div className="border rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold">Teeka Management</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Add commentary authors for this Grantha
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={addTeeka}
                data-testid="button-add-teeka"
              >
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                Add Teeka
              </Button>
            </div>

            {teekas.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No teekas added yet
              </p>
            ) : (
              <div className="space-y-3">
                {teekas.map((teeka, i) => (
                  <div
                    key={teeka.id}
                    className="flex gap-3 items-start p-3 bg-muted/40 rounded-lg"
                  >
                    <span className="text-xs font-semibold text-muted-foreground mt-2.5 w-5 shrink-0 text-center">
                      {i + 1}
                    </span>
                    <div className="flex-1 grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs">Teeka Name</Label>
                        <Input
                          value={teeka.TeekaName}
                          onChange={(e) =>
                            updateTeeka(teeka.id, "TeekaName", e.target.value)
                          }
                          placeholder="e.g., Nyaya-Nirnaya"
                          className="mt-1 h-8 text-sm"
                          data-testid={`input-teeka-name-${i}`}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Author</Label>
                        <Select
                          value={teeka.TeekaAuthor}
                          onValueChange={(val) =>
                            updateTeeka(teeka.id, "TeekaAuthor", val)
                          }
                        >
                          <SelectTrigger
                            className="mt-1 h-8 text-sm"
                            data-testid={`select-teeka-author-${i}`}
                          >
                            <SelectValue placeholder="Select author" />
                          </SelectTrigger>
                          <SelectContent>
                            {teekaAuthors.map((a) => (
                              <SelectItem key={a} value={a}>
                                {a}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="shrink-0 h-8 w-8 text-destructive hover:text-destructive mt-0.5"
                      onClick={() => removeTeeka(teeka.id)}
                      data-testid={`button-remove-teeka-${i}`}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-between items-center pt-2">
            <Button
              variant="outline"
              onClick={() => {
                setView("list");
                resetForm();
              }}
              data-testid="button-cancel"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!formData.GranthaName.trim()) {
                  toast({
                    variant: "destructive",
                    title: "Grantha Name is required",
                  });
                  return;
                }
                setStep(2);
              }}
              data-testid="button-next-hierarchy"
            >
              Next: Build Hierarchy
              <ChevronRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
        </div>
      ) : (
        /* ====== STEP 2: Hierarchy Builder ====== */
        <div className="space-y-6">
          <div>
            <h2 className="text-xl font-semibold">
              {formData.GranthaName || "Grantha"} Hierarchy
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              Adhyaya → Khanda → Manthra
            </p>
          </div>

          {/* Tree */}
          <div className="space-y-3">
            {adhyayas.map((adhyaya, aIdx) => (
              <div
                key={adhyaya.id}
                className="border rounded-xl overflow-hidden"
                data-testid={`adhyaya-${aIdx}`}
              >
                {/* Adhyaya row */}
                <div
                  className="flex items-center gap-3 px-4 py-3 bg-muted/30 cursor-pointer select-none"
                  onClick={() => toggleAdhyaya(adhyaya.id)}
                >
                  <span className="flex items-center justify-center w-7 h-7 rounded-full bg-primary/10 text-primary text-xs font-bold shrink-0">
                    {aIdx + 1}
                  </span>
                  <Input
                    value={adhyaya.title}
                    onChange={(e) => {
                      e.stopPropagation();
                      updateAdhyaya(adhyaya.id, e.target.value);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="h-8 text-sm font-medium border-0 bg-transparent shadow-none focus-visible:ring-1 focus-visible:ring-primary/50 px-2"
                    data-testid={`input-adhyaya-title-${aIdx}`}
                  />
                  <div className="flex items-center gap-1 ml-auto shrink-0">
                    <span className="text-xs text-muted-foreground mr-1">
                      {adhyaya.khandas.length} khanda
                      {adhyaya.khandas.length !== 1 ? "s" : ""}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeAdhyaya(adhyaya.id);
                      }}
                      data-testid={`button-remove-adhyaya-${aIdx}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                    {adhyaya.expanded ? (
                      <ChevronDown className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    )}
                  </div>
                </div>

                {/* Khandas */}
                {adhyaya.expanded && (
                  <div className="p-4 space-y-2.5">
                    {adhyaya.khandas.map((khanda, kIdx) => (
                      <div
                        key={khanda.id}
                        className="border rounded-lg overflow-hidden"
                        data-testid={`khanda-${aIdx}-${kIdx}`}
                      >
                        {/* Khanda row */}
                        <div
                          className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer select-none hover:bg-muted/20 transition-colors"
                          onClick={() => toggleKhanda(adhyaya.id, khanda.id)}
                        >
                          <Layers className="w-4 h-4 text-muted-foreground shrink-0" />
                          <Input
                            value={khanda.title}
                            onChange={(e) => {
                              e.stopPropagation();
                              updateKhanda(
                                adhyaya.id,
                                khanda.id,
                                e.target.value
                              );
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="h-7 text-sm border-0 bg-transparent shadow-none focus-visible:ring-1 focus-visible:ring-primary/50 px-1.5"
                            data-testid={`input-khanda-title-${aIdx}-${kIdx}`}
                          />
                          <div className="flex items-center gap-1 ml-auto shrink-0">
                            <span className="text-xs text-muted-foreground">
                              {khanda.manthras.length} manthra
                              {khanda.manthras.length !== 1 ? "s" : ""}
                            </span>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6 text-destructive hover:text-destructive"
                              onClick={(e) => {
                                e.stopPropagation();
                                removeKhanda(adhyaya.id, khanda.id);
                              }}
                              data-testid={`button-remove-khanda-${aIdx}-${kIdx}`}
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                            {khanda.expanded ? (
                              <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                            )}
                          </div>
                        </div>

                        {/* Manthras */}
                        {khanda.expanded && (
                          <div className="px-4 pt-2 pb-3 border-t bg-muted/10">
                            <p className="text-xs font-medium text-muted-foreground mb-2">
                              Manage Manthras
                            </p>
                            <div className="space-y-1">
                              {khanda.manthras.map((manthra, mIdx) => (
                                <div
                                  key={manthra.id}
                                  className="flex items-center gap-2 group py-0.5"
                                >
                                  <Hash className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                  <span className="text-sm flex-1">
                                    {manthra.title}
                                  </span>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive transition-opacity"
                                    onClick={() =>
                                      removeManthra(
                                        adhyaya.id,
                                        khanda.id,
                                        manthra.id
                                      )
                                    }
                                    data-testid={`button-remove-manthra-${aIdx}-${kIdx}-${mIdx}`}
                                  >
                                    <X className="w-3 h-3" />
                                  </Button>
                                </div>
                              ))}
                              <Button
                                size="sm"
                                variant="ghost"
                                className="w-full justify-start text-muted-foreground hover:text-foreground text-xs h-7 mt-1 pl-0"
                                onClick={() =>
                                  addManthra(adhyaya.id, khanda.id)
                                }
                                data-testid={`button-add-manthra-${aIdx}-${kIdx}`}
                              >
                                <Plus className="w-3.5 h-3.5 mr-1" />
                                Add
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}

                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full border-dashed text-muted-foreground hover:text-foreground"
                      onClick={() => addKhanda(adhyaya.id)}
                      data-testid={`button-add-khanda-${aIdx}`}
                    >
                      <Plus className="w-3.5 h-3.5 mr-1.5" />
                      Add New Khanda
                    </Button>
                  </div>
                )}
              </div>
            ))}

            <Button
              variant="outline"
              className="w-full border-dashed text-muted-foreground hover:text-foreground"
              onClick={addAdhyaya}
              data-testid="button-add-adhyaya"
            >
              <Plus className="w-4 h-4 mr-2" />
              New Adhyaya
            </Button>
          </div>

          <div className="flex justify-between items-center pt-2">
            <Button
              variant="outline"
              onClick={() => setStep(1)}
              data-testid="button-back"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back
            </Button>
            <Button
              onClick={handleSaveAndExit}
              disabled={saveDraft.isPending}
              data-testid="button-save-exit"
            >
              {saveDraft.isPending && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              Save & Exit
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
