import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useDrafts } from "@/hooks/use-drafts";
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
  SelectGroup,
  SelectItem,
  SelectLabel,
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
import {
  Loader2,
  ChevronRight,
  BookOpen,
  FileText,
  Hash,
  Plus,
  Pencil,
  Trash2,
  Send,
  Eye,
  CornerDownRight,
} from "lucide-react";
import { blocksToText } from "@/lib/strapi-blocks";
import { STRAPI_POLL_INTERVAL } from "@/hooks/use-strapi-sync";

const EMPTY_TT: TextAndTranslation = {
  SanskritTextEntry: "",
  EnglishTranslationText: "",
  OtherLanguagesTranslation: "",
  LanguageOfTranslation: "",
};

interface FlatChapter {
  documentId: string;
  ChapterTitle: string;
  order: number;
  granthaDocId?: string;
  parentDocId?: string;
  depth: number;
  raw: StrapiChapter;
}

function buildFlatTree(chapters: StrapiChapter[]): FlatChapter[] {
  const byDoc = new Map<string, StrapiChapter>();
  for (const c of chapters) byDoc.set(c.documentId, c);

  function getDepth(c: StrapiChapter, visited = new Set<string>()): number {
    if (!c.parent?.documentId || visited.has(c.documentId)) return 0;
    visited.add(c.documentId);
    const p = byDoc.get(c.parent.documentId);
    return p ? 1 + getDepth(p, visited) : 1;
  }

  const flat: FlatChapter[] = chapters.map((c) => ({
    documentId: c.documentId,
    ChapterTitle: c.ChapterTitle,
    order: c.order,
    granthaDocId: c.grantha?.documentId,
    parentDocId: c.parent?.documentId,
    depth: getDepth(c),
    raw: c,
  }));

  const roots = flat.filter((f) => !f.parentDocId).sort((a, b) => a.order - b.order);
  const result: FlatChapter[] = [];

  function addTree(docId: string) {
    const node = flat.find((f) => f.documentId === docId);
    if (!node) return;
    result.push(node);
    flat
      .filter((f) => f.parentDocId === docId)
      .sort((a, b) => a.order - b.order)
      .forEach((child) => addTree(child.documentId));
  }

  roots.forEach((r) => addTree(r.documentId));

  flat
    .filter((f) => f.parentDocId && !byDoc.has(f.parentDocId!))
    .forEach((orphan) => {
      if (!result.find((r) => r.documentId === orphan.documentId)) result.push(orphan);
    });

  return result;
}

function buildBreadcrumb(docId: string | undefined, flatTree: FlatChapter[], allGranthas: StrapiGrantha[]): string[] {
  const parts: string[] = [];
  let current = flatTree.find((f) => f.documentId === docId);
  const visited = new Set<string>();
  while (current && !visited.has(current.documentId)) {
    visited.add(current.documentId);
    parts.unshift(current.ChapterTitle);
    current = current.parentDocId ? flatTree.find((f) => f.documentId === current!.parentDocId) : undefined;
  }
  if (parts.length > 0) {
    const grantha = allGranthas.find((g) => {
      const root = flatTree.find((f) => f.documentId === docId);
      return root && (g.documentId === root.granthaDocId || flatTree.some((f) => f.documentId === docId && f.granthaDocId === g.documentId));
    });
    if (grantha) parts.unshift(grantha.GranthaName);
  }
  return parts;
}

function ReadOnlyField({ label, text }: { label: string; text?: string }) {
  if (!text?.trim()) return null;
  return (
    <div>
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">{label}</p>
      <div className="bg-muted/40 rounded-md px-3 py-2 text-sm whitespace-pre-wrap font-serif leading-relaxed">
        {text}
      </div>
    </div>
  );
}

function ReadOnlyTT({ label, tt }: { label: string; tt?: TextAndTranslation }) {
  if (!tt) return null;
  const sanskrit = blocksToText(tt.SanskritTextEntry);
  const english = blocksToText(tt.EnglishTranslationText);
  const other = blocksToText(tt.OtherLanguagesTranslation);
  const lang = typeof tt.LanguageOfTranslation === "string" ? tt.LanguageOfTranslation : "";
  if (!sanskrit && !english && !other) return null;
  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <p className="text-sm font-semibold text-foreground flex items-center gap-2">
        <FileText className="w-4 h-4 text-primary" />
        {label}
      </p>
      <ReadOnlyField label="Sanskrit Text (Devanagari)" text={sanskrit} />
      <ReadOnlyField label="English Translation" text={english} />
      {lang && <ReadOnlyField label={`Translation in ${lang}`} text={other} />}
    </div>
  );
}

function GranthaDetailCard({ grantha }: { grantha: StrapiGrantha }) {
  return (
    <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
      <p className="text-xs font-semibold text-primary uppercase tracking-wider">Selected Grantha</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
        <div>
          <span className="text-xs text-muted-foreground block">Name</span>
          <span className="font-medium">{grantha.GranthaName}</span>
        </div>
        {grantha.GranthaType && (
          <div>
            <span className="text-xs text-muted-foreground block">Type</span>
            <span>{grantha.GranthaType}</span>
          </div>
        )}
        {grantha.BhashyamName && (
          <div>
            <span className="text-xs text-muted-foreground block">Bhashyam</span>
            <span>{grantha.BhashyamName}</span>
          </div>
        )}
        {grantha.BhashyamAuthor && (
          <div>
            <span className="text-xs text-muted-foreground block">Author</span>
            <span>{grantha.BhashyamAuthor}</span>
          </div>
        )}
        {grantha.NumberOfTeekas != null && (
          <div>
            <span className="text-xs text-muted-foreground block">Teekas</span>
            <span>{grantha.NumberOfTeekas}</span>
          </div>
        )}
      </div>
      {grantha.IntroductionToTextEnglish && blocksToText(grantha.IntroductionToTextEnglish) && (
        <div>
          <span className="text-xs text-muted-foreground block mb-0.5">Introduction (English)</span>
          <p className="text-xs leading-relaxed text-foreground line-clamp-3">
            {blocksToText(grantha.IntroductionToTextEnglish)}
          </p>
        </div>
      )}
    </div>
  );
}

function ChapterDetailCard({
  chapter,
  flatTree,
  allGranthas,
  label = "Selected Parent",
}: {
  chapter: FlatChapter;
  flatTree: FlatChapter[];
  allGranthas: StrapiGrantha[];
  label?: string;
}) {
  const grantha = allGranthas.find((g) => g.documentId === chapter.granthaDocId);
  const parentChapter = chapter.parentDocId
    ? flatTree.find((f) => f.documentId === chapter.parentDocId)
    : null;

  const sanskrit = blocksToText(chapter.raw.ShlokaManthraEntry?.SanskritTextEntry);
  const english = blocksToText(chapter.raw.ShlokaManthraEntry?.EnglishTranslationText);

  return (
    <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
      <p className="text-xs font-semibold text-primary uppercase tracking-wider">{label}</p>
      <div className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
        {grantha && <><span className="font-medium text-foreground">{grantha.GranthaName}</span><ChevronRight className="w-3 h-3" /></>}
        {parentChapter && <><span>{parentChapter.ChapterTitle}</span><ChevronRight className="w-3 h-3" /></>}
        <span className="font-semibold text-foreground">{chapter.ChapterTitle}</span>
      </div>
      <div className="grid grid-cols-3 gap-x-4 gap-y-1.5 text-sm">
        <div>
          <span className="text-xs text-muted-foreground block">Title</span>
          <span className="font-medium">{chapter.ChapterTitle}</span>
        </div>
        <div>
          <span className="text-xs text-muted-foreground block">Order</span>
          <span>{chapter.order}</span>
        </div>
        <div>
          <span className="text-xs text-muted-foreground block">Depth</span>
          <span>Level {chapter.depth + 1}</span>
        </div>
        {grantha && (
          <div className="col-span-2">
            <span className="text-xs text-muted-foreground block">Grantha</span>
            <span>{grantha.GranthaName}</span>
          </div>
        )}
      </div>
      {(sanskrit || english) && (
        <div className="space-y-1.5 pt-1 border-t border-primary/10">
          {sanskrit && (
            <div>
              <span className="text-xs text-muted-foreground block mb-0.5">Sanskrit Text</span>
              <p className="text-xs font-serif leading-relaxed line-clamp-3">{sanskrit}</p>
            </div>
          )}
          {english && (
            <div>
              <span className="text-xs text-muted-foreground block mb-0.5">English Translation</span>
              <p className="text-xs leading-relaxed line-clamp-3">{english}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChapterViewPanel({
  item,
  allGranthas,
  flatTree,
  onClose,
  onEdit,
}: {
  item: any;
  allGranthas: StrapiGrantha[];
  flatTree: FlatChapter[];
  onClose: () => void;
  onEdit: () => void;
}) {
  const isDraft = !!item._isDraft;
  const data = isDraft ? item._draftData || item : item;

  const grantha = isDraft
    ? allGranthas.find((g) => g.documentId === data._grantha || g.documentId === data.grantha)
    : allGranthas.find((g) => g.documentId === item.grantha?.documentId);

  const parentChapter = isDraft ? null : flatTree.find((f) => f.documentId === item.parent?.documentId);
  const depth = flatTree.find((f) => f.documentId === item.documentId)?.depth ?? 0;

  const teekas: BhashyaEntry[] = data.Teekas || [];

  return (
    <div className="space-y-5">
      <DialogHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <DialogTitle className="text-xl">{data.ChapterTitle || item.ChapterTitle}</DialogTitle>
            <div className="flex items-center gap-2 mt-2">
              <Badge variant="outline" className="text-xs">Level {depth + 1}</Badge>
              {isDraft ? (
                <Badge className="bg-amber-100 text-amber-800 border-amber-200 text-xs">Draft</Badge>
              ) : (
                <Badge className="bg-green-100 text-green-800 border-green-200 text-xs">Published</Badge>
              )}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={onEdit} data-testid="button-view-edit">
            <Pencil className="w-3.5 h-3.5 mr-1.5" />
            Edit
          </Button>
        </div>
        <DialogDescription className="mt-2">
          <span className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
            {grantha && <><span className="font-medium">{grantha.GranthaName}</span><ChevronRight className="w-3 h-3" /></>}
            {parentChapter && <><span>{parentChapter.ChapterTitle}</span><ChevronRight className="w-3 h-3" /></>}
            <span className="text-foreground font-medium">{data.ChapterTitle || item.ChapterTitle}</span>
          </span>
        </DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-xs text-muted-foreground font-medium">Order</p>
          <p className="mt-0.5">{data.order ?? item.order ?? 0}</p>
        </div>
        {grantha && (
          <div>
            <p className="text-xs text-muted-foreground font-medium">Grantha</p>
            <p className="mt-0.5">{grantha.GranthaName}</p>
          </div>
        )}
      </div>

      <ReadOnlyTT label="Shloka / Manthra Entry" tt={data.ShlokaManthraEntry} />
      <ReadOnlyTT label="Bhashyam for Shloka / Manthra" tt={data.BhashyamForShlokaManthra} />

      {teekas.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-semibold text-foreground flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-primary" />
            Teekas (Commentaries)
          </p>
          {teekas.map((teeka, i) => (
            <div key={i} className="rounded-lg border border-border p-4 space-y-3">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">{teeka.TeekaName || `Teeka ${i + 1}`}</span>
                {teeka.TeekaAuthor && (
                  <Badge variant="secondary" className="text-xs">{teeka.TeekaAuthor}</Badge>
                )}
              </div>
              <ReadOnlyTT label="Teeka Entry" tt={teeka.TeekaEntry} />
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-end pt-2">
        <Button variant="outline" onClick={onClose} data-testid="button-view-close">Close</Button>
      </div>
    </div>
  );
}

export default function ChaptersPage() {
  const { toast } = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [editingDraftId, setEditingDraftId] = useState<number | null>(null);
  const [viewingItem, setViewingItem] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const [formData, setFormData] = useState({
    ChapterTitle: "",
    order: 0,
    grantha: "",
    parentDocId: "",
    ShlokaManthraEntry: { ...EMPTY_TT } as TextAndTranslation,
    BhashyamForShlokaManthra: { ...EMPTY_TT } as TextAndTranslation,
    Teekas: [] as BhashyaEntry[],
  });

  const { data, isLoading } = useQuery<StrapiResponse<StrapiChapter>>({
    queryKey: ["/api/strapi", "chapters"],
    refetchInterval: STRAPI_POLL_INTERVAL,
    refetchOnWindowFocus: true,
  });

  const { data: granthasData } = useQuery<StrapiResponse<StrapiGrantha>>({
    queryKey: ["/api/strapi", "granthas"],
    refetchInterval: STRAPI_POLL_INTERVAL,
    refetchOnWindowFocus: true,
  });

  const { unpublishedDrafts, isLoadingDrafts, saveDraft, publishDraft, deleteDraft } =
    useDrafts("chapters");

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

  const strapiChapters = data?.data || [];
  const flatTree = useMemo(() => buildFlatTree(strapiChapters), [strapiChapters]);

  const allGranthas = useMemo(() => {
    const seen = new Set<string>();
    return (granthasData?.data || []).filter((g) => {
      const key = g.GranthaName.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [granthasData]);

  function inferGranthaFromParent(parentDocId: string): string {
    let current = flatTree.find((f) => f.documentId === parentDocId);
    const visited = new Set<string>();
    while (current && !visited.has(current.documentId)) {
      visited.add(current.documentId);
      if (current.granthaDocId) return current.granthaDocId;
      if (!current.parentDocId) break;
      current = flatTree.find((f) => f.documentId === current!.parentDocId);
    }
    return "";
  }

  function resetForm() {
    setFormData({
      ChapterTitle: "",
      order: 0,
      grantha: "",
      parentDocId: "",
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
        grantha: d._grantha || "",
        parentDocId: d._parentDocId || "",
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
        parentDocId: item.parent?.documentId || "",
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

    const parentDocId = formData.parentDocId || null;
    const granthaDocId = formData.grantha || (parentDocId ? inferGranthaFromParent(parentDocId) : "");

    const payload: any = {
      _grantha: granthaDocId,
      _parentDocId: parentDocId || "",
      ChapterTitle: formData.ChapterTitle,
      order: formData.order,
      ShlokaManthraEntry: formData.ShlokaManthraEntry,
      BhashyamForShlokaManthra: formData.BhashyamForShlokaManthra,
      Teekas: formData.Teekas,
    };
    if (granthaDocId) payload.grantha = granthaDocId;
    if (parentDocId) payload.parent = parentDocId;

    const strapiDocId =
      editingItem && !editingItem._isDraft
        ? editingItem.documentId
        : editingItem?._strapiDocId || undefined;

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

  const draftRows = unpublishedDrafts.map((d) => ({
    ...(d.data as any),
    _isDraft: true,
    _draftId: d.id,
    _draftStatus: d.status,
    _strapiDocId: d.strapiDocumentId,
    _draftData: d.data,
  }));

  const searchLower = searchQuery.toLowerCase();

  const displayedDrafts = draftRows.filter((d) =>
    (d.ChapterTitle || "").toLowerCase().includes(searchLower)
  );

  const displayedPublished = flatTree.filter((f) =>
    f.ChapterTitle.toLowerCase().includes(searchLower)
  );

  const isSaving = saveDraft.isPending;

  const selectedParent = formData.parentDocId
    ? flatTree.find((f) => f.documentId === formData.parentDocId)
    : null;

  const selectedGrantha = formData.grantha
    ? allGranthas.find((g) => g.documentId === formData.grantha)
    : null;

  const parentsByGrantha = useMemo(() => {
    const groups = new Map<string, { grantha?: StrapiGrantha; chapters: FlatChapter[] }>();
    for (const f of flatTree) {
      const key = f.granthaDocId || "__none__";
      if (!groups.has(key)) {
        groups.set(key, {
          grantha: allGranthas.find((g) => g.documentId === f.granthaDocId),
          chapters: [],
        });
      }
      groups.get(key)!.chapters.push(f);
    }
    return groups;
  }, [flatTree, allGranthas]);

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-foreground">Chapters</h1>
        <Button onClick={openAdd} data-testid="chapter-add">
          <Plus className="w-4 h-4 mr-2" />
          Add Chapter
        </Button>
      </div>

      <div className="mb-4">
        <Input
          placeholder="Search chapters..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="max-w-sm"
          data-testid="input-search-chapters"
        />
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {isLoading || isLoadingDrafts ? (
          <div className="flex justify-center items-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : displayedDrafts.length === 0 && displayedPublished.length === 0 ? (
          <div className="py-20 text-center text-muted-foreground">
            <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>No chapters found. Add the first chapter above.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground w-8">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Title</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Grantha</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Order</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayedDrafts.map((draft) => {
                const isPub = publishDraft.isPending && publishDraft.variables === draft._draftId;
                return (
                  <tr
                    key={`draft-${draft._draftId}`}
                    className="border-b border-border hover:bg-muted/30 transition-colors"
                    data-testid={`row-draft-${draft._draftId}`}
                  >
                    <td className="px-4 py-3">
                      <Badge className="bg-amber-100 text-amber-800 border-amber-200 text-xs">Draft</Badge>
                    </td>
                    <td className="px-4 py-3 font-medium">{draft.ChapterTitle}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">—</td>
                    <td className="px-4 py-3 text-muted-foreground">{draft.order ?? 0}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setViewingItem(draft)}
                          data-testid={`button-view-draft-${draft._draftId}`}
                          title="View details"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openEdit(draft)}
                          data-testid={`button-edit-draft-${draft._draftId}`}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-primary hover:text-primary"
                          onClick={() => handlePublish(draft)}
                          disabled={isPub}
                          data-testid={`button-publish-draft-${draft._draftId}`}
                          title="Publish to Strapi"
                        >
                          {isPub ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(draft)}
                          data-testid={`button-delete-draft-${draft._draftId}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {displayedPublished.map((flat) => {
                const grantha = allGranthas.find((g) => g.documentId === flat.granthaDocId);
                return (
                  <tr
                    key={flat.documentId}
                    className="border-b border-border hover:bg-muted/30 transition-colors"
                    data-testid={`row-chapter-${flat.documentId}`}
                  >
                    <td className="px-4 py-3">
                      <Badge className="bg-green-100 text-green-800 border-green-200 text-xs">Published</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center" style={{ paddingLeft: `${flat.depth * 20}px` }}>
                        {flat.depth > 0 && (
                          <CornerDownRight className="w-3.5 h-3.5 text-muted-foreground mr-1.5 shrink-0" />
                        )}
                        <span className="font-medium">{flat.ChapterTitle}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {grantha?.GranthaName || flat.raw.grantha?.GranthaName || "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{flat.order}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setViewingItem(flat.raw)}
                          data-testid={`button-view-${flat.documentId}`}
                          title="View details"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openEdit(flat.raw)}
                          data-testid={`button-edit-${flat.documentId}`}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(flat.raw)}
                          data-testid={`button-delete-${flat.documentId}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Add / Edit form dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingItem ? "Edit Chapter" : "Add Chapter"}
            </DialogTitle>
            <DialogDescription>
              Fill in the chapter details. Parent and Grantha are both optional.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-5">

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>Chapter Title *</Label>
                <Input
                  value={formData.ChapterTitle}
                  onChange={(e) => setFormData({ ...formData, ChapterTitle: e.target.value })}
                  placeholder="e.g., Adhyaya 1, Khanda 2, Shloka 1.1"
                  className="mt-1.5"
                  data-testid="input-chapter-title"
                />
              </div>
              <div>
                <Label>Order</Label>
                <Input
                  type="number"
                  value={formData.order}
                  onChange={(e) => setFormData({ ...formData, order: parseInt(e.target.value) || 0 })}
                  className="mt-1.5"
                  data-testid="input-chapter-order"
                />
              </div>
            </div>

            {/* Hierarchy */}
            <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                <ChevronRight className="w-3.5 h-3.5" />
                Hierarchy Placement
              </p>

              {/* Parent Chapter — optional, any depth */}
              <div>
                <Label className="text-sm">Parent Chapter <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <Select
                  value={formData.parentDocId || "__none__"}
                  onValueChange={(val) => {
                    const parentDocId = val === "__none__" ? "" : val;
                    const inferred = parentDocId ? inferGranthaFromParent(parentDocId) : "";
                    setFormData((f) => ({
                      ...f,
                      parentDocId,
                      grantha: inferred || f.grantha,
                    }));
                  }}
                >
                  <SelectTrigger className="mt-1.5" data-testid="select-parent">
                    <SelectValue placeholder="No parent — top-level entry" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">
                      <span className="text-muted-foreground italic">No parent (top-level)</span>
                    </SelectItem>
                    {Array.from(parentsByGrantha.entries()).map(([key, group]) => (
                      <SelectGroup key={key}>
                        <SelectLabel>{group.grantha?.GranthaName || "No Grantha"}</SelectLabel>
                        {group.chapters
                          .filter((c) => !editingItem || c.documentId !== editingItem.documentId)
                          .map((c) => (
                            <SelectItem key={c.documentId} value={c.documentId}>
                              <span style={{ paddingLeft: `${c.depth * 12}px` }} className="inline-flex items-center gap-1">
                                {c.depth > 0 && <CornerDownRight className="w-3 h-3 text-muted-foreground" />}
                                {c.ChapterTitle}
                              </span>
                            </SelectItem>
                          ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
                {selectedParent && (
                  <ChapterDetailCard
                    chapter={selectedParent}
                    flatTree={flatTree}
                    allGranthas={allGranthas}
                    label="Selected Parent"
                  />
                )}
              </div>

              {/* Grantha — optional, auto-inferred from parent */}
              <div>
                <Label className="text-sm">
                  Grantha <span className="text-muted-foreground font-normal">(optional{formData.parentDocId ? ", auto-inferred from parent" : ""})</span>
                </Label>
                <Select
                  value={formData.grantha || "__none__"}
                  onValueChange={(val) =>
                    setFormData({ ...formData, grantha: val === "__none__" ? "" : val })
                  }
                >
                  <SelectTrigger className="mt-1.5" data-testid="select-grantha">
                    <SelectValue placeholder="Select Grantha (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">
                      <span className="text-muted-foreground italic">No Grantha</span>
                    </SelectItem>
                    {allGranthas.map((g) => (
                      <SelectItem key={g.documentId} value={g.documentId}>
                        {g.GranthaName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedGrantha && <GranthaDetailCard grantha={selectedGrantha} />}
              </div>

              {/* Path preview */}
              {(formData.parentDocId || formData.grantha) && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap pt-1 border-t border-border">
                  <span className="font-medium text-foreground mr-1">Path:</span>
                  {selectedGrantha && <><span>{selectedGrantha.GranthaName}</span><ChevronRight className="w-3 h-3" /></>}
                  {selectedParent && (() => {
                    const ancestors: FlatChapter[] = [];
                    let cur = selectedParent;
                    const seen = new Set<string>();
                    while (cur && !seen.has(cur.documentId)) {
                      seen.add(cur.documentId);
                      ancestors.unshift(cur);
                      cur = cur.parentDocId ? flatTree.find((f) => f.documentId === cur!.parentDocId)! : undefined as any;
                    }
                    return ancestors.map((a, i) => (
                      <span key={a.documentId} className="flex items-center gap-1">
                        {i > 0 && <ChevronRight className="w-3 h-3" />}
                        <span>{a.ChapterTitle}</span>
                      </span>
                    ));
                  })()}
                  <ChevronRight className="w-3 h-3" />
                  <span className="font-semibold text-foreground">{formData.ChapterTitle || "New Chapter"}</span>
                </div>
              )}
            </div>

            {/* Text content */}
            <TextTranslationFields
              label="Shloka / Manthra Entry"
              value={formData.ShlokaManthraEntry}
              onChange={(val) => setFormData({ ...formData, ShlokaManthraEntry: val })}
            />
            <TextTranslationFields
              label="Bhashyam for Shloka / Manthra"
              value={formData.BhashyamForShlokaManthra}
              onChange={(val) => setFormData({ ...formData, BhashyamForShlokaManthra: val })}
            />

            <BhashyaEntryFields
              label="Teekas (Commentaries)"
              value={formData.Teekas}
              onChange={(val) => setFormData({ ...formData, Teekas: val })}
            />

            <div className="flex justify-between items-center pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => { setFormOpen(false); resetForm(); setEditingItem(null); }}
                data-testid="button-cancel"
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving} data-testid="button-save-draft">
                {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Save as Draft
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* View dialog */}
      <Dialog open={!!viewingItem} onOpenChange={(open) => { if (!open) setViewingItem(null); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          {viewingItem && (
            <ChapterViewPanel
              item={viewingItem}
              allGranthas={allGranthas}
              flatTree={flatTree}
              onClose={() => setViewingItem(null)}
              onEdit={() => { openEdit(viewingItem); setViewingItem(null); }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete chapter?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &quot;{deleteTarget?.ChapterTitle || deleteTarget?._draftData?.ChapterTitle}&quot;.
              {!deleteTarget?._isDraft && " This cannot be undone."}
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
