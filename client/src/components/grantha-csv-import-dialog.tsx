import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Upload, Plus, Trash2, FileSpreadsheet, AlertCircle, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  duplicateVerseNumberGroups,
  missingLeadingSectionNumbers,
  sectionPathTokens,
} from "@/lib/grantha-csv-placement";
import {
  buildCoreTargets,
  buildImportPayload,
  buildTokenCounts,
  flattenTree,
  guessNumberColumn,
  parseCsv,
  planCsvRows,
  type AdhyayaNodeShape,
  type CoreTargetKey,
  type FieldMapping,
  type GranthaCsvImportPayload,
  type GranthaCsvPlacement,
  type GranthaCsvTargetRef,
  type PlanRow,
  type Scope,
  type TeekaDefShape,
  type TranslationMapRow,
} from "@/lib/grantha-csv-import";
import { translationLanguages } from "@shared/schema";

/** Structure-level names/toggles the dialog needs for its labels and level cap. */
interface StructureConfigShape {
  levelTwoEnabled: boolean;
  levelThreeEnabled: boolean;
  levelOneName: string;
  levelTwoName: string;
  levelThreeName: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adhyayas: AdhyayaNodeShape[];
  teekas: TeekaDefShape[];
  structureConfig: StructureConfigShape;
  /** Applies the mapped content into the editor tree (updates + creates). */
  onApply: (payload: GranthaCsvImportPayload) => void;
}

const SKIP = "__skip__";
const AUTO_TARGET = "__auto__";

export default function GranthaCsvImportDialog({
  open,
  onOpenChange,
  adhyayas,
  teekas,
  structureConfig,
  onApply,
}: Props) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState<string>("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [parseError, setParseError] = useState<string>("");

  // Mapping state
  const [numberColumn, setNumberColumn] = useState<number | null>(null);
  const [coreMapping, setCoreMapping] = useState<Record<string, number | null>>({});
  const [translationRows, setTranslationRows] = useState<TranslationMapRow[]>([]);
  const [matchMode, setMatchMode] = useState<"number" | "sequential">("number");
  const [trSeq, setTrSeq] = useState(0); // stable id source for translation rows

  // Missing-verse handling
  const [onMissing, setOnMissing] = useState<"create" | "skip">("create");
  const [placementMode, setPlacementMode] = useState<"single" | "group">("single");
  const [placementModeTouched, setPlacementModeTouched] = useState(false);
  const [targetKey, setTargetKey] = useState<string>("");
  const [sectionLevels, setSectionLevels] = useState<number>(1);
  const [sectionLevelsTouched, setSectionLevelsTouched] = useState(false);

  // Range (for updating existing verses)
  const [rangeFrom, setRangeFrom] = useState<string>("");
  const [rangeTo, setRangeTo] = useState<string>("");

  const flat = useMemo(() => flattenTree(adhyayas), [adhyayas]);

  // Default range to first..last once the tree is known.
  useEffect(() => {
    if (flat.length === 0) { setRangeFrom(""); setRangeTo(""); return; }
    setRangeFrom((cur) => (cur && flat.some((f) => f.manthraId === cur) ? cur : flat[0].manthraId));
    setRangeTo((cur) => (cur && flat.some((f) => f.manthraId === cur) ? cur : flat[flat.length - 1].manthraId));
  }, [flat]);

  // Append-target options (existing leaf containers, plus auto-create fallbacks).
  const targetOptions = useMemo(() => {
    const opts: { key: string; label: string; ref: GranthaCsvTargetRef }[] = [];
    for (const a of adhyayas) {
      const khandas = a.khandas ?? [];
      if (khandas.length === 0) {
        opts.push({ key: `a:${a.id}`, label: `${a.title || "Chapter"} → (new section)`, ref: { adhyayaId: a.id, khandaId: null } });
        continue;
      }
      for (const k of khandas) {
        const padas = k.padas ?? [];
        if (structureConfig.levelThreeEnabled && padas.length > 0) {
          for (const p of padas) {
            opts.push({
              key: `p:${a.id}:${k.id}:${p.id}`,
              label: `${a.title} › ${k.title} › ${p.title}`,
              ref: { adhyayaId: a.id, khandaId: k.id, padaId: p.id },
            });
          }
        } else {
          opts.push({
            key: `k:${a.id}:${k.id}`,
            label: `${a.title} › ${k.title}`,
            ref: { adhyayaId: a.id, khandaId: k.id },
          });
        }
      }
    }
    if (opts.length === 0) {
      opts.push({ key: AUTO_TARGET, label: "New chapter & section (auto-created)", ref: { adhyayaId: null, khandaId: null } });
    }
    return opts;
  }, [adhyayas, structureConfig.levelThreeEnabled]);

  // Default the target selection to the first available option.
  useEffect(() => {
    if (targetOptions.length === 0) return;
    setTargetKey((cur) => (cur && targetOptions.some((o) => o.key === cur) ? cur : targetOptions[0].key));
  }, [targetOptions]);

  const coreTargets: CoreTargetKey[] = useMemo(() => buildCoreTargets(teekas), [teekas]);

  const scopeOptions = useMemo(() => {
    const opts: { value: Scope; label: string }[] = [
      { value: "shloka", label: "Shloka" },
      { value: "bhashyam", label: "Bhashyam" },
    ];
    for (const tk of teekas) opts.push({ value: tk.id, label: `${tk.TeekaName || tk.TeekaAuthor || "Teeka"} (Teeka)` });
    return opts;
  }, [teekas]);

  function resetMapping() {
    setNumberColumn(null);
    setCoreMapping({});
    setTranslationRows([]);
  }

  function handleFile(file: File) {
    setParseError("");
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseCsv(String(reader.result ?? ""));
        if (parsed.length < 2) {
          setParseError("The CSV needs a header row and at least one data row.");
          setHeaders([]); setRows([]);
          return;
        }
        const hdr = parsed[0].map((h) => h.trim());
        setHeaders(hdr);
        setRows(parsed.slice(1));
        setFileName(file.name);
        resetMapping();
        const guess = guessNumberColumn(hdr);
        if (guess >= 0) setNumberColumn(guess);
      } catch (e: any) {
        setParseError(e?.message || "Failed to parse the CSV file.");
      }
    };
    reader.onerror = () => setParseError("Could not read the file.");
    reader.readAsText(file);
  }

  // Verses inside the selected range (inclusive), in tree order.
  const rangeVerses = useMemo(() => {
    if (flat.length === 0) return [];
    const fromOrd = flat.find((f) => f.manthraId === rangeFrom)?.ordinal ?? flat[0].ordinal;
    const toOrd = flat.find((f) => f.manthraId === rangeTo)?.ordinal ?? flat[flat.length - 1].ordinal;
    const lo = Math.min(fromOrd, toOrd);
    const hi = Math.max(fromOrd, toOrd);
    return flat.filter((f) => f.ordinal >= lo && f.ordinal <= hi);
  }, [flat, rangeFrom, rangeTo]);

  const rangeIds = useMemo(() => new Set(rangeVerses.map((v) => v.manthraId)), [rangeVerses]);

  const tokenCounts = useMemo(() => buildTokenCounts(flat), [flat]);

  // Classify each CSV data row: update existing / create new / skip.
  const plan = useMemo<PlanRow[]>(
    () =>
      planCsvRows({
        rows,
        numberColumn,
        matchMode,
        onMissing,
        flat,
        rangeVerses,
        rangeIds,
        tokenCounts,
      }),
    [rows, matchMode, rangeVerses, rangeIds, flat, numberColumn, onMissing, tokenCounts],
  );

  const updateCount = plan.filter((p) => p.action === "update").length;
  const createCount = plan.filter((p) => p.action === "create").length;
  const importableCount = updateCount + createCount;

  const mappedFieldCount =
    Object.values(coreMapping).filter((v) => v != null).length +
    translationRows.filter((r) => r.column != null && r.language).length;

  // Grouping: how many leading number tokens may form the section path.
  const maxSectionLevels = structureConfig.levelThreeEnabled
    ? 3
    : structureConfig.levelTwoEnabled
      ? 2
      : 1;

  const createNumbers = useMemo(
    () => plan.filter((p) => p.action === "create").map((p) => p.rowNumber),
    [plan],
  );

  // Default section-levels = (segments − 1), clamped — until the user overrides.
  useEffect(() => {
    if (sectionLevelsTouched || createNumbers.length === 0) return;
    const maxTokens = createNumbers.reduce((m, n) => Math.max(m, sectionPathTokens(n).length), 1);
    const def = Math.min(Math.max(maxTokens - 1, 1), maxSectionLevels);
    setSectionLevels(def);
  }, [createNumbers, maxSectionLevels, sectionLevelsTouched]);

  // Default placement to "group" when verse numbers are prefixed (e.g. "5.1"), so
  // an adhyaya-wise file routes each verse into its own chapter by the leading
  // number instead of appending everything onto whichever section is first — which
  // silently merged one adhyaya into the previous one. Explicit user choice wins.
  useEffect(() => {
    if (placementModeTouched || createNumbers.length === 0 || maxSectionLevels < 1) return;
    const prefixed = createNumbers.some((n) => sectionPathTokens(n).length >= 2);
    setPlacementMode(prefixed ? "group" : "single");
  }, [createNumbers, maxSectionLevels, placementModeTouched]);

  // Preview: distinct section paths the create rows resolve to.
  const groupPreview = useMemo(() => {
    const paths = new Set<string>();
    for (const n of createNumbers) {
      const toks = sectionPathTokens(n);
      const path = Array.from({ length: sectionLevels }, (_, i) => toks[i] ?? "1");
      paths.add(path.join(" › "));
    }
    return Array.from(paths);
  }, [createNumbers, sectionLevels]);

  // Section numbers the file never fills (numbers 1.x, 2.x, 5.x → 3 and 4 are missing).
  // Almost always a truncated export or the wrong number column: importing it leaves
  // sections whose ordinal name no longer matches their position, so say so up front.
  const sectionNumberGaps = useMemo(
    () => (placementMode === "group" ? missingLeadingSectionNumbers(createNumbers) : []),
    [createNumbers, placementMode],
  );

  // Verse numbers that collide once their digits are compared. Two rows numbered "1.1",
  // or "1.1" next to "1.1a": saving renumbers the odd one out from its position, which
  // lands it straight on its neighbour's number, and publish then has two verses fighting
  // over one CMS row. Caught here, before any of it is written.
  const duplicateNumbers = useMemo(
    () => duplicateVerseNumberGroups(createNumbers),
    [createNumbers],
  );

  const fieldMapping: FieldMapping = { coreTargets, coreMapping, translationRows, teekas };

  function currentPlacement(): GranthaCsvPlacement | null {
    if (onMissing !== "create") return null;
    if (placementMode === "group") return { mode: "group", sectionLevels };
    const target: GranthaCsvTargetRef | null =
      targetOptions.find((o) => o.key === targetKey)?.ref ?? targetOptions[0]?.ref ?? null;
    return target ? { mode: "single", target } : null;
  }

  function handleImport() {
    if (matchMode === "number" && numberColumn == null) {
      toast({ variant: "destructive", title: "Pick the verse-number column", description: "Needed to match/number verses." });
      return;
    }
    if (mappedFieldCount === 0) {
      toast({ variant: "destructive", title: "Map at least one field", description: "Choose which column fills which grantha field." });
      return;
    }
    const payload = buildImportPayload({
      plan,
      rows,
      mapping: fieldMapping,
      placement: currentPlacement(),
    });
    if (payload.updates.length === 0 && payload.creates.length === 0) {
      toast({ variant: "destructive", title: "Nothing to import", description: "No rows produced any content to import." });
      return;
    }
    onApply(payload);
    const parts: string[] = [];
    if (payload.updates.length) parts.push(`updated ${payload.updates.length}`);
    if (payload.creates.length) parts.push(`created ${payload.creates.length}`);
    toast({
      title: "CSV imported into draft",
      description: `Verses ${parts.join(", ")}. Review, then Save or Save & Publish.`,
    });
    onOpenChange(false);
  }

  const hasData = headers.length > 0 && rows.length > 0;
  const showCreateUI = matchMode === "number";

  const columnItems = (
    <>
      {headers.map((h, i) => (
        <SelectItem key={i} value={String(i)}>{h || `Column ${i + 1}`}</SelectItem>
      ))}
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl w-[calc(100vw-2rem)] max-h-[92vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-primary" />
            Import verses from CSV
          </DialogTitle>
          <DialogDescription>
            Upload a CSV, map each column to a grantha field, choose how rows match,
            then import. Content is written into the current draft — nothing is saved
            until you Save or Save &amp; Publish.
          </DialogDescription>
        </DialogHeader>

        {/* ── Step 1: file ── */}
        <section className="space-y-2 min-w-0">
          <div className="flex items-center gap-3 min-w-0">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
              data-testid="input-csv-file"
            />
            <Button variant="outline" className="shrink-0" onClick={() => fileInputRef.current?.click()} data-testid="button-choose-csv">
              <Upload className="w-4 h-4 mr-2" />
              {fileName ? "Choose a different file" : "Choose CSV file"}
            </Button>
            {fileName && (
              <span className="text-sm text-muted-foreground truncate min-w-0">
                {fileName} — {headers.length} columns, {rows.length} rows
              </span>
            )}
          </div>
          {parseError && (
            <Alert variant="destructive">
              <AlertCircle className="w-4 h-4" />
              <AlertTitle>Could not read CSV</AlertTitle>
              <AlertDescription>{parseError}</AlertDescription>
            </Alert>
          )}
        </section>

        {hasData && (
          <>
            {/* ── Step 2: matching strategy + number column ── */}
            <section className="space-y-3 border-t pt-4 min-w-0">
              <h4 className="text-sm font-semibold">How should rows match verses?</h4>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 min-w-0">
                <Select value={matchMode} onValueChange={(v) => setMatchMode(v as any)}>
                  <SelectTrigger className="w-60 shrink-0" data-testid="select-match-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="number">By verse number (recommended)</SelectItem>
                    <SelectItem value="sequential">Sequentially down the range</SelectItem>
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-2 min-w-0">
                  <Label className="text-xs whitespace-nowrap">Verse-number column</Label>
                  <Select
                    value={numberColumn == null ? SKIP : String(numberColumn)}
                    onValueChange={(v) => setNumberColumn(v === SKIP ? null : Number(v))}
                  >
                    <SelectTrigger className="w-48" data-testid="select-number-column">
                      <SelectValue placeholder="Select column" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SKIP}>— none —</SelectItem>
                      {columnItems}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </section>

            {/* ── Step 3: missing-verse handling (number mode only) ── */}
            {showCreateUI && (
              <section className="space-y-3 border-t pt-4 min-w-0">
                <h4 className="text-sm font-semibold">When a verse number doesn't exist yet</h4>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 min-w-0">
                  <Select value={onMissing} onValueChange={(v) => setOnMissing(v as any)}>
                    <SelectTrigger className="w-60 shrink-0" data-testid="select-on-missing">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="create">Create the verse</SelectItem>
                      <SelectItem value="skip">Skip it</SelectItem>
                    </SelectContent>
                  </Select>
                  {onMissing === "create" && (
                    <div className="flex items-center gap-2 min-w-0">
                      <Label className="text-xs whitespace-nowrap">Placement</Label>
                      <Select value={placementMode} onValueChange={(v) => { setPlacementMode(v as any); setPlacementModeTouched(true); }}>
                        <SelectTrigger className="w-56 shrink-0" data-testid="select-placement-mode">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="single">All in one section</SelectItem>
                          <SelectItem value="group" disabled={maxSectionLevels < 1}>
                            Group into sections by number
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>

                {onMissing === "create" && placementMode === "single" && (
                  <div className="flex items-center gap-2 min-w-0">
                    <Label className="text-xs whitespace-nowrap">Add new verses to</Label>
                    <Select value={targetKey} onValueChange={setTargetKey}>
                      <SelectTrigger className="w-64 max-w-[60vw]" data-testid="select-create-target">
                        <SelectValue placeholder="Select section" />
                      </SelectTrigger>
                      <SelectContent>
                        {targetOptions.map((o) => (
                          <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {onMissing === "create" && placementMode === "group" && (
                  <div className="space-y-2 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <Label className="text-xs whitespace-nowrap">Leading numbers as section path</Label>
                      <Select
                        value={String(sectionLevels)}
                        onValueChange={(v) => { setSectionLevels(Number(v)); setSectionLevelsTouched(true); }}
                      >
                        <SelectTrigger className="w-44 shrink-0" data-testid="select-section-levels">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="1">1 — {structureConfig.levelOneName}</SelectItem>
                          {maxSectionLevels >= 2 && (
                            <SelectItem value="2">2 — {structureConfig.levelOneName} › {structureConfig.levelTwoName}</SelectItem>
                          )}
                          {maxSectionLevels >= 3 && (
                            <SelectItem value="3">3 — …{structureConfig.levelTwoName} › {structureConfig.levelThreeName}</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                      <Badge variant="secondary" className="shrink-0">
                        {groupPreview.length} section{groupPreview.length === 1 ? "" : "s"}
                      </Badge>
                    </div>
                    {groupPreview.length > 0 && (
                      <p className="text-xs text-muted-foreground truncate">
                        e.g. {groupPreview.slice(0, 4).join(", ")}{groupPreview.length > 4 ? ", …" : ""}
                      </p>
                    )}
                    {sectionNumberGaps.length > 0 && (
                      <Alert variant="destructive" data-testid="alert-section-gaps">
                        <AlertCircle className="h-4 w-4" />
                        <AlertTitle>
                          {structureConfig.levelOneName} {sectionNumberGaps.slice(0, 8).join(", ")}
                          {sectionNumberGaps.length > 8 ? ", …" : ""} missing from this file
                        </AlertTitle>
                        <AlertDescription className="text-xs">
                          The verse numbers jump over {sectionNumberGaps.length === 1 ? "it" : "them"},
                          so the file is probably truncated or the wrong column is mapped as the verse
                          number. Importing anyway is safe — each verse still goes to the section its
                          own number names — but the grantha will have gaps until you import the rest.
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                )}

                {onMissing === "create" && duplicateNumbers.length > 0 && (
                  <Alert variant="destructive" data-testid="alert-duplicate-numbers">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>
                      {duplicateNumbers.length} verse number
                      {duplicateNumbers.length === 1 ? "" : "s"} used more than once
                    </AlertTitle>
                    <AlertDescription className="text-xs">
                      {duplicateNumbers.slice(0, 5).map((g) => g.join(" = ")).join("; ")}
                      {duplicateNumbers.length > 5 ? "; …" : ""}. Two verses cannot share a number
                      in one section — the odd one out gets renumbered from its position, onto its
                      neighbour's number. Fix the numbers in the file, or import these rows
                      separately.
                    </AlertDescription>
                  </Alert>
                )}

                {onMissing === "create" && (
                  <p className="text-xs text-muted-foreground">
                    New verses keep the full CSV number as their verse label, and are placed in
                    verse-number order — row order in the file doesn't matter.
                  </p>
                )}
              </section>
            )}

            {/* ── Step 4: range (only matters when there are existing verses) ── */}
            {flat.length > 0 && (
              <section className="space-y-3 border-t pt-4 min-w-0">
                <h4 className="text-sm font-semibold">Update which existing verses?</h4>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 min-w-0">
                  <div className="flex items-center gap-2">
                    <Label className="text-xs">From</Label>
                    <Select value={rangeFrom} onValueChange={setRangeFrom}>
                      <SelectTrigger className="w-48" data-testid="select-range-from">
                        <SelectValue placeholder="First verse" />
                      </SelectTrigger>
                      <SelectContent>
                        {flat.map((f) => (
                          <SelectItem key={f.manthraId} value={f.manthraId}>{f.label || `Verse ${f.ordinal}`}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center gap-2">
                    <Label className="text-xs">To</Label>
                    <Select value={rangeTo} onValueChange={setRangeTo}>
                      <SelectTrigger className="w-48" data-testid="select-range-to">
                        <SelectValue placeholder="Last verse" />
                      </SelectTrigger>
                      <SelectContent>
                        {flat.map((f) => (
                          <SelectItem key={f.manthraId} value={f.manthraId}>{f.label || `Verse ${f.ordinal}`}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Badge variant="secondary" className="shrink-0">{rangeVerses.length} in range</Badge>
                </div>
              </section>
            )}

            {/* ── Step 5: field mapping ── */}
            <section className="space-y-3 border-t pt-4 min-w-0">
              <h4 className="text-sm font-semibold">Map columns to fields</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                {coreTargets.map((tgt) => (
                  <div key={tgt.key} className="flex items-center justify-between gap-2 min-w-0">
                    <Label className="text-xs flex-1 min-w-0 truncate" title={tgt.label}>{tgt.label}</Label>
                    <Select
                      value={coreMapping[tgt.key] == null ? SKIP : String(coreMapping[tgt.key])}
                      onValueChange={(v) => setCoreMapping((m) => ({ ...m, [tgt.key]: v === SKIP ? null : Number(v) }))}
                    >
                      <SelectTrigger className="w-40 shrink-0" data-testid={`select-map-${tgt.key}`}>
                        <SelectValue placeholder="— skip —" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SKIP}>— skip —</SelectItem>
                        {columnItems}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>

              {/* Other-language translations */}
              <div className="pt-2 min-w-0">
                <div className="flex items-center justify-between gap-2 mb-2 min-w-0">
                  <Label className="text-xs truncate">Other-language translations</Label>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs px-2 shrink-0"
                    onClick={() => { setTranslationRows((r) => [...r, { id: `tr-${trSeq}`, scope: "shloka", language: "", column: null }]); setTrSeq((n) => n + 1); }}
                    data-testid="button-add-translation-map"
                  >
                    <Plus className="w-3 h-3 mr-1" />
                    Add column
                  </Button>
                </div>
                {translationRows.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Add a row to pull a language translation from a CSV column into the shloka, bhashyam, or a teeka.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {translationRows.map((tr) => (
                      <div key={tr.id} className="flex flex-wrap items-center gap-2 min-w-0">
                        <Select value={tr.scope} onValueChange={(v) => setTranslationRows((rows) => rows.map((x) => (x.id === tr.id ? { ...x, scope: v } : x)))}>
                          <SelectTrigger className="w-36 h-8 text-xs" data-testid={`select-tr-scope-${tr.id}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {scopeOptions.map((o) => (<SelectItem key={String(o.value)} value={String(o.value)}>{o.label}</SelectItem>))}
                          </SelectContent>
                        </Select>
                        <Select value={tr.language || SKIP} onValueChange={(v) => setTranslationRows((rows) => rows.map((x) => (x.id === tr.id ? { ...x, language: v === SKIP ? "" : v } : x)))}>
                          <SelectTrigger className="w-36 h-8 text-xs" data-testid={`select-tr-lang-${tr.id}`}>
                            <SelectValue placeholder="Language" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={SKIP}>— language —</SelectItem>
                            {translationLanguages.map((l) => (<SelectItem key={l} value={l}>{l}</SelectItem>))}
                          </SelectContent>
                        </Select>
                        <Select value={tr.column == null ? SKIP : String(tr.column)} onValueChange={(v) => setTranslationRows((rows) => rows.map((x) => (x.id === tr.id ? { ...x, column: v === SKIP ? null : Number(v) } : x)))}>
                          <SelectTrigger className="w-40 h-8 text-xs" data-testid={`select-tr-col-${tr.id}`}>
                            <SelectValue placeholder="— column —" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={SKIP}>— column —</SelectItem>
                            {columnItems}
                          </SelectContent>
                        </Select>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive shrink-0" onClick={() => setTranslationRows((rows) => rows.filter((x) => x.id !== tr.id))} data-testid={`button-remove-tr-${tr.id}`}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            {/* ── Step 6: preview ── */}
            <section className="space-y-2 border-t pt-4 min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-semibold">Preview</h4>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="secondary">{updateCount} update</Badge>
                  <Badge variant="secondary">{createCount} create</Badge>
                  <Badge variant="secondary">{mappedFieldCount} fields mapped</Badge>
                </div>
              </div>
              <ScrollArea className="h-48 rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-24">CSV #</TableHead>
                      <TableHead>Target verse</TableHead>
                      <TableHead className="w-24 text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {plan.map((p) => (
                      <TableRow key={p.rowIndex}>
                        <TableCell className="font-mono text-xs">{p.rowNumber}</TableCell>
                        <TableCell className="text-xs">
                          {p.action === "update" && (p.target?.label || `Verse ${p.target?.ordinal}`)}
                          {p.action === "create" && <span className="text-blue-600">new verse “{p.rowNumber}”</span>}
                          {p.action === "skip" && <span className="text-muted-foreground">{p.reason}</span>}
                        </TableCell>
                        <TableCell className="text-right">
                          {p.action === "update" && <Check className="w-4 h-4 text-green-600 inline" />}
                          {p.action === "create" && <Plus className="w-4 h-4 text-blue-600 inline" />}
                          {p.action === "skip" && <AlertCircle className="w-4 h-4 text-amber-500 inline" />}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
              {importableCount < rows.length && (
                <p className="text-xs text-amber-600">
                  {rows.length - importableCount} row(s) won't be imported (skipped).
                </p>
              )}
            </section>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-csv-import">
            Cancel
          </Button>
          <Button
            onClick={handleImport}
            disabled={!hasData || importableCount === 0 || mappedFieldCount === 0}
            data-testid="button-confirm-csv-import"
          >
            Import{importableCount > 0 ? ` ${importableCount} verse(s)` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
