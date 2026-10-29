/**
 * Provider audit — the two migrated workflows cannot reach the Gemini or Claude APIs.
 * ==================================================================================
 * Static, so it holds regardless of configuration: starting from the OCR and the
 * OCR → Grantha route modules, it follows every relative / @shared import, and fails if
 * any file reachable from them
 *   - imports a provider SDK (@anthropic-ai/*, @google/genai, @google/generative-ai, openai),
 *   - names a provider API endpoint or a provider API-key variable,
 *   - makes a raw HTTP call (fetch / http.request / axios) — a hidden fallback would need one.
 *   - names a local OCR engine or local model runtime in CODE (comments excluded):
 *     Tesseract, poppler's pdftotext/pdftoppm, EasyOCR, PaddleOCR, Ollama, llama.cpp,
 *   - spawns a process anywhere except the Hermex prompt session.
 * It also checks the Claude SDK is gone from package.json, that OCR's engine IS the Hermex
 * session (no engine switch, no fallback), and that translation's own Gemini wiring (the
 * thing that must keep working) is still where it was.
 *
 * Run: npm run test:provider-audit
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let PASS = 0;
const FAILURES = [];
function check(name, cond, detail = "") {
  if (cond) {
    PASS++;
    console.log(`  ok   ${name}`);
  } else {
    FAILURES.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const FORBIDDEN_IMPORT = /^(@anthropic-ai\/|@google\/genai|@google\/generative-ai|openai$|axios$|node-fetch$|undici$)/;
const FORBIDDEN_TEXT = [
  /generativelanguage\.googleapis\.com/,
  /api\.anthropic\.com/,
  /\bGEMINI_API_KEY\b/,
  /\bGOOGLE_API_KEY\b/,
  /\bANTHROPIC_(API_KEY|BASE_URL|WORKSPACE_ID)\b/,
  /\bfetch\s*\(/,
  /\bhttps?\.request\s*\(/,
];

const LOCAL_ENGINE = /tesseract|pdftotext|pdftoppm|easyocr|paddleocr|ollama|llama\.cpp|onnxruntime|@xenova|transformers\.js/i;
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

function resolveImport(fromFile, spec) {
  let base;
  if (spec.startsWith("@shared/")) base = path.join(ROOT, "shared", spec.slice(8));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function walk(entries) {
  const seen = new Set();
  const bare = new Map();
  const stack = entries.map((e) => path.join(ROOT, e));
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const resolved = resolveImport(file, spec);
      if (resolved) stack.push(resolved);
      else if (!spec.startsWith(".") && !spec.startsWith("@shared/")) bare.set(spec, file);
    }
  }
  return { files: [...seen], bare };
}

const rel = (f) => path.relative(ROOT, f);

for (const [label, entry] of [
  ["OCR workflow (server/ocr/routes.ts)", "server/ocr/routes.ts"],
  ["OCR → Grantha workflow (server/structure/routes.ts)", "server/structure/routes.ts"],
]) {
  console.log(`\n${label}`);
  const { files, bare } = walk([entry]);
  check(`the import graph was walked (${files.length} files)`, files.length > 5);
  const sdk = [...bare.keys()].filter((s) => FORBIDDEN_IMPORT.test(s));
  check("no provider SDK or HTTP client is imported anywhere in it", sdk.length === 0, sdk.join(", "));
  const hits = [];
  for (const file of files) {
    // db.ts / env.ts and friends are infrastructure shared by the whole app; the
    // workflow's own code is what must be provider-free.
    const src = fs.readFileSync(file, "utf8");
    for (const re of FORBIDDEN_TEXT) if (re.test(src)) hits.push(`${rel(file)} ~ ${re}`);
  }
  check("no provider endpoint, provider key or raw HTTP call in any reachable file", hits.length === 0, hits.join("; "));
  const engines = files.filter((f) => LOCAL_ENGINE.test(stripComments(fs.readFileSync(f, "utf8")))).map(rel);
  check("no local OCR engine or local model is named in any reachable code", engines.length === 0, engines.join(", "));
  const localEngineImports = [...bare.keys()].filter((s) => LOCAL_ENGINE.test(s) || /^(tesseract|node-tesseract|pdf-poppler|pdfjs-dist|canvas|sharp)/.test(s));
  check("no OCR/image-processing package is imported", localEngineImports.length === 0, localEngineImports.join(", "));
  // hermex-translate.ts is reachable only for HermexError/scrubHermexText; it spawns
  // translate_cli for translation, which these workflows must never call.
  const spawners = files.filter((f) => /child_process/.test(fs.readFileSync(f, "utf8"))).map(rel);
  check("the only processes reachable are Hermex's (prompt session, translation's adapter)",
    spawners.every((f) => f === "server/hermex/prompt-session.ts" || f === "server/hermex-translate.ts"), spawners.join(", "));
  const own = files.filter((f) => /server\/(ocr|structure)\//.test(rel(f)));
  const callsTranslation = own.filter((f) => /runHermexTranslate|translate_cli\.py/.test(stripComments(fs.readFileSync(f, "utf8")))).map(rel);
  check("it never runs translation's Hermex call (its own session only)", callsTranslation.length === 0, callsTranslation.join(", "));
  // Generated content reaches the CMS only through the grantha editor's own Save /
  // Publish (with its locks, backups and approval). The workflow itself cannot write it.
  const cmsWriters = files.map(rel).filter((f) => /^server\/(strapi|publish\/|grantha-)/.test(f));
  check("no CMS write path (Strapi client, publish queue) is reachable", cmsWriters.length === 0, cmsWriters.join(", "));
}

console.log("\nOCR's engine is Hermex, with no switch and no fallback");
{
  const jobs = fs.readFileSync(path.join(ROOT, "server/ocr/jobs.ts"), "utf8");
  const engine = fs.readFileSync(path.join(ROOT, "server/ocr/hermex-engine.ts"), "utf8");
  const cfg = fs.readFileSync(path.join(ROOT, "server/ocr/config.ts"), "utf8");
  check("the job runner transcribes only through createHermexOcrEngine", /createHermexOcrEngine\(/.test(jobs) && !/import\s*\{[^}]*\btranscribeRange\b/.test(jobs));
  check("the engine opens only a HermexPromptSession", /HermexPromptSession\.open\(/.test(engine));
  check("there is no engine selector to switch away from Hermex", !/OCR_ENGINE/.test(cfg + jobs + engine));
  for (const gone of ["server/ocr/local-engine.ts", "server/ocr/engine.ts", "server/lib/run-process.ts"]) {
    check(`${gone} (local OCR) is gone`, !fs.existsSync(path.join(ROOT, gone)));
  }
  const docs = fs.readFileSync(path.join(ROOT, "docs/OCR.md"), "utf8");
  check("the OCR docs do not ask for Tesseract or poppler packages", !/apt install[^\n]*(tesseract|poppler)/i.test(docs));
}

console.log("\nthe Python side of the structure session");
{
  const src = fs.readFileSync(path.join(ROOT, "python/hermex_translate/prompt_session.py"), "utf8");
  check("prompt_session.py makes no HTTP request and imports no provider SDK",
    !/requests\.|urllib|http\.client|google\.generativeai|anthropic|openai/.test(src));
  check("it drives the browser only through translate_cli's Hermex helpers", /import translate_cli as cli/.test(src));
}

console.log("\ndependencies");
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  check("@anthropic-ai/sdk is no longer a dependency", !("@anthropic-ai/sdk" in deps));
  check("no Gemini SDK was ever added", !Object.keys(deps).some((d) => /@google\/(genai|generative-ai)/.test(d)));
  const build = fs.readFileSync(path.join(ROOT, "script/build.ts"), "utf8");
  check("the build no longer lists the Claude SDK", !/@anthropic-ai/.test(build));
  const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  check(".env.example no longer asks for GEMINI_API_KEY or ANTHROPIC_API_KEY", !/^(GEMINI_API_KEY|ANTHROPIC_API_KEY)=/m.test(example));
}

console.log("\ntranslation's Gemini wiring is untouched");
{
  const cfg = fs.readFileSync(path.join(ROOT, "server/hermex/config.ts"), "utf8");
  check("translation still reads HERMEX_CHROME_PROFILE", /trimmed\("HERMEX_CHROME_PROFILE"\)/.test(cfg));
  const adapter = fs.readFileSync(path.join(ROOT, "server/hermex-translate.ts"), "utf8");
  check("translation still spawns translate_cli through runHermexTranslate", /export function runHermexTranslate/.test(adapter) && /hermexTranslateScriptPath\(\)/.test(adapter));
  const runner = fs.readFileSync(path.join(ROOT, "server/translation/hermex-runner.ts"), "utf8");
  check("the translation worker does not import the structure session", !/prompt-session|task-profiles|structure/.test(runner));
  const { files } = walk(["server/translation/worker-main.ts"]);
  const crossing = files.filter((f) => /server\/(ocr|structure)\/|prompt-session|task-profiles/.test(rel(f))).map(rel);
  check("nothing reachable from the translation worker touches OCR/structure code", crossing.length === 0, crossing.join(", "));
}

console.log(`\n${PASS} passed, ${FAILURES.length} failed`);
if (FAILURES.length > 0) {
  for (const f of FAILURES) console.error(` - ${f}`);
  process.exit(1);
}
