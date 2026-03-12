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
  Layers,
  FileText,
  Hash,
  Plus,
  Pencil,
  Trash2,
  Send,
  Eye,
} from "lucide-react";
import { blocksToText } from "@/components/text-translation-fields";

const CHAPTER_LEVELS = [
  {
    value: "adhyaya",
    label: "Adhyaya / Valli",
    sublabel: "Master Chapter",
    icon: BookOpen,
    color: "bg-orange-100 text-orange-800 border-orange-200",
    badgeVariant: "outline" as const,
  },
  {
    value: "khanda",
    label: "Khanda / Brahmana / Valli",
    sublabel: "Sub Chapter",
    icon: Layers,
    color: "bg-blue-100 text-blue-800 border-blue-200",
    badgeVariant: "secondary" as const,
  },
  {
    value: "shloka",
    label: "Shloka / Verse",
    sublabel: "Leaf Entry",
    icon: Hash,
    color: "bg-green-100 text-green-800 border-green-200",
    badgeVariant: "default" as const,
  },
] as const;

type ChapterLevel = (typeof CHAPTER_LEVELS)[number]["value"];

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
  level: ChapterLevel;
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

  function levelFromDepth(d: number): ChapterLevel {
    if (d === 0) return "adhyaya";
    if (d === 1) return "khanda";
    return "shloka";
  }

  const flat: FlatChapter[] = chapters.map((c) => {
    const depth = getDepth(c);
    return {
      documentId: c.documentId,
      ChapterTitle: c.ChapterTitle,
      order: c.order,
      granthaDocId: c.grantha?.documentId,
      parentDocId: c.parent?.documentId,
      depth,
      level: levelFromDepth(depth),
      raw: c,
    };
  });

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
      if (!result.find((r) => r.documentId === orphan.documentId)) {
        result.push(orphan);
      }
    });

  return result;
}

function chapterLabel(chapter: StrapiChapter, siblings: StrapiChapter[]): string {
  const duplicates = siblings.filter((s) => s.ChapterTitle === chapter.ChapterTitle);
  if (duplicates.length <= 1) return chapter.ChapterTitle;
  const sorted = [...duplicates].sort((a, b) => a.order - b.order || a.documentId.localeCompare(b.documentId));
  const idx = sorted.findIndex((s) => s.documentId === chapter.documentId);
  const orderPart = chapter.order !== undefined ? `Order ${chapter.order}` : `#${idx + 1}`;
  return `${chapter.ChapterTitle} — ${orderPart} (…${chapter.documentId.slice(-5)})`;
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

function ChapterViewPanel({
  item,
  allGranthas,
  flatTree,
  levelInfo,
  onClose,
  onEdit,
}: {
  item: any;
  allGranthas: StrapiGrantha[];
  flatTree: FlatChapter[];
  levelInfo: (level: ChapterLevel) => (typeof CHAPTER_LEVELS)[number];
  onClose: () => void;
  onEdit: () => void;
}) {
  const isDraft = !!item._isDraft;
  const data = isDraft ? item._draftData || item : item;
  const lvl = levelInfo(isDraft ? (data._level || "adhyaya") : (flatTree.find((f) => f.documentId === item.documentId)?.level || "adhyaya"));
  const LvlIcon = lvl.icon;

  const grantha = isDraft
    ? allGranthas.find((g) => g.documentId === data._grantha || g.documentId === data.grantha)
    : allGranthas.find((g) => g.documentId === (item.grantha?.documentId));

  const parentChapter = isDraft ? null : flatTree.find((f) => f.documentId === item.parent?.documentId);

  const teekas: BhashyaEntry[] = data.Teekas || [];

  return (
    <div className="space-y-5">
      <DialogHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <DialogTitle className="text-xl">{data.ChapterTitle || item.ChapterTitle}</DialogTitle>
            <div className="flex items-center gap-2 mt-2">
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-medium ${lvl.color}`}>
                <LvlIcon className="w-3 h-3" />
                {lvl.label}
              </span>
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

  const [chapterLevel, setChapterLevel] = useState<ChapterLevel>("adhyaya");

  const [formData, setFormData] = useState({
    ChapterTitle: "",
    order: 0,
    grantha: "",
    adhyayaParent: "",
    khandaParent: "",
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

  function resetForm() {
    setFormData({
      ChapterTitle: "",
      order: 0,
      grantha: "",
      adhyayaParent: "",
      khandaParent: "",
      ShlokaManthraEntry: { ...EMPTY_TT },
      BhashyamForShlokaManthra: { ...EMPTY_TT },
      Teekas: [],
    });
    setChapterLevel("adhyaya");
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
      setChapterLevel(d._level || "adhyaya");
      setFormData({
        ChapterTitle: d.ChapterTitle || "",
        order: d.order || 0,
        grantha: d._grantha || "",
        adhyayaParent: d._adhyayaParent || "",
        khandaParent: d._khandaParent || "",
        ShlokaManthraEntry: d.ShlokaManthraEntry || { ...EMPTY_TT },
        BhashyamForShlokaManthra: d.BhashyamForShlokaManthra || { ...EMPTY_TT },
        Teekas: d.Teekas || [],
      });
    } else {
      setEditingDraftId(null);
      const flat = flatTree.find((f) => f.documentId === item.documentId);
      const level = flat?.level || "adhyaya";
      setChapterLevel(level);

      setFormData({
        ChapterTitle: item.ChapterTitle || "",
        order: item.order || 0,
        grantha: level === "adhyaya" ? (item.grantha?.documentId || "") : "",
        adhyayaParent: level === "khanda" ? (item.parent?.documentId || "") : "",
        khandaParent: level === "shloka" ? (item.parent?.documentId || "") : "",
        ShlokaManthraEntry: item.ShlokaManthraEntry || { ...EMPTY_TT },
        BhashyamForShlokaManthra: item.BhashyamForShlokaManthra || { ...EMPTY_TT },
        Teekas: item.Teekas || [],
      });
    }
    setFormOpen(true);
  }

  function inferGranthaFromParent(parentDocId: string): string {
    let current = flatTree.find((f) => f.documentId === parentDocId);
    while (current) {
      if (current.granthaDocId) return current.granthaDocId;
      if (!current.parentDocId) break;
      current = flatTree.find((f) => f.documentId === current!.parentDocId);
    }
    return "";
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formData.ChapterTitle.trim()) {
      toast({ variant: "destructive", title: "Chapter Title is required" });
      return;
    }
    if (chapterLevel === "adhyaya" && !formData.grantha) {
      toast({ variant: "destructive", title: "Grantha is required for Adhyaya level" });
      return;
    }
    if (chapterLevel === "khanda" && !formData.adhyayaParent) {
      toast({ variant: "destructive", title: "Parent Adhyaya is required for Khanda level" });
      return;
    }
    if (chapterLevel === "shloka" && !formData.khandaParent) {
      toast({ variant: "destructive", title: "Parent chapter is required for Shloka level" });
      return;
    }

    const parentDocId =
      chapterLevel === "adhyaya" ? null :
      chapterLevel === "khanda" ? formData.adhyayaParent :
      formData.khandaParent;

    const granthaDocId =
      chapterLevel === "adhyaya" ? formData.grantha :
      parentDocId ? inferGranthaFromParent(parentDocId) : "";

    const payload: any = {
      _level: chapterLevel,
      _grantha: granthaDocId,
      _adhyayaParent: formData.adhyayaParent,
      _khandaParent: formData.khandaParent,
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

  const isSaving = saveDraft.isPending;

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

  const allGranthas = granthasData?.data || [];

  const levelInfo = (level: ChapterLevel) =>
    CHAPTER_LEVELS.find((l) => l.value === level)!;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Chapters</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Manage the Grantha → Adhyaya → Khanda → Shloka hierarchy
            </p>
          </div>
          <Button onClick={openAdd} data-testid="chapter-add">
            <Plus className="w-4 h-4 mr-2" />
            Add Chapter
          </Button>
        </div>

        <div className="mb-4 flex items-center gap-6 text-xs text-muted-foreground">
          {CHAPTER_LEVELS.map((l) => (
            <span key={l.value} className="flex items-center gap-1.5">
              <span className={`px-2 py-0.5 rounded border text-xs font-medium ${l.color}`}>
                {l.label}
              </span>
              {l.sublabel}
            </span>
          ))}
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
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Level</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Grantha</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Order</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody>
                {displayedDrafts.map((draft) => {
                  const lvl = levelInfo(draft._level || "adhyaya");
                  const LvlIcon = lvl.icon;
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
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-medium ${lvl.color}`}>
                          <LvlIcon className="w-3 h-3" />
                          {lvl.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">—</td>
                      <td className="px-4 py-3 text-muted-foreground">{draft.order ?? 0}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setViewingItem(draft)}
                            data-testid={`button-view-${draft._draftId}`}
                            title="View details"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handlePublish(draft)}
                            disabled={isPub}
                            data-testid={`button-publish-${draft._draftId}`}
                            title="Publish to CMS"
                          >
                            {isPub ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => openEdit(draft)}
                            data-testid={`button-edit-${draft._draftId}`}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setDeleteTarget(draft)}
                            data-testid={`button-delete-${draft._draftId}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {displayedPublished.map((flat) => {
                  const lvl = levelInfo(flat.level);
                  const LvlIcon = lvl.icon;
                  const grantha = allGranthas.find((g) => g.documentId === flat.granthaDocId);
                  return (
                    <tr
                      key={`pub-${flat.documentId}`}
                      className="border-b border-border hover:bg-muted/30 transition-colors"
                      data-testid={`row-chapter-${flat.documentId}`}
                    >
                      <td className="px-4 py-3">
                        <Badge className="bg-green-100 text-green-800 border-green-200 text-xs">Published</Badge>
                      </td>
                      <td className="px-4 py-3 font-medium">
                        <span
                          style={{ paddingLeft: flat.depth * 24 }}
                          className="flex items-center gap-1.5"
                        >
                          {flat.depth > 0 && (
                            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                          )}
                          {flat.ChapterTitle}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-medium ${lvl.color}`}>
                          <LvlIcon className="w-3 h-3" />
                          {lvl.label}
                        </span>
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

        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingItem ? "Edit Chapter" : "Add New Chapter"}
              </DialogTitle>
              <DialogDescription>
                Select the chapter level then fill in the details.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-5">

              <div>
                <Label className="mb-2 block">Chapter Level *</Label>
                <div className="grid grid-cols-3 gap-2">
                  {CHAPTER_LEVELS.map((l) => {
                    const Icon = l.icon;
                    const active = chapterLevel === l.value;
                    return (
                      <button
                        key={l.value}
                        type="button"
                        onClick={() => {
                          setChapterLevel(l.value);
                          setFormData((f) => ({ ...f, adhyayaParent: "", khandaParent: "" }));
                        }}
                        data-testid={`level-${l.value}`}
                        className={`flex flex-col items-center gap-1 p-3 rounded-lg border-2 text-sm font-medium transition-all ${
                          active
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-muted-foreground/40"
                        }`}
                      >
                        <Icon className={`w-4 h-4 ${active ? "text-primary" : "text-muted-foreground"}`} />
                        <span className={active ? "text-primary" : "text-foreground"}>{l.label}</span>
                        <span className="text-xs text-muted-foreground font-normal">{l.sublabel}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label>Chapter Title *</Label>
                  <Input
                    value={formData.ChapterTitle}
                    onChange={(e) => setFormData({ ...formData, ChapterTitle: e.target.value })}
                    placeholder="e.g., Adhyaya 1, Khanda 2, Shloka 1"
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

              <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <ChevronRight className="w-3.5 h-3.5" />
                  Hierarchy Placement
                </p>

                {/* ADHYAYA: belongs to a Grantha */}
                {chapterLevel === "adhyaya" && (
                  <div>
                    <Label className="text-sm">Grantha (Book) *</Label>
                    <Select
                      value={formData.grantha}
                      onValueChange={(val) =>
                        setFormData({ ...formData, grantha: val, adhyayaParent: "", khandaParent: "" })
                      }
                    >
                      <SelectTrigger className="mt-1.5" data-testid="select-grantha">
                        <SelectValue placeholder="Select Grantha" />
                      </SelectTrigger>
                      <SelectContent>
                        {allGranthas.map((g) => (
                          <SelectItem key={g.documentId} value={g.documentId}>
                            {g.GranthaName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* KHANDA: belongs to an Adhyaya (Grantha is inferred) */}
                {chapterLevel === "khanda" && (() => {
                  const allAdhyayas = flatTree.filter((f) => f.level === "adhyaya");
                  return (
                    <div>
                      <Label className="text-sm">Parent Adhyaya / Valli *</Label>
                      <Select
                        value={formData.adhyayaParent}
                        onValueChange={(val) =>
                          setFormData({ ...formData, adhyayaParent: val, khandaParent: "" })
                        }
                      >
                        <SelectTrigger className="mt-1.5" data-testid="select-adhyaya">
                          <SelectValue placeholder={allAdhyayas.length === 0 ? "No Adhyayas yet" : "Select Adhyaya / Valli"} />
                        </SelectTrigger>
                        <SelectContent>
                          {allAdhyayas.map((a) => {
                            const g = allGranthas.find((gr) => gr.documentId === a.granthaDocId);
                            return (
                              <SelectItem key={a.documentId} value={a.documentId}>
                                {a.ChapterTitle}{g ? ` — ${g.GranthaName}` : ""}
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground mt-1">
                        The Grantha will be automatically inferred from the selected Adhyaya.
                      </p>
                    </div>
                  );
                })()}

                {/* SHLOKA: belongs to a Khanda or directly to an Adhyaya */}
                {chapterLevel === "shloka" && (() => {
                  const allKhandas = flatTree.filter((f) => f.level === "khanda");
                  const allAdhyayas = flatTree.filter((f) => f.level === "adhyaya");
                  return (
                    <div>
                      <Label className="text-sm">Parent Chapter *</Label>
                      <Select
                        value={formData.khandaParent}
                        onValueChange={(val) => setFormData({ ...formData, khandaParent: val })}
                      >
                        <SelectTrigger className="mt-1.5" data-testid="select-shloka-parent">
                          <SelectValue placeholder="Select parent Khanda or Adhyaya" />
                        </SelectTrigger>
                        <SelectContent>
                          {allKhandas.length > 0 && (
                            <SelectGroup>
                              <SelectLabel>Khanda / Sub Chapter</SelectLabel>
                              {allKhandas.map((k) => {
                                const adhyaya = flatTree.find((f) => f.documentId === k.parentDocId);
                                const g = allGranthas.find((gr) => gr.documentId === k.granthaDocId || gr.documentId === adhyaya?.granthaDocId);
                                return (
                                  <SelectItem key={k.documentId} value={k.documentId}>
                                    {k.ChapterTitle}{adhyaya ? ` — ${adhyaya.ChapterTitle}` : ""}{g ? ` — ${g.GranthaName}` : ""}
                                  </SelectItem>
                                );
                              })}
                            </SelectGroup>
                          )}
                          {allAdhyayas.length > 0 && (
                            <SelectGroup>
                              <SelectLabel>Adhyaya / Valli (direct)</SelectLabel>
                              {allAdhyayas.map((a) => {
                                const g = allGranthas.find((gr) => gr.documentId === a.granthaDocId);
                                return (
                                  <SelectItem key={a.documentId} value={a.documentId}>
                                    {a.ChapterTitle}{g ? ` — ${g.GranthaName}` : ""}
                                  </SelectItem>
                                );
                              })}
                            </SelectGroup>
                          )}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground mt-1">
                        Prefer selecting a Khanda / Sub Chapter. Choose Adhyaya directly only if no Khanda exists for this text.
                      </p>
                    </div>
                  );
                })()}

                {/* Path preview */}
                {(() => {
                  let granthaName = "";
                  let parentNames: string[] = [];
                  if (chapterLevel === "adhyaya") {
                    granthaName = allGranthas.find((g) => g.documentId === formData.grantha)?.GranthaName || "";
                  } else if (chapterLevel === "khanda" && formData.adhyayaParent) {
                    const adhyaya = flatTree.find((f) => f.documentId === formData.adhyayaParent);
                    granthaName = allGranthas.find((g) => g.documentId === adhyaya?.granthaDocId)?.GranthaName || "";
                    if (adhyaya) parentNames = [adhyaya.ChapterTitle];
                  } else if (chapterLevel === "shloka" && formData.khandaParent) {
                    const parent = flatTree.find((f) => f.documentId === formData.khandaParent);
                    if (parent?.level === "khanda") {
                      const adhyaya = flatTree.find((f) => f.documentId === parent.parentDocId);
                      granthaName = allGranthas.find((g) => g.documentId === (parent.granthaDocId || adhyaya?.granthaDocId))?.GranthaName || "";
                      parentNames = [adhyaya?.ChapterTitle || "Adhyaya", parent.ChapterTitle];
                    } else if (parent) {
                      granthaName = allGranthas.find((g) => g.documentId === parent.granthaDocId)?.GranthaName || "";
                      parentNames = [parent.ChapterTitle];
                    }
                  }
                  return (
                    <div className="text-xs text-muted-foreground bg-muted/40 rounded px-3 py-2 flex items-center gap-1 flex-wrap">
                      <span className="font-medium">Path:</span>
                      {granthaName ? <span>{granthaName}</span> : <span className="italic">Grantha</span>}
                      {parentNames.map((n, i) => (
                        <span key={i} className="flex items-center gap-1">
                          <ChevronRight className="w-3 h-3" />
                          {n}
                        </span>
                      ))}
                      <ChevronRight className="w-3 h-3" />
                      <span className="font-medium text-primary">{formData.ChapterTitle || "This Chapter"}</span>
                    </div>
                  );
                })()}
              </div>

              <TextTranslationFields
                title="Shloka / Manthra Entry"
                value={formData.ShlokaManthraEntry}
                onChange={(val) => setFormData({ ...formData, ShlokaManthraEntry: val })}
                testIdPrefix="chapter-shloka"
              />

              <TextTranslationFields
                title="Bhashyam for Shloka / Manthra"
                value={formData.BhashyamForShlokaManthra}
                onChange={(val) => setFormData({ ...formData, BhashyamForShlokaManthra: val })}
                testIdPrefix="chapter-bhashyam"
              />

              <BhashyaEntryFields
                title="Teekas (Commentaries)"
                entries={formData.Teekas}
                onChange={(entries) => setFormData({ ...formData, Teekas: entries })}
                testIdPrefix="chapter-teeka"
              />

              <div className="flex justify-end gap-3 pt-2">
                <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
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
              <AlertDialogTitle>
                Delete {deleteTarget?._isDraft ? "Draft" : "Chapter"}
              </AlertDialogTitle>
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

        <Dialog open={!!viewingItem} onOpenChange={() => setViewingItem(null)}>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            {viewingItem && <ChapterViewPanel item={viewingItem} allGranthas={allGranthas} flatTree={flatTree} levelInfo={levelInfo} onClose={() => setViewingItem(null)} onEdit={() => { setViewingItem(null); openEdit(viewingItem); }} />}
          </DialogContent>
        </Dialog>
    </div>
  );
}
