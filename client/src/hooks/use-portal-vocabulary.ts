import { useQuery } from "@tanstack/react-query";
import {
  teekaAuthors,
  bhashyamAuthors,
  prasthanaBhashyamAuthors,
  defaultStructureLevelOneNames,
  defaultStructureLevelTwoNames,
  defaultStructureLevelThreeNames,
  defaultStructureLeafNames,
  type PortalVocabulary,
} from "@shared/schema";

function defaultBhashyamAuthorList(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...bhashyamAuthors, ...prasthanaBhashyamAuthors]) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export const PORTAL_VOCABULARY_QUERY_KEY = ["/api/cms/vocabulary"] as const;

const FALLBACK: PortalVocabulary = {
  teekaAuthors: [...teekaAuthors],
  bhashyamAuthors: defaultBhashyamAuthorList(),
  structureLevelOneNames: [...defaultStructureLevelOneNames],
  structureLevelTwoNames: [...defaultStructureLevelTwoNames],
  structureLevelThreeNames: [...defaultStructureLevelThreeNames],
  structureLeafNames: [...defaultStructureLeafNames],
};

export function usePortalVocabulary() {
  const query = useQuery<PortalVocabulary>({
    queryKey: [...PORTAL_VOCABULARY_QUERY_KEY],
    staleTime: 60_000,
  });

  return {
    vocabulary: query.data ?? FALLBACK,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
