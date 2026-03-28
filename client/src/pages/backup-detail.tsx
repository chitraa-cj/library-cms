import { useState, useMemo } from "react";
import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, BookOpen, ChevronRight, Hash, ScrollText, Download } from "lucide-react";

type TextNode = { type: "text"; text: string; bold?: boolean; italic?: boolean };
type Block = { type: string; children: TextNode[] };

type GranthaInfo = {
  id: number;
  documentId: string;
  GranthaName: string;
  GranthaType?: string;
};

type SectionInfo = {
  id: number;
  documentId: string;
  title: string;
  type?: string | null;
  order?: number | null;
  grantha?: GranthaInfo | null;
};

type ManthraEntry = {
  id: number;
  documentId: string;
  ShlokaManthraNumber: string;
  order?: number | null;
  Section: SectionInfo;
  ShlokaManthraEntry?: { SanskritTextEntry: Block[] };
  BhashyamEntry?: { SanskritTextEntry: Block[] };
  wordMeanings?: any[];
  Teekas?: any[];
};

type BackupData = {
  id: number;
  label: string;
  createdAt: string;
  granthaCount: number;
  sectionCount: number;
  manthraCount: number;
  data: {
    granthas: GranthaInfo[];
    sections: SectionInfo[];
    manthras: ManthraEntry[];
  };
};

function renderBlocks(blocks: Block[] | undefined): string {
  if (!blocks || blocks.length === 0) return "";
  return blocks
    .map((b) => b.children?.map((c) => c.text).join("") ?? "")
    .join("\n")
    .trim();
}

function SanskritText({ blocks }: { blocks: Block[] | undefined }) {
  const text = renderBlocks(blocks);
  if (!text) return null;
  return (
    <p className="text-sm whitespace-pre-wrap leading-relaxed font-[Noto_Serif_Devanagari,serif]">
      {text}
    </p>
  );
}

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
    if (!backup) return { granthaList: [], sectionsByGrantha: new Map<number, Map<number, SectionInfo>>(), manthrasBySection: new Map<number, ManthraEntry[]>() };

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
    ? Array.from(sectionsByGrantha.get(selectedGranthaId)?.values() ?? []).sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
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

      {/* Content area */}
      <div className="flex-1 overflow-hidden flex min-h-0">

        {/* Level 1: Grantha list */}
        {!selectedGrantha && (
          <ScrollArea className="flex-1">
            <div className="p-6 max-w-2xl mx-auto space-y-2">
              {granthaList.map((g) => {
                const sects = Array.from(sectionsByGrantha.get(g.id)?.values() ?? []);
                const mCount = sects.reduce((sum, s) => sum + (manthrasBySection.get(s.id)?.length ?? 0), 0);
                return (
                  <button
                    key={g.id}
                    onClick={() => { setSelectedGranthaId(g.id); setSelectedSectionId(null); }}
                    className="w-full text-left"
                    data-testid={`card-grantha-${g.id}`}
                  >
                    <Card className="hover:shadow-sm transition-shadow hover:border-primary/40">
                      <CardContent className="py-3 px-4">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <BookOpen className="w-4 h-4 text-primary flex-shrink-0" />
                            <span className="font-medium text-sm truncate">{g.GranthaName}</span>
                            {g.GranthaType && (
                              <Badge variant="outline" className="text-xs flex-shrink-0">{g.GranthaType}</Badge>
                            )}
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

        {/* Level 2+: Sections sidebar + Manthra content */}
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
                        {s.type && (
                          <p className="text-[10px] text-muted-foreground/60 mt-0.5 capitalize">{s.type}</p>
                        )}
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
                  <div className="px-6 py-3 border-b flex-shrink-0">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                      {selectedSection.title} &mdash; {manthras.length} manthras
                    </p>
                  </div>
                  <ScrollArea className="flex-1">
                    <div className="p-6 space-y-4 max-w-3xl">
                      {manthras.length === 0 && (
                        <p className="text-sm text-muted-foreground">No manthras in this section.</p>
                      )}
                      {manthras.map((m) => {
                        const hasBhashyam = !!renderBlocks(m.BhashyamEntry?.SanskritTextEntry);
                        return (
                          <Card key={m.id} data-testid={`card-manthra-${m.id}`}>
                            <CardHeader className="pb-0 pt-4 px-5">
                              <div className="flex items-center gap-2">
                                <Hash className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                                <CardTitle className="text-sm font-semibold text-primary" data-testid={`text-manthra-num-${m.id}`}>
                                  {m.ShlokaManthraNumber}
                                </CardTitle>
                                {hasBhashyam && (
                                  <Badge variant="outline" className="text-[10px] ml-auto">Bhashyam</Badge>
                                )}
                              </div>
                            </CardHeader>
                            <CardContent className="px-5 pt-3 pb-4 space-y-3">
                              <SanskritText blocks={m.ShlokaManthraEntry?.SanskritTextEntry} />
                              {hasBhashyam && (
                                <>
                                  <Separator />
                                  <div>
                                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Bhashyam</p>
                                    <SanskritText blocks={m.BhashyamEntry?.SanskritTextEntry} />
                                  </div>
                                </>
                              )}
                            </CardContent>
                          </Card>
                        );
                      })}
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
