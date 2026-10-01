/**
 * Translation Jobs (admin only).
 *
 * Start a whole-grantha translation and walk away: the job lives in Postgres and
 * a worker process on the server drains it over hours or days. Closing this page
 * — or the browser — changes nothing. Everything here is a view over the queue.
 *
 * Live status is polling, not sockets (this project has no socket layer): the
 * list and the open job refresh every few seconds WHILE something is active and
 * stop entirely once every job is terminal.
 */
import { useMemo, useState } from "react";
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
import { Separator } from "@/components/ui/separator";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  Languages,
  Loader2,
  Play,
  RefreshCw,
  Server,
} from "lucide-react";
import { otherTranslationLanguages, type TranslationJobStatus } from "@shared/schema";

const JOBS_KEY = "/api/translation-jobs";
const QUEUE_KEY = "/api/translation-jobs/queue/overview";

const TERMINAL: TranslationJobStatus[] = ["completed", "partially_failed", "failed", "cancelled"];

type JobRow = {
  id: string;
  status: TranslationJobStatus;
  grantha_name: string | null;
  created_by: string | null;
  target_languages: string[];
  total: number;
  completed: number;
  processing: number;
  queued: number;
  failed: number;
  retry_count: number;
  progress: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  last_activity_at: string | null;
  completed_at: string | null;
};

type JobDetail = JobRow & {
  counts: { queued: number; processing: number; completed: number; failed: number };
  current_item: ItemRow | null;
  recent_errors: Array<{
    item: number;
    mantra: string | null;
    attempts: number;
    error: string | null;
    last_attempt_at: string | null;
  }>;
  worker_enabled: boolean;
};

type ItemRow = {
  id: number;
  job_id: string;
  sequence_number: number;
  mantra_doc_id: string | null;
  mantra_label: string | null;
  status: "queued" | "processing" | "completed" | "failed";
  attempts: number;
  error: string | null;
  translated_text: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_attempt_at: string | null;
};

type Summary = {
  totalJobs: number;
  activeJobs: number;
  queuedJobs: number;
  completedJobs: number;
  failedJobs: number;
  cancelledJobs: number;
  queuedItems: number;
  processingItems: number;
  failedItems: number;
};

const ITEM_FILTERS = ["all", "queued", "processing", "completed", "failed"] as const;
type ItemFilter = (typeof ITEM_FILTERS)[number];

function statusBadge(status: string) {
  const map: Record<string, string> = {
    queued: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    processing: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    partially_failed: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    failed: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
    cancelled: "bg-muted text-muted-foreground",
  };
  return map[status] ?? map.queued;
}

function when(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

/** "3,847" — thousands of mantras are the normal case here. */
const n = (value: number | null | undefined) => (value ?? 0).toLocaleString();

export default function AdminTranslationsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === "admin";

  const [granthaName, setGranthaName] = useState("");
  const [languageInput, setLanguageInput] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [itemFilter, setItemFilter] = useState<ItemFilter>("all");
  const [itemPage, setItemPage] = useState(1);

  const jobsQuery = useQuery<{ jobs: JobRow[]; summary: Summary; worker_enabled: boolean }>({
    queryKey: [JOBS_KEY],
    enabled: isAdmin,
    // Poll only while something can still change; a finished board is static.
    refetchInterval: (query) => {
      const jobs = (query.state.data as any)?.jobs as JobRow[] | undefined;
      return jobs?.some((j) => !TERMINAL.includes(j.status)) ? 8000 : false;
    },
  });

  const jobs = jobsQuery.data?.jobs ?? [];
  const summary = jobsQuery.data?.summary;
  const activeJobId = selectedId ?? jobs[0]?.id ?? null;

  const detailQuery = useQuery<JobDetail>({
    queryKey: [`${JOBS_KEY}/${activeJobId}`],
    enabled: Boolean(isAdmin && activeJobId),
    refetchInterval: (query) => {
      const job = query.state.data as JobDetail | undefined;
      return job && !TERMINAL.includes(job.status) ? 6000 : false;
    },
  });
  const detail = detailQuery.data;
  const jobRunning = detail ? !TERMINAL.includes(detail.status) : false;

  const itemsQuery = useQuery<{ items: ItemRow[]; page: number; total: number; page_count: number }>({
    queryKey: [
      `${JOBS_KEY}/${activeJobId}/items`,
      { status: itemFilter === "all" ? "" : itemFilter, page: itemPage },
    ],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(itemPage), limit: "25" });
      if (itemFilter !== "all") params.set("status", itemFilter);
      const res = await apiRequest("GET", `${JOBS_KEY}/${activeJobId}/items?${params}`);
      return res.json();
    },
    enabled: Boolean(isAdmin && activeJobId),
    refetchInterval: jobRunning ? 10_000 : false,
  });

  const queueQuery = useQuery<{
    processing: ItemRow[];
    upcoming: ItemRow[];
    failed: ItemRow[];
    summary: Summary;
    worker_enabled: boolean;
  }>({
    queryKey: [QUEUE_KEY],
    enabled: isAdmin,
    refetchInterval: (query) => {
      const data = query.state.data as any;
      const busy = (data?.processing?.length ?? 0) > 0 || (data?.upcoming?.length ?? 0) > 0;
      return busy ? 8000 : 30_000;
    },
  });

  const requestedLanguages = useMemo(
    () =>
      languageInput
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean),
    [languageInput],
  );
  const unknownLanguages = requestedLanguages.filter(
    (l) => !(otherTranslationLanguages as readonly string[]).includes(l),
  );

  function refreshAll() {
    void queryClient.invalidateQueries({ queryKey: [JOBS_KEY] });
    void queryClient.invalidateQueries({ queryKey: [QUEUE_KEY] });
    if (activeJobId) {
      void queryClient.invalidateQueries({ queryKey: [`${JOBS_KEY}/${activeJobId}`] });
      void queryClient.invalidateQueries({ queryKey: [`${JOBS_KEY}/${activeJobId}/items`] });
    }
  }

  const createJob = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", JOBS_KEY, {
        granthaName: granthaName.trim(),
        targetLanguages: requestedLanguages,
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "Translation job queued",
        description: `${n(data.total_items)} mantra(s) queued. The worker picks them up on its own — you can close this page.`,
      });
      setGranthaName("");
      setSelectedId(data.job_id);
      refreshAll();
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Could not queue the job", description: err?.message });
    },
  });

  const cancelJob = useMutation({
    mutationFn: async (jobId: string) => (await apiRequest("POST", `${JOBS_KEY}/${jobId}/cancel`, {})).json(),
    onSuccess: (data: any) => {
      toast({
        title: "Job cancelled",
        description: `${n(data.cancelledItems)} queued item(s) stopped. Anything already in flight finishes first.`,
      });
      refreshAll();
    },
    onError: (err: any) => toast({ variant: "destructive", title: "Cancel failed", description: err?.message }),
  });

  const retryJob = useMutation({
    mutationFn: async (jobId: string) =>
      (await apiRequest("POST", `${JOBS_KEY}/${jobId}/retry-failed`, {})).json(),
    onSuccess: (data: any) => {
      toast({ title: "Failed items requeued", description: `${n(data.requeued)} item(s) back in the queue.` });
      refreshAll();
    },
    onError: (err: any) => toast({ variant: "destructive", title: "Retry failed", description: err?.message }),
  });

  if (!isAdmin) {
    return (
      <div className="max-w-2xl mx-auto p-6 text-sm text-muted-foreground">
        Admin access required to view translation jobs.
      </div>
    );
  }

  const workerEnabled = jobsQuery.data?.worker_enabled ?? true;

  return (
    <div className="mx-auto max-w-[1400px] p-6 space-y-6" data-testid="page-admin-translations">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <Languages className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Translation Jobs</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Queue a grantha for Gemini translation. The work runs on the server, one mantra at a time,
          and survives restarts — nothing needs to stay open here.
        </p>
      </div>

      {!workerEnabled ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Hermex is disabled on this server (HERMEX_ENABLED=0). Jobs can be queued but nothing will run
          until it is enabled and the worker process is started.
        </div>
      ) : null}

      {/* ── Summary ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          { label: "Total jobs", value: summary?.totalJobs, testId: "tile-total" },
          { label: "Active", value: summary?.activeJobs, testId: "tile-active" },
          { label: "Queued", value: summary?.queuedJobs, testId: "tile-queued" },
          { label: "Completed", value: summary?.completedJobs, testId: "tile-completed" },
          { label: "Failed", value: summary?.failedJobs, testId: "tile-failed" },
        ].map((tile) => (
          <Card key={tile.label} data-testid={tile.testId}>
            <CardContent className="p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">{tile.label}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{n(tile.value)}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Start a job ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Start a translation</CardTitle>
          <CardDescription>
            One job per grantha. Every mantra becomes its own queue row, so progress is kept per verse
            and a failure never costs the verses that already succeeded.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <Label htmlFor="grantha-name" className="text-xs">
                Grantha name
              </Label>
              <Input
                id="grantha-name"
                value={granthaName}
                onChange={(e) => setGranthaName(e.target.value)}
                placeholder="Chandogya Upanishad"
                className="mt-1.5"
                data-testid="input-grantha-name"
              />
            </div>
            <div>
              <Label htmlFor="languages" className="text-xs">
                Languages (comma-separated — leave blank for every missing language)
              </Label>
              <Input
                id="languages"
                value={languageInput}
                onChange={(e) => setLanguageInput(e.target.value)}
                placeholder="Tamil, Kannada, Telugu"
                className="mt-1.5"
                data-testid="input-languages"
              />
              {unknownLanguages.length > 0 ? (
                <p className="mt-1 text-xs text-destructive">
                  Not a supported language: {unknownLanguages.join(", ")}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={() => createJob.mutate()}
              disabled={!granthaName.trim() || unknownLanguages.length > 0 || createJob.isPending}
              data-testid="button-create-job"
            >
              {createJob.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              Queue job
            </Button>
            <Button variant="outline" onClick={refreshAll} data-testid="button-refresh">
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          {/* ── Job table ─────────────────────────────────────────────── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Jobs</CardTitle>
              <CardDescription>Click a row to open it.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 text-left">Job</th>
                      <th className="px-4 py-2 text-left">Status</th>
                      <th className="px-4 py-2 text-left">Progress</th>
                      <th className="px-3 py-2 text-right">Done</th>
                      <th className="px-3 py-2 text-right">Failed</th>
                      <th className="px-3 py-2 text-right">Left</th>
                      <th className="px-4 py-2 text-left">Created</th>
                      <th className="px-4 py-2 text-left">Last activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="px-4 py-6 text-center text-muted-foreground">
                          {jobsQuery.isLoading ? "Loading…" : "No translation jobs yet."}
                        </td>
                      </tr>
                    ) : (
                      jobs.map((job) => (
                        <tr
                          key={job.id}
                          onClick={() => {
                            setSelectedId(job.id);
                            setItemPage(1);
                          }}
                          className={`cursor-pointer border-b transition-colors hover:bg-muted/40 ${
                            job.id === activeJobId ? "bg-muted/60" : ""
                          }`}
                          data-testid={`row-job-${job.id}`}
                        >
                          <td className="px-4 py-2">
                            <div className="font-medium">{job.grantha_name || "(explicit list)"}</div>
                            <div className="font-mono text-[11px] text-muted-foreground">
                              {job.id.slice(0, 8)}
                            </div>
                          </td>
                          <td className="px-4 py-2">
                            <Badge variant="secondary" className={statusBadge(job.status)}>
                              {job.status}
                            </Badge>
                          </td>
                          <td className="px-4 py-2 min-w-[140px]">
                            <Progress value={job.progress} className="h-2" />
                            <span className="text-[11px] tabular-nums text-muted-foreground">
                              {job.progress.toFixed(2)}%
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{n(job.completed)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {job.failed > 0 ? (
                              <span className="text-destructive">{n(job.failed)}</span>
                            ) : (
                              0
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {n(job.queued + job.processing)}
                          </td>
                          <td className="px-4 py-2 text-xs text-muted-foreground">{when(job.created_at)}</td>
                          <td className="px-4 py-2 text-xs text-muted-foreground">
                            {when(job.last_activity_at)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* ── Job detail ────────────────────────────────────────────── */}
          {detail ? (
            <Card data-testid="panel-job-detail">
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">
                      {detail.grantha_name || "Translation job"}{" "}
                      <span className="font-mono text-xs text-muted-foreground">
                        #{detail.id.slice(0, 8)}
                      </span>
                    </CardTitle>
                    <CardDescription>
                      {detail.target_languages?.length
                        ? `Languages: ${detail.target_languages.join(", ")}`
                        : "Every language still missing on each mantra"}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className={statusBadge(detail.status)}>
                      {detail.status}
                    </Badge>
                    {!TERMINAL.includes(detail.status) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => cancelJob.mutate(detail.id)}
                        disabled={cancelJob.isPending}
                        data-testid="button-cancel-job"
                      >
                        <Ban className="mr-2 h-4 w-4" />
                        Cancel
                      </Button>
                    ) : null}
                    {detail.failed > 0 ? (
                      <Button
                        size="sm"
                        onClick={() => retryJob.mutate(detail.id)}
                        disabled={retryJob.isPending}
                        data-testid="button-retry-failed"
                      >
                        <RefreshCw className="mr-2 h-4 w-4" />
                        Retry {n(detail.failed)} failed
                      </Button>
                    ) : null}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="tabular-nums">
                      {n(detail.completed)} / {n(detail.total)}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {detail.progress.toFixed(2)}%
                    </span>
                  </div>
                  <Progress value={detail.progress} className="h-3" data-testid="progress-job" />
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Queued</p>
                    <p className="tabular-nums">{n(detail.counts?.queued)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Processing</p>
                    <p className="tabular-nums">{n(detail.counts?.processing)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Completed</p>
                    <p className="tabular-nums">{n(detail.counts?.completed)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Failed</p>
                    <p className="tabular-nums">{n(detail.counts?.failed)}</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground md:grid-cols-4">
                  <div>
                    <p>Created</p>
                    <p className="text-foreground">{when(detail.created_at)}</p>
                  </div>
                  <div>
                    <p>Started</p>
                    <p className="text-foreground">{when(detail.started_at)}</p>
                  </div>
                  <div>
                    <p>Last activity</p>
                    <p className="text-foreground">{when(detail.last_activity_at)}</p>
                  </div>
                  <div>
                    <p>Finished</p>
                    <p className="text-foreground">{when(detail.completed_at)}</p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <span className="flex items-center gap-1.5">
                    <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
                    Retries so far: <span className="tabular-nums">{n(detail.retry_count)}</span>
                  </span>
                  {detail.current_item ? (
                    <span className="flex items-center gap-1.5">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
                      Now translating #{detail.current_item.sequence_number}{" "}
                      {detail.current_item.mantra_label ? `(${detail.current_item.mantra_label})` : ""} — attempt{" "}
                      {detail.current_item.attempts}
                    </span>
                  ) : null}
                </div>

                {detail.recent_errors?.length ? (
                  <>
                    <Separator />
                    <div>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Recent errors
                      </p>
                      <ul className="space-y-1.5 text-xs">
                        {detail.recent_errors.map((e) => (
                          <li key={e.item} className="rounded border border-destructive/30 p-2">
                            <span className="font-medium">
                              #{e.item} {e.mantra ?? ""}
                            </span>{" "}
                            <span className="text-muted-foreground">
                              · {e.attempts} attempt(s) · {when(e.last_attempt_at)}
                            </span>
                            <div className="mt-0.5 text-destructive">{e.error}</div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </>
                ) : null}

                <Separator />

                {/* ── Item list with filters + pagination ──────────────── */}
                <div>
                  <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    {ITEM_FILTERS.map((f) => (
                      <Button
                        key={f}
                        size="sm"
                        variant={itemFilter === f ? "default" : "outline"}
                        onClick={() => {
                          setItemFilter(f);
                          setItemPage(1);
                        }}
                        data-testid={`button-filter-${f}`}
                      >
                        {f === "all" ? "All" : f[0].toUpperCase() + f.slice(1)}
                      </Button>
                    ))}
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                      {n(itemsQuery.data?.total)} item(s)
                    </span>
                  </div>

                  <div className="overflow-x-auto rounded border">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="px-3 py-1.5 text-left">#</th>
                          <th className="px-3 py-1.5 text-left">Mantra</th>
                          <th className="px-3 py-1.5 text-left">Status</th>
                          <th className="px-3 py-1.5 text-right">Attempts</th>
                          <th className="px-3 py-1.5 text-left">Last attempt</th>
                          <th className="px-3 py-1.5 text-left">Result / error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(itemsQuery.data?.items ?? []).map((item) => (
                          <tr key={item.id} className="border-t" data-testid={`row-item-${item.id}`}>
                            <td className="px-3 py-1.5 tabular-nums">{item.sequence_number}</td>
                            <td className="px-3 py-1.5">{item.mantra_label ?? item.mantra_doc_id}</td>
                            <td className="px-3 py-1.5">
                              <Badge variant="secondary" className={statusBadge(item.status)}>
                                {item.status}
                              </Badge>
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{item.attempts}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">
                              {when(item.last_attempt_at)}
                            </td>
                            <td className="px-3 py-1.5">
                              {item.error ? (
                                <span className="text-destructive">{item.error}</span>
                              ) : (
                                <span className="text-muted-foreground">
                                  {item.translated_text?.split("\n")[0] ?? "—"}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                        {(itemsQuery.data?.items?.length ?? 0) === 0 ? (
                          <tr>
                            <td colSpan={6} className="px-3 py-4 text-center text-muted-foreground">
                              Nothing here.
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-2 flex items-center justify-between text-xs">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={itemPage <= 1}
                      onClick={() => setItemPage((p) => Math.max(1, p - 1))}
                      data-testid="button-items-prev"
                    >
                      Previous
                    </Button>
                    <span className="tabular-nums text-muted-foreground">
                      Page {itemsQuery.data?.page ?? 1} of {itemsQuery.data?.page_count ?? 1}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={(itemsQuery.data?.page ?? 1) >= (itemsQuery.data?.page_count ?? 1)}
                      onClick={() => setItemPage((p) => p + 1)}
                      data-testid="button-items-next"
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>

        {/* ── Queue view ───────────────────────────────────────────────── */}
        <Card className="h-fit" data-testid="panel-queue">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Server className="h-4 w-4 text-primary" />
              Queue
            </CardTitle>
            <CardDescription>Across every job, in the order the worker will take them.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 text-sm">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Currently processing
              </p>
              {(queueQuery.data?.processing?.length ?? 0) === 0 ? (
                <p className="text-xs text-muted-foreground">Nothing in flight.</p>
              ) : (
                <ul className="space-y-2">
                  {queueQuery.data!.processing.map((item) => (
                    <li key={item.id} className="rounded border p-2" data-testid={`queue-processing-${item.id}`}>
                      <div className="flex items-center gap-1.5 font-medium">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />#
                        {item.sequence_number} {item.mantra_label ?? ""}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        job {item.job_id.slice(0, 8)} · started {when(item.started_at)} · attempt {item.attempts}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Next queued
              </p>
              {(queueQuery.data?.upcoming?.length ?? 0) === 0 ? (
                <p className="text-xs text-muted-foreground">The queue is empty.</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {queueQuery.data!.upcoming.slice(0, 10).map((item) => (
                    <li key={item.id} className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5">
                        <Clock className="h-3 w-3 text-muted-foreground" />#{item.sequence_number}{" "}
                        {item.mantra_label ?? ""}
                      </span>
                      <span className="text-muted-foreground">
                        {item.job_id.slice(0, 8)} · {when(item.created_at)}
                        {item.attempts > 0 ? ` · ${item.attempts} try` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Failed items
              </p>
              {(queueQuery.data?.failed?.length ?? 0) === 0 ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                  None.
                </p>
              ) : (
                <ul className="space-y-2 text-xs">
                  {queueQuery.data!.failed.slice(0, 8).map((item) => (
                    <li key={item.id} className="rounded border border-destructive/30 p-2">
                      <div className="font-medium">
                        #{item.sequence_number} {item.mantra_label ?? ""}
                      </div>
                      <div className="text-muted-foreground">
                        {item.attempts} attempt(s) · {when(item.last_attempt_at)}
                      </div>
                      <div className="mt-0.5 text-destructive">{item.error}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
