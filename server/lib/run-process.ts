/**
 * Run a local executable and collect its output — the one way the OCR pipeline
 * talks to poppler and Tesseract.
 *
 * Properties every caller relies on:
 *   - arguments are an array and there is never a shell, so nothing derived from
 *     an upload (a filename, a page number) can become a command;
 *   - a hard timeout and an AbortSignal both kill the child (SIGTERM, then SIGKILL);
 *   - stdout is capped, so a misbehaving tool cannot exhaust the heap;
 *   - failures come back as a typed `ProcessError` whose `kind` says whether a
 *     retry could help.
 */
import { spawn } from "node:child_process";

export type ProcessErrorKind =
  /** The binary is not installed / not on PATH. Permanent until someone installs it. */
  | "missing"
  /** It ran past its ceiling and was killed. Possibly transient (load). */
  | "timeout"
  /** The caller cancelled. */
  | "cancelled"
  /** Killed by a signal we did not send (OOM killer, operator). Transient. */
  | "killed"
  /** Non-zero exit. Usually the input's fault (corrupt PDF, unreadable image). */
  | "exit"
  /** Produced more output than allowed. */
  | "overflow";

export class ProcessError extends Error {
  readonly kind: ProcessErrorKind;
  readonly exitCode: number | null;
  readonly stderr: string;
  constructor(kind: ProcessErrorKind, message: string, opts: { exitCode?: number | null; stderr?: string } = {}) {
    super(message);
    this.name = "ProcessError";
    this.kind = kind;
    this.exitCode = opts.exitCode ?? null;
    this.stderr = opts.stderr ?? "";
  }

  /** Whether running the same command again could plausibly succeed. */
  get transient(): boolean {
    return this.kind === "timeout" || this.kind === "killed";
  }
}

export interface RunProcessOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Run under `nice -n <level>` (0 = do not wrap). */
  nice?: number;
  env?: NodeJS.ProcessEnv;
  /** Bytes of stdout to accept before killing the child. */
  maxStdoutBytes?: number;
}

export interface ProcessResult {
  stdout: Buffer;
  stderr: string;
}

const DEFAULT_MAX_STDOUT = 64 * 1024 * 1024;

export function runProcess(bin: string, args: readonly string[], opts: RunProcessOptions): Promise<ProcessResult> {
  const niceLevel = opts.nice ?? 0;
  const [command, argv] =
    niceLevel > 0 && process.platform !== "win32"
      ? ["nice", ["-n", String(niceLevel), bin, ...args]]
      : [bin, [...args]];
  const maxStdout = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;

  return new Promise<ProcessResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new ProcessError("cancelled", "Cancelled."));
      return;
    }

    const child = spawn(command, argv, { shell: false, stdio: ["ignore", "pipe", "pipe"], env: opts.env ?? process.env });
    const out: Buffer[] = [];
    let outBytes = 0;
    let stderr = "";
    let ourKill: ProcessErrorKind | null = null;
    let settled = false;

    const kill = (why: ProcessErrorKind) => {
      if (ourKill) return;
      ourKill = why;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
    };
    const timer = setTimeout(() => kill("timeout"), opts.timeoutMs);
    const onAbort = () => kill("cancelled");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (err: ProcessError | null, result?: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(result!);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.byteLength;
      if (outBytes > maxStdout) {
        kill("overflow");
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // Keep the tail only; tools like Tesseract are chatty and it is diagnostic text.
      stderr = (stderr + chunk.toString("utf8")).slice(-4_000);
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      const missing = err.code === "ENOENT";
      finish(
        new ProcessError(missing ? "missing" : "exit", missing ? `${bin} is not installed or not on PATH.` : `${bin}: ${err.message}`),
      );
    });

    child.on("close", (code, signal) => {
      const name = bin.split("/").pop() ?? bin;
      if (ourKill === "timeout") {
        return finish(new ProcessError("timeout", `${name} did not finish within ${Math.round(opts.timeoutMs / 1000)}s.`, { stderr }));
      }
      if (ourKill === "cancelled") return finish(new ProcessError("cancelled", "Cancelled.", { stderr }));
      if (ourKill === "overflow") {
        return finish(new ProcessError("overflow", `${name} produced more than ${Math.round(maxStdout / 1024 / 1024)}MB of output.`, { stderr }));
      }
      if (signal) {
        return finish(new ProcessError("killed", `${name} was killed by ${signal}.`, { stderr }));
      }
      // `nice` exits 127 when the wrapped binary is missing.
      if (code === 127 && niceLevel > 0) {
        return finish(new ProcessError("missing", `${bin} is not installed or not on PATH.`, { exitCode: code, stderr }));
      }
      if (code !== 0) {
        const detail = stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300);
        return finish(new ProcessError("exit", `${name} exited ${code}${detail ? `: ${detail}` : ""}`, { exitCode: code, stderr }));
      }
      finish(null, { stdout: Buffer.concat(out), stderr });
    });
  });
}
