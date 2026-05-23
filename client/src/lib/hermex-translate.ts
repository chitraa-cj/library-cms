import { apiRequest } from "@/lib/queryClient";
import type { StrapiTranslation } from "@shared/schema";

export type HermexTranslateMode = "missing" | "all";

export type HermexTranslateParams = {
  sourceText: string;
  sourceLanguage: "English" | "Sanskrit";
  targetLanguages: string[];
  context?: string;
  chunkSize?: number;
};

export async function fetchHermexStatus(): Promise<{
  enabled: boolean;
  otherTranslationLanguageCount: number;
  otherTranslationLanguages: string[];
}> {
  const res = await apiRequest("GET", "/api/hermex/status");
  return res.json();
}

export async function hermexTranslate(params: HermexTranslateParams): Promise<StrapiTranslation[]> {
  const res = await apiRequest("POST", "/api/hermex/translate", params);
  const body = await res.json();
  return (body.translations ?? []) as StrapiTranslation[];
}
