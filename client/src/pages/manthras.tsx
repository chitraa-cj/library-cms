import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, CMS_FETCH_INIT } from "@/lib/queryClient";
import { syncGranthaCmsCaches } from "@/lib/strapi-cache-sync";
import { useToast } from "@/hooks/use-toast";
import { useDrafts } from "@/hooks/use-drafts";
import { useAuth } from "@/hooks/use-auth";
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
  type StrapiManthra,
  type StrapiSection,
  type StrapiResponse,
  type TextAndTranslation,
  type BhashyaEntry,
  type WordMeaning,
} from "@shared/schema";
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  Send,
  Hash,
  X,
  ChevronDown,
  ChevronRight,
  Lock,
  Eye,
  AlertTriangle,
} from "lucide-react";
import { blocksToText, textToBlocks } from "@/lib/strapi-blocks";
import {
  normalizeManthrasForMantrasTab,
  compareMantraNumberSuffix,
  mantraNumberSuffix,
  MANTRA_LINK_MIN_CONTENT_SCORE,
  buildSectionByDocIdMap,
  buildSectionAncestorPath,
  sectionPathLabel,
  isMantraSectionMisplacedOnAdhyaya,
  strapiGranthaHasKhandaSections,
} from "@/lib/grantha-structure-sync";
import {
  fetchPublishedManthraForEdit,
  isManthraFetchAbortError,
} from "@/lib/resolve-strapi-mantra-detail";
import { collectUnlinkedMantrasFromGranthaDraft } from "@/lib/grantha-strapi-mantra-sync";
import {
  invalidateManthraCache,
  invalidateManthraCacheOnDocIdCorrection,
} from "@/lib/mantra-cms-cache";
import { STRAPI_POLL_INTERVAL } from "@/hooks/use-strapi-sync";

const EMPTY_TT: TextAndTranslation = {
  SanskritTextEntry: "",
  EnglishTranslationText: "",
  OtherTranslations: [],
};

/**
 * When Strapi returns a TextAndTranslation object the "other language" translation
 * lives in OtherTranslations[0].{LanguageOfTranslation, TranslationText}.
 * TextTranslationFields reads the legacy flat fields LanguageOfTranslation and
 * OtherLanguagesTranslation, so we copy the first array entry into those flat fields
 * so the editor pre-fills correctly.
 */
function unpackOtherTranslation(tt: TextAndTranslation | null | undefined): TextAndTranslation {
  if (!tt) return { ...EMPTY_TT };
  const first =
    Array.isArray(tt.OtherTranslations) && tt.OtherTranslations.length > 0
      ? tt.OtherTranslations[0]
      : null;
  if (!first) return tt;
  // Don't overwrite if the legacy flat fields are already populated
  if (tt.LanguageOfTranslation) return tt;
  return {
    ...tt,
    LanguageOfTranslation: first.LanguageOfTranslation ?? "",
    OtherLanguagesTranslation: first.TranslationText ?? [],
  };
}

let _uid = 0;
function uid() { return String(++_uid); }

function normalizeTextAndTranslationFromApi(
  tt: TextAndTranslation | null | undefined,
): TextAndTranslation {
  const unpacked = unpackOtherTranslation(tt);
  const out: TextAndTranslation = { ...unpacked };
  for (const field of ["SanskritTextEntry", "EnglishTranslationText", "IASTTransliteration"] as const) {
    const v = out[field];
    if (typeof v === "string" && v.trim()) {
      out[field] = textToBlocks(v);
    }
  }
  return out;
}

function formDataFromStrapiManthra(fullItem: Record<string, any>) {
  return {
    ShlokaManthraNumber: fullItem.ShlokaManthraNumber || "",
    order: fullItem.order != null ? String(fullItem.order) : "",
    section: fullItem.Section?.documentId || fullItem.section?.documentId || "",
    ShlokaManthraEntry: normalizeTextAndTranslationFromApi(fullItem.ShlokaManthraEntry),
    BhashyamEntry: normalizeTextAndTranslationFromApi(fullItem.BhashyamEntry),
    Teekas: (fullItem.Teekas || []).map((t: any) => ({
      teeka: t.teeka
        ? {
            id: t.teeka.id,
            documentId: t.teeka.documentId,
            TeekaName: t.teeka.TeekaName || "",
            TeekaAuthor: t.teeka.TeekaAuthor || undefined,
          }
        : null,
      TeekaName: t.teeka?.TeekaName || t.TeekaName || "",
      TeekaAuthor: t.teeka?.TeekaAuthor || t.TeekaAuthor || "",
      TeekaEntry: t.TeekaEntry || {},
    })),
    wordMeanings: (fullItem.wordMeanings || []).map((w: WordMeaning) => ({ ...w, _id: uid() })),
  };
}

export default function ManthrasPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [editingDraftId, setEditingDraftId] = useState<number | null>(null);
  const [viewOnly, setViewOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterGrantha, setFilterGrantha] = useState("__all__");
  const [filterSection, setFilterSection] = useState("__all__");
  // All sections start expanded; clicking a section header collapses it
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [fetchingEditDocId, setFetchingEditDocId] = useState<string | null>(null);
  const publishedManthraLoadGenRef = useRef(0);
  const publishedManthraAbortRef = useRef<AbortController | null>(null);
  const [insertTarget, setInsertTarget] = useState<{ afterDocumentId: string; afterNum: string; sectionDocId: string } | null>(null);
  const [isInserting, setIsInserting] = useState(false);

  useEffect(() => {
    return () => {
      publishedManthraAbortRef.current?.abort();
    };
  }, []);

  function cancelPublishedManthraLoad(): void {
    publishedManthraAbortRef.current?.abort();
    publishedManthraAbortRef.current = null;
    publishedManthraLoadGenRef.current += 1;
    setFetchingEditDocId(null);
  }
  function toggleSection(key: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const [formData, setFormData] = useState({
    ShlokaManthraNumber: "",
    order: "",
    section: "",
    ShlokaManthraEntry: { ...EMPTY_TT } as TextAndTranslation,
    BhashyamEntry: { ...EMPTY_TT } as TextAndTranslation,
    Teekas: [] as BhashyaEntry[],
    wordMeanings: [] as (WordMeaning & { _id: string })[],
  });

  const { data, isLoading } = useQuery<StrapiResponse<StrapiManthra>>({
    queryKey: ["/api/strapi", "manthras"],
    refetchInterval: STRAPI_POLL_INTERVAL,
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
  });

  const { data: sectionsData } = useQuery<StrapiResponse<StrapiSection>>({
    queryKey: ["/api/strapi", "sections"],
    refetchOnWindowFocus: true,
  });

  const { data: locksData } = useQuery<any[]>({
    queryKey: ["/api/granthas/locks"],
    refetchOnWindowFocus: true,
  });

  const lockedDocIds = useMemo(() => new Set((locksData ?? []).map((l: any) => l.granthaDocId as string)), [locksData]);

  const { unpublishedDrafts, isLoadingDrafts, saveDraft, publishDraft, deleteDraft } =
    useDrafts("manthras");

  const { drafts: granthaDrafts, isLoadingDrafts: isLoadingGranthaDrafts } = useDrafts("granthas");

  const { data: unifiedPendingData, isLoading: isLoadingUnifiedPending } = useQuery<{
    pendingGranthaMantras: import("@/lib/grantha-strapi-mantra-sync").UnlinkedGranthaDraftMantra[];
  }>({
    queryKey: ["/api/cms/manthras-unified"],
    refetchOnWindowFocus: true,
  });

  const deleteMutation = useMutation({
    mutationFn: async (documentId: string) => {
      const res = await apiRequest("DELETE", `/api/strapi/manthras/${documentId}`);
      return res.json();
    },
    onSuccess: () => {
      void syncGranthaCmsCaches(queryClient);
      setDeleteTarget(null);
      toast({ title: "Manthra deleted" });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  const allSections = sectionsData?.data || [];

  const pendingGranthaMantras = useMemo(() => {
    const fromServer = unifiedPendingData?.pendingGranthaMantras;
    if (fromServer) return fromServer;
    return granthaDrafts.flatMap((d) =>
      collectUnlinkedMantrasFromGranthaDraft({
        id: d.id,
        strapiDocumentId: d.strapiDocumentId,
        data: d.data as Record<string, unknown>,
      }),
    );
  }, [unifiedPendingData, granthaDrafts]);

  // Derive unique granthas from sections AND from manthras data
  const allGranthasFromSections = useMemo(() => {
    const seen = new Set<string>();
    const result: { name: string }[] = [];
    // From sections
    allSections.forEach((s) => {
      const name = (s as any).grantha?.GranthaName;
      if (name && !seen.has(name)) { seen.add(name); result.push({ name }); }
    });
    // From published manthras (m.grantha is the top-level field set by server normalization)
    (data?.data || []).forEach((m: any) => {
      const name = m.grantha?.GranthaName;
      if (name && !seen.has(name)) { seen.add(name); result.push({ name }); }
    });
    pendingGranthaMantras.forEach((p) => {
      if (p.granthaName && !seen.has(p.granthaName)) {
        seen.add(p.granthaName);
        result.push({ name: p.granthaName });
      }
    });
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }, [allSections, data, pendingGranthaMantras]);

  // Sections filtered by selected grantha (for filter dropdown cascading)
  const sectionsForFilter = useMemo(() => {
    if (filterGrantha === "__all__") return allSections;
    return allSections.filter((s) => (s as any).grantha?.GranthaName === filterGrantha);
  }, [allSections, filterGrantha]);

  // Build a fast lookup: sectionDocId → section (with grantha) from the sections list.
  // This is used to fill in missing grantha data on manthras where Strapi's nested
  // populate didn't return the grantha (Strapi v5 nested populate can silently omit
  // sub-relations for some records when the response is very large).
  const sectionByDocId = useMemo(() => buildSectionByDocIdMap(allSections), [allSections]);

  const strapiManthras = useMemo(() => {
    return normalizeManthrasForMantrasTab([...(data?.data || [])], allSections as any[]);
  }, [data, allSections]);

  const manthrasFetchMeta = (data as { meta?: { cmsFetch?: {
    rowsReturned?: number;
    strapiTotal?: number;
    complete?: boolean;
  } } } | undefined)?.meta?.cmsFetch;

  const rawManthraCount = data?.data?.length ?? 0;
  const fetchLooksIncomplete =
    !!manthrasFetchMeta &&
    (manthrasFetchMeta.complete === false ||
      (typeof manthrasFetchMeta.strapiTotal === "number" &&
        rawManthraCount < manthrasFetchMeta.strapiTotal));

  function getGranthaForSection(sectionDocId: string) {
    const sec = allSections.find((s) => s.documentId === sectionDocId);
    return (sec as any)?.grantha?.GranthaName || "";
  }

  function getGranthaDocIdForSection(sectionDocId: string) {
    const sec = allSections.find((s) => s.documentId === sectionDocId);
    return (sec as any)?.grantha?.documentId || "";
  }

  function resetForm() {
    invalidateManthraCache();
    setFormData({
      ShlokaManthraNumber: "",
      order: "",
      section: "",
      ShlokaManthraEntry: { ...EMPTY_TT },
      BhashyamEntry: { ...EMPTY_TT },
      Teekas: [],
      wordMeanings: [],
    });
    setEditingDraftId(null);
  }

  function openAdd() {
    setEditingItem(null);
    resetForm();
    setFormOpen(true);
  }

  async function confirmInsert() {
    if (!insertTarget) return;
    setIsInserting(true);
    try {
      const res = await apiRequest("POST", "/api/strapi/manthras/insert-between", {
        afterDocumentId: insertTarget.afterDocumentId,
        sectionDocId: insertTarget.sectionDocId,
        afterNum: insertTarget.afterNum,
      });
      const json = await res.json();
      const newDoc = json?.data;
      setInsertTarget(null);
      void syncGranthaCmsCaches(queryClient);
      toast({
        title: `Shloka inserted after ${insertTarget.afterNum}`,
        description: json.recompacted
          ? "Section sort keys were recompacted to make room."
          : "No sibling shlokas needed renumbering (fractional sort key).",
      });
      if (newDoc?.documentId) {
        fetch(`/api/strapi/manthras/${newDoc.documentId}`, CMS_FETCH_INIT)
          .then((r) => r.json())
          .then((resp) => {
            const fullItem = resp.data ?? resp;
            setEditingItem(fullItem);
            setEditingDraftId(null);
            setFormData({
              ShlokaManthraNumber: fullItem.ShlokaManthraNumber || "",
              order: fullItem.order != null ? String(fullItem.order) : "",
              section: fullItem.Section?.documentId || fullItem.section?.documentId || "",
              ShlokaManthraEntry: { ...EMPTY_TT },
              BhashyamEntry: { ...EMPTY_TT },
              Teekas: [],
              wordMeanings: [],
            });
            setViewOnly(false);
            setFormOpen(true);
          });
      }
    } catch (e: any) {
      toast({ variant: "destructive", title: "Insert failed", description: e.message });
    } finally {
      setIsInserting(false);
    }
  }

  function openView(item: any) {
    setViewOnly(true);
    if (item._isDraft) {
      setEditingItem(item);
      setEditingDraftId(item._draftId);
      const d = item._draftData;
      setFormData({
        ShlokaManthraNumber: d.ShlokaManthraNumber || "",
        order: d.order != null ? String(d.order) : "",
        section: d._section || "",
        ShlokaManthraEntry: unpackOtherTranslation(d.ShlokaManthraEntry),
        BhashyamEntry: unpackOtherTranslation(d.BhashyamEntry),
        Teekas: d.Teekas || [],
        wordMeanings: (d.wordMeanings || []).map((w: WordMeaning) => ({ ...w, _id: uid() })),
      });
      setFormOpen(true);
    } else {
      loadPublishedManthraForEdit(item, true);
    }
  }

  async function loadPublishedManthraForEdit(item: any, viewOnlyMode: boolean) {
    const preferredDocId = item.documentId as string;
    publishedManthraAbortRef.current?.abort();

    const controller = new AbortController();
    publishedManthraAbortRef.current = controller;
    const loadGen = ++publishedManthraLoadGenRef.current;
    const { signal } = controller;

    const isStale = () =>
      loadGen !== publishedManthraLoadGenRef.current || signal.aborted;

    setFetchingEditDocId(preferredDocId);
    try {
      const result = await fetchPublishedManthraForEdit(
        {
          documentId: preferredDocId,
          grantha: item.grantha,
          section: item.section,
          ShlokaManthraNumber: item.ShlokaManthraNumber,
        },
        { signal },
      );
      if (isStale()) return;

      const { data: fullItem, documentId, corrected, contentScore } = result;
      invalidateManthraCacheOnDocIdCorrection(preferredDocId, documentId, corrected);
      setEditingItem({ ...fullItem, documentId });
      setEditingDraftId(null);
      setFormData(formDataFromStrapiManthra(fullItem));
      setViewOnly(viewOnlyMode);
      setFormOpen(true);

      if (corrected) {
        toast({
          title: "Opened CMS row with content",
          description:
            "This list row was an empty duplicate. Loaded the verse record used by the Grantha editor.",
        });
      } else if ((contentScore ?? 0) < MANTRA_LINK_MIN_CONTENT_SCORE) {
        const sanskrit = blocksToText(fullItem.ShlokaManthraEntry?.SanskritTextEntry);
        if (!sanskrit.trim()) {
          toast({
            title: "No verse text in CMS",
            description:
              "This Shloka exists in Strapi but has no Sanskrit/English saved. Edit in the Grantha page or paste text here, then Save & Publish.",
          });
        }
      }
    } catch (err: unknown) {
      if (isStale() || isManthraFetchAbortError(err)) return;
      const message = err instanceof Error ? err.message : String(err);
      toast({ variant: "destructive", title: "Error loading manthra", description: message });
    } finally {
      if (loadGen === publishedManthraLoadGenRef.current) {
        setFetchingEditDocId(null);
        if (publishedManthraAbortRef.current === controller) {
          publishedManthraAbortRef.current = null;
        }
      }
    }
  }

  function openEdit(item: any) {
    const granthaDocId = item._isDraft
      ? getGranthaDocIdForSection(item._draftData?._section || "")
      : (item as any).grantha?.documentId;
    if (granthaDocId && lockedDocIds.has(granthaDocId)) {
      toast({ variant: "destructive", title: "Grantha is blocked", description: "This grantha is blocked from editing. Contact an admin to remove the blocker." });
      return;
    }
    setViewOnly(false);
    if (item._isDraft) {
      setEditingItem(item);
      setEditingDraftId(item._draftId);
      const d = item._draftData;
      setFormData({
        ShlokaManthraNumber: d.ShlokaManthraNumber || "",
        order: d.order != null ? String(d.order) : "",
        section: d._section || "",
        ShlokaManthraEntry: unpackOtherTranslation(d.ShlokaManthraEntry),
        BhashyamEntry: unpackOtherTranslation(d.BhashyamEntry),
        Teekas: d.Teekas || [],
        wordMeanings: (d.wordMeanings || []).map((w: WordMeaning) => ({ ...w, _id: uid() })),
      });
      setFormOpen(true);
    } else {
      loadPublishedManthraForEdit(item, false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const payload: any = {
      _section: formData.section,
      ShlokaManthraNumber: formData.ShlokaManthraNumber,
      ShlokaManthraEntry: formData.ShlokaManthraEntry,
      BhashyamEntry: formData.BhashyamEntry,
      Teekas: formData.Teekas,
      wordMeanings: formData.wordMeanings.map(({ _id, ...rest }) => rest),
    };
    if (formData.order) payload.order = parseInt(formData.order) || 0;
    if (formData.section) payload.Section = formData.section;

    const displayTitle =
      formData.ShlokaManthraNumber.trim() ||
      blocksToText(formData.ShlokaManthraEntry.SanskritTextEntry)?.slice(0, 40) ||
      `Manthra ${formData.order || ""}`;

    const strapiDocId =
      editingItem && !editingItem._isDraft
        ? editingItem.documentId
        : editingItem?._strapiDocId || undefined;

    saveDraft.mutate(
      {
        title: displayTitle,
        data: payload,
        strapiDocumentId: strapiDocId,
        draftId: editingDraftId || undefined,
      },
      {
        onSuccess: () => {
          if (strapiDocId) invalidateManthraCache(strapiDocId);
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
      deleteMutation.mutate(deleteTarget.documentId);
    }
  }

  function clearFilters() {
    setSearchQuery("");
    setFilterGrantha("__all__");
    setFilterSection("__all__");
  }

  const hasActiveFilters = searchQuery || filterGrantha !== "__all__" || filterSection !== "__all__";

  const draftRows = unpublishedDrafts.map((d) => ({
    ...(d.data as any),
    _isDraft: true,
    _draftId: d.id,
    _draftStatus: d.status,
    _strapiDocId: d.strapiDocumentId,
    _draftData: d.data,
    _createdBy: d.createdBy,
  }));

  const searchLower = searchQuery.toLowerCase();

  const displayedDrafts = draftRows.filter((d) => {
    const matchesSearch =
      (d.ShlokaManthraNumber || "").toLowerCase().includes(searchLower) ||
      blocksToText(d.ShlokaManthraEntry?.SanskritTextEntry)?.toLowerCase().includes(searchLower);
    const granthaName = getGranthaForSection(d._section || "");
    const matchesGrantha = filterGrantha === "__all__" || granthaName === filterGrantha;
    const matchesSection = filterSection === "__all__" || d._section === filterSection;
    return matchesSearch && matchesGrantha && matchesSection;
  });

  const displayedPendingGrantha = pendingGranthaMantras.filter((p) => {
    const matchesSearch =
      p.title.toLowerCase().includes(searchLower) ||
      p.granthaName.toLowerCase().includes(searchLower);
    const matchesGrantha = filterGrantha === "__all__" || p.granthaName === filterGrantha;
    return matchesSearch && matchesGrantha;
  });

  const displayedPublished = strapiManthras.filter((m) => {
    const text = (m.ShlokaManthraNumber || blocksToText(m.ShlokaManthraEntry?.SanskritTextEntry) || "").toLowerCase();
    const matchesSearch = text.includes(searchLower);
    // server normalises grantha to top-level: m.grantha (not m.section.grantha)
    const granthaName = (m as any).grantha?.GranthaName || "";
    const matchesGrantha = filterGrantha === "__all__" || granthaName === filterGrantha;
    const sectionDocId = (m as any).section?.documentId || "";
    const matchesSection = filterSection === "__all__" || sectionDocId === filterSection;
    return matchesSearch && matchesGrantha && matchesSection;
  });

  const isSaving = saveDraft.isPending;
  const selectedSection = formData.section
    ? allSections.find((s) => s.documentId === formData.section)
    : null;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Manthras</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Individual verse / mantra entries within a Section. Rows inserted in the Grantha editor appear here after CMS sync (may show as &quot;No number&quot; until verse labels are synced).
          </p>
        </div>
        <Button onClick={openAdd} data-testid="manthra-add">
          <Plus className="w-4 h-4 mr-2" />
          Add Manthra
        </Button>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap gap-3 items-center">
        <Input
          placeholder="Search manthras..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-52"
          data-testid="input-search-manthras"
        />
        <Select value={filterGrantha} onValueChange={(v) => { setFilterGrantha(v); setFilterSection("__all__"); }}>
          <SelectTrigger className="w-52" data-testid="select-filter-grantha">
            <SelectValue placeholder="All Granthas" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All Granthas</SelectItem>
            {allGranthasFromSections.map((g) => (
              <SelectItem key={g.name} value={g.name}>{g.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterSection} onValueChange={setFilterSection}>
          <SelectTrigger className="w-52" data-testid="select-filter-section">
            <SelectValue placeholder="All Sections" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All Sections</SelectItem>
            {sectionsForFilter.map((s) => (
              <SelectItem key={s.documentId} value={s.documentId}>
                {s.title}{s.type && s.type !== "null" ? ` (${s.type})` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters} className="text-muted-foreground hover:text-foreground" data-testid="button-clear-filters">
            <X className="w-3.5 h-3.5 mr-1" /> Clear filters
          </Button>
        )}
      </div>

      {fetchLooksIncomplete && (
        <div
          className="mb-4 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
          data-testid="manthras-incomplete-fetch-banner"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Incomplete mantra list loaded</p>
            <p className="text-xs mt-0.5 opacity-90">
              CMS returned {rawManthraCount} of {manthrasFetchMeta?.strapiTotal ?? "?"} rows.
              Refresh the page (or use the &quot;Update available&quot; prompt after deploy).
            </p>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {isLoading || isLoadingDrafts || isLoadingGranthaDrafts || isLoadingUnifiedPending ? (
          <div className="flex justify-center items-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : displayedDrafts.length === 0 && displayedPendingGrantha.length === 0 && displayedPublished.length === 0 ? (
          <div className="py-20 text-center text-muted-foreground">
            <Hash className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>{hasActiveFilters ? "No manthras match the current filters." : "No manthras found. Add the first manthra above."}</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Number / Sanskrit</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Section</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Order</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayedPendingGrantha.map((p) => (
                <tr
                  key={`pending-grantha-${p.granthaDraftId}-${p.manthraId}`}
                  className="border-b border-border bg-amber-50/40 dark:bg-amber-950/20 hover:bg-amber-50/70 dark:hover:bg-amber-950/30 transition-colors"
                  data-testid={`row-pending-grantha-${p.manthraId}`}
                >
                  <td className="px-4 py-3">
                    <Badge className="bg-amber-100 text-amber-900 border-amber-300 text-xs">Grantha draft</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium">{p.title}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Not in CMS yet — open the grantha, Save, then Sync verse numbers to CMS.
                    </p>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <p className="font-medium text-foreground">{p.granthaName}</p>
                    <p className="text-muted-foreground">Portal hierarchy only</p>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">—</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs text-right">Edit in Granthas</td>
                </tr>
              ))}

              {displayedDrafts.map((draft) => {
                const isPub = publishDraft.isPending && publishDraft.variables === draft._draftId;
                const section = allSections.find((s) => s.documentId === draft._section);
                const granthaName = getGranthaForSection(draft._section || "");
                const draftGranthaDocId = getGranthaDocIdForSection(draft._section || "");
                const draftLocked = draftGranthaDocId ? lockedDocIds.has(draftGranthaDocId) : false;
                const sanskrit = blocksToText(draft.ShlokaManthraEntry?.SanskritTextEntry);
                return (
                  <tr key={`draft-${draft._draftId}`} className="border-b border-border hover:bg-muted/30 transition-colors" data-testid={`row-draft-${draft._draftId}`}>
                    <td className="px-4 py-3"><Badge className="bg-amber-100 text-amber-800 border-amber-200 text-xs">Draft</Badge></td>
                    <td className="px-4 py-3">
                      <p className="font-medium">{draft.ShlokaManthraNumber || <span className="text-muted-foreground italic">No number</span>}</p>
                      {sanskrit && <p className="text-xs text-muted-foreground font-serif line-clamp-1 mt-0.5">{sanskrit}</p>}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {section ? (
                        <div>
                          {granthaName && (
                            <p className="font-medium text-foreground text-xs flex items-center gap-1">
                              {granthaName}
                              {draftLocked && <Lock className="w-3 h-3 text-orange-500 shrink-0" />}
                            </p>
                          )}
                          <p className="text-muted-foreground">{section.title}{section.type && section.type !== "null" ? <span className="text-muted-foreground/60"> ({section.type})</span> : null}</p>
                        </div>
                      ) : granthaName ? (
                        <span className="font-medium text-foreground flex items-center gap-1">
                          {granthaName}
                          {draftLocked && <Lock className="w-3 h-3 text-orange-500 shrink-0" />}
                        </span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{draft.order ?? "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        {draftLocked ? (
                          <Button size="sm" variant="ghost" onClick={() => openView(draft)} title="View (read-only)" data-testid={`button-view-draft-${draft._draftId}`}><Eye className="w-3.5 h-3.5 text-orange-500" /></Button>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => openEdit(draft)} data-testid={`button-edit-draft-${draft._draftId}`}><Pencil className="w-3.5 h-3.5" /></Button>
                        )}
                        <Button size="sm" variant="ghost" className="text-primary hover:text-primary" onClick={() => publishDraft.mutate(draft._draftId)} disabled={isPub || draftLocked} data-testid={`button-publish-draft-${draft._draftId}`}>
                          {isPub ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                        </Button>
                        {(!user?.id || draft._createdBy === user.id) && (
                          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleteTarget(draft)} data-testid={`button-delete-draft-${draft._draftId}`}><Trash2 className="w-3.5 h-3.5" /></Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}

              {/* Published — hierarchical: grantha header → section sub-header → manthra rows */}
              {(() => {
                // Group by grantha
                const byGrantha = new Map<string, { granthaName: string; manthras: any[] }>();
                for (const m of displayedPublished) {
                  const gId = (m as any).grantha?.documentId || "__none__";
                  const gName = (m as any).grantha?.GranthaName || "No Grantha";
                  if (!byGrantha.has(gId)) byGrantha.set(gId, { granthaName: gName, manthras: [] });
                  byGrantha.get(gId)!.manthras.push(m);
                }

                const rows: JSX.Element[] = [];

                for (const [gId, { granthaName, manthras: gManthras }] of byGrantha) {
                  // Grantha header row (matches sections page styling)
                  rows.push(
                    <tr key={`grantha-${gId}`} className="bg-muted/60 border-b border-border">
                      <td colSpan={5} className="px-4 py-2">
                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{granthaName}</span>
                        <span className="ml-2 text-xs text-muted-foreground">({gManthras.length} mantra{gManthras.length !== 1 ? "s" : ""})</span>
                      </td>
                    </tr>
                  );

                  const granthaSections = allSections.filter(
                    (s) => (s as any).grantha?.documentId === gId || (s as any).grantha?.GranthaName === granthaName,
                  );

                  // Group by full section path (Adhyaya → Khanda), not only the immediate Section row
                  const byPath = new Map<
                    string,
                    { pathLabel: string; leafType: string | null; sDocId: string; misplaced: boolean; manthras: any[] }
                  >();
                  for (const m of gManthras) {
                    const sec = (m as any).section;
                    const sId = sec?.documentId || "__none__";
                    const path =
                      sId !== "__none__"
                        ? buildSectionAncestorPath(sId, sectionByDocId)
                        : [];
                    const pathLabel =
                      path.length > 0 ? sectionPathLabel(path) : sec?.title || "No Section";
                    const pathKey = path.map((p) => p.documentId).join("/") || sId;
                    const leaf = path[path.length - 1];
                    const misplaced = isMantraSectionMisplacedOnAdhyaya(sId, granthaSections);
                    if (!byPath.has(pathKey)) {
                      byPath.set(pathKey, {
                        pathLabel,
                        leafType: leaf?.type ?? sec?.type ?? null,
                        sDocId: sId,
                        misplaced,
                        manthras: [],
                      });
                    }
                    byPath.get(pathKey)!.manthras.push(m);
                  }

                  const sortedPaths = [...byPath.entries()].sort((a, b) =>
                    a[1].pathLabel.localeCompare(b[1].pathLabel),
                  );

                  for (const [pathKey, { pathLabel, leafType, sDocId, misplaced, manthras: sManthras }] of sortedPaths) {
                    const sectionKey = `${gId}__${pathKey}`;
                    const isCollapsed = collapsedSections.has(sectionKey);

                    // Section sub-header (collapsible, starts expanded)
                    rows.push(
                      <tr
                        key={`section-${gId}-${pathKey}`}
                        className="bg-muted/20 border-b border-border hover:bg-muted/30 transition-colors cursor-pointer select-none"
                        onClick={() => toggleSection(sectionKey)}
                        data-testid={`row-section-group-${sectionKey}`}
                      >
                        <td colSpan={5} className="px-4 py-2 pl-8">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-muted-foreground">
                              {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                            </span>
                            <span className="text-sm font-medium text-foreground">{pathLabel}</span>
                            {leafType && leafType !== "null" && (
                              <Badge variant="outline" className="text-xs py-0 h-5">{leafType}</Badge>
                            )}
                            {misplaced && (
                              <Badge variant="destructive" className="text-xs py-0 h-5">
                                Wrong section — use Khanda
                              </Badge>
                            )}
                            <span className="text-xs text-muted-foreground">
                              ({sManthras.length} mantra{sManthras.length !== 1 ? "s" : ""})
                            </span>
                          </div>
                        </td>
                      </tr>
                    );

                    // Manthra rows (hidden when section is collapsed)
                    if (!isCollapsed) {
                      const sorted = [...sManthras].sort((a: any, b: any) => {
                        const bySuffix = compareMantraNumberSuffix(
                          mantraNumberSuffix(a.ShlokaManthraNumber),
                          mantraNumberSuffix(b.ShlokaManthraNumber),
                        );
                        if (bySuffix !== 0) return bySuffix;
                        const oa = a.order ?? 999999;
                        const ob = b.order ?? 999999;
                        if (oa !== ob) return oa - ob;
                        return String(a.documentId ?? "").localeCompare(String(b.documentId ?? ""));
                      });
                      const granthaLocked = lockedDocIds.has(gId);
                      for (let mi = 0; mi < sorted.length; mi++) {
                        const m = sorted[mi];
                        const sanskrit = blocksToText(m.ShlokaManthraEntry?.SanskritTextEntry);
                        rows.push(
                          <tr
                            key={m.documentId}
                            className="border-b border-border hover:bg-muted/20 transition-colors"
                            data-testid={`row-manthra-${m.documentId}`}
                          >
                            <td className="px-4 py-3">
                              <Badge className="bg-green-100 text-green-800 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-800 text-xs">Live</Badge>
                            </td>
                            <td className="px-4 py-3" style={{ paddingLeft: 56 }}>
                              <p className="font-medium text-sm">{m.ShlokaManthraNumber || <span className="text-muted-foreground italic">No number</span>}</p>
                              {sanskrit && <p className="text-xs text-muted-foreground font-serif line-clamp-1 mt-0.5">{sanskrit}</p>}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground text-xs">
                              {pathLabel}
                              {leafType && leafType !== "null" ? (
                                <span className="text-muted-foreground/60"> ({leafType})</span>
                              ) : null}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground text-sm">{m.order ?? "—"}</td>
                            <td className="px-4 py-3">
                              <div className="flex justify-end gap-1">
                                {granthaLocked ? (
                                  <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); openView(m); }} title="View (read-only)" data-testid={`button-view-${m.documentId}`}>
                                    {fetchingEditDocId === m.documentId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5 text-orange-500" />}
                                  </Button>
                                ) : (
                                  <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); openEdit(m); }} disabled={fetchingEditDocId === m.documentId} data-testid={`button-edit-${m.documentId}`}>
                                    {fetchingEditDocId === m.documentId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Pencil className="w-3.5 h-3.5" />}
                                  </Button>
                                )}
                                <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={(e) => { e.stopPropagation(); setDeleteTarget(m); }} disabled={granthaLocked} data-testid={`button-delete-${m.documentId}`}><Trash2 className="w-3.5 h-3.5" /></Button>
                              </div>
                            </td>
                          </tr>
                        );
                        {/* Insert-between separator row — shown between consecutive live rows only */}
                        if (mi < sorted.length - 1 && !granthaLocked) {
                          rows.push(
                            <tr
                              key={`insert-${m.documentId}`}
                              className="group h-0 border-0 hover:h-auto"
                              data-testid={`row-insert-after-${m.documentId}`}
                            >
                              <td colSpan={5} className="p-0">
                                <div className="flex items-center justify-center h-0 group-hover:h-6 overflow-hidden transition-all duration-150">
                                  <div className="flex items-center gap-2 w-full px-14">
                                    <div className="flex-1 border-t border-dashed border-primary/30" />
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-5 px-2 py-0 text-xs rounded-full border-primary/40 text-primary hover:bg-primary hover:text-primary-foreground gap-1"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setInsertTarget({
                                          afterDocumentId: m.documentId,
                                          afterNum: m.ShlokaManthraNumber || String(m.order ?? "?"),
                                          sectionDocId: sDocId,
                                        });
                                      }}
                                      data-testid={`button-insert-after-${m.documentId}`}
                                    >
                                      <Plus className="w-3 h-3" />
                                      Insert
                                    </Button>
                                    <div className="flex-1 border-t border-dashed border-primary/30" />
                                  </div>
                                </div>
                              </td>
                            </tr>
                          );
                        }
                      }
                    }
                  }
                }

                return rows;
              })()}
            </tbody>
          </table>
        )}
      </div>

      {/* Form dialog */}
      <Dialog open={formOpen} onOpenChange={(open) => {
        setFormOpen(open);
        if (!open) {
          cancelPublishedManthraLoad();
          resetForm();
          setEditingItem(null);
          setViewOnly(false);
        }
      }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{viewOnly ? "View Manthra" : editingItem ? "Edit Manthra" : "Add Manthra"}</DialogTitle>
            <DialogDescription>
              A Manthra is an individual verse or mantra within a Section.
            </DialogDescription>
          </DialogHeader>
          {viewOnly && (
            <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-orange-50 border border-orange-200 dark:bg-orange-950/30 dark:border-orange-800 text-sm text-orange-800 dark:text-orange-300">
              <Lock className="w-4 h-4 shrink-0" />
              <span>This grantha is blocked from editing. Viewing in read-only mode.</span>
            </div>
          )}
          <form onSubmit={handleSubmit} className="space-y-5">
          <fieldset disabled={viewOnly} className="contents">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Shloka / Manthra Number *</Label>
                <Input
                  value={formData.ShlokaManthraNumber}
                  onChange={(e) => setFormData((prev) => ({ ...prev, ShlokaManthraNumber: e.target.value }))}
                  placeholder="e.g., 1, 2.3, I-1"
                  className="mt-1.5"
                  data-testid="input-manthra-number"
                />
              </div>
              <div>
                <Label>Order <span className="text-muted-foreground font-normal">(display sequence)</span></Label>
                <Input
                  type="number"
                  value={formData.order}
                  onChange={(e) => setFormData((prev) => ({ ...prev, order: e.target.value }))}
                  className="mt-1.5"
                  data-testid="input-manthra-order"
                />
              </div>
            </div>

            <div>
              <Label>Section <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Select
                value={formData.section || "__none__"}
                onValueChange={(v) => setFormData((prev) => ({ ...prev, section: v === "__none__" ? "" : v }))}
              >
                <SelectTrigger className="mt-1.5" data-testid="select-manthra-section">
                  <SelectValue placeholder="Select Section" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__"><span className="text-muted-foreground italic">No Section</span></SelectItem>
                  {allSections.map((s) => (
                    <SelectItem key={s.documentId} value={s.documentId}>
                      {s.title}{s.type && s.type !== "null" ? ` (${s.type})` : ""}{(s as any).grantha ? ` — ${(s as any).grantha.GranthaName}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedSection && (
                <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm">
                  <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-1">Selected Section</p>
                  <p className="font-medium">{selectedSection.title}</p>
                  {selectedSection.type && selectedSection.type !== "null" && <p className="text-xs text-muted-foreground">Type: {selectedSection.type}</p>}
                  {(selectedSection as any).grantha && <p className="text-xs text-muted-foreground">Grantha: {(selectedSection as any).grantha.GranthaName}</p>}
                </div>
              )}
            </div>

            <TextTranslationFields
              title="Shloka / Manthra Entry"
              testIdPrefix="shloka"
              value={formData.ShlokaManthraEntry}
              onChange={(val) => setFormData((prev) => ({ ...prev, ShlokaManthraEntry: val }))}
            />
            <TextTranslationFields
              title="Bhashyam Entry"
              testIdPrefix="bhashyam"
              value={formData.BhashyamEntry}
              onChange={(val) => setFormData((prev) => ({ ...prev, BhashyamEntry: val }))}
            />
            <BhashyaEntryFields
              title="Teekas (Commentaries)"
              entries={formData.Teekas}
              onChange={(val) => setFormData((prev) => ({ ...prev, Teekas: val }))}
              testIdPrefix="teeka"
            />

            {/* Word Meanings */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Word Meanings</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setFormData((prev) => ({ ...prev, wordMeanings: [...prev.wordMeanings, { _id: uid(), word: "", meaning: "", position: prev.wordMeanings.length + 1 }] }))}
                  data-testid="button-add-word-meaning"
                >
                  <Plus className="w-3.5 h-3.5 mr-1" /> Add Word
                </Button>
              </div>
              {formData.wordMeanings.length === 0 ? (
                <p className="text-xs text-muted-foreground italic py-2">No word meanings added.</p>
              ) : (
                <div className="space-y-2">
                  {formData.wordMeanings.map((wm, idx) => (
                    <div key={wm._id} className="grid grid-cols-[1fr_2fr_auto_auto] gap-2 items-center">
                      <Input
                        value={wm.word || ""}
                        onChange={(e) => setFormData((prev) => {
                          const updated = [...prev.wordMeanings];
                          updated[idx] = { ...updated[idx], word: e.target.value };
                          return { ...prev, wordMeanings: updated };
                        })}
                        placeholder="Word"
                        className="text-sm"
                        data-testid={`input-wm-word-${idx}`}
                      />
                      <Input
                        value={wm.meaning || ""}
                        onChange={(e) => setFormData((prev) => {
                          const updated = [...prev.wordMeanings];
                          updated[idx] = { ...updated[idx], meaning: e.target.value };
                          return { ...prev, wordMeanings: updated };
                        })}
                        placeholder="Meaning"
                        className="text-sm"
                        data-testid={`input-wm-meaning-${idx}`}
                      />
                      <Input
                        type="number"
                        value={wm.position ?? ""}
                        onChange={(e) => setFormData((prev) => {
                          const updated = [...prev.wordMeanings];
                          updated[idx] = { ...updated[idx], position: parseInt(e.target.value) || null };
                          return { ...prev, wordMeanings: updated };
                        })}
                        placeholder="#"
                        className="text-sm w-16"
                        data-testid={`input-wm-position-${idx}`}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive h-9 w-9 p-0"
                        onClick={() => setFormData((prev) => ({ ...prev, wordMeanings: prev.wordMeanings.filter((_, i) => i !== idx) }))}
                        data-testid={`button-remove-wm-${idx}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">Columns: Word | Meaning | Position #</p>
                </div>
              )}
            </div>

          </fieldset>

            <div className="flex justify-between pt-2">
              {viewOnly ? (
                <Button type="button" variant="outline" className="w-full" onClick={() => { setFormOpen(false); resetForm(); setEditingItem(null); setViewOnly(false); }} data-testid="button-close-view">Close</Button>
              ) : (
                <>
                  <Button type="button" variant="outline" onClick={() => { setFormOpen(false); resetForm(); setEditingItem(null); }}>Cancel</Button>
                  <Button type="submit" disabled={isSaving} data-testid="button-save-manthra">
                    {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    Save as Draft
                  </Button>
                </>
              )}
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete manthra?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &quot;{deleteTarget?.title || deleteTarget?._draftData?.title || "this manthra"}&quot;.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="button-confirm-delete">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Insert-between confirmation */}
      <AlertDialog open={!!insertTarget} onOpenChange={(open) => { if (!open) setInsertTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Insert new shloka?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span className="block">
                A new blank shloka will be inserted <strong>after {insertTarget?.afterNum}</strong>.
              </span>
              <span className="block text-amber-600 dark:text-amber-400">
                All subsequent shlokas in this section will be renumbered (+1). This may take a moment.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isInserting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmInsert} disabled={isInserting} data-testid="button-confirm-insert">
              {isInserting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin inline" />Inserting…</> : "Insert & Renumber"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
