/**
 * Node side of `python/hermex_translate/prompt_session.py`: one Chrome on one
 * task-specific Gemini profile, kept open across many prompts.
 *
 * Opening Chrome and warming Gemini up costs ~30–60s, so a structure job opens ONE
 * session and sends every page range through it, instead of paying that per range.
 *
 * Guarantees:
 *   - one request in flight per session; each carries a correlation id and only the
 *     answer bearing that id can resolve it — an answer can never be attributed to
 *     another request;
 *   - every request runs in a fresh Gemini chat (the Python side starts one);
 *   - a request outliving its ceiling, or cancelled, kills the session (the browser
 *     state is then unknown); the caller opens a new one if it wants to continue;
 *   - failures are `HermexError`s with the same reason vocabulary translation uses.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { HermexError, scrubHermexText, type HermexFailureReason } from "../hermex-translate";
import { hermexPython, repoRoot } from "./config";
import { promptSessionScript, taskChildEnv, type HermexTaskProfile } from "./task-profiles";

export interface PromptSessionOptions {
  profile: HermexTaskProfile;
  /** How long the browser may take to launch, log in and warm up. */
  launchTimeoutMs: number;
  /** Override for tests. */
  python?: string;
  script?: string;
  /** Prefix for log lines, e.g. the job id — never document text. */
  label: string;
}

type Pending = {
  id: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  onAbort?: () => void;
  signal?: AbortSignal;
};

const KNOWN_REASONS = new Set<HermexFailureReason>([
  "unavailable", "display", "chrome", "login", "timeout", "empty", "malformed", "process", "busy", "transient", "unknown",
]);

function asReason(value: unknown): HermexFailureReason {
  return KNOWN_REASONS.has(value as HermexFailureReason) ? (value as HermexFailureReason) : "unknown";
}

function log(label: string, message: string): void {
  console.log(`[hermex-session ${label}] ${message}`);
}

export class HermexPromptSession {
  private child: ChildProcess | null = null;
  private pending: Pending | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private stderrTail = "";
  private exitError: HermexError | null = null;

  private constructor(private readonly opts: PromptSessionOptions) {}

  /** Launch the browser and wait until it is logged in and ready (or fail precisely). */
  static async open(opts: PromptSessionOptions): Promise<HermexPromptSession> {
    const session = new HermexPromptSession(opts);
    await session.start();
    return session;
  }

  get alive(): boolean {
    return !this.closed && this.child != null && this.child.exitCode == null;
  }

  private start(): Promise<void> {
    const python = this.opts.python ?? hermexPython();
    const script = this.opts.script ?? promptSessionScript();
    log(this.opts.label, `starting browser session (profile=${this.opts.profile.task}, headless=${this.opts.profile.headless})`);

    return new Promise<void>((resolve, reject) => {
      let ready = false;
      const child = spawn(python, [script], {
        cwd: repoRoot(),
        env: taskChildEnv(this.opts.profile),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
      this.child = child;

      const launchTimer = setTimeout(() => {
        if (ready) return;
        this.kill();
        reject(new HermexError("timeout", `The Gemini browser did not become ready within ${Math.round(this.opts.launchTimeoutMs / 1000)}s.`));
      }, this.opts.launchTimeoutMs);

      child.on("error", (err) => {
        clearTimeout(launchTimer);
        this.closed = true;
        reject(new HermexError(err && (err as any).code === "ENOENT" ? "unavailable" : "process", `Could not start Hermex: ${scrubHermexText(err)}`));
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4_000);
      });

      const lines = readline.createInterface({ input: child.stdout! });
      lines.on("line", (line) => {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          log(this.opts.label, "ignored a non-protocol line on stdout");
          return;
        }
        if (!ready) {
          if (msg?.type === "ready") {
            ready = true;
            clearTimeout(launchTimer);
            log(this.opts.label, "browser session ready");
            resolve();
          } else if (msg?.type === "fatal") {
            clearTimeout(launchTimer);
            const err = new HermexError(asReason(msg.reason), scrubHermexText(msg.error ?? "Hermex session failed to start", 400));
            this.exitError = err;
            reject(err);
          }
          return;
        }
        this.onAnswer(msg);
      });

      child.on("close", (code) => {
        clearTimeout(launchTimer);
        this.closed = true;
        const err =
          this.exitError ??
          new HermexError("chrome", `The Gemini browser session ended (exit ${code ?? "?"}).${this.stderrTail ? ` ${scrubHermexText(this.stderrTail.split("\n").filter(Boolean).slice(-2).join(" "), 300)}` : ""}`);
        if (!ready) reject(err);
        this.failPending(err);
      });
    });
  }

  private onAnswer(msg: any): void {
    const pending = this.pending;
    if (!pending || msg?.id !== pending.id) {
      // Belongs to no live request (a late answer after a timeout, or a stray line):
      // never attribute it to whatever is waiting now.
      log(this.opts.label, `discarded an answer for ${String(msg?.id ?? "?").slice(0, 8)} (no matching request)`);
      return;
    }
    this.settle();
    if (msg.ok === true && typeof msg.text === "string") {
      pending.resolve(msg.text);
    } else {
      pending.reject(new HermexError(asReason(msg.reason), scrubHermexText(msg.error ?? "Gemini request failed", 400)));
    }
  }

  private settle(): void {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    if (p.onAbort) p.signal?.removeEventListener("abort", p.onAbort);
    this.pending = null;
  }

  private failPending(err: Error): void {
    const p = this.pending;
    if (!p) return;
    this.settle();
    p.reject(err);
  }

  /**
   * Send one prompt; resolves with Gemini's reply text. Calls queue behind each
   * other — a session never has two requests in flight.
   */
  ask(prompt: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<string> {
    const run = () => this.askNow(prompt, opts);
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private askNow(prompt: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<string> {
    if (!this.alive) {
      return Promise.reject(this.exitError ?? new HermexError("chrome", "The Gemini browser session is not running."));
    }
    if (opts.signal?.aborted) return Promise.reject(new HermexError("unknown", "Cancelled.", { retryable: false }));

    return new Promise<string>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.settle();
        // The browser may still be generating; its state is unknown, so the session ends.
        this.kill();
        reject(new HermexError("timeout", `Gemini did not answer within ${Math.round(opts.timeoutMs / 1000)}s.`));
      }, opts.timeoutMs);
      const pending: Pending = { id, resolve, reject, timer, signal: opts.signal };
      if (opts.signal) {
        pending.onAbort = () => {
          this.settle();
          this.kill();
          reject(new HermexError("unknown", "Cancelled.", { retryable: false }));
        };
        opts.signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending = pending;
      // Python's own per-query wait is shorter than ours, so it reports its timeout first.
      const timeoutSec = Math.max(60, Math.floor((opts.timeoutMs * 0.8) / 3 / 1000));
      this.child!.stdin!.write(JSON.stringify({ id, op: "ask", prompt, timeoutSec }) + "\n");
    });
  }

  /** Close the browser politely; force it after a grace period. */
  async close(): Promise<void> {
    if (this.closed || !this.child) return;
    const child = this.child;
    await new Promise<void>((resolve) => {
      const grace = setTimeout(() => {
        this.kill();
        resolve();
      }, 30_000);
      child.once("close", () => {
        clearTimeout(grace);
        resolve();
      });
      try {
        child.stdin?.write(JSON.stringify({ op: "close" }) + "\n");
        child.stdin?.end();
      } catch {
        this.kill();
      }
    });
  }

  private kill(): void {
    const child = this.child;
    if (!child || child.exitCode != null) return;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode == null) child.kill("SIGKILL");
    }, 10_000).unref?.();
  }
}
