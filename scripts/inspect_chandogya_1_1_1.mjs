import { config } from "dotenv";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
config({ path: path.join(root, ".env") });

const STRAPI_URL = process.env.STRAPI_URL || "http://13.53.121.15:1337";
const TOKEN = process.env.STRAPI_API_TOKEN;
const MANTRA_ID = "q4ta2627qp3nwdcv4ibv9pud";

const OTHER_LANGS = [
  "Hindi", "Kannada", "Telugu", "Tamil", "Malayalam", "Gujarati", "Bengali", "Marathi", "Odia", "Punjabi",
  "Assamese", "Konkani", "Sinhala", "German", "French", "Spanish", "Portuguese", "Italian", "Dutch", "Russian",
  "Ukrainian", "Greek", "Polish", "Czech", "Romanian", "Hungarian", "Turkish", "Persian", "Arabic", "Hebrew",
  "Japanese", "Korean", "Thai", "Vietnamese", "Indonesian", "Malay", "Burmese", "Tibetan", "Mongolian", "Amharic",
  "Swahili", "Mandarin", "Egyptian_Arabic",
];

function curlJSON(url) {
  const out = execFileSync(
    "curl",
    ["-sg", "--globoff", "--max-time", "120", "-H", `Authorization: Bearer ${TOKEN}`, url],
    { encoding: "utf8", maxBuffer: 80 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

function blocksToText(blocks) {
  if (!blocks) return "";
  if (typeof blocks === "string") return blocks.trim();
  if (!Array.isArray(blocks)) return "";
  return blocks.map((b) => (b.children || []).map((c) => c.text || "").join("")).join("\n").trim();
}

function report(label, entry) {
  const have = new Set();
  for (const r of entry?.OtherTranslations ?? []) {
    const lang = r?.LanguageOfTranslation?.trim();
    if (lang && blocksToText(r.TranslationText)) have.add(lang);
  }
  const missing = OTHER_LANGS.filter((l) => !have.has(l));
  console.log(`\n${label}:`);
  console.log(`  filled: ${have.size}, missing: ${missing.length}`);
  console.log(`  english len: ${blocksToText(entry?.EnglishTranslationText).length}`);
  console.log(`  sanskrit len: ${blocksToText(entry?.SanskritTextEntry).length}`);
  return { have, missing, entry };
}

const Q =
  "?populate[Teekas][populate][TeekaEntry][populate]=*" +
  "&populate[Teekas][populate][teeka][fields][0]=TeekaName" +
  "&populate[ShlokaManthraEntry][populate]=*" +
  "&populate[BhashyamEntry][populate]=*";

const m = curlJSON(`${STRAPI_URL}/api/manthras/${MANTRA_ID}${Q}`)?.data;
console.log("Mantra", m.ShlokaManthraNumber, m.documentId);
const shloka = report("ShlokaManthraEntry", m.ShlokaManthraEntry);
const bhashyam = report("BhashyamEntry", m.BhashyamEntry);
const teekas = [];
for (const t of m.Teekas ?? []) {
  teekas.push({
    name: t.teeka?.TeekaName,
    teekaDocId: t.teeka?.documentId,
    componentId: t.id,
    ...report(`Teeka ${t.teeka?.TeekaName}`, t.TeekaEntry),
  });
}

console.log("\nTeeka count:", teekas.length);
