import { useState, useMemo } from "react";
import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft, BookOpen, ChevronRight, Hash, ScrollText, Download,
  ChevronDown, ChevronUp, Languages, BookMarked, Type, Loader2,
  RotateCcw, CheckCircle, AlertCircle,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────
type TextNode = { type: "text"; text: string; bold?: boolean; italic?: boolean };
type Block = { type: string; children: TextNode[] };

type Translation = {
  id: number;
  LanguageOfTranslation: string;
  TranslationText: Block[];
  isAiTranslated?: boolean | null;
};

type ShlokEntry = {
  id: number;
  SanskritTextEntry?: Block[];
  IASTTransliteration?: Block[] | string | null;
  EnglishTranslationText?: Block[];
  OtherTranslations?: Translation[];
};

type TeekaItem = {
  id: number;
  teeka?: { TeekaName: string; TeekaAuthor?: string };
  TeekaEntry?: ShlokEntry;
};

type WordMeaning = {
  id: number;
  word?: string;
  meaning?: string;
};

type GranthaInfo = { id: number; documentId: string; GranthaName: string; GranthaType?: string };
type SectionInfo = {
  id: number; documentId: string; title: string; type?: string | null;
  order?: number | null; grantha?: GranthaInfo | null; manthraCount: number;
};

type ManthraEntry = {
  id: number;
  documentId: string;
  ShlokaManthraNumber: string;
  order?: number | null;
  Section: { id: number; documentId: string; title: string };
  ShlokaManthraEntry?: ShlokEntry;
  BhashyamEntry?: ShlokEntry | null;
  Teekas?: TeekaItem[];
  wordMeanings?: WordMeaning[];
};

type BackupSummary = {
  id: number; label: string; createdAt: string;
  granthaCount: number; sectionCount: number; manthraCount: number;
  granthas: GranthaInfo[];
  sections: SectionInfo[];
};

// ── Helpers ────────────────────────────────────────────────────────
function blocksToText(blocks: Block[] | undefined): string {
  if (!blocks?.length) return "";
  return blocks.map((b) => b.children?.map((c) => c.text).join("") ?? "").join("\n").trim();
}

// IASTTransliteration comes from Strapi as rich-text blocks but may also be
// stored as a plain string in older backup records. Normalize to plain text.
function iastToText(v: Block[] | string | null | undefined): string {
  if (!v) return "";
  if (typeof v === "string") return v.trim();
  return blocksToText(v);
}

function BlockText({ blocks, className = "" }: { blocks: Block[] | undefined; className?: string }) {
  const text = blocksToText(blocks);
  if (!text) return null;
  return <p className={`whitespace-pre-wrap leading-relaxed ${className}`}>{text}</p>;
}

function SectionLabel({ label }: { label: string }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5">{label}</p>
  );
}

function EntryBlock({ entry, showBadge }: { entry: ShlokEntry; showBadge?: string }) {
  const hasSanskrit = !!blocksToText(entry.SanskritTextEntry);
  const hasIAST = !!iastToText(entry.IASTTransliteration);
  const hasEnglish = !!blocksToText(entry.EnglishTranslationText);
  const otherTranslations = entry.OtherTranslations?.filter(
    (t) => blocksToText(t.TranslationText)
  ) ?? [];

  if (!hasSanskrit && !hasIAST && !hasEnglish && !otherTranslations.length) return null;

  return (
    <div className="space-y-3">
      {showBadge && (
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-xs">{showBadge}</Badge>
        </div>
      )}
      {hasSanskrit && (
        <div>
          <SectionLabel label="Sanskrit" />
          <BlockText blocks={entry.SanskritTextEntry} className="text-sm font-[Noto_Serif_Devanagari,serif]" />
        </div>
      )}
      {hasIAST && (
        <div>
          <SectionLabel label="IAST Transliteration" />
          <p className="text-sm italic text-muted-foreground whitespace-pre-wrap leading-relaxed">{iastToText(entry.IASTTransliteration)}</p>
        </div>
      )}
      {hasEnglish && (
        <div>
          <SectionLabel label="English Translation" />
          <BlockText blocks={entry.EnglishTranslationText} className="text-sm" />
        </div>
      )}
      {otherTranslations.map((t) => (
        <div key={t.id}>
          <div className="flex items-center gap-1.5 mb-1.5">
            <Languages className="w-3 h-3 text-muted-foreground" />
            <SectionLabel label={t.LanguageOfTranslation} />
            {t.isAiTranslated && <Badge variant="outline" className="text-[9px] py-0">AI</Badge>}
          </div>
          <BlockText blocks={t.TranslationText} className="text-sm" />
        </div>
      ))}
    </div>
  );
}

function countOtLangs(entry: ShlokEntry | undefined | null): number {
  return (
    entry?.OtherTranslations?.filter((t) => blocksToText(t.TranslationText)).length ?? 0
  );
}

function ManthraCard({
  manthra,
  granthaDocumentId,
  canRestore,
  restoring,
  onRestore,
}: {
  manthra: ManthraEntry;
  granthaDocumentId?: string;
  canRestore: boolean;
  restoring: boolean;
  onRestore: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const otCount = countOtLangs(manthra.ShlokaManthraEntry);

  const shloka = manthra.ShlokaManthraEntry;
  const bhashyam = manthra.BhashyamEntry;
  const teekas = manthra.Teekas?.filter((t) => t.TeekaEntry) ?? [];
  const wordMeanings = manthra.wordMeanings?.filter((w) => w.word || w.meaning) ?? [];

  const hasBhashyam = bhashyam && (
    !!blocksToText(bhashyam.SanskritTextEntry) ||
    !!blocksToText(bhashyam.EnglishTranslationText) ||
    !!(bhashyam.OtherTranslations?.filter((t) => blocksToText(t.TranslationText)).length)
  );
  const hasExtras = hasBhashyam || teekas.length > 0 || wordMeanings.length > 0 ||
    iastToText(shloka?.IASTTransliteration) || blocksToText(shloka?.EnglishTranslationText) ||
    (shloka?.OtherTranslations?.filter((t) => blocksToText(t.TranslationText)).length ?? 0) > 0;

  return (
    <Card data-testid={`card-manthra-${manthra.id}`} className="overflow-hidden">
      <CardHeader className="pb-0 pt-4 px-5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Hash className="w-3.5 h-3.5 text-primary flex-shrink-0" />
            <CardTitle className="text-sm font-semibold text-primary" data-testid={`text-manthra-num-${manthra.id}`}>
              {manthra.ShlokaManthraNumber}
            </CardTitle>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {otCount > 0 && (
              <Badge variant="secondary" className="text-[10px]">{otCount} lang{otCount !== 1 ? "s" : ""}</Badge>
            )}
            {hasBhashyam && <Badge variant="outline" className="text-[10px]">Bhashyam</Badge>}
            {teekas.length > 0 && <Badge variant="outline" className="text-[10px]">{teekas.length} Teeka{teekas.length > 1 ? "s" : ""}</Badge>}
            {canRestore && granthaDocumentId && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-[10px] px-2"
                disabled={restoring}
                onClick={(e) => {
                  e.stopPropagation();
                  onRestore();
                }}
                data-testid={`button-restore-manthra-${manthra.id}`}
              >
                {restoring ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RotateCcw className="w-3 h-3 mr-1" />
                )}
                Restore live
              </Button>
            )}
            {hasExtras && (
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setExpanded((e) => !e)} data-testid={`button-expand-manthra-${manthra.id}`}>
                {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-5 pt-3 pb-4 space-y-4">
        {shloka && <BlockText blocks={shloka.SanskritTextEntry} className="text-sm font-[Noto_Serif_Devanagari,serif]" />}

        {expanded && (
          <>
            {shloka && (iastToText(shloka.IASTTransliteration) || blocksToText(shloka.EnglishTranslationText) || (shloka.OtherTranslations?.length ?? 0) > 0) && (
              <div className="space-y-3 pl-3 border-l-2 border-muted">
                {!!iastToText(shloka.IASTTransliteration) && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5"><Type className="w-3 h-3 text-muted-foreground" /><SectionLabel label="IAST Transliteration" /></div>
                    <p className="text-sm italic text-muted-foreground whitespace-pre-wrap leading-relaxed">{iastToText(shloka.IASTTransliteration)}</p>
                  </div>
                )}
                {!!blocksToText(shloka.EnglishTranslationText) && (
                  <div>
                    <SectionLabel label="English Translation" />
                    <BlockText blocks={shloka.EnglishTranslationText} className="text-sm" />
                  </div>
                )}
                {shloka.OtherTranslations?.filter((t) => blocksToText(t.TranslationText)).map((t) => (
                  <div key={t.id}>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <Languages className="w-3 h-3 text-muted-foreground" />
                      <SectionLabel label={t.LanguageOfTranslation} />
                      {t.isAiTranslated && <Badge variant="outline" className="text-[9px] py-0">AI</Badge>}
                    </div>
                    <BlockText blocks={t.TranslationText} className="text-sm" />
                  </div>
                ))}
              </div>
            )}

            {hasBhashyam && bhashyam && (
              <>
                <Separator />
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <BookMarked className="w-4 h-4 text-amber-600" />
                    <span className="text-sm font-semibold text-amber-700 dark:text-amber-400">Bhashyam</span>
                  </div>
                  <div className="pl-3 border-l-2 border-amber-200 dark:border-amber-800 space-y-3">
                    {!!blocksToText(bhashyam.SanskritTextEntry) && (
                      <div>
                        <SectionLabel label="Sanskrit" />
                        <BlockText blocks={bhashyam.SanskritTextEntry} className="text-sm font-[Noto_Serif_Devanagari,serif]" />
                      </div>
                    )}
                    {!!iastToText(bhashyam.IASTTransliteration) && (
                      <div>
                        <div className="flex items-center gap-1.5 mb-1.5"><Type className="w-3 h-3 text-muted-foreground" /><SectionLabel label="IAST" /></div>
                        <p className="text-sm italic text-muted-foreground whitespace-pre-wrap leading-relaxed">{iastToText(bhashyam.IASTTransliteration)}</p>
                      </div>
                    )}
                    {!!blocksToText(bhashyam.EnglishTranslationText) && (
                      <div>
                        <SectionLabel label="English Translation" />
                        <BlockText blocks={bhashyam.EnglishTranslationText} className="text-sm" />
                      </div>
                    )}
                    {bhashyam.OtherTranslations?.filter((t) => blocksToText(t.TranslationText)).map((t) => (
                      <div key={t.id}>
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <Languages className="w-3 h-3 text-muted-foreground" />
                          <SectionLabel label={t.LanguageOfTranslation} />
                          {t.isAiTranslated && <Badge variant="outline" className="text-[9px] py-0">AI</Badge>}
                        </div>
                        <BlockText blocks={t.TranslationText} className="text-sm" />
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {teekas.length > 0 && (
              <>
                <Separator />
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <BookOpen className="w-4 h-4 text-indigo-600" />
                    <span className="text-sm font-semibold text-indigo-700 dark:text-indigo-400">Teekas ({teekas.length})</span>
                  </div>
                  {teekas.map((tk) => (
                    <div key={tk.id} className="pl-3 border-l-2 border-indigo-200 dark:border-indigo-800 space-y-3">
                      <div>
                        <p className="text-xs font-semibold">{tk.teeka?.TeekaName ?? "Teeka"}</p>
                        {tk.teeka?.TeekaAuthor && (
                          <p className="text-[10px] text-muted-foreground">{tk.teeka.TeekaAuthor}</p>
                        )}
                      </div>
                      {tk.TeekaEntry && <EntryBlock entry={tk.TeekaEntry} />}
                    </div>
                  ))}
                </div>
              </>
            )}

            {wordMeanings.length > 0 && (
              <>
                <Separator />
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Word Meanings</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                    {wordMeanings.map((wm) => (
                      <div key={wm.id} className="text-xs flex gap-2">
                        <span className="font-medium text-primary min-w-0">{wm.word}</span>
                        <span className="text-muted-foreground min-w-0">{wm.meaning}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main Page ──────────────────────────────────────────────────────
type RestoreResult = {
  total: number; restored: number; skipped: number; errored: number;
  results: { manthra: string; docId: string; action: string }[];
  errors: { manthra: string; error: string }[];
};

type MantraRestoreResult = {
  ok: boolean;
  manthra: string;
  actions: string[];
  skipped: string[];
  errors: string[];
  message?: string;
};

export default function BackupDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { toast } = useToast();

  const [selectedGranthaId, setSelectedGranthaId] = useState<number | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(null);

  // Grantha-wide restore state
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreField, setRestoreField] = useState<string>("both");
  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const [restoreProgress, setRestoreProgress] = useState<{ current: number; total: number } | null>(null);

  // Single-mantra restore state
  const [mantraRestoreOpen, setMantraRestoreOpen] = useState(false);
  const [mantraRestoreTarget, setMantraRestoreTarget] = useState<ManthraEntry | null>(null);
  const [mantraRestoreField, setMantraRestoreField] = useState<string>("all");
  const [mantraRestoreResult, setMantraRestoreResult] = useState<MantraRestoreResult | null>(null);
  const [mantraRestoringDocId, setMantraRestoringDocId] = useState<string | null>(null);

  async function handleRestoreMantra() {
    if (!mantraRestoreTarget || !selectedGrantha?.documentId) return;
    setMantraRestoringDocId(mantraRestoreTarget.documentId);
    setMantraRestoreResult(null);
    try {
      const res = await fetch(`/api/admin/backups/${id}/restore-manthra`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          manthraDocumentId: mantraRestoreTarget.documentId,
          granthaDocId: selectedGrantha.documentId,
          field: mantraRestoreField,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "Restore failed");
      }
      setMantraRestoreResult({
        ok: data.ok !== false,
        manthra: data.manthra ?? mantraRestoreTarget.ShlokaManthraNumber,
        actions: data.actions ?? [],
        skipped: data.skipped ?? [],
        errors: data.errors ?? [],
        message: data.message,
      });
      if (data.ok !== false && (data.actions?.length ?? 0) > 0) {
        toast({
          title: "Mantra restored to Strapi",
          description: `${data.manthra}: ${data.actions?.join("; ")}`,
        });
      } else if ((data.skipped?.length ?? 0) > 0 && !(data.errors?.length)) {
        toast({
          title: "Nothing to change",
          description: data.skipped?.join("; "),
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setMantraRestoreResult({
        ok: false,
        manthra: mantraRestoreTarget.ShlokaManthraNumber,
        actions: [],
        skipped: [],
        errors: [msg],
      });
      toast({ variant: "destructive", title: "Restore failed", description: msg });
    } finally {
      setMantraRestoringDocId(null);
    }
  }

  function openMantraRestore(m: ManthraEntry) {
    setMantraRestoreTarget(m);
    setMantraRestoreField("all");
    setMantraRestoreResult(null);
    setMantraRestoreOpen(true);
  }

  async function handleRestore(granthaDocId: string) {
    setRestoring(true);
    setRestoreResult(null);
    setRestoreProgress(null);
    try {
      // Start the async restore job
      const startRes = await fetch(`/api/admin/backups/${id}/restore-grantha`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ granthaDocId, field: restoreField }),
      });
      const startData = await startRes.json();
      if (!startRes.ok) throw new Error(startData.message || "Restore failed to start");

      // If no jobId, the result came back inline (0 manthras case)
      if (!startData.jobId) {
        setRestoreResult(startData);
        return;
      }

      setRestoreProgress({ current: 0, total: startData.total });

      // Poll for job completion
      const jobId = startData.jobId;
      while (true) {
        await new Promise((r) => setTimeout(r, 2500));
        const pollRes = await fetch(`/api/admin/restore-jobs/${jobId}`);
        if (!pollRes.ok) throw new Error("Failed to poll restore job");
        const pollData = await pollRes.json();
        setRestoreProgress({ current: pollData.progress, total: pollData.total });

        if (pollData.status === "done" || pollData.status === "error") {
          setRestoreResult({
            total: pollData.total,
            restored: pollData.restored,
            skipped: pollData.skipped,
            errored: pollData.errored,
            results: pollData.results,
            errors: pollData.errors,
          });
          if (pollData.status === "error" && pollData.message) {
            setRestoreResult((prev: any) => prev ? { ...prev, errors: [{ manthra: "Fatal", error: pollData.message }, ...(prev.errors ?? [])] } : null);
          }
          break;
        }
      }
    } catch (e: any) {
      setRestoreResult({ total: 0, restored: 0, skipped: 0, errored: 1, results: [], errors: [{ manthra: "—", error: e.message }] });
    } finally {
      setRestoring(false);
      setRestoreProgress(null);
    }
  }

  // ── Load lightweight summary (granthas + section list, no manthra text) ──
  const { data: summary, isLoading, error } = useQuery<BackupSummary>({
    queryKey: ["/api/admin/backups", id, "summary"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/backups/${id}/summary`);
      if (!res.ok) throw new Error("Failed to load snapshot");
      return res.json();
    },
    staleTime: 10 * 60 * 1000,
  });

  // ── Load manthras for the selected section only ──
  const { data: manthras = [], isLoading: manthrasLoading } = useQuery<ManthraEntry[]>({
    queryKey: ["/api/admin/backups", id, "sections", selectedSectionId, "manthras"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/backups/${id}/sections/${selectedSectionId}/manthras`);
      if (!res.ok) throw new Error("Failed to load manthras");
      return res.json();
    },
    enabled: selectedSectionId !== null,
    staleTime: 10 * 60 * 1000,
  });

  // ── Build grantha → sections map from summary ──
  const { granthaList, sectionsByGrantha } = useMemo(() => {
    if (!summary) return { granthaList: [] as GranthaInfo[], sectionsByGrantha: new Map<number, SectionInfo[]>() };

    const granthaMap = new Map<number, GranthaInfo>();
    const sectionsByGrantha = new Map<number, SectionInfo[]>();

    for (const sec of summary.sections) {
      const grantha = sec.grantha;
      const granthaId = grantha?.id ?? -1;
      const granthaInfo: GranthaInfo = grantha ?? { id: -1, documentId: "", GranthaName: "Ungrouped" };
      if (!granthaMap.has(granthaId)) granthaMap.set(granthaId, granthaInfo);
      if (!sectionsByGrantha.has(granthaId)) sectionsByGrantha.set(granthaId, []);
      sectionsByGrantha.get(granthaId)!.push(sec);
    }

    for (const [, secs] of sectionsByGrantha) {
      secs.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    }

    const granthaList = Array.from(granthaMap.values()).sort((a, b) => {
      if (a.id === -1) return 1;
      if (b.id === -1) return -1;
      return a.GranthaName.localeCompare(b.GranthaName);
    });

    return { granthaList, sectionsByGrantha };
  }, [summary]);

  const selectedGrantha = granthaList.find((g) => g.id === selectedGranthaId) ?? null;
  const sections = selectedGranthaId !== null ? (sectionsByGrantha.get(selectedGranthaId) ?? []) : [];
  const selectedSection = sections.find((s) => s.id === selectedSectionId) ?? null;

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-72" />
        <div className="space-y-2 mt-4">
          {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}
        </div>
      </div>
    );
  }

  if (error || !summary) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <Link href="/admin/backups">
          <Button variant="ghost" size="sm" className="mb-4"><ArrowLeft className="w-4 h-4 mr-1" /> Back</Button>
        </Link>
        <p className="text-muted-foreground">Snapshot not found or failed to load.</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b flex-shrink-0">
        <div className="flex items-center gap-3">
          <Link href="/admin/backups">
            <Button variant="ghost" size="icon" data-testid="button-back-to-backups">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="font-semibold" data-testid="page-title-backup-detail">Snapshot #{summary.id}</h1>
            <p className="text-xs text-muted-foreground">
              {new Date(summary.createdAt).toLocaleString()} &middot; {summary.granthaCount} granthas &middot; {summary.sectionCount} sections &middot; {summary.manthraCount} manthras
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => window.open(`/api/admin/backups/${id}/download`, "_blank")} data-testid="button-download-snapshot">
            <Download className="w-4 h-4 mr-1.5" /> Download
          </Button>
        </div>

        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 mt-3 text-xs">
          <button
            onClick={() => { setSelectedGranthaId(null); setSelectedSectionId(null); }}
            className={selectedGrantha ? "text-muted-foreground hover:text-foreground transition-colors" : "font-medium text-foreground"}
            data-testid="breadcrumb-granthas"
          >
            Granthas
          </button>
          {selectedGrantha && (
            <>
              <ChevronRight className="w-3 h-3 text-muted-foreground" />
              <button
                onClick={() => setSelectedSectionId(null)}
                className={selectedSection ? "text-muted-foreground hover:text-foreground transition-colors" : "font-medium text-foreground"}
                data-testid="breadcrumb-grantha"
              >
                {selectedGrantha.GranthaName}
              </button>
            </>
          )}
          {selectedSection && (
            <>
              <ChevronRight className="w-3 h-3 text-muted-foreground" />
              <span className="font-medium text-foreground" data-testid="breadcrumb-section">{selectedSection.title}</span>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex min-h-0">

        {/* Level 1: Granthas */}
        {!selectedGrantha && (
          <ScrollArea className="flex-1">
            <div className="p-6 max-w-2xl mx-auto space-y-2">
              {granthaList.map((g) => {
                const sects = sectionsByGrantha.get(g.id) ?? [];
                const mCount = sects.reduce((sum, s) => sum + (s.manthraCount ?? 0), 0);
                return (
                  <button key={g.id} onClick={() => { setSelectedGranthaId(g.id); setSelectedSectionId(null); }} className="w-full text-left" data-testid={`card-grantha-${g.id}`}>
                    <Card className="hover:shadow-sm transition-shadow hover:border-primary/40">
                      <CardContent className="py-3 px-4">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <BookOpen className="w-4 h-4 text-primary flex-shrink-0" />
                            <span className="font-medium text-sm truncate">{g.GranthaName}</span>
                            {g.GranthaType && <Badge variant="outline" className="text-xs flex-shrink-0">{g.GranthaType}</Badge>}
                          </div>
                          <div className="flex items-center gap-4 text-xs text-muted-foreground flex-shrink-0">
                            <span className="flex items-center gap-1"><ScrollText className="w-3 h-3" />{sects.length}</span>
                            <span className="flex items-center gap-1"><Hash className="w-3 h-3" />{mCount}</span>
                            <ChevronRight className="w-3.5 h-3.5" />
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        )}

        {/* Level 2+: Sections sidebar + Manthra list */}
        {selectedGrantha && (
          <>
            {/* Sections sidebar */}
            <div className="w-64 border-r flex flex-col flex-shrink-0 min-h-0">
              <div className="px-4 py-2.5 border-b flex-shrink-0 space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Sections ({sections.length})
                </p>
                {selectedGrantha?.documentId && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full text-xs h-7"
                    onClick={() => { setRestoreResult(null); setRestoreOpen(true); }}
                    data-testid="button-restore-grantha"
                  >
                    <RotateCcw className="w-3 h-3 mr-1.5" /> Restore to Strapi
                  </Button>
                )}
              </div>
              <ScrollArea className="flex-1">
                <div className="p-2 space-y-0.5">
                  {sections.map((s) => {
                    const isActive = s.id === selectedSectionId;
                    return (
                      <button
                        key={s.id}
                        onClick={() => setSelectedSectionId(s.id)}
                        data-testid={`button-section-${s.id}`}
                        className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                          isActive
                            ? "bg-sidebar-accent text-sidebar-foreground font-medium"
                            : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate">{s.title}</span>
                          <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums">{s.manthraCount}</span>
                        </div>
                        {s.type && <p className="text-[10px] text-muted-foreground/60 mt-0.5 capitalize">{s.type}</p>}
                      </button>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>

            {/* Manthra list */}
            <div className="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col">
              {!selectedSection ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                  Select a section to view manthras
                </div>
              ) : manthrasLoading ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
                  <Loader2 className="w-6 h-6 animate-spin" />
                  <span className="text-sm">Loading manthras…</span>
                </div>
              ) : (
                <ScrollArea className="flex-1">
                  <div className="p-4 space-y-3 max-w-3xl">
                    <p className="text-xs text-muted-foreground px-1">
                      {selectedSection.title} &middot; {manthras.length} mantra{manthras.length !== 1 ? "s" : ""}
                    </p>
                    {manthras.length === 0 ? (
                      <p className="text-sm text-muted-foreground px-1">No manthras in this section.</p>
                    ) : (
                      manthras.map((m) => (
                        <ManthraCard
                          key={m.id}
                          manthra={m}
                          granthaDocumentId={selectedGrantha?.documentId}
                          canRestore={!!selectedGrantha?.documentId}
                          restoring={mantraRestoringDocId === m.documentId}
                          onRestore={() => openMantraRestore(m)}
                        />
                      ))
                    )}
                  </div>
                </ScrollArea>
              )}
            </div>
          </>
        )}
      </div>

      {/* Single mantra restore */}
      <Dialog
        open={mantraRestoreOpen}
        onOpenChange={(o) => {
          if (!mantraRestoringDocId) {
            setMantraRestoreOpen(o);
            if (!o) {
              setMantraRestoreTarget(null);
              setMantraRestoreResult(null);
            }
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <RotateCcw className="w-4 h-4" />
              Restore one mantra to Strapi
            </DialogTitle>
          </DialogHeader>

          {mantraRestoreTarget && (
            <div className="space-y-4">
              <p className="text-sm">
                <span className="font-medium text-primary">{mantraRestoreTarget.ShlokaManthraNumber}</span>
                <span className="text-muted-foreground"> — only this verse is updated. Other mantras in the grantha stay unchanged.</span>
              </p>
              <p className="text-xs text-muted-foreground">
                Snapshot has {countOtLangs(mantraRestoreTarget.ShlokaManthraEntry)} Shloka translation(s). Missing languages are merged into live Strapi; existing live text is not overwritten.
              </p>
              {!mantraRestoreResult && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">What to restore</p>
                  <Select value={mantraRestoreField} onValueChange={setMantraRestoreField} disabled={!!mantraRestoringDocId}>
                    <SelectTrigger data-testid="select-restore-manthra-field">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All applicable (recommended)</SelectItem>
                      <SelectItem value="shloka_ot">Shloka translations only</SelectItem>
                      <SelectItem value="both">Teekas + Bhashyam (if missing in live)</SelectItem>
                      <SelectItem value="teekas">Teekas only</SelectItem>
                      <SelectItem value="bhashyam">Bhashyam only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              {mantraRestoreResult && (
                <div className="rounded-md border p-3 space-y-2 text-xs">
                  {mantraRestoreResult.actions.map((a, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-green-700 dark:text-green-400">
                      <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                      <span>{a}</span>
                    </div>
                  ))}
                  {mantraRestoreResult.skipped.map((s, i) => (
                    <div key={i} className="text-muted-foreground">{s}</div>
                  ))}
                  {mantraRestoreResult.errors.map((e, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-red-600">
                      <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                      <span>{e}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            {!mantraRestoreResult ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => setMantraRestoreOpen(false)}
                  disabled={!!mantraRestoringDocId}
                  data-testid="button-restore-manthra-cancel"
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => void handleRestoreMantra()}
                  disabled={!!mantraRestoringDocId}
                  data-testid="button-restore-manthra-confirm"
                >
                  {mantraRestoringDocId ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  Restore this mantra
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                onClick={() => {
                  setMantraRestoreOpen(false);
                  setMantraRestoreTarget(null);
                  setMantraRestoreResult(null);
                }}
                data-testid="button-restore-manthra-close"
              >
                Close
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Grantha-wide restore */}
      <Dialog open={restoreOpen} onOpenChange={(o) => { if (!restoring) { setRestoreOpen(o); if (!o) setRestoreResult(null); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="w-4 h-4" />
              Restore to Strapi — {selectedGrantha?.GranthaName}
            </DialogTitle>
          </DialogHeader>

          {!restoreResult ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Compares each mantra in this snapshot against live Strapi. Only pushes data where the live record is <strong>missing</strong> content — existing live translations are not overwritten. Use <strong>Shloka translations</strong> when Hermex reports missing Hindi/Kannada/etc. but this snapshot still has full OtherTranslations.
              </p>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">What to restore</p>
                <Select value={restoreField} onValueChange={setRestoreField} disabled={restoring}>
                  <SelectTrigger data-testid="select-restore-field">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="both">Teekas + Bhashyam (both)</SelectItem>
                    <SelectItem value="shloka_ot">Shloka OtherTranslations (missing langs only)</SelectItem>
                    <SelectItem value="all">Teekas + Bhashyam + Shloka OT</SelectItem>
                    <SelectItem value="teekas">Teekas only</SelectItem>
                    <SelectItem value="bhashyam">Bhashyam only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {restoring && restoreProgress && (
                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Restoring manthras…</span>
                    <span>{restoreProgress.current} / {restoreProgress.total} processed</span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                    <div
                      className="h-2 bg-primary rounded-full transition-all duration-500"
                      style={{ width: `${restoreProgress.total > 0 ? Math.round((restoreProgress.current / restoreProgress.total) * 100) : 0}%` }}
                    />
                  </div>
                </div>
              )}
              {restoring && !restoreProgress && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Scanning Strapi for missing content…
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-4 gap-2 text-center">
                {[
                  { label: "Total", value: restoreResult.total, color: "text-foreground" },
                  { label: "Restored", value: restoreResult.restored, color: "text-green-600 dark:text-green-400" },
                  { label: "Skipped", value: restoreResult.skipped, color: "text-muted-foreground" },
                  { label: "Errors", value: restoreResult.errored, color: restoreResult.errored > 0 ? "text-red-500" : "text-muted-foreground" },
                ].map((s) => (
                  <div key={s.label} className="rounded-lg border p-2">
                    <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
                    <p className="text-[10px] text-muted-foreground uppercase">{s.label}</p>
                  </div>
                ))}
              </div>
              {restoreResult.results.filter((r) => !r.action.includes("skipped")).length > 0 && (
                <ScrollArea className="h-40 rounded border">
                  <div className="p-2 space-y-1">
                    {restoreResult.results.filter((r) => !r.action.includes("skipped")).map((r, i) => (
                      <div key={i} className="flex items-start gap-1.5 text-xs">
                        <CheckCircle className="w-3 h-3 text-green-500 flex-shrink-0 mt-0.5" />
                        <span><span className="font-medium">{r.manthra}</span> — {r.action}</span>
                      </div>
                    ))}
                    {restoreResult.errors.map((e, i) => (
                      <div key={i} className="flex items-start gap-1.5 text-xs">
                        <AlertCircle className="w-3 h-3 text-red-500 flex-shrink-0 mt-0.5" />
                        <span><span className="font-medium">{e.manthra}</span> — {e.error}</span>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
              {restoreResult.errored === 0 && restoreResult.restored === 0 && (
                <p className="text-sm text-muted-foreground text-center py-2">
                  All content already present in live Strapi — nothing to restore.
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            {!restoreResult ? (
              <>
                <Button variant="outline" onClick={() => setRestoreOpen(false)} disabled={restoring} data-testid="button-restore-cancel">
                  Cancel
                </Button>
                <Button
                  onClick={() => handleRestore(selectedGrantha!.documentId)}
                  disabled={restoring}
                  data-testid="button-restore-confirm"
                >
                  {restoring ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Restoring…</> : <><RotateCcw className="w-3.5 h-3.5 mr-1.5" />Start Restore</>}
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => { setRestoreOpen(false); setRestoreResult(null); }} data-testid="button-restore-close">
                Close
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
