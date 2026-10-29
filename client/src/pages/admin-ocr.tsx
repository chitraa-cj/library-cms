/**
 * OCR Docs (admin only).
 *
 * Upload a PDF or scan; the server transcribes it page by page with the LOCAL
 * engine (the PDF's own text layer where usable, Tesseract otherwise) and streams
 * the merged result back here as pages land — so a 300-page book is readable from
 * the first minute. Uncertain pages carry review flags; nothing is AI-corrected.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
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
  Ban,
  CheckCircle2,
  Copy,
  Download,
  FileScan,
  FileText,
  Loader2,
  Printer,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { highlightHtml, renderOcrMarkdown, renderOcrPlainText } from "@/lib/ocr-markdown";
import { OCR_PAGE_FLAG_LABELS } from "@shared/ocr-quality";
import OcrStructureWizard from "@/components/ocr-structure-wizard";
import { fetchStructureJobsForOcr } from "@/lib/ocr-structure-client";
import type { Draft, OcrJob, OcrJobStatus, OcrPage, StrapiGrantha, StrapiResponse, StructureJob } from "@shared/schema";

const JOBS_KEY = "/api/admin/ocr/jobs";
const TERMINAL: OcrJobStatus[] = ["done", "partial", "failed", "cancelled"];

/** What a running range is doing right now (server memory, see server/ocr/progress.ts). */
type ChunkLive = {
  model: string;
  attempt: number;
  maxAttempts: number;
  phase: "slot" | "request" | "backoff";
  startedAt: number;
  phaseStartedAt: number;
  nextAttemptAt: number | null;
  lastError: string | null;
};

type ChunkStatus = {
  chunkIndex: number;
  startPage: number;
  endPage: number;
  status: "queued" | "running" | "done" | "failed" | "skipped";
  attempts: number;
  model: string | null;
  durationMs: number;
  error: string | null;
  live?: ChunkLive | null;
};

type JobProgress = {
  pagesTotal: number;
  pagesDone: number;
  pagesRunning: number;
  pagesFailed: number;
  pagesQueued: number;
  elapsedMs: number | null;
  etaMs: number | null;
  basis: "measured" | "historical" | "guess" | null;
  msPerPage: number | null;
  retrying: number;
};

type JobDetail = {
  job: OcrJob;
  chunks: ChunkStatus[];
  active: boolean;
  usage: UsageSnapshot;
  progress?: JobProgress;
  serverNow?: number;
};
type UsageSnapshot = {
  inFlight: number;
  waiting: number;
  concurrency: number;
};
type OcrConfig = {
  configured: boolean;
  engine: {
    name: string;
    languages: { devanagari: string; latin: string; fallback: string };
    problems: string[];
    warnings: string[];
    dpi: { fast: number; accurate: number };
  };
  limits: {
    maxUploadMb: number;
    maxPages: number;
    defaultChunkSize: number;
    maxChunkSize: number;
    retentionDays: number;
  };
  usage: UsageSnapshot;
};
type DocumentResult = {
  job: OcrJob;
  pages: OcrPage[];
  markdown: string;
  missingRanges: Array<{ startPage: number; endPage: number; error: string | null }>;
};

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff";

function mimeFor(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "tif" || ext === "tiff") return "image/tiff";
  return "application/octet-stream";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** An engine error, cut to the words an editor can act on. */
function shortError(error: string | null | undefined): string {
  if (!error) return "";
  if (/did not finish within/i.test(error)) return "timed out";
  if (/killed by/i.test(error)) return "engine process was killed";
  const firstLine = error.split("\n")[0];
  return firstLine.length > 70 ? `${firstLine.slice(0, 67)}…` : firstLine;
}

/** One line describing what a running range is doing, with live countdowns. */
function describeLive(c: ChunkStatus, serverNow: number): string {
  const live = c.live;
  if (!live) return "starting…";
  const attempt = live.attempt > 0 ? `attempt ${live.attempt} of ${live.maxAttempts}` : "";
  if (live.phase === "backoff") {
    const wait = Math.max(0, (live.nextAttemptAt ?? serverNow) - serverNow);
    return `${shortError(live.lastError)} · retrying in ${formatDuration(wait)} (next: attempt ${live.attempt + 1} of ${live.maxAttempts})`;
  }
  if (live.phase === "request") {
    const inFlight = Math.max(0, serverNow - live.phaseStartedAt);
    return `${live.model} · ${attempt} · reading for ${formatDuration(inFlight)}`;
  }
  return "waiting for a free OCR lane";
}

function statusBadge(status: OcrJobStatus) {
  const map: Record<OcrJobStatus, { label: string; className: string }> = {
    queued: { label: "Queued", className: "bg-muted text-muted-foreground" },
    running: { label: "Transcribing", className: "bg-blue-500/15 text-blue-700 dark:text-blue-300" },
    done: { label: "Done", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
    partial: { label: "Partial", className: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
    failed: { label: "Failed", className: "bg-destructive/15 text-destructive" },
    cancelled: { label: "Cancelled", className: "bg-muted text-muted-foreground" },
  };
  const entry = map[status] ?? map.queued;
  return <Badge className={`${entry.className} border-0`}>{entry.label}</Badge>;
}

/** Upload with XHR so the editor sees byte progress on a 100MB scan. */
function uploadDocument(
  file: File,
  opts: { quality: string; textMode: string },
  onProgress: (pct: number) => void,
): Promise<{ job: OcrJob; reused?: boolean }> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      fileName: file.name,
      mimeType: mimeFor(file),
      quality: opts.quality,
      textMode: opts.textMode,
    });

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${JOBS_KEY}?${params.toString()}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", mimeFor(file));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body?.message || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed — connection lost."));
    xhr.send(file);
  });
}

export default function AdminOcrPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [file, setFile] = useState<File | null>(null);
  const [quality, setQuality] = useState("fast");
  const [textMode, setTextMode] = useState("auto");
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isAdmin = user?.role === "admin";
  // "Create Grantha from OCR" — the structure workflow hangs off the selected document.
  const [wizardOpen, setWizardOpen] = useState(false);

  const configQuery = useQuery<OcrConfig>({
    queryKey: ["/api/admin/ocr/config"],
    enabled: isAdmin,
    staleTime: 5 * 60_000,
  });

  const jobsQuery = useQuery<{ jobs: OcrJob[]; usage: UsageSnapshot }>({
    queryKey: [JOBS_KEY],
    enabled: isAdmin,
    refetchInterval: (query) => {
      const jobs = (query.state.data as any)?.jobs as OcrJob[] | undefined;
      return jobs?.some((j) => !TERMINAL.includes(j.status)) ? 4000 : false;
    },
  });

  const jobs = jobsQuery.data?.jobs ?? [];
  const activeJobId = selectedId ?? jobs[0]?.id ?? null;

  const detailQuery = useQuery<JobDetail>({
    queryKey: [`${JOBS_KEY}/${activeJobId}`],
    enabled: Boolean(isAdmin && activeJobId),
    refetchInterval: (query) => {
      const job = (query.state.data as any)?.job as OcrJob | undefined;
      return job && !TERMINAL.includes(job.status) ? 1500 : false;
    },
  });

  const detail = detailQuery.data;
  const job = detail?.job;
  const running = job ? !TERMINAL.includes(job.status) : false;

  const docQuery = useQuery<DocumentResult>({
    queryKey: [`${JOBS_KEY}/${activeJobId}/document`],
    enabled: Boolean(isAdmin && activeJobId && (job?.chunksDone ?? 0) > 0),
    // While the job runs, refresh the merged document so finished pages appear
    // as they land; once it is terminal, one final fetch and stop.
    refetchInterval: running ? 5000 : false,
  });

  // A finished job's last page batch must be fetched once more after the run ends.
  useEffect(() => {
    if (job && TERMINAL.includes(job.status)) {
      void queryClient.invalidateQueries({ queryKey: [`${JOBS_KEY}/${job.id}/document`] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, job?.id]);

  // Analyses already run for the selected document, so the button can say "continue"
  // instead of silently starting a second (billable) run.
  const structureJobsQuery = useQuery<{ jobs: StructureJob[] }>({
    queryKey: ["structure-for-ocr", activeJobId],
    queryFn: () => fetchStructureJobsForOcr(activeJobId!),
    enabled: Boolean(isAdmin && activeJobId),
    staleTime: 30_000,
  });
  const latestStructureJob = structureJobsQuery.data?.jobs?.[0] ?? null;

  // Destinations for "Upload to Grantha": published granthas and in-progress portal
  // drafts, from the same lists the granthas page uses (both are lite/slim payloads).
  const granthaListQuery = useQuery<StrapiResponse<StrapiGrantha>>({
    queryKey: ["/api/strapi", "granthas", "lite"],
    enabled: Boolean(isAdmin && wizardOpen),
    staleTime: 60_000,
  });
  const granthaDraftsQuery = useQuery<Draft[]>({
    queryKey: ["/api/drafts", "granthas"],
    queryFn: async () => {
      const res = await fetch("/api/drafts?contentType=granthas", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Failed to fetch drafts");
      return res.json();
    },
    enabled: Boolean(isAdmin && wizardOpen),
    staleTime: 60_000,
  });

  const granthaOptions = useMemo(() => {
    const options: Array<{ key: string; label: string; documentId?: string; draftId?: number }> = [];
    for (const draft of granthaDraftsQuery.data ?? []) {
      // A draft linked to a published grantha is the same grantha; prefer the draft so the
      // editor opens the work in progress rather than forking it.
      options.push({
        key: `draft:${draft.id}`,
        label: `${draft.title || "(untitled draft)"} — draft`,
        ...(draft.strapiDocumentId ? { documentId: draft.strapiDocumentId } : { draftId: draft.id }),
      });
    }
    const draftedDocIds = new Set(
      (granthaDraftsQuery.data ?? []).map((d) => d.strapiDocumentId).filter(Boolean) as string[],
    );
    for (const grantha of granthaListQuery.data?.data ?? []) {
      if (draftedDocIds.has(grantha.documentId)) continue;
      options.push({
        key: `grantha:${grantha.documentId}`,
        label: grantha.GranthaName || grantha.documentId,
        documentId: grantha.documentId,
      });
    }
    return options;
  }, [granthaDraftsQuery.data, granthaListQuery.data]);

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose a file first.");
      setUploadPct(0);
      return uploadDocument(
        file,
        { quality, textMode },
        setUploadPct,
      );
    },
    onSuccess: (data) => {
      setUploadPct(null);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setSelectedId(data.job.id);
      void queryClient.invalidateQueries({ queryKey: [JOBS_KEY] });
      toast({
        title: data.reused ? "Already transcribed" : "OCR started",
        description: data.reused
          ? `${data.job.fileName} was uploaded before with the same settings — showing that transcription instead of running it again.`
          : `${data.job.fileName} — ${data.job.pageCount} page(s).`,
      });
    },
    onError: (err: Error) => {
      setUploadPct(null);
      toast({ variant: "destructive", title: "Upload failed", description: err.message });
    },
  });

  const actionMutation = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: "cancel" | "retry" | "delete" }) => {
      if (action === "delete") {
        await apiRequest("DELETE", `${JOBS_KEY}/${id}`);
        return { action };
      }
      await apiRequest("POST", `${JOBS_KEY}/${id}/${action}`);
      return { action };
    },
    onSuccess: ({ action }, vars) => {
      void queryClient.invalidateQueries({ queryKey: [JOBS_KEY] });
      void queryClient.invalidateQueries({ queryKey: [`${JOBS_KEY}/${vars.id}`] });
      void queryClient.invalidateQueries({ queryKey: [`${JOBS_KEY}/${vars.id}/document`] });
      if (action === "delete" && selectedId === vars.id) setSelectedId(null);
      toast({ title: action === "retry" ? "Retrying failed pages" : action === "cancel" ? "Cancelled" : "Deleted" });
    },
    onError: (err: Error) => toast({ variant: "destructive", title: "Action failed", description: err.message }),
  });

  const pages = docQuery.data?.pages ?? [];
  const renderedPages = useMemo(
    () =>
      pages.map((p) => {
        // Locally transcribed pages are plain text: Markdown rendering would turn a
        // danda read as "|" into a table, or a leading "#" into a heading. Pages from
        // the old Gemini path (no meta) were Markdown and keep rendering as such.
        const html = p.meta ? renderOcrPlainText(p.markdown) : renderOcrMarkdown(p.markdown);
        return { page: p.page, meta: p.meta, html: search.trim() ? highlightHtml(html, search) : html };
      }),
    [pages, search],
  );

  const matchCount = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle.length < 2) return 0;
    return pages.reduce((sum, p) => sum + p.markdown.toLowerCase().split(needle).length - 1, 0);
  }, [pages, search]);

  // Pages the engine flagged for a human look (low confidence, empty, repeated lines…).
  const flaggedPages = useMemo(() => pages.filter((p) => (p.meta?.flags?.length ?? 0) > 0), [pages]);

  // A one-second ticker so elapsed time, the ETA and retry countdowns move
  // between polls instead of jumping every 1.5s.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const progress = detail?.progress ?? null;
  // Time since the poll that produced `progress`, so server figures can be
  // advanced locally; and the server's clock "now", for absolute stamps.
  const sinceFetchMs = detailQuery.dataUpdatedAt ? Math.max(0, Date.now() - detailQuery.dataUpdatedAt) : 0;
  const serverNow = (detail?.serverNow ?? Date.now()) + sinceFetchMs;
  const elapsedMs = progress?.elapsedMs != null && running ? progress.elapsedMs + sinceFetchMs : progress?.elapsedMs ?? null;
  const etaLeftMs = running && progress?.etaMs != null ? Math.max(0, progress.etaMs - sinceFetchMs) : null;
  const eta = useMemo(() => {
    if (etaLeftMs == null || !progress) return null;
    const base = etaLeftMs < 5_000 ? "finishing…" : `about ${formatDuration(etaLeftMs)} left`;
    if (progress.basis === "guess") return `${base} (rough guess until the first range finishes)`;
    if (progress.basis === "historical") return `${base} (from earlier documents)`;
    return base;
  }, [etaLeftMs, progress]);

  const runningChunks = useMemo(
    () => (detail?.chunks ?? []).filter((c) => c.status === "running"),
    [detail],
  );
  const queuedChunkCount = useMemo(
    () => (detail?.chunks ?? []).filter((c) => c.status === "queued").length,
    [detail],
  );

  function printDocument() {
    if (renderedPages.length === 0) return;
    const win = window.open("", "_blank");
    if (!win) return;
    const body = renderedPages
      .map(
        (p) =>
          `<section class="page"><div class="body">${p.html}</div><footer>Page ${p.page}</footer></section>`,
      )
      .join("");
    win.document.write(`<!doctype html><html><head><meta charset="utf-8" />
      <title>${job?.fileName ?? "OCR"}</title>
      <style>
        body { font-family: Georgia, "Noto Serif Devanagari", serif; margin: 0; color: #111; }
        .page { padding: 48px 56px; page-break-after: always; min-height: 90vh; position: relative; }
        .page footer { position: absolute; bottom: 18px; right: 56px; font-size: 11px; color: #777; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #bbb; padding: 4px 6px; text-align: left; }
        h1,h2,h3 { font-family: Georgia, serif; }
        mark { background: #fde68a; }
      </style></head><body>${body}</body></html>`);
    win.document.close();
    win.focus();
    win.print();
  }

  async function copyAll() {
    const text = docQuery.data?.markdown ?? "";
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied", description: `${text.length.toLocaleString()} characters copied.` });
    } catch {
      toast({ variant: "destructive", title: "Copy failed", description: "Use Download instead." });
    }
  }

  if (!isAdmin) {
    return (
      <div className="max-w-2xl mx-auto p-6 text-sm text-muted-foreground">
        Admin access required to use OCR Docs.
      </div>
    );
  }

  const limits = configQuery.data?.limits;
  const usage = detail?.usage ?? jobsQuery.data?.usage ?? configQuery.data?.usage;

  return (
    <div className="mx-auto max-w-[1400px] p-6 space-y-6">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <FileScan className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold" data-testid="page-title-ocr">
            OCR Docs
          </h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Transcribe PDFs and scans on this server — no external AI service. Pages with a usable
          text layer are read directly; scanned pages go through local OCR (Tesseract). Pages appear
          below as they finish, uncertain ones are flagged for review, and only failed pages are
          ever re-run.
        </p>
      </div>

      {configQuery.data && !configQuery.data.configured && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-start gap-3 pt-6 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <span>
              The local OCR engine is not ready on this server.{" "}
              {configQuery.data.engine?.problems?.join(" ")}
            </span>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        {/* ─── Left column: upload + job list ─────────────────────────────── */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">New transcription</CardTitle>
              <CardDescription>
                PDF or image, up to {limits?.maxUploadMb ?? 120}MB and {limits?.maxPages ?? 1500} pages.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const dropped = e.dataTransfer.files?.[0];
                  if (dropped) setFile(dropped);
                }}
                onClick={() => fileInputRef.current?.click()}
                className={`cursor-pointer rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
                  dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                }`}
                data-testid="ocr-dropzone"
              >
                <Upload className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
                {file ? (
                  <div className="text-sm">
                    <p className="truncate font-medium">{file.name}</p>
                    <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Drop a file here or <span className="text-primary">browse</span>
                  </p>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPT}
                  className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  data-testid="ocr-file-input"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Scan resolution</Label>
                  <Select value={quality} onValueChange={setQuality}>
                    <SelectTrigger data-testid="ocr-quality">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fast">Standard — {configQuery.data?.engine?.dpi.fast ?? 200} dpi</SelectItem>
                      <SelectItem value="accurate">Fine print — {configQuery.data?.engine?.dpi.accurate ?? 300} dpi</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">PDF text layer</Label>
                  <Select value={textMode} onValueChange={setTextMode}>
                    <SelectTrigger data-testid="ocr-text-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Use it when readable</SelectItem>
                      <SelectItem value="ocr">Always OCR</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Choose <strong>Always OCR</strong> when the PDF was made with an old Devanagari font
                (Kruti Dev and similar): its text layer looks like text but is not Unicode Sanskrit.
              </p>

              {uploadPct !== null && (
                <div className="space-y-1">
                  <Progress value={uploadPct} />
                  <p className="text-xs text-muted-foreground">Uploading… {uploadPct}%</p>
                </div>
              )}

              <Button
                className="w-full"
                disabled={!file || uploadMutation.isPending || configQuery.data?.configured === false}
                onClick={() => uploadMutation.mutate()}
                data-testid="ocr-start"
              >
                {uploadMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Starting…
                  </>
                ) : (
                  <>
                    <FileScan className="mr-2 h-4 w-4" /> Start OCR
                  </>
                )}
              </Button>

              {usage && (
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {configQuery.data?.engine?.name ?? "Local OCR"}: {usage.inFlight}/{usage.concurrency} lanes busy
                  {usage.waiting > 0 ? `, ${usage.waiting} waiting` : ""}.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Recent documents</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 px-2 pb-3">
              {jobs.length === 0 && (
                <p className="px-2 py-4 text-sm text-muted-foreground">No documents yet.</p>
              )}
              {jobs.map((j) => {
                const pct = j.chunksTotal > 0 ? Math.round(((j.chunksDone + j.chunksFailed) / j.chunksTotal) * 100) : 0;
                return (
                  <button
                    key={j.id}
                    onClick={() => setSelectedId(j.id)}
                    className={`w-full rounded-lg px-3 py-2 text-left transition-colors ${
                      activeJobId === j.id ? "bg-accent" : "hover:bg-accent/50"
                    }`}
                    data-testid={`ocr-job-${j.id}`}
                  >
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate text-sm font-medium">{j.fileName}</span>
                      {statusBadge(j.status)}
                    </div>
                    <div className="mt-1 flex items-center gap-2 pl-6 text-xs text-muted-foreground">
                      <span>{j.pageCount} pages</span>
                      <span>·</span>
                      <span>
                        {j.chunksDone}/{j.chunksTotal} ranges
                      </span>
                      {j.chunksFailed > 0 && <span className="text-destructive">· {j.chunksFailed} failed</span>}
                    </div>
                    {!TERMINAL.includes(j.status) && <Progress value={pct} className="mt-1.5 h-1" />}
                  </button>
                );
              })}
            </CardContent>
          </Card>
        </div>

        {/* ─── Right column: progress + document ──────────────────────────── */}
        <div className="space-y-4">
          {!job && (
            <Card>
              <CardContent className="py-16 text-center text-sm text-muted-foreground">
                Upload a document to see its transcription here.
              </CardContent>
            </Card>
          )}

          {job && (
            <>
              <Card>
                <CardContent className="space-y-3 pt-6">
                  <div className="flex flex-wrap items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{job.fileName}</span>
                    {statusBadge(job.status)}
                    <span className="text-xs text-muted-foreground">
                      {job.pageCount} pages · {job.model}
                      {job.textMode === "ocr" ? " · always OCR" : ""} · {formatBytes(job.fileSize)}
                    </span>
                    <div className="ml-auto flex items-center gap-2">
                      {/* The OCR → Grantha entry point. Available as soon as any page
                          range has been transcribed, so a long book can be structured
                          while its tail is still being read. */}
                      <Button
                        size="sm"
                        disabled={job.chunksDone === 0}
                        title={
                          job.chunksDone === 0
                            ? "Wait for the first page range to be transcribed"
                            : "Organise this transcription into a grantha hierarchy"
                        }
                        onClick={() => setWizardOpen(true)}
                        data-testid="ocr-create-grantha"
                      >
                        <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                        {latestStructureJob ? "Continue Grantha" : "Create Grantha from OCR"}
                      </Button>
                      {running && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => actionMutation.mutate({ id: job.id, action: "cancel" })}
                          data-testid="ocr-cancel"
                        >
                          <Ban className="mr-1.5 h-3.5 w-3.5" /> Cancel
                        </Button>
                      )}
                      {!running && (job.chunksFailed > 0 || job.status === "cancelled") && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => actionMutation.mutate({ id: job.id, action: "retry" })}
                          data-testid="ocr-retry"
                        >
                          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry failed
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (confirm(`Delete "${job.fileName}" and its transcription?`)) {
                            actionMutation.mutate({ id: job.id, action: "delete" });
                          }
                        }}
                        data-testid="ocr-delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Progress
                      value={
                        progress && progress.pagesTotal > 0
                          ? (progress.pagesDone / progress.pagesTotal) * 100
                          : job.chunksTotal > 0
                            ? (job.chunksDone / job.chunksTotal) * 100
                            : 0
                      }
                      data-testid="ocr-progress"
                    />
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground" data-testid="ocr-pages-done">
                        {progress ? `${progress.pagesDone}/${progress.pagesTotal} pages transcribed` : `${job.chunksDone}/${job.chunksTotal} page ranges transcribed`}
                      </span>
                      {progress && progress.pagesRunning > 0 && running && (
                        <span className="text-blue-700 dark:text-blue-300">{progress.pagesRunning} in progress</span>
                      )}
                      {progress && progress.pagesFailed > 0 && (
                        <span className="text-destructive">{progress.pagesFailed} failed</span>
                      )}
                      {elapsedMs != null && (
                        <span data-testid="ocr-elapsed">
                          {running ? "elapsed" : "took"} {formatDuration(elapsedMs)}
                        </span>
                      )}
                      {eta && (
                        <span className="text-foreground" data-testid="ocr-eta">
                          {eta}
                        </span>
                      )}
                      {flaggedPages.length > 0 && (
                        <span className="text-amber-700 dark:text-amber-300" data-testid="ocr-flagged-count">
                          {flaggedPages.length} page{flaggedPages.length === 1 ? "" : "s"} flagged for review
                        </span>
                      )}
                    </div>
                  </div>

                  {/* What each in-flight range is doing, with live countdowns. */}
                  {running && (runningChunks.length > 0 || queuedChunkCount > 0) && (
                    <ul className="space-y-1 rounded-md border border-border bg-muted/30 p-2.5 text-xs" data-testid="ocr-live">
                      {runningChunks.map((c) => (
                        <li key={c.chunkIndex} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          {c.live?.phase === "backoff" ? (
                            <AlertTriangle className="h-3 w-3 shrink-0 text-amber-600" />
                          ) : (
                            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-blue-600" />
                          )}
                          <span className="font-medium">
                            {c.startPage === c.endPage ? `Page ${c.startPage}` : `Pages ${c.startPage}–${c.endPage}`}
                          </span>
                          <span className="text-muted-foreground">{describeLive(c, serverNow)}</span>
                        </li>
                      ))}
                      {runningChunks.length === 0 && (
                        <li className="flex items-center gap-2 text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" /> Waiting for a worker to pick up the first range…
                        </li>
                      )}
                      {queuedChunkCount > 0 && (
                        <li className="pl-5 text-muted-foreground">
                          {queuedChunkCount} more range{queuedChunkCount === 1 ? "" : "s"} waiting their turn
                        </li>
                      )}
                      {progress && progress.retrying > 0 && (
                        <li className="pl-5 pt-1 text-muted-foreground">
                          A page hit a transient engine error and is retrying on its own; nothing is lost.
                        </li>
                      )}
                    </ul>
                  )}

                  {/* One tile per page range — the unit of work and of retry. */}
                  {detail && detail.chunks.length > 1 && (
                    <div className="flex flex-wrap gap-1">
                      {detail.chunks.map((c) => (
                        <span
                          key={c.chunkIndex}
                          title={`Pages ${c.startPage}–${c.endPage}${c.error ? ` — ${c.error}` : ""}`}
                          className={`h-2.5 w-6 rounded-sm ${
                            c.status === "done"
                              ? "bg-emerald-500"
                              : c.status === "running"
                                ? "animate-pulse bg-blue-500"
                                : c.status === "failed" || c.status === "skipped"
                                  ? "bg-destructive"
                                  : "bg-muted"
                          }`}
                        />
                      ))}
                    </div>
                  )}

                  {job.error && (
                    <p className="flex items-start gap-2 text-xs text-destructive">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {job.error}
                    </p>
                  )}
                </CardContent>
              </Card>

              {pages.length > 0 && (
                <Card>
                  <CardContent className="pt-6">
                    <div className="mb-4 flex flex-wrap items-center gap-2">
                      <div className="relative min-w-[220px] flex-1">
                        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder="Search the transcription…"
                          className="pl-8"
                          data-testid="ocr-search"
                        />
                        {search && (
                          <button
                            onClick={() => setSearch("")}
                            className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                      {search.trim().length >= 2 && (
                        <span className="text-xs text-muted-foreground">{matchCount} matches</span>
                      )}
                      <Separator orientation="vertical" className="h-6" />
                      <Button variant="outline" size="sm" onClick={copyAll} data-testid="ocr-copy">
                        <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy
                      </Button>
                      <Button variant="outline" size="sm" onClick={printDocument} data-testid="ocr-print">
                        <Printer className="mr-1.5 h-3.5 w-3.5" /> Print / PDF
                      </Button>
                      <Button variant="outline" size="sm" asChild>
                        <a href={`${JOBS_KEY}/${job.id}/download?format=md`} download>
                          <Download className="mr-1.5 h-3.5 w-3.5" /> .md
                        </a>
                      </Button>
                      <Button variant="outline" size="sm" asChild>
                        <a href={`${JOBS_KEY}/${job.id}/download?format=txt`} download>
                          <Download className="mr-1.5 h-3.5 w-3.5" /> .txt
                        </a>
                      </Button>
                      <Button variant="outline" size="sm" asChild>
                        <a
                          href={`${JOBS_KEY}/${job.id}/download?format=raw`}
                          download
                          title="The engine's untouched output, before normalization — for comparison"
                        >
                          <Download className="mr-1.5 h-3.5 w-3.5" /> Raw
                        </a>
                      </Button>
                      <Button variant="ghost" size="sm" asChild>
                        <a href={`${JOBS_KEY}/${job.id}/source`} target="_blank" rel="noreferrer">
                          Original
                        </a>
                      </Button>
                    </div>

                    {docQuery.data?.missingRanges?.length ? (
                      <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                        <p className="mb-1 flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-300">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {docQuery.data.missingRanges.length} page range(s) not transcribed yet
                        </p>
                        <p className="text-muted-foreground">
                          {docQuery.data.missingRanges
                            .slice(0, 6)
                            .map((r) => `p${r.startPage}–${r.endPage}`)
                            .join(", ")}
                          {docQuery.data.missingRanges.length > 6 ? " …" : ""}
                          {running ? " — still running." : " — use Retry failed."}
                        </p>
                      </div>
                    ) : null}

                    {/* Paginated, page-shaped view of the merged transcription. */}
                    <div className="max-h-[70vh] space-y-6 overflow-y-auto rounded-lg bg-muted/40 p-4">
                      {renderedPages.map((p) => (
                        <article
                          key={p.page}
                          className="mx-auto w-full max-w-[820px] rounded-md border border-border bg-background px-10 py-8 shadow-sm"
                          data-testid={`ocr-page-${p.page}`}
                        >
                          {p.meta && p.meta.flags.length > 0 && (
                            <div
                              className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs"
                              data-testid={`ocr-page-flags-${p.page}`}
                            >
                              <p className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-300">
                                <AlertTriangle className="h-3.5 w-3.5" /> Review this page
                              </p>
                              <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                                {p.meta.flags.map((flag) => (
                                  <li key={flag}>{OCR_PAGE_FLAG_LABELS[flag] ?? flag}</li>
                                ))}
                              </ul>
                              {p.meta.lowConfidenceSamples && p.meta.lowConfidenceSamples.length > 0 && (
                                <p className="mt-1 text-muted-foreground">
                                  Uncertain words: {p.meta.lowConfidenceSamples.slice(0, 8).join(" · ")}
                                </p>
                              )}
                            </div>
                          )}
                          <div
                            className="ocr-page-body text-[15px] leading-relaxed"
                            dangerouslySetInnerHTML={{ __html: p.html }}
                          />
                          <div className="mt-6 border-t border-border pt-2 text-right text-[11px] text-muted-foreground">
                            Page {p.page}
                            {p.meta && (
                              <>
                                {" · "}
                                {p.meta.source === "embedded" ? "PDF text layer" : p.meta.engine}
                                {p.meta.confidence != null ? ` · confidence ${Math.round(p.meta.confidence)}` : ""}
                              </>
                            )}
                          </div>
                        </article>
                      ))}
                      {running && (
                        <p className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" /> More pages are still being
                          transcribed…
                        </p>
                      )}
                      {!running && job.status === "done" && (
                        <p className="flex items-center justify-center gap-2 py-4 text-sm text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 className="h-4 w-4" /> All {pages.length} pages transcribed.
                        </p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}

              {pages.length === 0 && running && (
                <Card>
                  <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-center text-sm text-muted-foreground">
                    <p className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" /> Transcribing the first page range…
                    </p>
                    <p className="text-xs">
                      {elapsedMs != null && <>Running for {formatDuration(elapsedMs)}. </>}
                      {etaLeftMs != null
                        ? `First pages should land within about ${formatDuration(Math.min(etaLeftMs, (progress?.msPerPage ?? 6000) * job.chunkSize + 8000))}.`
                        : "Pages appear here as soon as one range finishes."}
                    </p>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      </div>

      {job && (
        <OcrStructureWizard
          open={wizardOpen}
          onOpenChange={setWizardOpen}
          ocrJob={job}
          granthaOptions={granthaOptions}
        />
      )}
    </div>
  );
}
