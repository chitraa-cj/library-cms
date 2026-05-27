import { otherTranslationLanguages } from "../../shared/schema";

/** Sacred-Script-Hub `language_code` → Strapi `LanguageOfTranslation`. */
const SCRAPED_TO_STRAPI: Record<string, string> = {
  hi: "Hindi",
  hindi: "Hindi",
  kannada: "Kannada",
  tamil: "Tamil",
  telugu: "Telugu",
  ml: "Malayalam",
  malayalam: "Malayalam",
  gu: "Gujarati",
  gujarati: "Gujarati",
  bn: "Bengali",
  bengali: "Bengali",
  mr: "Marathi",
  marathi: "Marathi",
  or: "Odia",
  odia: "Odia",
  pa: "Punjabi",
  punjabi: "Punjabi",
  as: "Assamese",
  assamese: "Assamese",
  kok: "Konkani",
  konkani: "Konkani",
  si: "Sinhala",
  sinhala: "Sinhala",
  german: "German",
  french: "French",
  spanish: "Spanish",
  portuguese: "Portuguese",
  pt: "Portuguese",
  italian: "Italian",
  it: "Italian",
  dutch: "Dutch",
  nl: "Dutch",
  russian: "Russian",
  ru: "Russian",
  ukrainian: "Ukrainian",
  uk: "Ukrainian",
  greek: "Greek",
  el: "Greek",
  polish: "Polish",
  pl: "Polish",
  czech: "Czech",
  romanian: "Romanian",
  hungarian: "Hungarian",
  turkish: "Turkish",
  tr: "Turkish",
  persian: "Persian",
  fa: "Persian",
  arabic: "Arabic",
  hebrew: "Hebrew",
  he: "Hebrew",
  japanese: "Japanese",
  ja: "Japanese",
  korean: "Korean",
  ko: "Korean",
  thai: "Thai",
  th: "Thai",
  vietnamese: "Vietnamese",
  vi: "Vietnamese",
  indonesian: "Indonesian",
  id: "Indonesian",
  malay: "Malay",
  ms: "Malay",
  burmese: "Burmese",
  my: "Burmese",
  tibetan: "Tibetan",
  bo: "Tibetan",
  mongolian: "Mongolian",
  mn: "Mongolian",
  amharic: "Amharic",
  am: "Amharic",
  swahili: "Swahili",
  sw: "Swahili",
  mandarin: "Mandarin",
  egyptian_arabic: "Egyptian_Arabic",
  arz: "Egyptian_Arabic",
  pcm: "English",
  bho: "Hindi",
  ku: "Persian",
  mni: "Bengali",
  ne: "Hindi",
  ur: "Persian",
  sd: "Persian",
  ks: "Hindi",
  az: "Turkish",
  ha: "Arabic",
};

const SKIP_SCRAPED_LANGS = new Set([
  "devanagari",
  "sanskrit",
  "sa",
  "english",
  "en",
]);

const STRAPI_OT_SET = new Set<string>(otherTranslationLanguages);

export function mapScrapedLanguageCode(code: string): string | null {
  const key = (code || "").trim().toLowerCase();
  if (!key || SKIP_SCRAPED_LANGS.has(key)) return null;
  const mapped = SCRAPED_TO_STRAPI[key];
  if (!mapped || !STRAPI_OT_SET.has(mapped)) return null;
  return mapped;
}

export function normalizeCompareText(t: string): string {
  return (t || "")
    .normalize("NFC")
    .replace(/[\u0966-\u096F0-9]+/g, "")
    .replace(/॥/g, "")
    .replace(/ऽ/g, "")
    .replace(/ॐ/g, "ओं")
    // Scraped sandhi (येऽविद्याम) vs Strapi split (ये अविद्याम)
    .replace(/येऽ/g, "येअ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactCompare(t: string): string {
  return normalizeCompareText(t).replace(/\s/g, "");
}

/** True when scraped and live Sanskrit (or commentary SK) clearly refer to the same text. */
export function sanskritTextsMatch(scraped: string, live: string): boolean {
  const a = normalizeCompareText(scraped);
  const b = normalizeCompareText(live);
  if (!a || !b) return false;
  if (a === b) return true;
  const ca = compactCompare(scraped);
  const cb = compactCompare(live);
  if (ca && cb && ca === cb) return true;
  const probe = Math.min(48, a.length, b.length);
  if (probe >= 24 && a.slice(0, probe) === b.slice(0, probe)) return true;
  if (ca.length >= 24 && cb.length >= 24 && ca.slice(0, 48) === cb.slice(0, 48)) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 20 && longer.includes(shorter.slice(0, Math.min(shorter.length, 80)))) return true;
  let same = 0;
  const n = Math.min(shorter.length, longer.length);
  for (let i = 0; i < n; i++) {
    if (shorter[i] === longer[i]) same++;
  }
  return n > 0 && same / longer.length >= 0.78;
}
