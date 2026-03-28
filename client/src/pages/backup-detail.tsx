import { useState, useMemo } from "react";
import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  ArrowLeft, BookOpen, ChevronRight, Hash, ScrollText, Download,
  ChevronDown, ChevronUp, Languages, BookMarked, Type,
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
  IASTTransliteration?: string | null;
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
type SectionInfo = { id: number; documentId: string; title: string; type?: string | null; order?: number | null; grantha?: GranthaInfo | null };

type ManthraEntry = {
  id: number;
  documentId: string;
  ShlokaManthraNumber: string;
  order?: number | null;
  Section: SectionInfo;
  ShlokaManthraEntry?: ShlokEntry;
  BhashyamEntry?: ShlokEntry | null;
  Teekas?: TeekaItem[];
  wordMeanings?: WordMeaning[];
};

type BackupData = {
  id: number; label: string; createdAt: string;
  granthaCount: number; sectionCount: number; manthraCount: number;
  data: { granthas: GranthaInfo[]; sections: SectionInfo[]; manthras: ManthraEntry[] };
};

// ── Helpers ────────────────────────────────────────────────────────
function blocksToText(blocks: Block[] | undefined): string {
  if (!blocks?.length) return "";
  return blocks.map((b) => b.children?.map((c) => c.text).join("") ?? "").join("\n").trim();
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
  const hasIAST = !!entry.IASTTransliteration?.trim();
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
          <p className="text-sm italic text-muted-foreground whitespace-pre-wrap leading-relaxed">{entry.IASTTransliteration}</p>
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

function ManthraCard({ manthra }: { manthra: ManthraEntry }) {
  const [expanded, setExpanded] = useState(false);

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
    shloka?.IASTTransliteration || blocksToText(shloka?.EnglishTranslationText) ||
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
            {hasBhashyam && <Badge variant="outline" className="text-[10px]">Bhashyam</Badge>}
            {teekas.length > 0 && <Badge variant="outline" className="text-[10px]">{teekas.length} Teeka{teekas.length > 1 ? "s" : ""}</Badge>}
            {hasExtras && (
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setExpanded((e) => !e)} data-testid={`button-expand-manthra-${manthra.id}`}>
                {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-5 pt-3 pb-4 space-y-4">
        {/* Always visible: Sanskrit */}
        {shloka && <BlockText blocks={shloka.SanskritTextEntry} className="text-sm font-[Noto_Serif_Devanagari,serif]" />}

        {expanded && (
          <>
            {/* Manthra additional fields */}
            {shloka && (shloka.IASTTransliteration || blocksToText(shloka.EnglishTranslationText) || (shloka.OtherTranslations?.length ?? 0) > 0) && (
              <div className="space-y-3 pl-3 border-l-2 border-muted">
                {shloka.IASTTransliteration?.trim() && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5"><Type className="w-3 h-3 text-muted-foreground" /><SectionLabel label="IAST Transliteration" /></div>
                    <p className="text-sm italic text-muted-foreground whitespace-pre-wrap leading-relaxed">{shloka.IASTTransliteration}</p>
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

            {/* Bhashyam */}
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
                    {bhashyam.IASTTransliteration?.trim() && (
                      <div>
                        <div className="flex items-center gap-1.5 mb-1.5"><Type className="w-3 h-3 text-muted-foreground" /><SectionLabel label="IAST" /></div>
                        <p className="text-sm italic text-muted-foreground whitespace-pre-wrap leading-relaxed">{bhashyam.IASTTransliteration}</p>
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

            {/* Teekas */}
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
                      {tk.TeekaEntry && (
                        <EntryBlock entry={tk.TeekaEntry} />
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Word Meanings */}
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
export default function BackupDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [selectedGranthaId, setSelectedGranthaId] = useState<number | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(null);

  const { data: backup, isLoading, error } = useQuery<BackupData>({
    queryKey: ["/api/admin/backups", id, "data"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/backups/${id}/data`);
      if (!res.ok) throw new Error("Failed to load snapshot");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const { granthaList, sectionsByGrantha, manthrasBySection } = useMemo(() => {
    if (!backup) return {
      granthaList: [] as GranthaInfo[],
      sectionsByGrantha: new Map<number, Map<number, SectionInfo>>(),
      manthrasBySection: new Map<number, ManthraEntry[]>(),
    };

    const granthaMap = new Map<number, GranthaInfo>();
    const sectionsByGrantha = new Map<number, Map<number, SectionInfo>>();
    const manthrasBySection = new Map<number, ManthraEntry[]>();

    const sectionGranthaMap = new Map<number, GranthaInfo>();
    for (const sec of backup.data.sections) {
      if (sec.grantha) sectionGranthaMap.set(sec.id, sec.grantha);
    }

    for (const manthra of backup.data.manthras) {
      const sec = manthra.Section;
      if (!sec) continue;
      const grantha = sec.grantha || sectionGranthaMap.get(sec.id) || null;
      const granthaId = grantha?.id ?? -1;
      const granthaInfo: GranthaInfo = grantha ?? { id: -1, documentId: "", GranthaName: "Ungrouped" };

      if (!granthaMap.has(granthaId)) granthaMap.set(granthaId, granthaInfo);
      if (!sectionsByGrantha.has(granthaId)) sectionsByGrantha.set(granthaId, new Map());
      const sections = sectionsByGrantha.get(granthaId)!;
      if (!sections.has(sec.id)) sections.set(sec.id, { ...sec, grantha });
      if (!manthrasBySection.has(sec.id)) manthrasBySection.set(sec.id, []);
      manthrasBySection.get(sec.id)!.push(manthra);
    }

    for (const [, manthras] of manthrasBySection) {
      manthras.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    }

    const granthaList = Array.from(granthaMap.values()).sort((a, b) => {
      if (a.id === -1) return 1;
      if (b.id === -1) return -1;
      return a.GranthaName.localeCompare(b.GranthaName);
    });

    return { granthaList, sectionsByGrantha, manthrasBySection };
  }, [backup]);

  const selectedGrantha = granthaList.find((g) => g.id === selectedGranthaId) ?? null;
  const sections = selectedGranthaId !== null
    ? Array.from(sectionsByGrantha.get(selectedGranthaId)?.values() ?? [])
        .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    : [];
  const selectedSection = sections.find((s) => s.id === selectedSectionId) ?? null;
  const manthras = selectedSectionId !== null ? (manthrasBySection.get(selectedSectionId) ?? []) : [];

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

  if (error || !backup) {
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
            <h1 className="font-semibold" data-testid="page-title-backup-detail">Snapshot #{backup.id}</h1>
            <p className="text-xs text-muted-foreground">
              {new Date(backup.createdAt).toLocaleString()} &middot; {backup.granthaCount} granthas &middot; {backup.sectionCount} sections &middot; {backup.manthraCount} manthras
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
                const sects = Array.from(sectionsByGrantha.get(g.id)?.values() ?? []);
                const mCount = sects.reduce((sum, s) => sum + (manthrasBySection.get(s.id)?.length ?? 0), 0);
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

        {/* Level 2+: Sections + Manthras */}
        {selectedGrantha && (
          <>
            {/* Sections sidebar */}
            <div className="w-64 border-r flex flex-col flex-shrink-0 min-h-0">
              <div className="px-4 py-2.5 border-b flex-shrink-0">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Sections ({sections.length})
                </p>
              </div>
              <ScrollArea className="flex-1">
                <div className="p-2 space-y-0.5">
                  {sections.map((s) => {
                    const count = manthrasBySection.get(s.id)?.length ?? 0;
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
                          <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums">{count}</span>
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
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center text-muted-foreground">
                    <ScrollText className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">Select a section to view its manthras</p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="px-6 py-3 border-b flex-shrink-0 flex items-center justify-between gap-4">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                      {selectedSection.title} — {manthras.length} manthras
                    </p>
                    <p className="text-[10px] text-muted-foreground">Click ↕ on any manthra to expand teekas & translations</p>
                  </div>
                  <ScrollArea className="flex-1">
                    <div className="p-6 space-y-3 max-w-3xl">
                      {manthras.length === 0 && (
                        <p className="text-sm text-muted-foreground">No manthras in this section.</p>
                      )}
                      {manthras.map((m) => <ManthraCard key={m.id} manthra={m} />)}
                    </div>
                  </ScrollArea>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
