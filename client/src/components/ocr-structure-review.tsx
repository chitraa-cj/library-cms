/**
 * Visual structural review for an OCR → Grantha analysis.
 *
 * Why this is a text overlay and not boxes on the scan: the OCR engine returns Markdown
 * per page, never coordinates. Drawing boxes would mean inventing them, and a box in the
 * wrong place is worse than no box — so the "overlay" is the transcription itself, with
 * every classified passage tinted by what it was classified as, in page order, next to
 * the hierarchy the classification produced. Selecting either side highlights the other.
 *
 * Every edit here is a `StructureOverride` handed up to the wizard, which persists it and
 * re-reads the assembled structure from the server. Nothing is computed twice: the colours
 * and the tree both come from the same assembly the CSV will be written from.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Combine,
  Eraser,
  MoveDown,
  MoveUp,
  Scissors,
  Undo2,
  Wand2,
} from "lucide-react";
import {
  STRUCTURE_ITEM_KINDS,
  STRUCTURE_SCRIPTS,
  sectionLevelNames,
  type AssembledVerse,
  type StructureHierarchyConfig,
  type StructureItem,
  type StructureItemKind,
  type StructureOverride,
} from "@shared/ocr-structure";
import { translationLanguages } from "@shared/schema";

/** One palette, used by the legend, the blocks and the tree, so colours mean one thing. */
const KIND_STYLES: Record<string, { label: string; bar: string; chip: string; tint: string }> = {
  "section-1": {
    label: "Level 1 heading",
    bar: "bg-violet-500",
    chip: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    tint: "bg-violet-500/5",
  },
  "section-2": {
    label: "Level 2 heading",
    bar: "bg-sky-500",
    chip: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
    tint: "bg-sky-500/5",
  },
  "section-3": {
    label: "Level 3 heading",
    bar: "bg-teal-500",
    chip: "bg-teal-500/15 text-teal-700 dark:text-teal-300",
    tint: "bg-teal-500/5",
  },
  verse: {
    label: "Entry (verse/mantra)",
    bar: "bg-emerald-500",
    chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    tint: "bg-emerald-500/5",
  },
  bhashyam: {
    label: "Bhashyam",
    bar: "bg-amber-500",
    chip: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    tint: "bg-amber-500/5",
  },
  teeka: {
    label: "Teeka",
    bar: "bg-orange-500",
    chip: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
    tint: "bg-orange-500/5",
  },
  translation: {
    label: "Translation",
    bar: "bg-blue-500",
    chip: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
    tint: "bg-blue-500/5",
  },
  prose: {
    label: "Prose (not imported)",
    bar: "bg-slate-400",
    chip: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
    tint: "bg-slate-500/5",
  },
  footnote: {
    label: "Footnote (not imported)",
    bar: "bg-slate-400",
    chip: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
    tint: "bg-slate-500/5",
  },
  ignored: {
    label: "Page furniture",
    bar: "bg-muted",
    chip: "bg-muted text-muted-foreground",
    tint: "",
  },
  uncertain: {
    label: "Uncertain — needs a look",
    bar: "bg-rose-500",
    chip: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
    tint: "bg-rose-500/10",
  },
};

function styleKeyFor(item: StructureItem): string {
  if (item.kind === "section") return `section-${Math.min(3, Math.max(1, item.level ?? 1))}`;
  return item.kind;
}

const SCRIPT_LABELS: Record<string, string> = {
  devanagari: "Devanagari → Sanskrit field",
  iast: "IAST → transliteration field",
  english: "English → English field",
  other: "Other script → Sanskrit field",
};

const PAGE_WINDOW = 12;

interface Props {
  config: StructureHierarchyConfig;
  items: StructureItem[];
  verses: AssembledVerse[];
  unassigned: Array<{ item: StructureItem; reason: string }>;
  confidenceThreshold: number;
  /** Appends edits. The wizard persists them and re-reads the structure. */
  onOverrides: (overrides: StructureOverride[]) => void;
  busy?: boolean;
}

export default function OcrStructureReview({
  config,
  items,
  verses,
  unassigned,
  confidenceThreshold,
  onOverrides,
  busy,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "uncertain" | "unassigned">("all");
  const [search, setSearch] = useState("");
  const [pageFrom, setPageFrom] = useState(0);
  const [draftText, setDraftText] = useState<string>("");
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());
  const blockRefs = useRef(new Map<string, HTMLDivElement>());
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const unassignedIds = useMemo(() => new Set(unassigned.map((u) => u.item.id)), [unassigned]);
  const selected = useMemo(() => items.find((i) => i.id === selectedId) ?? null, [items, selectedId]);

  useEffect(() => {
    setDraftText(selected?.text ?? "");
  }, [selectedId, selected?.text]);

  const pages = useMemo(() => {
    const set = new Set<number>();
    for (const item of items) set.add(item.page);
    return [...set].sort((a, b) => a - b);
  }, [items]);

  const visiblePages = useMemo(
    () => pages.slice(pageFrom, pageFrom + PAGE_WINDOW),
    [pages, pageFrom],
  );

  const matches = (item: StructureItem): boolean => {
    if (filter === "uncertain" && item.confidence >= confidenceThreshold) return false;
    if (filter === "unassigned" && !unassignedIds.has(item.id)) return false;
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
      const hay = `${item.text ?? ""} ${item.title ?? ""} ${item.number ?? ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  };

  const byPage = useMemo(() => {
    const map = new Map<number, StructureItem[]>();
    for (const item of items) {
      if (!matches(item)) continue;
      const list = map.get(item.page);
      if (list) list.push(item);
      else map.set(item.page, [item]);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, filter, search, unassignedIds, confidenceThreshold]);

  /** Jump to (and select) a block, pulling its page into the window first. */
  function revealItem(id: string) {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    const index = pages.indexOf(item.page);
    if (index >= 0 && (index < pageFrom || index >= pageFrom + PAGE_WINDOW)) {
      setPageFrom(Math.max(0, index - 2));
    }
    setSelectedId(id);
    // After the window moves, the node exists on the next frame.
    requestAnimationFrame(() => {
      blockRefs.current.get(id)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  type EditPatch = Extract<StructureOverride, { op: "edit" }>["patch"];
  function edit(id: string, patch: EditPatch) {
    onOverrides([{ op: "edit", id, patch }]);
  }

  /**
   * Apply the same reclassification to every other block the document currently reads the
   * same way (same kind, same script). Opt-in and counted, never automatic: a repeated
   * layout is exactly where one correction should fix fifty, and exactly where a silent
   * bulk change would be unreviewable.
   */
  function similarTo(item: StructureItem): StructureItem[] {
    return items.filter(
      (other) =>
        other.id !== item.id &&
        other.kind === item.kind &&
        (other.script ?? "") === (item.script ?? "") &&
        other.kind !== "section",
    );
  }

  const sectionNames = sectionLevelNames(config);
  const languageOptions = useMemo(() => [...translationLanguages], []);

  // ── hierarchy tree ──
  const tree = useMemo(() => {
    const roots = new Map<string, { label: string; verses: AssembledVerse[] }>();
    for (const verse of verses) {
      const key = verse.path.join(" › ") || "(no sections)";
      const label =
        verse.path.length === 0
          ? "(no sections)"
          : verse.path
              .map((num, i) => `${sectionNames[i] ?? `L${i + 1}`} ${num}${verse.pathTitles[i] ? ` — ${verse.pathTitles[i]}` : ""}`)
              .join("  ›  ");
      const node = roots.get(key);
      if (node) node.verses.push(verse);
      else roots.set(key, { label, verses: [verse] });
    }
    return [...roots.entries()].map(([key, node]) => ({ key, ...node }));
  }, [verses, sectionNames]);

  return (
    <div className="space-y-3">
      {/* ── legend + filters ── */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-2.5 text-xs">
        {["section-1", "section-2", "section-3", "verse", "bhashyam", "teeka", "translation", "prose", "uncertain"]
          .filter((key) => !key.startsWith("section-") || Number(key.slice(-1)) <= sectionNames.length)
          .map((key) => (
            <span key={key} className="inline-flex items-center gap-1.5">
              <span className={`h-2.5 w-4 rounded-sm ${KIND_STYLES[key].bar}`} />
              {key.startsWith("section-")
                ? `${sectionNames[Number(key.slice(-1)) - 1] ?? KIND_STYLES[key].label}`
                : KIND_STYLES[key].label}
            </span>
          ))}
        <Separator orientation="vertical" className="mx-1 h-4" />
        <div className="flex items-center gap-1.5">
          <Select value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
            <SelectTrigger className="h-7 w-[170px] text-xs" data-testid="structure-review-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All passages</SelectItem>
              <SelectItem value="uncertain">Uncertain only</SelectItem>
              <SelectItem value="unassigned">Not imported only</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search the source…"
            className="h-7 w-[200px] text-xs"
            data-testid="structure-review-search"
          />
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* ── proposed hierarchy ── */}
        <div className="max-h-[62vh] space-y-1 overflow-y-auto rounded-md border border-border p-2">
          <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">
            Proposed hierarchy — {verses.length} entr{verses.length === 1 ? "y" : "ies"}
          </p>
          {tree.length === 0 && (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">
              No entries were detected yet.
            </p>
          )}
          {tree.map((node) => {
            const collapsed = collapsedPaths.has(node.key);
            return (
              <div key={node.key} className="rounded-sm">
                <button
                  className="flex w-full items-start gap-1 rounded-sm px-1 py-1 text-left text-xs font-medium hover:bg-accent"
                  onClick={() =>
                    setCollapsedPaths((prev) => {
                      const next = new Set(prev);
                      if (next.has(node.key)) next.delete(node.key);
                      else next.add(node.key);
                      return next;
                    })
                  }
                >
                  {collapsed ? (
                    <ChevronRight className="mt-0.5 h-3 w-3 shrink-0" />
                  ) : (
                    <ChevronDown className="mt-0.5 h-3 w-3 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 break-words">{node.label}</span>
                  <span className="text-muted-foreground">{node.verses.length}</span>
                </button>
                {!collapsed && (
                  <ul className="ml-4 space-y-0.5 border-l border-border pl-2">
                    {node.verses.map((verse) => (
                      <li key={verse.key}>
                        <button
                          className={`flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-xs hover:bg-accent ${
                            verse.itemIds.includes(selectedId ?? "") ? "bg-accent" : ""
                          }`}
                          onClick={() => revealItem(verse.itemIds[0])}
                          title={`Page ${verse.page} · CSV number ${verse.csvNumber}`}
                          data-testid={`structure-tree-verse-${verse.csvNumber}`}
                        >
                          <span className={`h-2 w-2 shrink-0 rounded-full ${KIND_STYLES.verse.bar}`} />
                          <span className="min-w-0 flex-1 truncate">
                            {verse.number || "(unnumbered)"}
                          </span>
                          {verse.bhashyam.itemIds.length > 0 && (
                            <span className={`h-2 w-2 shrink-0 rounded-full ${KIND_STYLES.bhashyam.bar}`} title="has bhashyam" />
                          )}
                          {verse.teekas.length > 0 && (
                            <span className={`h-2 w-2 shrink-0 rounded-full ${KIND_STYLES.teeka.bar}`} title={`${verse.teekas.length} teeka(s)`} />
                          )}
                          {verse.warnings.length > 0 && (
                            <span title={verse.warnings.join("\n")}>
                              <AlertTriangle className="h-3 w-3 shrink-0 text-amber-600" />
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>

        {/* ── source overlay ── */}
        <div className="space-y-2">
          {pages.length > PAGE_WINDOW && (
            <div className="flex items-center justify-between gap-2 text-xs">
              <Button
                variant="outline"
                size="sm"
                disabled={pageFrom === 0}
                onClick={() => setPageFrom((p) => Math.max(0, p - PAGE_WINDOW))}
              >
                Earlier pages
              </Button>
              <span className="text-muted-foreground">
                Pages {visiblePages[0] ?? 0}–{visiblePages[visiblePages.length - 1] ?? 0} of{" "}
                {pages[pages.length - 1] ?? 0}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={pageFrom + PAGE_WINDOW >= pages.length}
                onClick={() => setPageFrom((p) => Math.min(pages.length - 1, p + PAGE_WINDOW))}
              >
                Later pages
              </Button>
            </div>
          )}

          <div className="max-h-[62vh] space-y-4 overflow-y-auto rounded-md border border-border bg-muted/20 p-3">
            {visiblePages.map((page) => {
              const pageItems = byPage.get(page) ?? [];
              if (pageItems.length === 0) return null;
              return (
                <section key={page} className="space-y-1.5">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Page {page}
                  </p>
                  {pageItems.map((item) => {
                    const key = styleKeyFor(item);
                    const uncertain = item.confidence < confidenceThreshold;
                    const style = KIND_STYLES[key] ?? KIND_STYLES.prose;
                    const isSelected = item.id === selectedId;
                    const parked = unassignedIds.has(item.id);
                    return (
                      <div
                        key={item.id}
                        ref={(node) => {
                          if (node) blockRefs.current.set(item.id, node);
                          else blockRefs.current.delete(item.id);
                        }}
                        className={`rounded-md border bg-background ${
                          isSelected ? "border-primary ring-1 ring-primary/40" : "border-border"
                        }`}
                        data-testid={`structure-block-${item.id}`}
                      >
                        <button
                          className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left ${
                            uncertain ? KIND_STYLES.uncertain.tint : style.tint
                          }`}
                          onClick={() => setSelectedId(isSelected ? null : item.id)}
                        >
                          <span
                            className={`mt-0.5 w-1 shrink-0 self-stretch rounded-full ${
                              uncertain ? KIND_STYLES.uncertain.bar : style.bar
                            }`}
                          />
                          <span className="min-w-0 flex-1 space-y-1">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <Badge className={`border-0 text-[10px] ${uncertain ? KIND_STYLES.uncertain.chip : style.chip}`}>
                                {item.kind === "section"
                                  ? `${sectionNames[(item.level ?? 1) - 1] ?? `Level ${item.level}`} heading`
                                  : item.kind === "teeka"
                                    ? `Teeka — ${item.teekaName || "unnamed"}`
                                    : item.kind === "translation"
                                      ? `Translation — ${item.language || "unknown"}`
                                      : style.label}
                              </Badge>
                              {item.number && (
                                <span className="text-[11px] font-medium text-muted-foreground">#{item.number}</span>
                              )}
                              {item.script && (
                                <span className="text-[11px] text-muted-foreground">{item.script}</span>
                              )}
                              <span className="text-[11px] text-muted-foreground">
                                {Math.round(item.confidence * 100)}%
                              </span>
                              {item.edited && (
                                <Badge variant="outline" className="text-[10px]">
                                  edited
                                </Badge>
                              )}
                              {parked && (
                                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                                  not imported
                                </Badge>
                              )}
                            </span>
                            <span className="block whitespace-pre-wrap break-words text-[13px] leading-relaxed">
                              {item.kind === "section" ? item.title || item.number : item.text}
                            </span>
                            {item.note && (
                              <span className="block text-[11px] italic text-muted-foreground">{item.note}</span>
                            )}
                          </span>
                        </button>

                        {isSelected && (
                          <div className="space-y-3 border-t border-border p-2.5">
                            <div className="grid gap-2 sm:grid-cols-2">
                              <div className="space-y-1">
                                <Label className="text-xs">Content type</Label>
                                <Select
                                  value={item.kind}
                                  onValueChange={(value) =>
                                    edit(item.id, { kind: value as StructureItemKind })
                                  }
                                >
                                  <SelectTrigger className="h-8 text-xs">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {STRUCTURE_ITEM_KINDS.map((kind) => (
                                      <SelectItem key={kind} value={kind}>
                                        {kind === "section"
                                          ? "Section heading"
                                          : kind === "verse"
                                            ? `Entry (${config.levelNames[config.depth - 1]})`
                                            : kind}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>

                              {item.kind === "section" ? (
                                <div className="space-y-1">
                                  <Label className="text-xs">Hierarchy level</Label>
                                  <Select
                                    value={String(item.level ?? 1)}
                                    onValueChange={(value) => edit(item.id, { level: Number(value) })}
                                  >
                                    <SelectTrigger className="h-8 text-xs">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {sectionNames.map((name, i) => (
                                        <SelectItem key={i} value={String(i + 1)}>
                                          Level {i + 1} — {name}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                              ) : (
                                <div className="space-y-1">
                                  <Label className="text-xs">Script / target field</Label>
                                  <Select
                                    value={item.script ?? "devanagari"}
                                    onValueChange={(value) => edit(item.id, { script: value as StructureItem["script"] })}
                                  >
                                    <SelectTrigger className="h-8 text-xs">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {STRUCTURE_SCRIPTS.map((script) => (
                                        <SelectItem key={script} value={script}>
                                          {SCRIPT_LABELS[script]}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                              )}

                              <div className="space-y-1">
                                <Label className="text-xs">
                                  {item.kind === "section" ? "Section number" : "Entry number"}
                                </Label>
                                <Input
                                  className="h-8 text-xs"
                                  defaultValue={item.number ?? ""}
                                  key={`num-${item.id}-${item.number ?? ""}`}
                                  placeholder="e.g. 12"
                                  onBlur={(e) => {
                                    const next = e.target.value.trim();
                                    if (next !== (item.number ?? "")) edit(item.id, { number: next });
                                  }}
                                />
                              </div>

                              {item.kind === "section" && (
                                <div className="space-y-1">
                                  <Label className="text-xs">Heading text</Label>
                                  <Input
                                    className="h-8 text-xs"
                                    defaultValue={item.title ?? ""}
                                    key={`title-${item.id}-${item.title ?? ""}`}
                                    onBlur={(e) => {
                                      const next = e.target.value;
                                      if (next !== (item.title ?? "")) edit(item.id, { title: next });
                                    }}
                                  />
                                </div>
                              )}

                              {(item.kind === "bhashyam" || item.kind === "teeka" || item.kind === "translation") && (
                                <div className="space-y-1">
                                  <Label className="text-xs">Belongs to</Label>
                                  <Select
                                    value={item.attachTo ?? "previous_verse"}
                                    onValueChange={(value) => edit(item.id, { attachTo: value as StructureItem["attachTo"] })}
                                  >
                                    <SelectTrigger className="h-8 text-xs">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="previous_verse">The entry above it</SelectItem>
                                      <SelectItem value="section">
                                        The section (not imported onto an entry)
                                      </SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                              )}

                              {item.kind === "teeka" && (
                                <div className="space-y-1">
                                  <Label className="text-xs">Teeka name</Label>
                                  <Input
                                    className="h-8 text-xs"
                                    defaultValue={item.teekaName ?? ""}
                                    key={`teeka-${item.id}-${item.teekaName ?? ""}`}
                                    onBlur={(e) => {
                                      const next = e.target.value.trim();
                                      if (next !== (item.teekaName ?? "")) edit(item.id, { teekaName: next });
                                    }}
                                  />
                                </div>
                              )}

                              {item.kind === "translation" && (
                                <div className="space-y-1">
                                  <Label className="text-xs">Language</Label>
                                  <Select
                                    value={item.language ?? "English"}
                                    onValueChange={(value) => edit(item.id, { language: value })}
                                  >
                                    <SelectTrigger className="h-8 text-xs">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent className="max-h-60">
                                      {languageOptions.map((language) => (
                                        <SelectItem key={language} value={language}>
                                          {language}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                              )}
                            </div>

                            {item.kind !== "section" && (
                              <div className="space-y-1">
                                <div className="flex items-center justify-between">
                                  <Label className="text-xs">
                                    Source text {item.edited ? "(edited)" : "(as transcribed)"}
                                  </Label>
                                  {item.originalText != null && item.originalText !== item.text && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 text-[11px]"
                                      onClick={() => edit(item.id, { text: item.originalText })}
                                    >
                                      <Undo2 className="mr-1 h-3 w-3" /> Restore transcription
                                    </Button>
                                  )}
                                </div>
                                <Textarea
                                  ref={textareaRef}
                                  rows={4}
                                  className="font-serif text-[13px]"
                                  value={draftText}
                                  onChange={(e) => setDraftText(e.target.value)}
                                  onBlur={() => {
                                    if (draftText !== (item.text ?? "")) edit(item.id, { text: draftText });
                                  }}
                                />
                              </div>
                            )}

                            <div className="flex flex-wrap items-center gap-1.5">
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-[11px]"
                                disabled={busy || item.kind === "section"}
                                onClick={() => {
                                  const at = textareaRef.current?.selectionStart ?? 0;
                                  if (at > 0 && at < draftText.length) {
                                    onOverrides([{ op: "split", id: item.id, at }]);
                                  }
                                }}
                                title="Split this block at the cursor position in the text above"
                              >
                                <Scissors className="mr-1 h-3 w-3" /> Split at cursor
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-[11px]"
                                disabled={busy}
                                onClick={() => onOverrides([{ op: "merge", id: item.id }])}
                                title="Fold this block into the block above it (same type only)"
                              >
                                <Combine className="mr-1 h-3 w-3" /> Merge up
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-[11px]"
                                disabled={busy}
                                onClick={() => {
                                  const index = items.findIndex((i) => i.id === item.id);
                                  if (index > 0) {
                                    const target = index >= 2 ? items[index - 2].id : null;
                                    onOverrides([{ op: "move", id: item.id, after: target }]);
                                  }
                                }}
                              >
                                <MoveUp className="mr-1 h-3 w-3" /> Move up
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-[11px]"
                                disabled={busy}
                                onClick={() => {
                                  const index = items.findIndex((i) => i.id === item.id);
                                  if (index >= 0 && index < items.length - 1) {
                                    onOverrides([{ op: "move", id: item.id, after: items[index + 1].id }]);
                                  }
                                }}
                              >
                                <MoveDown className="mr-1 h-3 w-3" /> Move down
                              </Button>
                              {item.kind !== "section" && similarTo(item).length > 0 && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-[11px]"
                                  disabled={busy}
                                  onClick={() => {
                                    const similar = similarTo(item);
                                    if (
                                      !confirm(
                                        `Apply "${item.kind}${item.script ? ` / ${item.script}` : ""}" → the type you just chose to ${similar.length} other block(s) the document currently reads the same way?`,
                                      )
                                    )
                                      return;
                                    onOverrides(
                                      similar.map((other) => ({
                                        op: "edit" as const,
                                        id: other.id,
                                        patch: {
                                          kind: item.kind,
                                          script: item.script,
                                          attachTo: item.attachTo,
                                          teekaName: item.teekaName,
                                          language: item.language,
                                        },
                                      })),
                                    );
                                  }}
                                  title="Apply this classification to every other block of the same current type"
                                >
                                  <Wand2 className="mr-1 h-3 w-3" /> Apply to {similarTo(item).length} similar
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-[11px] text-destructive"
                                disabled={busy}
                                onClick={() => {
                                  if (confirm("Leave this passage out of the import?")) {
                                    onOverrides([{ op: "delete", id: item.id }]);
                                    setSelectedId(null);
                                  }
                                }}
                              >
                                <Eraser className="mr-1 h-3 w-3" /> Exclude
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </section>
              );
            })}
            {visiblePages.every((page) => (byPage.get(page) ?? []).length === 0) && (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No passages match the current filter.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
