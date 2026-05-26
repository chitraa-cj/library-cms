/**
 * Merge missing OtherTranslations from a backup row onto live Strapi content.
 */
import {
  blocksToText,
  filledLangs,
  mergeOtherTranslations,
  mergeTeekaEntry,
  rowLanguage,
  rowTranslationContent,
  textToBlocks,
} from "./hermex-grantha-sync";

export function normalizeOtRows(entry: any): any[] {
  const ot = entry?.OtherTranslations;
  if (!Array.isArray(ot)) return [];
  return ot
    .filter((r) => rowLanguage(r))
    .map((r) => ({
      LanguageOfTranslation: rowLanguage(r),
      TranslationText: Array.isArray(rowTranslationContent(r))
        ? rowTranslationContent(r)
        : textToBlocks(blocksToText(rowTranslationContent(r))),
      isAiTranslated: r.isAiTranslated ?? false,
    }))
    .filter((r) => blocksToText(r.TranslationText));
}

export function mergeMissingOtFromBackup(liveEntry: any, backupEntry: any): {
  merged: any;
  addedLangs: string[];
} {
  const live = { ...(liveEntry ?? {}) };
  const backupOt = normalizeOtRows(backupEntry);
  const liveOt: any[] = Array.isArray(live.OtherTranslations) ? live.OtherTranslations : [];
  const liveHave = filledLangs(live);
  const toAdd = backupOt.filter((r) => {
    const lang = r.LanguageOfTranslation;
    return lang && !liveHave.has(lang);
  });
  if (toAdd.length === 0) {
    return { merged: live, addedLangs: [] };
  }
  const mergedOt = mergeOtherTranslations(toAdd, liveOt);
  const merged = mergeTeekaEntry(live, { OtherTranslations: mergedOt });
  return { merged, addedLangs: toAdd.map((r) => r.LanguageOfTranslation) };
}

export function mantraSuffix(label: string | undefined): string | null {
  const m = String(label ?? "")
    .trim()
    .match(/([\d]+(?:\.[\d]+)*)\s*$/);
  return m ? m[1] : null;
}
