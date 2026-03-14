import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useDrafts } from "@/hooks/use-drafts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  granthaTypes,
  bhashyamAuthors,
  teekaAuthors,
  translationLanguages,
  type StrapiGrantha,
  type StrapiResponse,
} from "@shared/schema";
import { blocksToText, textToBlocks } from "@/lib/strapi-blocks";
import StrapiSyncBar from "@/components/strapi-sync-bar";
import { STRAPI_POLL_INTERVAL } from "@/hooks/use-strapi-sync";
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
  FileText,
} from "lucide-react";

// ---------- Local Types ----------

interface TeekaDefinition {
  id: string;
  TeekaName: string;
  TeekaAuthor: string;
}

interface OtherTranslationEntry {
  id: string;
  language: string;
  text: string;
}

interface GranthaNameTranslationEntry {
  id: string;
  language: string;
  name: string;
}

interface ManthraTeekaEntry {
  TeekaName: string;
  TeekaAuthor: string;
  TeekaEntry?: {
    SanskritTextEntry?: string;
    EnglishTranslationText?: string;
  };
}

interface ManthraNode {
  id: string;
  title: string;
  order: number;
  ShlokaManthraEntry?: {
    SanskritTextEntry?: string;
    EnglishTranslationText?: string;
  };
  BhashyamForShlokaManthra?: {
    SanskritTextEntry?: string;
    EnglishTranslationText?: string;
  };
  Teekas?: ManthraTeekaEntry[];
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

function hasManthraContent(m: ManthraNode) {
  return !!(
    m.ShlokaManthraEntry?.SanskritTextEntry ||
    m.ShlokaManthraEntry?.EnglishTranslationText ||
    m.BhashyamForShlokaManthra?.SanskritTextEntry ||
    m.Teekas?.some((t) => t.TeekaEntry?.SanskritTextEntry)
  );
}

// ---------- Grantha Card ----------

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

// ---------- Step Indicator ----------

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

  const [view, setView] = useState<"list" | "form">("list");
  const [step, setStep] = useState<1 | 2>(1);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [editingDraftId, setEditingDraftId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);

  // Step 1
  const [formData, setFormData] = useState({
    GranthaName: "",
    GranthaType: "",
    BhashyamName: "",
    BhashyamAuthor: "",
    IntroductionToTextEnglish: "",
    BhashyakaraIntroductionSanskrit: "",
    BhashyakaraIntroductionEnglish: "",
    BhashyakaraIntroductionIAST: "",
    slug: "",
    order: "",
    introVideoId: "",
    introVideoTitle: "",
  });
  const [teekas, setTeekas] = useState<TeekaDefinition[]>([]);
  const [otherTranslations, setOtherTranslations] = useState<OtherTranslationEntry[]>([]);
  const [granthaNameTranslations, setGranthaNameTranslations] = useState<GranthaNameTranslationEntry[]>([]);

  // Step 2
  const [adhyayas, setAdhyayas] = useState<AdhyayaNode[]>([]);

  // Manthra content dialog
  const [editingManthra, setEditingManthra] = useState<{
    adhyayaId: string;
    khandaId: string;
    manthraId: string;
  } | null>(null);

  // Data
  const { data, isLoading } = useQuery<StrapiResponse<StrapiGrantha>>({
    queryKey: ["/api/strapi", "granthas"],
    refetchInterval: STRAPI_POLL_INTERVAL,
    refetchOnWindowFocus: true,
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

  // ---------- Helpers ----------

  const EMPTY_FORM = {
    GranthaName: "",
    GranthaType: "",
    BhashyamName: "",
    BhashyamAuthor: "",
    IntroductionToTextEnglish: "",
    BhashyakaraIntroductionSanskrit: "",
    BhashyakaraIntroductionEnglish: "",
    BhashyakaraIntroductionIAST: "",
    slug: "",
    order: "",
    introVideoId: "",
    introVideoTitle: "",
  };

  function resetForm() {
    setFormData(EMPTY_FORM);
    setTeekas([]);
    setOtherTranslations([]);
    setGranthaNameTranslations([]);
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
        IntroductionToTextEnglish: blocksToText(d.IntroductionToTextEnglish) || "",
        BhashyakaraIntroductionSanskrit:
          blocksToText(d.BhashyakaraIntroduction?.SanskritTextEntry) || "",
        BhashyakaraIntroductionEnglish:
          blocksToText(d.BhashyakaraIntroduction?.EnglishTranslationText) || "",
        BhashyakaraIntroductionIAST:
          blocksToText(d.BhashyakaraIntroduction?.IASTTransliteration) || "",
        slug: d.slug || "",
        order: d.order != null ? String(d.order) : "",
        introVideoId: d.introVideoId || "",
        introVideoTitle: d.introVideoTitle || "",
      });
      setTeekas(d.teekas || []);
      setOtherTranslations(d.otherTranslations || []);
      setGranthaNameTranslations(d.granthaNameTranslations || []);
      setAdhyayas(d.hierarchy || []);
    } else {
      setEditingDraftId(null);
      setFormData({
        GranthaName: item.GranthaName || "",
        GranthaType: item.GranthaType || "",
        BhashyamName: item.BhashyamName || "",
        BhashyamAuthor: item.BhashyamAuthor || "",
        IntroductionToTextEnglish: blocksToText(item.IntroductionToTextEnglish) || "",
        BhashyakaraIntroductionSanskrit:
          blocksToText(item.BhashyakaraIntroduction?.SanskritTextEntry) || "",
        BhashyakaraIntroductionEnglish:
          blocksToText(item.BhashyakaraIntroduction?.EnglishTranslationText) || "",
        BhashyakaraIntroductionIAST:
          blocksToText(item.BhashyakaraIntroduction?.IASTTransliteration) || "",
        slug: item.slug || "",
        order: item.order != null ? String(item.order) : "",
        introVideoId: item.introVideoId || "",
        introVideoTitle: item.introVideoTitle || "",
      });
      setOtherTranslations(
        Array.isArray(item.BhashyakaraIntroduction?.OtherTranslations)
          ? item.BhashyakaraIntroduction.OtherTranslations.map((t: any) => ({
              id: uid(),
              language: t.LanguageOfTranslation || "",
              text: blocksToText(t.OtherLanguagesTranslation) || "",
            }))
          : []
      );
      setGranthaNameTranslations(
        Array.isArray(item.GranthaNameTranslations)
          ? item.GranthaNameTranslations.map((t: any) => ({
              id: uid(),
              language: t.LanguageOfTranslation || "",
              name: t.GranthaNameTranslation || t.name || "",
            }))
          : []
      );
      setTeekas([]);
      setAdhyayas([]);
    }
    setStep(1);
    setView("form");
  }

  // ---------- Teeka handlers ----------

  function addTeeka() {
    setTeekas([...teekas, { id: uid(), TeekaName: "", TeekaAuthor: "" }]);
  }

  function updateTeeka(id: string, field: keyof Omit<TeekaDefinition, "id">, value: string) {
    setTeekas(teekas.map((t) => (t.id === id ? { ...t, [field]: value } : t)));
  }

  function removeTeeka(id: string) {
    setTeekas(teekas.filter((t) => t.id !== id));
  }

  // ---------- OtherTranslations handlers ----------

  function addOtherTranslation() {
    setOtherTranslations([...otherTranslations, { id: uid(), language: "", text: "" }]);
  }

  function updateOtherTranslation(id: string, field: keyof Omit<OtherTranslationEntry, "id">, value: string) {
    setOtherTranslations(otherTranslations.map((t) => (t.id === id ? { ...t, [field]: value } : t)));
  }

  function removeOtherTranslation(id: string) {
    setOtherTranslations(otherTranslations.filter((t) => t.id !== id));
  }

  // ---------- GranthaNameTranslations handlers ----------

  function addGranthaNameTranslation() {
    setGranthaNameTranslations([...granthaNameTranslations, { id: uid(), language: "", name: "" }]);
  }

  function updateGranthaNameTranslation(id: string, field: keyof Omit<GranthaNameTranslationEntry, "id">, value: string) {
    setGranthaNameTranslations(granthaNameTranslations.map((t) => (t.id === id ? { ...t, [field]: value } : t)));
  }

  function removeGranthaNameTranslation(id: string) {
    setGranthaNameTranslations(granthaNameTranslations.filter((t) => t.id !== id));
  }

  // ---------- Hierarchy handlers ----------

  function addAdhyaya() {
    const n = adhyayas.length + 1;
    setAdhyayas([
      ...adhyayas,
      { id: uid(), title: `${ordinal(n)} Adhyaya (Chapter ${n})`, order: n, khandas: [], expanded: true },
    ]);
  }

  function updateAdhyaya(id: string, title: string) {
    setAdhyayas(adhyayas.map((a) => (a.id === id ? { ...a, title } : a)));
  }

  function removeAdhyaya(id: string) {
    setAdhyayas(adhyayas.filter((a) => a.id !== id));
  }

  function toggleAdhyaya(id: string) {
    setAdhyayas(adhyayas.map((a) => (a.id === id ? { ...a, expanded: !a.expanded } : a)));
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
            { id: uid(), title: `${ordinal(n)} Khanda (Section ${n})`, order: n, manthras: [], expanded: true },
          ],
        };
      })
    );
  }

  function updateKhanda(adhyayaId: string, khandaId: string, title: string) {
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        return { ...a, khandas: a.khandas.map((k) => (k.id === khandaId ? { ...k, title } : k)) };
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
            const newManthra: ManthraNode = {
              id: uid(),
              title: `Manthra ${aIdx}.${kIdx}.${mIdx}`,
              order: mIdx,
              // Pre-populate Teekas from Step 1 definitions
              Teekas: teekas.map((t) => ({
                TeekaName: t.TeekaName,
                TeekaAuthor: t.TeekaAuthor,
              })),
            };
            return { ...k, manthras: [...k.manthras, newManthra] };
          }),
        };
      })
    );
  }

  function removeManthra(adhyayaId: string, khandaId: string, manthraId: string) {
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        return {
          ...a,
          khandas: a.khandas.map((k) => {
            if (k.id !== khandaId) return k;
            return { ...k, manthras: k.manthras.filter((m) => m.id !== manthraId) };
          }),
        };
      })
    );
  }

  function updateManthraContent(
    adhyayaId: string,
    khandaId: string,
    manthraId: string,
    updates: Partial<ManthraNode>
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
              manthras: k.manthras.map((m) =>
                m.id === manthraId ? { ...m, ...updates } : m
              ),
            };
          }),
        };
      })
    );
  }

  // Get the currently edited manthra object
  const currentManthra: ManthraNode | null = (() => {
    if (!editingManthra) return null;
    const a = adhyayas.find((x) => x.id === editingManthra.adhyayaId);
    const k = a?.khandas.find((x) => x.id === editingManthra.khandaId);
    return k?.manthras.find((x) => x.id === editingManthra.manthraId) ?? null;
  })();

  // ---------- Save / Delete / Publish ----------

  function handleSaveAndExit() {
    if (!formData.GranthaName.trim()) {
      toast({ variant: "destructive", title: "Grantha Name is required" });
      return;
    }

    const payload: Record<string, any> = {
      GranthaName: formData.GranthaName,
      GranthaType: formData.GranthaType || undefined,
      BhashyamName: formData.BhashyamName || undefined,
      BhashyamAuthor: formData.BhashyamAuthor || undefined,
      teekas,
      otherTranslations,
      granthaNameTranslations,
      hierarchy: adhyayas,
    };

    if (formData.slug.trim()) payload.slug = formData.slug.trim();
    if (formData.order.trim()) {
      const n = parseInt(formData.order, 10);
      if (!isNaN(n)) payload.order = n;
    }
    if (formData.introVideoId.trim()) payload.introVideoId = formData.introVideoId.trim();
    if (formData.introVideoTitle.trim()) payload.introVideoTitle = formData.introVideoTitle.trim();

    if (formData.IntroductionToTextEnglish.trim()) {
      payload.IntroductionToTextEnglish = textToBlocks(formData.IntroductionToTextEnglish);
    }

    if (
      formData.BhashyakaraIntroductionSanskrit.trim() ||
      formData.BhashyakaraIntroductionEnglish.trim() ||
      formData.BhashyakaraIntroductionIAST.trim() ||
      otherTranslations.length > 0
    ) {
      payload.BhashyakaraIntroduction = {
        ...(formData.BhashyakaraIntroductionSanskrit.trim()
          ? { SanskritTextEntry: textToBlocks(formData.BhashyakaraIntroductionSanskrit) }
          : {}),
        ...(formData.BhashyakaraIntroductionEnglish.trim()
          ? { EnglishTranslationText: textToBlocks(formData.BhashyakaraIntroductionEnglish) }
          : {}),
        ...(formData.BhashyakaraIntroductionIAST.trim()
          ? { IASTTransliteration: textToBlocks(formData.BhashyakaraIntroductionIAST) }
          : {}),
        ...(otherTranslations.length > 0
          ? {
              OtherTranslations: otherTranslations.map((t) => ({
                LanguageOfTranslation: t.language,
                OtherLanguagesTranslation: t.text.trim() ? textToBlocks(t.text) : undefined,
              })),
            }
          : {}),
      };
    }

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

  // Collect which Strapi documentIds are currently being edited by a draft
  // so we can hide the "published" card and only show the draft.
  const draftedStrapiIds = new Set(
    unpublishedDrafts.map((d) => d.strapiDocumentId).filter(Boolean) as string[]
  );

  // Deduplicate drafts by Grantha name — keep only the most recently updated
  // one per name so the list doesn't show multiple Draft cards for the same text.
  const seenDraftNames = new Set<string>();
  const deduplicatedDrafts = [...unpublishedDrafts]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .filter((d) => {
      const name = ((d.data as any)?.GranthaName ?? "").toLowerCase().trim() || String(d.id);
      if (seenDraftNames.has(name)) return false;
      seenDraftNames.add(name);
      return true;
    });

  const mergedData = [
    ...deduplicatedDrafts.map((d) => ({
      ...(d.data as any),
      _isDraft: true,
      _draftId: d.id,
      _draftStatus: d.status,
      _strapiDocId: d.strapiDocumentId,
      _draftData: d.data,
    })),
    // Suppress published Strapi entry when a local draft is editing it
    ...(data?.data || [])
      .filter((item) => !draftedStrapiIds.has(item.documentId))
      .map((item) => ({
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
          <div className="flex items-center gap-3">
            <StrapiSyncBar />
            <Button onClick={openAdd} data-testid="button-new-grantha">
              <Plus className="w-4 h-4 mr-2" />
              New Entry
            </Button>
          </div>
        </div>

        {isLoading || isLoadingDrafts ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="rounded-xl border bg-card p-5 h-36 animate-pulse" />
            ))}
          </div>
        ) : mergedData.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-muted-foreground gap-4">
            <BookOpen className="w-14 h-14 opacity-20" />
            <p className="text-sm">No granthas yet — create your first entry.</p>
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
                onDelete={() => setDeleteTarget(item)}
                onPublish={() => handlePublish(item)}
                isPublishing={
                  publishDraft.isPending &&
                  (publishDraft.variables as number) === item._draftId
                }
              />
            ))}
          </div>
        )}

        <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Delete {deleteTarget?._isDraft ? "Draft" : "Grantha"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete &quot;{deleteTarget?.GranthaName}&quot;?
                {!deleteTarget?._isDraft && " This will remove it from the CMS."}
                {deleteTarget?._isDraft && " This draft has not been published yet."}
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

  // ---------- Render: Form ----------

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto">
      {/* Step indicator */}
      <div className="flex items-end gap-0 mb-10">
        <StepDot n={1} active={step === 1} done={step > 1} label="Configuration" />
        <div className={`flex-1 h-0.5 mb-5 transition-colors ${step > 1 ? "bg-primary" : "bg-border"}`} />
        <StepDot n={2} active={step === 2} done={false} label="Build Hierarchy" />
      </div>

      {step === 1 ? (
        /* ====== STEP 1 ====== */
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
                onChange={(e) => setFormData({ ...formData, GranthaName: e.target.value })}
                placeholder="e.g., Chandogya Upanishad"
                className="mt-1.5"
                data-testid="input-grantha-name"
              />
            </div>
            <div>
              <Label>Grantha Type</Label>
              <Select
                value={formData.GranthaType}
                onValueChange={(val) => setFormData({ ...formData, GranthaType: val })}
              >
                <SelectTrigger className="mt-1.5" data-testid="select-grantha-type">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {granthaTypes.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Bhashyam Name</Label>
              <Input
                value={formData.BhashyamName}
                onChange={(e) => setFormData({ ...formData, BhashyamName: e.target.value })}
                placeholder="e.g., Chandogya Bhashyam"
                className="mt-1.5"
                data-testid="input-bhashyam-name"
              />
            </div>
            <div>
              <Label>Bhashyam Author</Label>
              <Select
                value={formData.BhashyamAuthor}
                onValueChange={(val) => setFormData({ ...formData, BhashyamAuthor: val })}
              >
                <SelectTrigger className="mt-1.5" data-testid="select-bhashyam-author">
                  <SelectValue placeholder="Select author" />
                </SelectTrigger>
                <SelectContent>
                  {bhashyamAuthors.map((a) => (
                    <SelectItem key={a} value={a}>{a}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Introductions */}
          <div className="border rounded-xl p-5 space-y-4">
            <div>
              <h3 className="font-semibold">Introductions</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                English introduction to the text and the Bhashyakara's introduction in Sanskrit &amp; English
              </p>
            </div>

            <div>
              <Label>Introduction to Text (English)</Label>
              <Textarea
                value={formData.IntroductionToTextEnglish}
                onChange={(e) =>
                  setFormData({ ...formData, IntroductionToTextEnglish: e.target.value })
                }
                placeholder="Brief English introduction to this Grantha..."
                rows={4}
                className="mt-1.5"
                data-testid="textarea-introduction-english"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t">
              <div>
                <Label className="flex items-center gap-1.5">
                  Bhashyakara Introduction
                  <span className="text-xs text-muted-foreground font-normal">(Sanskrit)</span>
                </Label>
                <Textarea
                  value={formData.BhashyakaraIntroductionSanskrit}
                  onChange={(e) =>
                    setFormData({ ...formData, BhashyakaraIntroductionSanskrit: e.target.value })
                  }
                  placeholder="Sanskrit commentary introduction..."
                  rows={5}
                  className="mt-1.5 font-serif"
                  data-testid="textarea-bhashyakara-sanskrit"
                />
              </div>
              <div>
                <Label className="flex items-center gap-1.5">
                  Bhashyakara Introduction
                  <span className="text-xs text-muted-foreground font-normal">(English)</span>
                </Label>
                <Textarea
                  value={formData.BhashyakaraIntroductionEnglish}
                  onChange={(e) =>
                    setFormData({ ...formData, BhashyakaraIntroductionEnglish: e.target.value })
                  }
                  placeholder="English translation of commentary introduction..."
                  rows={5}
                  className="mt-1.5"
                  data-testid="textarea-bhashyakara-english"
                />
              </div>
            </div>

            {/* IAST Transliteration */}
            <div className="pt-2 border-t">
              <Label className="flex items-center gap-1.5">
                Bhashyakara Introduction
                <span className="text-xs text-muted-foreground font-normal">(IAST Romanisation)</span>
              </Label>
              <Textarea
                value={formData.BhashyakaraIntroductionIAST}
                onChange={(e) =>
                  setFormData({ ...formData, BhashyakaraIntroductionIAST: e.target.value })
                }
                placeholder="IAST transliteration of the commentary introduction..."
                rows={4}
                className="mt-1.5 font-mono text-sm"
                data-testid="textarea-bhashyakara-iast"
              />
            </div>

            {/* Other Language Translations (repeatable) */}
            <div className="pt-2 border-t">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <Label>Other Language Translations</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Translations of the Bhashyakara Introduction in other languages
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={addOtherTranslation}
                  data-testid="button-add-other-translation"
                >
                  <Plus className="w-3.5 h-3.5 mr-1.5" />
                  Add Translation
                </Button>
              </div>

              {otherTranslations.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No other translations added yet
                </p>
              ) : (
                <div className="space-y-3">
                  {otherTranslations.map((t, i) => (
                    <div
                      key={t.id}
                      className="p-3 bg-muted/40 rounded-lg space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <Select
                          value={t.language}
                          onValueChange={(val) => updateOtherTranslation(t.id, "language", val)}
                        >
                          <SelectTrigger
                            className="h-8 text-sm w-48"
                            data-testid={`select-other-translation-language-${i}`}
                          >
                            <SelectValue placeholder="Select language" />
                          </SelectTrigger>
                          <SelectContent>
                            {translationLanguages.map((l) => (
                              <SelectItem key={l} value={l}>{l}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          onClick={() => removeOtherTranslation(t.id)}
                          data-testid={`button-remove-other-translation-${i}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                      <Textarea
                        value={t.text}
                        onChange={(e) => updateOtherTranslation(t.id, "text", e.target.value)}
                        placeholder="Translation text..."
                        rows={3}
                        className="text-sm"
                        data-testid={`textarea-other-translation-text-${i}`}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Teeka Management */}
          <div className="border rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold">Teeka Management</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Define commentary works associated with this Grantha
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={addTeeka} data-testid="button-add-teeka">
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
                          onChange={(e) => updateTeeka(teeka.id, "TeekaName", e.target.value)}
                          placeholder="e.g., Nyaya-Nirnaya"
                          className="mt-1 h-8 text-sm"
                          data-testid={`input-teeka-name-${i}`}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Author</Label>
                        <Select
                          value={teeka.TeekaAuthor}
                          onValueChange={(val) => updateTeeka(teeka.id, "TeekaAuthor", val)}
                        >
                          <SelectTrigger className="mt-1 h-8 text-sm" data-testid={`select-teeka-author-${i}`}>
                            <SelectValue placeholder="Select author" />
                          </SelectTrigger>
                          <SelectContent>
                            {teekaAuthors.map((a) => (
                              <SelectItem key={a} value={a}>{a}</SelectItem>
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

          {/* Grantha Name Translations (repeatable) */}
          <div className="border rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold">Grantha Name Translations</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Name of the Grantha in other languages
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={addGranthaNameTranslation}
                data-testid="button-add-grantha-name-translation"
              >
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                Add Translation
              </Button>
            </div>

            {granthaNameTranslations.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No Grantha name translations added yet
              </p>
            ) : (
              <div className="space-y-3">
                {granthaNameTranslations.map((t, i) => (
                  <div
                    key={t.id}
                    className="flex gap-3 items-start p-3 bg-muted/40 rounded-lg"
                  >
                    <span className="text-xs font-semibold text-muted-foreground mt-2.5 w-5 shrink-0 text-center">
                      {i + 1}
                    </span>
                    <div className="flex-1 grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs">Language</Label>
                        <Select
                          value={t.language}
                          onValueChange={(val) => updateGranthaNameTranslation(t.id, "language", val)}
                        >
                          <SelectTrigger
                            className="mt-1 h-8 text-sm"
                            data-testid={`select-grantha-name-language-${i}`}
                          >
                            <SelectValue placeholder="Select language" />
                          </SelectTrigger>
                          <SelectContent>
                            {translationLanguages.map((l) => (
                              <SelectItem key={l} value={l}>{l}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-xs">Translated Name</Label>
                        <Input
                          value={t.name}
                          onChange={(e) => updateGranthaNameTranslation(t.id, "name", e.target.value)}
                          placeholder="Name in the selected language..."
                          className="mt-1 h-8 text-sm"
                          data-testid={`input-grantha-name-translation-${i}`}
                        />
                      </div>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="shrink-0 h-8 w-8 text-destructive hover:text-destructive mt-0.5"
                      onClick={() => removeGranthaNameTranslation(t.id)}
                      data-testid={`button-remove-grantha-name-translation-${i}`}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Additional Details */}
          <div className="border rounded-xl p-5 space-y-4">
            <div>
              <h3 className="font-semibold">Additional Details</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                SEO slug, display order, and intro video information
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>Slug</Label>
                <Input
                  value={formData.slug}
                  onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
                  placeholder="e.g., chandogya-upanishad"
                  className="mt-1.5"
                  data-testid="input-slug"
                />
              </div>
              <div>
                <Label>Display Order</Label>
                <Input
                  type="number"
                  value={formData.order}
                  onChange={(e) => setFormData({ ...formData, order: e.target.value })}
                  placeholder="e.g., 1"
                  className="mt-1.5"
                  data-testid="input-order"
                />
              </div>
              <div>
                <Label>Intro Video ID</Label>
                <Input
                  value={formData.introVideoId}
                  onChange={(e) => setFormData({ ...formData, introVideoId: e.target.value })}
                  placeholder="YouTube or Vimeo video ID..."
                  className="mt-1.5"
                  data-testid="input-intro-video-id"
                />
              </div>
              <div>
                <Label>Intro Video Title</Label>
                <Input
                  value={formData.introVideoTitle}
                  onChange={(e) => setFormData({ ...formData, introVideoTitle: e.target.value })}
                  placeholder="Title of the intro video..."
                  className="mt-1.5"
                  data-testid="input-intro-video-title"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-between items-center pt-2">
            <Button
              variant="outline"
              onClick={() => { setView("list"); resetForm(); }}
              data-testid="button-cancel"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!formData.GranthaName.trim()) {
                  toast({ variant: "destructive", title: "Grantha Name is required" });
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
        /* ====== STEP 2 ====== */
        <div className="space-y-6">
          <div>
            <h2 className="text-xl font-semibold">
              {formData.GranthaName || "Grantha"} Hierarchy
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              Adhyaya → Khanda → Manthra — click any Manthra to enter its text content
            </p>
          </div>

          {/* Tree */}
          <div className="space-y-3">
            {adhyayas.map((adhyaya, aIdx) => (
              <div key={adhyaya.id} className="border rounded-xl overflow-hidden" data-testid={`adhyaya-${aIdx}`}>
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
                    onChange={(e) => { e.stopPropagation(); updateAdhyaya(adhyaya.id, e.target.value); }}
                    onClick={(e) => e.stopPropagation()}
                    className="h-8 text-sm font-medium border-0 bg-transparent shadow-none focus-visible:ring-1 focus-visible:ring-primary/50 px-2"
                    data-testid={`input-adhyaya-title-${aIdx}`}
                  />
                  <div className="flex items-center gap-1 ml-auto shrink-0">
                    <span className="text-xs text-muted-foreground mr-1">
                      {adhyaya.khandas.length} khanda{adhyaya.khandas.length !== 1 ? "s" : ""}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={(e) => { e.stopPropagation(); removeAdhyaya(adhyaya.id); }}
                      data-testid={`button-remove-adhyaya-${aIdx}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                    {adhyaya.expanded
                      ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
                      : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                  </div>
                </div>

                {/* Khandas */}
                {adhyaya.expanded && (
                  <div className="p-4 space-y-2.5">
                    {adhyaya.khandas.map((khanda, kIdx) => (
                      <div key={khanda.id} className="border rounded-lg overflow-hidden" data-testid={`khanda-${aIdx}-${kIdx}`}>
                        {/* Khanda row */}
                        <div
                          className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer select-none hover:bg-muted/20"
                          onClick={() => toggleKhanda(adhyaya.id, khanda.id)}
                        >
                          <Layers className="w-4 h-4 text-muted-foreground shrink-0" />
                          <Input
                            value={khanda.title}
                            onChange={(e) => { e.stopPropagation(); updateKhanda(adhyaya.id, khanda.id, e.target.value); }}
                            onClick={(e) => e.stopPropagation()}
                            className="h-7 text-sm border-0 bg-transparent shadow-none focus-visible:ring-1 focus-visible:ring-primary/50 px-1.5"
                            data-testid={`input-khanda-title-${aIdx}-${kIdx}`}
                          />
                          <div className="flex items-center gap-1 ml-auto shrink-0">
                            <span className="text-xs text-muted-foreground">
                              {khanda.manthras.length} manthra{khanda.manthras.length !== 1 ? "s" : ""}
                            </span>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6 text-destructive hover:text-destructive"
                              onClick={(e) => { e.stopPropagation(); removeKhanda(adhyaya.id, khanda.id); }}
                              data-testid={`button-remove-khanda-${aIdx}-${kIdx}`}
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                            {khanda.expanded
                              ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                              : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
                          </div>
                        </div>

                        {/* Manthras */}
                        {khanda.expanded && (
                          <div className="px-4 pt-2 pb-3 border-t bg-muted/10">
                            <p className="text-xs font-medium text-muted-foreground mb-2">
                              Manage Manthras
                            </p>
                            <div className="space-y-1">
                              {khanda.manthras.map((manthra, mIdx) => {
                                const hasContent = hasManthraContent(manthra);
                                return (
                                  <div
                                    key={manthra.id}
                                    className="flex items-center gap-2 group py-0.5"
                                  >
                                    <Hash className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                    <span className="text-sm flex-1">{manthra.title}</span>
                                    {hasContent && (
                                      <span
                                        className="text-xs text-primary font-medium"
                                        title="Has content"
                                      >
                                        <FileText className="w-3.5 h-3.5" />
                                      </span>
                                    )}
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                                      onClick={() => setEditingManthra({ adhyayaId: adhyaya.id, khandaId: khanda.id, manthraId: manthra.id })}
                                      data-testid={`button-edit-manthra-${aIdx}-${kIdx}-${mIdx}`}
                                      title="Enter text content"
                                    >
                                      <Pencil className="w-3 h-3" />
                                    </Button>
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive"
                                      onClick={() => removeManthra(adhyaya.id, khanda.id, manthra.id)}
                                      data-testid={`button-remove-manthra-${aIdx}-${kIdx}-${mIdx}`}
                                    >
                                      <X className="w-3 h-3" />
                                    </Button>
                                  </div>
                                );
                              })}
                              <Button
                                size="sm"
                                variant="ghost"
                                className="w-full justify-start text-muted-foreground hover:text-foreground text-xs h-7 mt-1 pl-0"
                                onClick={() => addManthra(adhyaya.id, khanda.id)}
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
            <Button variant="outline" onClick={() => setStep(1)} data-testid="button-back">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back
            </Button>
            <Button onClick={handleSaveAndExit} disabled={saveDraft.isPending} data-testid="button-save-exit">
              {saveDraft.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Save & Exit
            </Button>
          </div>
        </div>
      )}

      {/* Manthra content dialog */}
      <Dialog
        open={!!editingManthra}
        onOpenChange={(open) => { if (!open) setEditingManthra(null); }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{currentManthra?.title ?? "Manthra"}</DialogTitle>
            <DialogDescription>
              Enter the Sanskrit text and translations. These fields map directly to the CMS chapter record.
            </DialogDescription>
          </DialogHeader>

          {currentManthra && editingManthra && (
            <div className="space-y-5 pt-1">
              {/* Shloka / Manthra Text */}
              <section className="space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-2">
                  <Hash className="w-4 h-4 text-primary" />
                  Shloka / Manthra Text
                  <span className="text-xs text-muted-foreground font-normal">(ShlokaManthraEntry)</span>
                </h4>
                <div>
                  <Label className="text-xs">Sanskrit (Devanagari)</Label>
                  <Textarea
                    value={currentManthra.ShlokaManthraEntry?.SanskritTextEntry ?? ""}
                    onChange={(e) =>
                      updateManthraContent(
                        editingManthra.adhyayaId,
                        editingManthra.khandaId,
                        editingManthra.manthraId,
                        {
                          ShlokaManthraEntry: {
                            ...currentManthra.ShlokaManthraEntry,
                            SanskritTextEntry: e.target.value,
                          },
                        }
                      )
                    }
                    placeholder="Sanskrit text in Devanagari..."
                    rows={3}
                    className="mt-1.5 font-serif"
                    data-testid="textarea-shloka-sanskrit"
                  />
                </div>
                <div>
                  <Label className="text-xs">English Translation</Label>
                  <Textarea
                    value={currentManthra.ShlokaManthraEntry?.EnglishTranslationText ?? ""}
                    onChange={(e) =>
                      updateManthraContent(
                        editingManthra.adhyayaId,
                        editingManthra.khandaId,
                        editingManthra.manthraId,
                        {
                          ShlokaManthraEntry: {
                            ...currentManthra.ShlokaManthraEntry,
                            EnglishTranslationText: e.target.value,
                          },
                        }
                      )
                    }
                    placeholder="English translation..."
                    rows={3}
                    className="mt-1.5"
                    data-testid="textarea-shloka-english"
                  />
                </div>
              </section>

              {/* Bhashyam */}
              <section className="space-y-3 border-t pt-4">
                <h4 className="text-sm font-semibold flex items-center gap-2">
                  <FileText className="w-4 h-4 text-primary" />
                  Bhashyam for this Manthra
                  <span className="text-xs text-muted-foreground font-normal">(BhashyamForShlokaManthra)</span>
                </h4>
                <div>
                  <Label className="text-xs">Sanskrit Commentary</Label>
                  <Textarea
                    value={currentManthra.BhashyamForShlokaManthra?.SanskritTextEntry ?? ""}
                    onChange={(e) =>
                      updateManthraContent(
                        editingManthra.adhyayaId,
                        editingManthra.khandaId,
                        editingManthra.manthraId,
                        {
                          BhashyamForShlokaManthra: {
                            ...currentManthra.BhashyamForShlokaManthra,
                            SanskritTextEntry: e.target.value,
                          },
                        }
                      )
                    }
                    placeholder="Sanskrit bhashyam commentary..."
                    rows={4}
                    className="mt-1.5 font-serif"
                    data-testid="textarea-bhashyam-sanskrit"
                  />
                </div>
                <div>
                  <Label className="text-xs">English Translation</Label>
                  <Textarea
                    value={currentManthra.BhashyamForShlokaManthra?.EnglishTranslationText ?? ""}
                    onChange={(e) =>
                      updateManthraContent(
                        editingManthra.adhyayaId,
                        editingManthra.khandaId,
                        editingManthra.manthraId,
                        {
                          BhashyamForShlokaManthra: {
                            ...currentManthra.BhashyamForShlokaManthra,
                            EnglishTranslationText: e.target.value,
                          },
                        }
                      )
                    }
                    placeholder="English translation of bhashyam..."
                    rows={4}
                    className="mt-1.5"
                    data-testid="textarea-bhashyam-english"
                  />
                </div>
              </section>

              {/* Teekas */}
              {(currentManthra.Teekas ?? []).length > 0 && (
                <section className="space-y-3 border-t pt-4">
                  <h4 className="text-sm font-semibold flex items-center gap-2">
                    <Layers className="w-4 h-4 text-primary" />
                    Teeka Entries
                    <span className="text-xs text-muted-foreground font-normal">(Teekas)</span>
                  </h4>
                  {(currentManthra.Teekas ?? []).map((teeka, tIdx) => (
                    <div key={tIdx} className="rounded-lg border p-4 space-y-3">
                      <p className="text-xs font-semibold text-foreground">
                        {teeka.TeekaName || `Teeka ${tIdx + 1}`}
                        {teeka.TeekaAuthor && (
                          <span className="font-normal text-muted-foreground ml-1">
                            — {teeka.TeekaAuthor}
                          </span>
                        )}
                      </p>
                      <div>
                        <Label className="text-xs">Sanskrit Commentary</Label>
                        <Textarea
                          value={teeka.TeekaEntry?.SanskritTextEntry ?? ""}
                          onChange={(e) => {
                            const updatedTeekas = (currentManthra.Teekas ?? []).map((t, i) =>
                              i === tIdx
                                ? {
                                    ...t,
                                    TeekaEntry: {
                                      ...t.TeekaEntry,
                                      SanskritTextEntry: e.target.value,
                                    },
                                  }
                                : t
                            );
                            updateManthraContent(
                              editingManthra.adhyayaId,
                              editingManthra.khandaId,
                              editingManthra.manthraId,
                              { Teekas: updatedTeekas }
                            );
                          }}
                          placeholder={`${teeka.TeekaName || "Teeka"} Sanskrit commentary...`}
                          rows={3}
                          className="mt-1.5 font-serif"
                          data-testid={`textarea-teeka-sanskrit-${tIdx}`}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">English Translation</Label>
                        <Textarea
                          value={teeka.TeekaEntry?.EnglishTranslationText ?? ""}
                          onChange={(e) => {
                            const updatedTeekas = (currentManthra.Teekas ?? []).map((t, i) =>
                              i === tIdx
                                ? {
                                    ...t,
                                    TeekaEntry: {
                                      ...t.TeekaEntry,
                                      EnglishTranslationText: e.target.value,
                                    },
                                  }
                                : t
                            );
                            updateManthraContent(
                              editingManthra.adhyayaId,
                              editingManthra.khandaId,
                              editingManthra.manthraId,
                              { Teekas: updatedTeekas }
                            );
                          }}
                          placeholder="English translation..."
                          rows={3}
                          className="mt-1.5"
                          data-testid={`textarea-teeka-english-${tIdx}`}
                        />
                      </div>
                    </div>
                  ))}
                </section>
              )}

              <div className="flex justify-end pt-2">
                <Button onClick={() => setEditingManthra(null)} data-testid="button-manthra-done">
                  <Check className="w-4 h-4 mr-2" />
                  Done
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
