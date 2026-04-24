import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
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
} from "lucide-react";
import { blocksToText } from "@/lib/strapi-blocks";
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
  const [insertTarget, setInsertTarget] = useState<{ afterDocumentId: string; afterNum: string; sectionDocId: string } | null>(null);
  const [isInserting, setIsInserting] = useState(false);
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

  const deleteMutation = useMutation({
    mutationFn: async (documentId: string) => {
      const res = await apiRequest("DELETE", `/api/strapi/manthras/${documentId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "manthras"] });
      setDeleteTarget(null);
      toast({ title: "Manthra deleted" });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  const allSections = sectionsData?.data || [];

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
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }, [allSections, data]);

  // Sections filtered by selected grantha (for filter dropdown cascading)
  const sectionsForFilter = useMemo(() => {
    if (filterGrantha === "__all__") return allSections;
    return allSections.filter((s) => (s as any).grantha?.GranthaName === filterGrantha);
  }, [allSections, filterGrantha]);

  // Build a fast lookup: sectionDocId → section (with grantha) from the sections list.
  // This is used to fill in missing grantha data on manthras where Strapi's nested
  // populate didn't return the grantha (Strapi v5 nested populate can silently omit
  // sub-relations for some records when the response is very large).
  const sectionByDocId = useMemo(() => {
    const map = new Map<string, any>();
    for (const s of allSections) {
      if (s.documentId) map.set(s.documentId, s);
    }
    return map;
  }, [allSections]);

  const strapiManthras = useMemo(() => {
    return [...(data?.data || [])].map((m: any) => {
      // If the server normalization already gave us a grantha, use it.
      if (m.grantha) return m;
      // Otherwise supplement from the sections list using the section documentId.
      const sectionDocId = m.section?.documentId;
      if (!sectionDocId) return m;
      const sec = sectionByDocId.get(sectionDocId);
      if (!sec?.grantha) return m;
      return { ...m, grantha: sec.grantha };
    }).sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
  }, [data, sectionByDocId]);

  function getGranthaForSection(sectionDocId: string) {
    const sec = allSections.find((s) => s.documentId === sectionDocId);
    return (sec as any)?.grantha?.GranthaName || "";
  }

  function getGranthaDocIdForSection(sectionDocId: string) {
    const sec = allSections.find((s) => s.documentId === sectionDocId);
    return (sec as any)?.grantha?.documentId || "";
  }

  function resetForm() {
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
      });
      const json = await res.json();
      const newDoc = json?.data;
      setInsertTarget(null);
      await queryClient.invalidateQueries({ queryKey: ["/api/strapi", "manthras"] });
      toast({ title: `Shloka inserted after ${insertTarget.afterNum}`, description: `${json.shiftedCount ?? 0} subsequent shlokas renumbered.` });
      if (newDoc?.documentId) {
        fetch(`/api/strapi/manthras/${newDoc.documentId}`)
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
      setFetchingEditDocId(item.documentId);
      fetch(`/api/strapi/manthras/${item.documentId}`)
        .then((r) => r.json())
        .then((resp) => {
          const fullItem = resp.data ?? resp;
          setEditingItem(fullItem);
          setEditingDraftId(null);
          setFormData({
            ShlokaManthraNumber: fullItem.ShlokaManthraNumber || "",
            order: fullItem.order != null ? String(fullItem.order) : "",
            section: fullItem.Section?.documentId || fullItem.section?.documentId || "",
            ShlokaManthraEntry: unpackOtherTranslation(fullItem.ShlokaManthraEntry),
            BhashyamEntry: unpackOtherTranslation(fullItem.BhashyamEntry),
            Teekas: (fullItem.Teekas || []).map((t: any) => ({
              teeka: t.teeka ? { id: t.teeka.id, documentId: t.teeka.documentId, TeekaName: t.teeka.TeekaName || "", TeekaAuthor: t.teeka.TeekaAuthor || undefined } : null,
              TeekaName: t.teeka?.TeekaName || t.TeekaName || "",
              TeekaAuthor: t.teeka?.TeekaAuthor || t.TeekaAuthor || "",
              TeekaEntry: t.TeekaEntry || {},
            })),
            wordMeanings: (fullItem.wordMeanings || []).map((w: WordMeaning) => ({ ...w, _id: uid() })),
          });
          setFormOpen(true);
        })
        .catch((err) => {
          toast({ variant: "destructive", title: "Error loading manthra", description: err.message });
        })
        .finally(() => setFetchingEditDocId(null));
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
      // The list only fetches lightweight data (no bhashyam/teekas/OtherTranslations).
      // Fetch the full manthra detail before opening the edit form.
      setFetchingEditDocId(item.documentId);
      fetch(`/api/strapi/manthras/${item.documentId}`)
        .then((r) => r.json())
        .then((resp) => {
          const fullItem = resp.data ?? resp;
          setEditingItem(fullItem);
          setEditingDraftId(null);
          setFormData({
            ShlokaManthraNumber: fullItem.ShlokaManthraNumber || "",
            order: fullItem.order != null ? String(fullItem.order) : "",
            section: fullItem.Section?.documentId || fullItem.section?.documentId || "",
            ShlokaManthraEntry: unpackOtherTranslation(fullItem.ShlokaManthraEntry),
            BhashyamEntry: unpackOtherTranslation(fullItem.BhashyamEntry),
            Teekas: (fullItem.Teekas || []).map((t: any) => ({
              teeka: t.teeka ? {
                id: t.teeka.id,
                documentId: t.teeka.documentId,
                TeekaName: t.teeka.TeekaName || "",
                TeekaAuthor: t.teeka.TeekaAuthor || undefined,
              } : null,
              TeekaName: t.teeka?.TeekaName || t.TeekaName || "",
              TeekaAuthor: t.teeka?.TeekaAuthor || t.TeekaAuthor || "",
              TeekaEntry: t.TeekaEntry || {},
            })),
            wordMeanings: (fullItem.wordMeanings || []).map((w: WordMeaning) => ({ ...w, _id: uid() })),
          });
          setFormOpen(true);
        })
        .catch((err) => {
          toast({ variant: "destructive", title: "Error loading manthra", description: err.message });
        })
        .finally(() => setFetchingEditDocId(null));
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
          <p className="text-sm text-muted-foreground mt-0.5">Individual verse / mantra entries within a Section</p>
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

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {isLoading || isLoadingDrafts ? (
          <div className="flex justify-center items-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : displayedDrafts.length === 0 && displayedPublished.length === 0 ? (
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

                  // Group by section within this grantha
                  const bySection = new Map<string, { sTitle: string; sType: string | null; sDocId: string; manthras: any[] }>();
                  for (const m of gManthras) {
                    const sec = (m as any).section;
                    const sId = sec?.documentId || "__none__";
                    if (!bySection.has(sId)) bySection.set(sId, { sTitle: sec?.title || "No Section", sType: sec?.type || null, sDocId: sId, manthras: [] });
                    bySection.get(sId)!.manthras.push(m);
                  }

                  for (const [sId, { sTitle, sType, manthras: sManthras }] of bySection) {
                    const sectionKey = `${gId}__${sId}`;
                    const isCollapsed = collapsedSections.has(sectionKey);

                    // Section sub-header (collapsible, starts expanded)
                    rows.push(
                      <tr
                        key={`section-${gId}-${sId}`}
                        className="bg-muted/20 border-b border-border hover:bg-muted/30 transition-colors cursor-pointer select-none"
                        onClick={() => toggleSection(sectionKey)}
                        data-testid={`row-section-group-${sectionKey}`}
                      >
                        <td colSpan={5} className="px-4 py-2 pl-8">
                          <div className="flex items-center gap-2">
                            <span className="text-muted-foreground">
                              {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                            </span>
                            <span className="text-sm font-medium text-foreground">{sTitle}</span>
                            {sType && (
                              <Badge variant="outline" className="text-xs py-0 h-5">{sType}</Badge>
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
                      const sorted = [...sManthras].sort((a: any, b: any) => (a.order ?? 999) - (b.order ?? 999));
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
                              {sTitle}{sType ? <span className="text-muted-foreground/60"> ({sType})</span> : null}
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
                                          sectionDocId: sId,
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
      <Dialog open={formOpen} onOpenChange={(open) => { setFormOpen(open); if (!open) { resetForm(); setEditingItem(null); setViewOnly(false); } }}>
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
