import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type HermexTranslateJob = {
  sourceText: string;
  sourceLanguage: "English" | "Sanskrit";
  targetLanguages: string[];
  context?: string;
};

export type HermexTranslateRequest = HermexTranslateJob & {
  jobs?: HermexTranslateJob[];
  chunkSize?: number;
  headless?: boolean;
  queryTimeoutSec?: number;
  continueOnError?: boolean;
  chunkDelaySec?: number;
  maxRetries?: number;
};

export type HermexTranslationRow = {
  language: string;
  text: string;
};

export type HermexBatchResult = {
  context?: string;
  translations: HermexTranslationRow[];
};

export type HermexTranslateResponse = {
  ok: boolean;
  translations?: HermexTranslationRow[];
  results?: HermexBatchResult[];
  error?: string;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function hermexEnabled(): boolean {
  const flag = process.env.HERMEX_ENABLED;
  if (flag === "0" || flag === "false") return false;
  return true;
}

export function hermexPythonBin(): string {
  if (process.env.HERMEX_PYTHON) return process.env.HERMEX_PYTHON;
  const venvPy = path.join(repoRoot, ".venv-hermex", "bin", "python3");
  if (fs.existsSync(venvPy)) return venvPy;
  return "python3";
}

export function hermexTranslateScriptPath(): string {
  return (
    process.env.HERMEX_TRANSLATE_SCRIPT ||
    path.join(repoRoot, "python", "hermex_translate", "translate_cli.py")
  );
}

export function hermexTranslateTimeoutMs(): number {
  const n = parseInt(process.env.HERMEX_TRANSLATE_TIMEOUT_MS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : 45 * 60 * 1000;
}

/**
 * Run Hermex Gemini translation via Python subprocess (stdin/stdout JSON).
 */
export function runHermexTranslate(req: HermexTranslateRequest): Promise<HermexTranslateResponse> {
  return new Promise((resolve, reject) => {
    const py = hermexPythonBin();
    const script = hermexTranslateScriptPath();
    const timeoutMs = hermexTranslateTimeoutMs();

    const child = spawn(py, [script], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Hermex translation timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(
          new Error(
            `Hermex process exited ${code ?? "?"} with no output.${stderr ? ` stderr: ${stderr.slice(0, 500)}` : ""}`,
          ),
        );
        return;
      }
      try {
        const parsed = JSON.parse(trimmed) as HermexTranslateResponse;
        if (!parsed.ok) {
          reject(new Error(parsed.error || "Hermex translation failed"));
          return;
        }
        resolve(parsed);
      } catch {
        reject(
          new Error(
            `Invalid JSON from Hermex (exit ${code}): ${trimmed.slice(0, 300)}${stderr ? ` | ${stderr.slice(0, 200)}` : ""}`,
          ),
        );
      }
    });

    const payload =
      Array.isArray(req.jobs) && req.jobs.length > 0
        ? {
            jobs: req.jobs,
            chunkSize: req.chunkSize,
            headless: req.headless,
            queryTimeoutSec: req.queryTimeoutSec,
            continueOnError: req.continueOnError ?? true,
            chunkDelaySec: req.chunkDelaySec,
            maxRetries: req.maxRetries,
          }
        : {
            ...req,
            continueOnError: req.continueOnError ?? true,
            chunkDelaySec: req.chunkDelaySec,
            maxRetries: req.maxRetries,
          };
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}
