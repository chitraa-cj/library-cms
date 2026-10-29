/**
 * "Create Grantha from OCR" — the whole workflow, in one resumable dialog.
 *
 *   hierarchy  →  instructions  →  analysis  →  questions  →  review  →  export/upload
 *
 * State lives on the server (one `cms_structure_jobs` row per attempt), so closing the
 * dialog, refreshing the tab or losing the connection costs nothing: re-opening it finds
 * the job and lands on the step the job's workflow state implies. The only thing kept in
 * React is what the user is typing.
 *
 * The export leg has two exits, both ending in the SAME importer the editors already use:
 * download the CSV, or hand it straight to a grantha — in which case the generated CSV is
 * loaded into the existing `grantha-csv-import-dialog`, with its column mapping and
 * hierarchy mapping pre-proposed for review.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertCircle,
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  HelpCircle,
  Loader2,
  Mic,
  MicOff,
  Pencil,
  Wallet,
  RefreshCw,
  Sparkles,
  Upload,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { usePortalVocabulary } from "@/hooks/use-portal-vocabulary";
import OcrStructureReview from "@/components/ocr-structure-review";
import {
  cancelStructureJob,
  confirmStructureReview,
  deleteStructureJob,
  fetchStructureConfig,
  fetchStructureEstimate,
  fetchStructureJob,
  fetchStructureJobsForOcr,
  fetchStructureResult,
  retryStructureJob,
  saveStructureOverrides,
  setStructureHandoff,
  startStructureJob,
  structureCsvDownloadUrl,
  type StructureResultView,
} from "@/lib/ocr-structure-client";
import {
  STRUCTURE_MAX_DEPTH,
  STRUCTURE_WORKFLOW_LABELS,
  leafLevelName,
  sectionLevelCount,
  type StructureOverride,
} from "@shared/ocr-structure";
import type { OcrJob, StructureJob } from "@shared/schema";

type Step = "hierarchy" | "instructions" | "analysis" | "questions" | "review" | "export";

const TERMINAL: StructureJob["status"][] = ["done", "partial", "failed", "cancelled"];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ocrJob: OcrJob;
  /** Destinations the editor can hand the CSV to (granthas and portal drafts). */
  granthaOptions: Array<{ key: string; label: string; documentId?: string; draftId?: number }>;
}

/** One page box: a page number, or null for "no bound". */
function parsePageInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : null;
}

/** Browser speech-to-text, when the browser has it. Nothing leaves the user's machine. */
function speechRecognitionCtor(): any | null {
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export default function OcrStructureWizard({ open, onOpenChange, ocrJob, granthaOptions }: Props) {
  const { toast } = useToast();
  const { vocabulary } = usePortalVocabulary();

  const [jobId, setJobId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("hierarchy");
  const [depth, setDepth] = useState(2);
  const [levelNames, setLevelNames] = useState<string[]>(["Adhyaya", "Mantra", "Pada", "Mantra"]);
  const [instructions, setInstructions] = useState("");
  // The page window, as typed. Empty means "no bound": both empty = the whole document.
  const [pageFromInput, setPageFromInput] = useState("");
  const [pageToInput, setPageToInput] = useState("");
  const [appliedRange, setAppliedRange] = useState<{ from: number | null; to: number | null }>({
    from: null,
    to: null,
  });
  const [voiceUsed, setVoiceUsed] = useState(false);
  const [listening, setListening] = useState(false);
  const [destination, setDestination] = useState("");
  const recognitionRef = useRef<any>(null);

  const configQuery = useQuery({
    queryKey: ["structure-config"],
    queryFn: fetchStructureConfig,
    enabled: open,
    staleTime: 5 * 60_000,
  });

  // Existing analyses for this document, so re-opening the dialog resumes rather than
  // starting a second (billable) run.
  const existingQuery = useQuery({
    queryKey: ["structure-for-ocr", ocrJob.id],
    queryFn: () => fetchStructureJobsForOcr(ocrJob.id),
    enabled: open,
  });

  /**
   * Set when the user deliberately discards an analysis to change its settings. Without
   * it, the resume effect below would re-adopt the job from the still-cached list and
   * drop them straight back into the locked, read-only wizard they just left.
   */
  const skipResumeRef = useRef(false);

  useEffect(() => {
    if (!open || jobId || skipResumeRef.current) return;
    const latest = existingQuery.data?.jobs?.[0];
    if (!latest) return;
    setJobId(latest.id);
    setDepth(latest.depth);
    setLevelNames((prev) => {
      const next = [...prev];
      (latest.levelNames ?? []).forEach((name, i) => {
        next[i] = name;
      });
      return next;
    });
    setInstructions(latest.instructions ?? "");
    setPageFromInput(latest.pageFrom != null ? String(latest.pageFrom) : "");
    setPageToInput(latest.pageTo != null ? String(latest.pageTo) : "");
    overridesRef.current = ((latest.overrides ?? []) as StructureOverride[]) ?? [];
    setStep(TERMINAL.includes(latest.status) ? "review" : "analysis");
  }, [open, jobId, existingQuery.data]);

  /**
   * Typing in the page boxes must not fire one estimate per keystroke: the estimate
   * assembles the whole transcription server-side, which is the heaviest read this API
   * does. Settle for half a second, then ask.
   */
  const typedRange = useMemo(
    () => ({ from: parsePageInput(pageFromInput), to: parsePageInput(pageToInput) }),
    [pageFromInput, pageToInput],
  );
  useEffect(() => {
    const timer = setTimeout(() => setAppliedRange(typedRange), 500);
    return () => clearTimeout(timer);
  }, [typedRange.from, typedRange.to]);

  // What this would cost, fetched for the step where the decision is made. Not polled:
  // it only changes when the budget or the chosen page window moves, and both of those
  // are in this component.
  const estimateQuery = useQuery({
    queryKey: ["structure-estimate", ocrJob.id, appliedRange.from, appliedRange.to],
    queryFn: () => fetchStructureEstimate(ocrJob.id, appliedRange),
    enabled: Boolean(open && !jobId && step === "instructions"),
    staleTime: 30_000,
  });
  const estimate = estimateQuery.data;

  const detailQuery = useQuery({
    queryKey: ["structure-job", jobId],
    queryFn: () => fetchStructureJob(jobId!),
    enabled: Boolean(open && jobId),
    refetchInterval: (query) => {
      const job = (query.state.data as any)?.job as StructureJob | undefined;
      return job && !TERMINAL.includes(job.status) ? 2000 : false;
    },
  });

  const job = detailQuery.data?.job;
  const running = job ? !TERMINAL.includes(job.status) : false;

  // The classified passages are only pulled on the steps that show them. While the
  // analysis runs, the poll asks for counts and questions only, every 20 seconds —
  // re-downloading the whole transcription on every 2-second progress tick would put
  // tens of megabytes through the event loop for a "so far" line.
  const wantsItems = step === "questions" || step === "review" || step === "export";
  const resultQuery = useQuery<StructureResultView>({
    queryKey: ["structure-result", jobId, wantsItems],
    queryFn: () => fetchStructureResult(jobId!, { withItems: wantsItems }),
    enabled: Boolean(open && jobId && (job?.chunksDone ?? 0) > 0),
    refetchInterval: running && !wantsItems ? 20_000 : false,
  });

  // One final read once the run is terminal, so the review opens on the finished set.
  useEffect(() => {
    if (job && TERMINAL.includes(job.status)) void resultQuery.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, job?.id]);

  const result = resultQuery.data;

  // Once the analysis finishes, land on the step the job's state implies.
  useEffect(() => {
    if (!job || !result) return;
    if (!TERMINAL.includes(job.status)) return;
    if (step !== "analysis") return;
    setStep(result.ambiguities.length > 0 ? "questions" : "review");
  }, [job?.status, result, step]);

  const startMutation = useMutation({
    mutationFn: () =>
      startStructureJob({
        ocrJobId: ocrJob.id,
        depth,
        levelNames: levelNames.slice(0, depth),
        instructions,
        voiceUsed,
        // What is typed, not the debounced copy the estimate used: clicking Analyse
        // within the debounce window must not start a different range than the boxes show.
        pageFrom: typedRange.from,
        pageTo: typedRange.to,
      }),
    onSuccess: ({ job: created }) => {
      setJobId(created.id);
      setStep("analysis");
      void queryClient.invalidateQueries({ queryKey: ["structure-for-ocr", ocrJob.id] });
      toast({
        title: "Analysis started",
        description: `${created.chunksTotal} page range(s) queued for ${created.model}.`,
      });
    },
    onError: (err: Error) =>
      toast({ variant: "destructive", title: "Could not start the analysis", description: err.message }),
  });

  const overridesMutation = useMutation({
    mutationFn: (next: StructureOverride[]) => saveStructureOverrides(jobId!, next),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["structure-job", jobId] });
      void queryClient.invalidateQueries({ queryKey: ["structure-result", jobId] });
      void resultQuery.refetch();
    },
    onError: (err: Error) =>
      toast({ variant: "destructive", title: "Edit not saved", description: err.message }),
  });

  const reviewMutation = useMutation({
    mutationFn: () => confirmStructureReview(jobId!),
    onSuccess: () => {
      setStep("export");
      void detailQuery.refetch();
      void resultQuery.refetch();
    },
    onError: (err: any) =>
      toast({
        variant: "destructive",
        title: "Review not confirmed",
        description: err?.message ?? "Fix the blocking errors first.",
      }),
  });

  /**
   * "Cancel & edit settings": throw this attempt away and go back to step 1 with the
   * hierarchy, the instructions and the page range editable again.
   *
   * It deletes the job rather than leaving it beside the next one, because the resume
   * logic always adopts the newest analysis for this document — a discarded attempt left
   * in the list is a trap, not a record. Ranges that were already analysed are real money,
   * so losing them is confirmed first; a run that analysed nothing (the usual case, a
   * misconfigured hierarchy or a failed first range) goes straight back.
   */
  const discardMutation = useMutation({
    mutationFn: async () => {
      if (!jobId) return;
      if (running) await cancelStructureJob(jobId);
      await deleteStructureJob(jobId);
    },
    onSuccess: () => {
      skipResumeRef.current = true;
      setJobId(null);
      overridesRef.current = [];
      setStep("hierarchy");
      queryClient.removeQueries({ queryKey: ["structure-job"] });
      queryClient.removeQueries({ queryKey: ["structure-result"] });
      void queryClient.invalidateQueries({ queryKey: ["structure-for-ocr", ocrJob.id] });
      void queryClient.invalidateQueries({ queryKey: ["structure-estimate", ocrJob.id] });
      toast({
        title: "Analysis discarded",
        description: "Change the hierarchy, the instructions or the page range, then analyse again.",
      });
    },
    onError: (err: Error) =>
      toast({ variant: "destructive", title: "Could not discard the analysis", description: err.message }),
  });

  function discardAndEdit() {
    const analysed = job?.chunksDone ?? 0;
    if (analysed > 0) {
      const ok = window.confirm(
        `This throws away ${analysed} page range(s) that have already been analysed` +
          `. Analysing them again takes the same requests again.\n\nDiscard this analysis and edit the settings?`,
      );
      if (!ok) return;
    }
    discardMutation.mutate();
  }

  const actionMutation = useMutation({
    mutationFn: async (action: "cancel" | "retry") => {
      if (action === "cancel") await cancelStructureJob(jobId!);
      else await retryStructureJob(jobId!);
    },
    onSuccess: () => {
      void detailQuery.refetch();
      toast({ title: "Done" });
    },
    onError: (err: Error) => toast({ variant: "destructive", title: "Action failed", description: err.message }),
  });

  /**
   * Append edits to the authoritative list.
   *
   * Through a ref, not through the last polled job row: the overrides endpoint REPLACES
   * the list, and two quick edits that both read a stale copy would make the second one
   * silently drop the first. The ref is reseeded from the server whenever a fetch brings
   * a longer list than we hold (a resumed session, another tab).
   */
  const overridesRef = useRef<StructureOverride[]>([]);
  useEffect(() => {
    const fromServer = ((job?.overrides ?? []) as StructureOverride[]) ?? [];
    if (fromServer.length > overridesRef.current.length) overridesRef.current = fromServer;
  }, [job?.overrides]);

  function appendOverrides(next: StructureOverride[]) {
    const merged = [...overridesRef.current, ...next];
    overridesRef.current = merged;
    overridesMutation.mutate(merged);
  }

  // ── voice dictation ──
  function toggleDictation() {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) {
      toast({
        variant: "destructive",
        title: "Dictation is not available in this browser",
        description: "Type the instructions instead, or use Chrome/Edge.",
      });
      return;
    }
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const recognition = new Ctor();
    recognition.lang = "en-IN";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event: any) => {
      let text = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) text += event.results[i][0].transcript;
      }
      if (text.trim()) {
        // Transcribed into the SAME editable field, so the user reviews and corrects
        // the transcription before anything is sent for interpretation.
        setInstructions((prev) => (prev ? `${prev.replace(/\s+$/, "")} ${text.trim()}` : text.trim()));
        setVoiceUsed(true);
      }
    };
    recognition.onerror = (event: any) => {
      setListening(false);
      toast({
        variant: "destructive",
        title: "Dictation stopped",
        description: String(event?.error ?? "The microphone could not be read."),
      });
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }

  useEffect(() => {
    if (!open) skipResumeRef.current = false;
  }, [open]);

  useEffect(() => {
    if (!open && recognitionRef.current) {
      recognitionRef.current.stop?.();
      recognitionRef.current = null;
      setListening(false);
    }
  }, [open]);

  const nameOptionsFor = (index: number): string[] => {
    if (index === depth - 1) return vocabulary.structureLeafNames;
    if (index === 0) return vocabulary.structureLevelOneNames;
    if (index === 1) return vocabulary.structureLevelTwoNames;
    return vocabulary.structureLevelThreeNames;
  };

  const activeNames = levelNames.slice(0, depth).map((n) => (n ?? "").trim());
  const duplicateName = useMemo(() => {
    const seen = new Set<string>();
    for (const name of activeNames) {
      const key = name.toLowerCase();
      if (!key) continue;
      if (seen.has(key)) return name;
      seen.add(key);
    }
    return null;
  }, [activeNames.join("|")]);

  const hierarchyReady = activeNames.length === depth && activeNames.every(Boolean) && !duplicateName;
  const cfg = { depth, levelNames: activeNames };
  const sectionCount = sectionLevelCount(cfg);
  const confidenceThreshold = configQuery.data?.limits.confidenceThreshold ?? 0.7;

  const stepOrder: Step[] = ["hierarchy", "instructions", "analysis", "questions", "review", "export"];
  const stepLabels: Record<Step, string> = {
    hierarchy: "Hierarchy",
    instructions: "Instructions",
    analysis: "Analysis",
    questions: "Questions",
    review: "Review",
    export: "CSV & upload",
  };

  const progressPct =
    job && job.chunksTotal > 0
      ? Math.round(((job.chunksDone + job.chunksFailed) / job.chunksTotal) * 100)
      : 0;

  function handleUploadToGrantha() {
    if (!jobId || !result) return;
    const option = granthaOptions.find((o) => o.key === destination);
    if (!option) {
      toast({ variant: "destructive", title: "Pick a destination grantha" });
      return;
    }
    setStructureHandoff({
      structureJobId: jobId,
      target: option.documentId
        ? { kind: "grantha", documentId: option.documentId, name: option.label }
        : option.draftId != null
          ? { kind: "draft", draftId: option.draftId, name: option.label }
          : { kind: "new", name: option.label },
      summary: {
        verses: result.verses.length,
        sectionLevels: result.csv.sectionLevels,
        levelNames: result.config.levelNames,
        fileName: ocrJob.fileName,
      },
      createdAt: Date.now(),
    });
    toast({
      title: "Opening the grantha editor",
      description: "The generated CSV will be loaded into the usual import dialog for mapping.",
    });
    onOpenChange(false);
    window.location.assign("/granthas");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[94vh] w-[calc(100vw-2rem)] max-w-6xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Create Grantha from OCR — {ocrJob.fileName}
          </DialogTitle>
          <DialogDescription>
            Configure the hierarchy once, describe how the book is laid out, and let the assistant
            classify the transcription (Hermex, on the account reserved for document analysis). You review the result, then download the CSV or hand it straight to a
            grantha through the usual import dialog.
          </DialogDescription>
        </DialogHeader>

        {/* ── step rail ── */}
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {stepOrder.map((s, i) => {
            const reachable =
              s === "hierarchy" ||
              s === "instructions" ||
              (jobId != null && (s !== "questions" || (result?.ambiguities.length ?? 0) > 0));
            return (
              <button
                key={s}
                disabled={!reachable}
                onClick={() => reachable && setStep(s)}
                className={`rounded-full px-2.5 py-1 transition-colors ${
                  step === s
                    ? "bg-primary text-primary-foreground"
                    : reachable
                      ? "bg-muted hover:bg-accent"
                      : "bg-muted/50 text-muted-foreground"
                }`}
                data-testid={`structure-step-${s}`}
              >
                {i + 1}. {stepLabels[s]}
              </button>
            );
          })}
          {result && (
            <Badge variant="outline" className="ml-auto">
              {STRUCTURE_WORKFLOW_LABELS[result.workflowState]}
            </Badge>
          )}
        </div>

        {configQuery.data && !configQuery.data.configured && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Document analysis is not ready on this server</AlertTitle>
            <AlertDescription>
              {configQuery.data.runtime?.problems?.join(" ") ||
                "The dedicated Hermex profile is not configured."}
            </AlertDescription>
          </Alert>
        )}

        {/* ── 1. hierarchy ── */}
        {step === "hierarchy" && (
          <section className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-sm">How many hierarchy levels does this grantha have?</Label>
              <p className="text-xs text-muted-foreground">
                Counting the entries themselves. "Kanda → Sarga → Adhyaya → Shloka" is four; a text
                that is just numbered mantras is one.
              </p>
              <Select
                value={String(depth)}
                onValueChange={(value) => {
                  const next = Number(value);
                  setDepth(next);
                  setLevelNames((prev) => {
                    const copy = [...prev];
                    // Keep the leaf name on the new last level rather than losing it.
                    const leaf = copy[depth - 1] || "Mantra";
                    for (let i = copy.length; i < next; i++) copy[i] = "";
                    copy[next - 1] = copy[next - 1] || leaf;
                    return copy;
                  });
                }}
                disabled={Boolean(jobId)}
              >
                <SelectTrigger className="w-[220px]" data-testid="structure-depth">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: STRUCTURE_MAX_DEPTH }, (_, i) => i + 1).map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} level{n === 1 ? "" : "s"}
                      {n === 1 ? " (entries only)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-sm">What is each level called?</Label>
              {Array.from({ length: depth }, (_, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <span className="w-24 shrink-0 text-xs text-muted-foreground">
                    {i === depth - 1 ? "Entries" : `Level ${i + 1}`}
                  </span>
                  <Input
                    className="w-[220px]"
                    value={levelNames[i] ?? ""}
                    disabled={Boolean(jobId)}
                    placeholder={i === depth - 1 ? "Mantra" : "Kanda"}
                    onChange={(e) =>
                      setLevelNames((prev) => {
                        const next = [...prev];
                        next[i] = e.target.value;
                        return next;
                      })
                    }
                    data-testid={`structure-level-name-${i}`}
                  />
                  <Select
                    value=""
                    disabled={Boolean(jobId)}
                    onValueChange={(value) =>
                      setLevelNames((prev) => {
                        const next = [...prev];
                        next[i] = value;
                        return next;
                      })
                    }
                  >
                    <SelectTrigger className="w-[160px] text-xs">
                      <SelectValue placeholder="Common names…" />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      {nameOptionsFor(i).map((name) => (
                        <SelectItem key={name} value={name}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
              <p className="mb-1 text-xs font-medium text-muted-foreground">This hierarchy</p>
              <p className="font-medium">
                {activeNames.length > 0 ? activeNames.join("  ›  ") : "—"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {sectionCount} section level{sectionCount === 1 ? "" : "s"} plus{" "}
                {leafLevelName(cfg)} entries. The CMS supports up to {STRUCTURE_MAX_DEPTH} levels.
              </p>
            </div>

            {duplicateName && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Two levels are both called "{duplicateName}"</AlertTitle>
                <AlertDescription>
                  The grantha editor needs one name per level — give each level its own.
                </AlertDescription>
              </Alert>
            )}

            {jobId && (
              <p className="text-xs text-muted-foreground">
                This analysis already ran with the hierarchy above, so it is read-only here. To
                change it, use <strong>Cancel &amp; edit settings</strong> on the Analysis step —
                that discards this attempt and unlocks these fields.
              </p>
            )}

            <DialogFooter>
              <Button onClick={() => setStep("instructions")} disabled={!hierarchyReady}>
                Next: instructions
              </Button>
            </DialogFooter>
          </section>
        )}

        {/* ── 2. instructions ── */}
        {step === "instructions" && (
          <section className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-sm">How is this document organised?</Label>
                <Button
                  type="button"
                  variant={listening ? "destructive" : "outline"}
                  size="sm"
                  onClick={toggleDictation}
                  disabled={Boolean(jobId)}
                  data-testid="structure-dictate"
                >
                  {listening ? (
                    <>
                      <MicOff className="mr-1.5 h-3.5 w-3.5" /> Stop dictation
                    </>
                  ) : (
                    <>
                      <Mic className="mr-1.5 h-3.5 w-3.5" /> Dictate
                    </>
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Plain sentences, not rules. Which printed markers start each level, what belongs to
                what, how to read irregular numbering. Dictation lands in this same box so you can
                correct the transcription before it is used.
              </p>
              <Textarea
                rows={8}
                value={instructions}
                disabled={Boolean(jobId)}
                maxLength={configQuery.data?.limits.maxInstructionChars ?? 8000}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={`e.g. Level 1 headings begin with "${activeNames[0] || "Kanda"}". Each numbered ${leafLevelName(cfg)} belongs to the ${activeNames[Math.max(0, sectionCount - 1)] || "section"} above it. A Bhashyam follows its mantra — attach it to that mantra rather than starting a new section. Footnotes at the bottom of a page are apparatus, not content.`}
                data-testid="structure-instructions"
              />
              <p className="text-xs text-muted-foreground">
                {instructions.length}/{configQuery.data?.limits.maxInstructionChars ?? 8000} characters
                {voiceUsed ? " · includes dictated text" : ""}
              </p>
            </div>

            {/* Scope, next to the cost it decides. */}
            {!jobId && (
              <div className="space-y-2 rounded-md border border-border p-3" data-testid="structure-page-range">
                <Label className="text-sm">Which pages?</Label>
                <p className="text-xs text-muted-foreground">
                  Leave both boxes empty for the whole transcription. A range analyses — and bills —
                  those pages only, so a long scan can be done a hundred pages at a time and each part
                  reviewed on its own.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">Pages</span>
                  <Input
                    type="number"
                    min={1}
                    inputMode="numeric"
                    className="w-24"
                    value={pageFromInput}
                    placeholder={String(estimate?.availableFrom ?? 1)}
                    onChange={(e) => setPageFromInput(e.target.value)}
                    data-testid="structure-page-from"
                  />
                  <span className="text-xs text-muted-foreground">to</span>
                  <Input
                    type="number"
                    min={1}
                    inputMode="numeric"
                    className="w-24"
                    value={pageToInput}
                    placeholder={String(estimate?.availableTo ?? ocrJob.pageCount)}
                    onChange={(e) => setPageToInput(e.target.value)}
                    data-testid="structure-page-to"
                  />
                  {(pageFromInput.trim() || pageToInput.trim()) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setPageFromInput("");
                        setPageToInput("");
                      }}
                    >
                      Whole document
                    </Button>
                  )}
                </div>
                {estimate && (
                  <p className="text-xs text-muted-foreground" data-testid="structure-page-range-summary">
                    {estimate.window
                      ? `Pages ${estimate.window.from}–${estimate.window.to} will be analysed — ${estimate.pages} transcribed page(s) of the document's ${estimate.availablePages}. Nothing outside the range is sent.`
                      : `The whole transcription will be analysed — ${estimate.pages} page(s) (p${estimate.availableFrom}–${estimate.availableTo}).`}
                  </p>
                )}
              </div>
            )}

            <Alert>
              <HelpCircle className="h-4 w-4" />
              <AlertTitle>What happens next</AlertTitle>
              <AlertDescription className="text-xs">
                {estimate ? `${estimate.pages} page(s) of the transcription are` : "The transcription is"}{" "}
                classified in page ranges of {configQuery.data?.limits.pagesPerChunk ?? 3}, in order, so a
                heading on one page still governs the next. The assistant only marks which lines are
                headings, verses and commentary — every word you review is cut from the OCR text itself,
                never retyped by the model. Nothing is written to the CMS during the analysis.
              </AlertDescription>
            </Alert>

            {/* The size of the job, before the button that starts it. */}
            {!jobId && (
              <div
                className={`space-y-2 rounded-md border p-3 ${
                  estimate && !estimate.withinLimits ? "border-destructive/50 bg-destructive/5" : "border-border bg-muted/30"
                }`}
                data-testid="structure-estimate"
              >
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <Wallet className="h-4 w-4" />
                  Requests needed
                  {estimateQuery.isLoading && <Loader2 className="h-3 w-3 animate-spin" />}
                </p>
                {estimate ? (
                  <>
                    <p className="text-sm">
                      <strong>{estimate.estimate.requests}</strong> request(s) for {estimate.pages} page(s) ·{" "}
                      {estimate.remainingRequestsToday} left today on the analysis account.
                    </p>
                    <p className="text-[11px] text-muted-foreground">{estimate.estimate.basis}.</p>
                    {estimate.warnings.map((w, i) => (
                      <p key={i} className="text-xs text-amber-700 dark:text-amber-300">
                        {w}
                      </p>
                    ))}
                    {!estimate.withinLimits && (
                      <Alert variant="destructive" className="mt-1">
                        <AlertCircle className="h-4 w-4" />
                        <AlertTitle>Too large — not started</AlertTitle>
                        <AlertDescription className="text-xs">
                          <ul className="list-disc space-y-0.5 pl-4">
                            {estimate.blockers.map((blocker, i) => (
                              <li key={i}>{blocker}</li>
                            ))}
                          </ul>
                          Analyse fewer pages at a time.
                        </AlertDescription>
                      </Alert>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {estimateQuery.error ? (estimateQuery.error as Error).message : "Sizing this document…"}
                  </p>
                )}
              </div>
            )}

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setStep("hierarchy")}>
                Back
              </Button>
              {jobId ? (
                <Button onClick={() => setStep("analysis")}>Go to the analysis</Button>
              ) : (
                <Button
                  onClick={() => startMutation.mutate()}
                  disabled={
                    !hierarchyReady ||
                    startMutation.isPending ||
                    configQuery.data?.configured === false ||
                    estimate?.withinLimits === false
                  }
                  title={estimate?.withinLimits === false ? "This page range is over the configured limits" : undefined}
                  data-testid="structure-start"
                >
                  {startMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Starting…
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-2 h-4 w-4" /> Analyse the document
                    </>
                  )}
                </Button>
              )}
            </DialogFooter>
          </section>
        )}

        {/* ── 3. analysis ── */}
        {step === "analysis" && job && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">
                {job.chunksDone}/{job.chunksTotal} page ranges analysed
              </span>
              {job.pageFrom != null && job.pageTo != null && (
                <Badge variant="outline" data-testid="structure-job-window">
                  pages {job.pageFrom}–{job.pageTo} only
                </Badge>
              )}
              {job.chunksFailed > 0 && (
                <span className="text-destructive">{job.chunksFailed} failed</span>
              )}
              <span className="text-xs text-muted-foreground">
                {job.model} · {job.requestCount} request(s)
              </span>
              <div className="ml-auto flex items-center gap-2">
                {running && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => actionMutation.mutate("cancel")}
                    data-testid="structure-cancel"
                  >
                    <Ban className="mr-1.5 h-3.5 w-3.5" /> Cancel
                  </Button>
                )}
                {!running && job.chunksFailed > 0 && (
                  <Button variant="outline" size="sm" onClick={() => actionMutation.mutate("retry")}>
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry failed ranges
                  </Button>
                )}
              </div>
            </div>

            <Progress value={progressPct} data-testid="structure-progress" />

            {detailQuery.data?.live && (
              <p className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-2 text-xs">
                {detailQuery.data.live.phase === "backoff" ? (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                ) : (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-600" />
                )}
                Range {detailQuery.data.live.chunkIndex + 1}:{" "}
                {detailQuery.data.live.phase === "backoff"
                  ? `${detailQuery.data.live.lastError ?? "transient error"} — retrying (attempt ${detailQuery.data.live.attempt + 1} of ${detailQuery.data.live.maxAttempts})`
                  : detailQuery.data.live.phase === "request"
                    ? `waiting on the assistant (attempt ${detailQuery.data.live.attempt} of ${detailQuery.data.live.maxAttempts})`
                    : "opening the browser / waiting for a request slot"}
              </p>
            )}

            <div className="flex flex-wrap gap-1">
              {(detailQuery.data?.chunks ?? []).map((chunk) => (
                <span
                  key={chunk.chunkIndex}
                  title={`Pages ${chunk.startPage}–${chunk.endPage}${chunk.error ? ` — ${chunk.error}` : ""}`}
                  className={`h-2.5 w-6 rounded-sm ${
                    chunk.status === "done"
                      ? "bg-emerald-500"
                      : chunk.status === "running"
                        ? "animate-pulse bg-blue-500"
                        : chunk.status === "failed" || chunk.status === "skipped"
                          ? "bg-destructive"
                          : "bg-muted"
                  }`}
                />
              ))}
            </div>

            {job.error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>The analysis reported a problem</AlertTitle>
                <AlertDescription className="break-words text-xs">{job.error}</AlertDescription>
              </Alert>
            )}

            {result && (
              <p className="text-xs text-muted-foreground">
                So far: {result.stats.sections} heading(s), {result.stats.verses} entr
                {result.stats.verses === 1 ? "y" : "ies"}, {result.stats.unassigned} passage(s) not part
                of an entry, {result.stats.lowConfidence} uncertain.
              </p>
            )}

            <DialogFooter className="gap-2 sm:justify-between">
              <Button
                variant="outline"
                onClick={discardAndEdit}
                disabled={discardMutation.isPending}
                className="text-destructive hover:text-destructive"
                data-testid="structure-discard"
              >
                {discardMutation.isPending ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Discarding…
                  </>
                ) : (
                  <>
                    <Pencil className="mr-1.5 h-3.5 w-3.5" /> Cancel &amp; edit settings
                  </>
                )}
              </Button>
              <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close — it keeps running
              </Button>
              <Button
                onClick={() => setStep((result?.ambiguities.length ?? 0) > 0 ? "questions" : "review")}
                disabled={!result || result.stats.verses === 0}
              >
                {(result?.ambiguities.length ?? 0) > 0 ? "Answer the questions" : "Review the structure"}
              </Button>
              </div>
            </DialogFooter>
          </section>
        )}

        {/* ── 4. questions ── */}
        {step === "questions" && result && (
          <section className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {result.ambiguities.length === 0
                ? "Nothing left to ask — the structure is unambiguous."
                : `${result.ambiguities.length} thing${result.ambiguities.length === 1 ? "" : "s"} could not be settled from the pages alone. Everything else was decided automatically.`}
            </p>

            {result.ambiguities.map((ambiguity) => (
              <div
                key={ambiguity.id}
                className="space-y-2 rounded-md border border-border p-3"
                data-testid={`structure-question-${ambiguity.id}`}
              >
                <p className="text-sm font-medium">{ambiguity.question}</p>
                <p className="text-xs text-muted-foreground">{ambiguity.evidence}</p>
                <div className="flex flex-wrap gap-2">
                  {ambiguity.options.map((option) => (
                    <Button
                      key={option.id}
                      size="sm"
                      variant={option.recommended ? "default" : "outline"}
                      disabled={overridesMutation.isPending}
                      onClick={() => appendOverrides(option.apply)}
                    >
                      {option.label}
                      {option.recommended ? " (recommended)" : ""}
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setStep("review");
                      // The review's own editor is the "custom answer" path: every option
                      // above is just a shortcut for edits that can be made by hand there.
                    }}
                  >
                    Decide it in the review
                  </Button>
                </div>
              </div>
            ))}

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setStep("analysis")}>
                Back
              </Button>
              <Button onClick={() => setStep("review")}>Review the structure</Button>
            </DialogFooter>
          </section>
        )}

        {/* ── 5. review ── */}
        {step === "review" && result && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span>
                <strong>{result.stats.verses}</strong> entries · <strong>{result.stats.sections}</strong>{" "}
                headings · <strong>{result.stats.unassigned}</strong> not imported ·{" "}
                <strong>{result.stats.lowConfidence}</strong> uncertain ·{" "}
                <strong>{result.stats.edited}</strong> edited by hand
              </span>
              {job?.pageFrom != null && job?.pageTo != null && (
                <span className="text-muted-foreground">
                  from pages {job.pageFrom}–{job.pageTo} only
                </span>
              )}
              {result.teekaNames.length > 0 && (
                <span className="text-muted-foreground">Teekas: {result.teekaNames.join(", ")}</span>
              )}
              {result.languages.length > 0 && (
                <span className="text-muted-foreground">Translations: {result.languages.join(", ")}</span>
              )}
              {overridesMutation.isPending && (
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> saving…
                </span>
              )}
            </div>

            {result.missingRanges.length > 0 && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{result.missingRanges.length} page range(s) were not analysed</AlertTitle>
                <AlertDescription className="text-xs">
                  {result.missingRanges
                    .slice(0, 6)
                    .map((r) => `p${r.startPage}–${r.endPage}`)
                    .join(", ")}
                  {result.missingRanges.length > 6 ? " …" : ""} — retry them on the Analysis step before
                  exporting, or the CSV will be missing those pages.
                </AlertDescription>
              </Alert>
            )}

            {result.validation.errors.map((issue, i) => (
              <Alert variant="destructive" key={`${issue.code}-${i}`}>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Must be fixed</AlertTitle>
                <AlertDescription className="text-xs">{issue.message}</AlertDescription>
              </Alert>
            ))}

            {result.validation.warnings.length > 0 && (
              <details className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs">
                <summary className="cursor-pointer font-medium text-amber-700 dark:text-amber-300">
                  {result.validation.warnings.length} warning(s) — review, then continue if they are expected
                </summary>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
                  {result.validation.warnings.map((issue, i) => (
                    <li key={`${issue.code}-${i}`}>{issue.message}</li>
                  ))}
                </ul>
              </details>
            )}

            <OcrStructureReview
              config={result.config}
              items={result.items}
              verses={result.verses}
              unassigned={result.unassigned}
              confidenceThreshold={confidenceThreshold}
              onOverrides={appendOverrides}
              busy={overridesMutation.isPending}
            />

            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                onClick={() => setStep((result.ambiguities.length ?? 0) > 0 ? "questions" : "analysis")}
              >
                Back
              </Button>
              <Button
                onClick={() => reviewMutation.mutate()}
                disabled={!result.validation.ok || reviewMutation.isPending}
                data-testid="structure-confirm-review"
              >
                {reviewMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Validating…
                  </>
                ) : (
                  <>
                    <Check className="mr-2 h-4 w-4" /> Structure looks right — continue
                  </>
                )}
              </Button>
            </DialogFooter>
          </section>
        )}

        {/* ── 6. export ── */}
        {step === "export" && result && jobId && (
          <section className="space-y-4">
            <Alert>
              <CheckCircle2 className="h-4 w-4" />
              <AlertTitle>
                {result.csv.rowCount} row(s) ready, {result.csv.columns.length} column(s)
              </AlertTitle>
              <AlertDescription className="text-xs">
                The number column encodes {result.csv.sectionLevels} section level(s), which is what the
                grantha importer reads to place each entry. Columns:{" "}
                {result.csv.columns.map((c) => c.header).join(", ")}
                {job?.pageFrom != null && job?.pageTo != null
                  ? ` — from pages ${job.pageFrom}–${job.pageTo} of the document only, so the rest of the book has to be analysed separately.`
                  : ""}
              </AlertDescription>
            </Alert>

            {job?.importStatus === "done" && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>This analysis has already been imported</AlertTitle>
                <AlertDescription className="text-xs">
                  Into {job.importGranthaDocId ?? "a grantha"}
                  {job.importedAt ? ` on ${new Date(job.importedAt).toLocaleString()}` : ""}. Importing it
                  again would duplicate the entries; the editor will ask before letting you.
                </AlertDescription>
              </Alert>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 rounded-md border border-border p-3">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <Download className="h-4 w-4" /> Download CSV
                </p>
                <p className="text-xs text-muted-foreground">
                  The same file the direct upload uses. Import it later through the grantha editor's
                  "Import verses from CSV".
                </p>
                <Button variant="outline" size="sm" asChild>
                  <a href={structureCsvDownloadUrl(jobId)} download data-testid="structure-download-csv">
                    <Download className="mr-1.5 h-3.5 w-3.5" /> Download .csv
                  </a>
                </Button>
              </div>

              <div className="space-y-2 rounded-md border border-border p-3">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <Upload className="h-4 w-4" /> Upload to a grantha
                </p>
                <p className="text-xs text-muted-foreground">
                  Opens the grantha editor with this CSV loaded into the usual import dialog, with the
                  hierarchy mapping proposed for review. Nothing is written until you confirm there.
                </p>
                <Select value={destination} onValueChange={setDestination}>
                  <SelectTrigger className="text-xs" data-testid="structure-destination">
                    <SelectValue placeholder="Choose the destination grantha…" />
                  </SelectTrigger>
                  <SelectContent className="max-h-60">
                    {granthaOptions.map((option) => (
                      <SelectItem key={option.key} value={option.key}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  onClick={handleUploadToGrantha}
                  disabled={!destination}
                  data-testid="structure-upload"
                >
                  <FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" /> Map &amp; import
                </Button>
              </div>
            </div>

            <Separator />
            <p className="text-xs text-muted-foreground">
              The import itself runs through the grantha editor's own draft Save / Save &amp; Publish —
              the same path every other edit takes, with the same validation, locks and backups.
            </p>

            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("review")}>
                Back to the review
              </Button>
            </DialogFooter>
          </section>
        )}

        {(step === "analysis" || step === "questions" || step === "review" || step === "export") &&
          !result &&
          jobId && (
            <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {(job?.chunksDone ?? 0) === 0 ? "Waiting for the first page range…" : "Loading the analysis…"}
            </p>
          )}
      </DialogContent>
    </Dialog>
  );
}
