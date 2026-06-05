import {
  teekaAuthors,
  bhashyamAuthors,
  prasthanaBhashyamAuthors,
  defaultStructureLevelOneNames,
  defaultStructureLevelTwoNames,
  defaultStructureLevelThreeNames,
  defaultStructureLeafNames,
  type PortalVocabulary,
  type PortalVocabularyCustom,
  type PortalVocabularyKey,
} from "@shared/schema";
import { storage } from "./storage";

function mergeLists(defaults: readonly string[], custom: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...defaults, ...(custom ?? [])]) {
    const v = String(raw ?? "").trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

const DEFAULTS: PortalVocabulary = {
  teekaAuthors: [...teekaAuthors],
  bhashyamAuthors: mergeLists([...bhashyamAuthors, ...prasthanaBhashyamAuthors], undefined),
  structureLevelOneNames: [...defaultStructureLevelOneNames],
  structureLevelTwoNames: [...defaultStructureLevelTwoNames],
  structureLevelThreeNames: [...defaultStructureLevelThreeNames],
  structureLeafNames: [...defaultStructureLeafNames],
};

function buildMerged(custom: PortalVocabularyCustom): PortalVocabulary {
  return {
    teekaAuthors: mergeLists(DEFAULTS.teekaAuthors, custom.teekaAuthors),
    bhashyamAuthors: mergeLists(DEFAULTS.bhashyamAuthors, custom.bhashyamAuthors),
    structureLevelOneNames: mergeLists(DEFAULTS.structureLevelOneNames, custom.structureLevelOneNames),
    structureLevelTwoNames: mergeLists(DEFAULTS.structureLevelTwoNames, custom.structureLevelTwoNames),
    structureLevelThreeNames: mergeLists(DEFAULTS.structureLevelThreeNames, custom.structureLevelThreeNames),
    structureLeafNames: mergeLists(DEFAULTS.structureLeafNames, custom.structureLeafNames),
  };
}

let cached: PortalVocabulary | null = null;

export function invalidatePortalVocabularyCache(): void {
  cached = null;
}

export async function getPortalVocabulary(): Promise<PortalVocabulary> {
  if (cached) return cached;
  const custom = await storage.getPortalVocabularyCustom();
  cached = buildMerged(custom);
  return cached;
}

export async function getTeekaAuthorsAllowlist(): Promise<Set<string>> {
  const vocab = await getPortalVocabulary();
  return new Set(vocab.teekaAuthors);
}

/** Map draft author to the canonical allowlist spelling (case-insensitive). */
export function resolveAllowedTeekaAuthor(
  author: string | undefined | null,
  allow: Set<string>,
): string | undefined {
  const trimmed = String(author ?? "").trim();
  if (!trimmed) return undefined;
  if (allow.has(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  for (const entry of allow) {
    if (entry.toLowerCase() === lower) return entry;
  }
  return undefined;
}

export async function isAllowedTeekaAuthor(name: string | undefined | null): Promise<boolean> {
  const allow = await getTeekaAuthorsAllowlist();
  return resolveAllowedTeekaAuthor(name, allow) !== undefined;
}

/**
 * Strapi's grantha `BhashyamAuthor` field is an enum that only accepts the
 * canonical grantha author spellings. The CMS vocabulary dropdown also offers
 * the prasthana-thraya variants ("Sri Shankaracharya", "Sri Upanishad
 * Brahmendra") and admin-added custom values — none of which Strapi's grantha
 * enum accepts, so publishing a grantha with one of those 400s.
 */
const granthaBhashyamAuthorAllow = new Set<string>(bhashyamAuthors);

/** Known prasthana-spelling → grantha-enum-spelling equivalents (lower-cased keys). */
const bhashyamAuthorAliases: Record<string, string> = {
  "sri shankaracharya": "Sri Shankarayacharya",
  "sri upanishad brahmendra": "Upanishad Brahmendra",
};

/**
 * Map a draft `BhashyamAuthor` to a value Strapi's grantha enum will accept.
 * Returns `undefined` when the value is empty or unrecognized — callers should
 * omit the field entirely in that case so Strapi validation passes.
 */
export function resolveAllowedBhashyamAuthor(
  author: string | undefined | null,
): string | undefined {
  const trimmed = String(author ?? "").trim();
  if (!trimmed) return undefined;
  if (granthaBhashyamAuthorAllow.has(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  for (const entry of granthaBhashyamAuthorAllow) {
    if (entry.toLowerCase() === lower) return entry;
  }
  return bhashyamAuthorAliases[lower];
}

export async function addPortalVocabularyEntry(
  key: PortalVocabularyKey,
  value: string,
  userId: string,
): Promise<PortalVocabulary> {
  const trimmed = value.trim();
  if (!trimmed) {
    throw Object.assign(new Error("Name cannot be empty"), { status: 400 });
  }
  const custom = await storage.addPortalVocabularyEntry(key, trimmed, userId);
  invalidatePortalVocabularyCache();
  return buildMerged(custom);
}

export async function removePortalVocabularyEntry(
  key: PortalVocabularyKey,
  value: string,
  userId: string,
): Promise<PortalVocabulary> {
  const trimmed = value.trim();
  if (!trimmed) {
    throw Object.assign(new Error("Name cannot be empty"), { status: 400 });
  }
  const custom = await storage.removePortalVocabularyEntry(key, trimmed, userId);
  invalidatePortalVocabularyCache();
  return buildMerged(custom);
}

export function getPortalVocabularyDefaults(): PortalVocabulary {
  return { ...DEFAULTS };
}
