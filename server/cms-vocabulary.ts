import {
  teekaAuthors,
  bhashyamAuthors,
  prasthanaBhashyamAuthors,
  defaultStructureLevelOneNames,
  defaultStructureLevelTwoNames,
  defaultStructureLevelThreeNames,
  defaultStructureLeafNames,
  normalizePortalVocabularyName,
  portalVocabularyNameKey,
  type PortalVocabulary,
  type PortalVocabularyCustom,
  type PortalVocabularyKey,
} from "@shared/schema";
import { storage } from "./storage";

function mergeLists(defaults: readonly string[], custom: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...defaults, ...(custom ?? [])]) {
    const v = normalizePortalVocabularyName(raw);
    if (!v) continue;
    const key = portalVocabularyNameKey(v);
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

/**
 * The merged Shared-list vocabulary (built-in defaults + admin-added custom names).
 *
 * Deliberately NOT cached in process memory. It used to be, with the cache dropped
 * whenever an admin added or removed a name — but that invalidation only ever reached
 * the process that served the admin request. Grantha publishing now runs in its own
 * pm2 process (`cms-publish-worker`), which built its copy on its first publish and
 * never saw another add: the Shared-lists page (web process, fresh) showed a name that
 * publishing (worker process, stale) rejected as "not in the shared vocabulary", until
 * the worker happened to restart. The vocabulary is one small JSONB row read a handful
 * of times per publish and once per editor page load, so reading it from Postgres on
 * every call costs nothing measurable and makes every process see the same list the
 * moment an add or remove commits.
 */
export async function getPortalVocabulary(): Promise<PortalVocabulary> {
  const custom = await storage.getPortalVocabularyCustom();
  return buildMerged(custom);
}

export async function getTeekaAuthorsAllowlist(): Promise<Set<string>> {
  const vocab = await getPortalVocabulary();
  return new Set(vocab.teekaAuthors);
}

/**
 * Match `author` against an allowlist by vocabulary identity (trim, NFC, case) and
 * return the allowlist's own spelling, so what is published is always the shared
 * list's canonical form.
 */
function resolveAllowedName(author: unknown, allow: Set<string>): string | undefined {
  const normalized = normalizePortalVocabularyName(author);
  if (!normalized) return undefined;
  if (allow.has(normalized)) return normalized;
  const key = portalVocabularyNameKey(normalized);
  for (const entry of allow) {
    if (portalVocabularyNameKey(entry) === key) return entry;
  }
  return undefined;
}

/** Map draft author to the canonical allowlist spelling (case-insensitive). */
export function resolveAllowedTeekaAuthor(
  author: string | undefined | null,
  allow: Set<string>,
): string | undefined {
  return resolveAllowedName(author, allow);
}

export async function isAllowedTeekaAuthor(name: string | undefined | null): Promise<boolean> {
  const allow = await getTeekaAuthorsAllowlist();
  return resolveAllowedTeekaAuthor(name, allow) !== undefined;
}

/** Known prasthana-spelling → grantha-spelling equivalents (vocabulary-key keyed). */
const bhashyamAuthorAliases: Record<string, string> = {
  "sri shankaracharya": "Sri Shankarayacharya",
  "sri upanishad brahmendra": "Upanishad Brahmendra",
};

/**
 * Allowed grantha `BhashyamAuthor` values = the merged Shared-list vocabulary
 * (built-in defaults + admin-added custom names), i.e. the same source the
 * dropdown reads. A name added via Shared lists is therefore publishable with no
 * code change. Strapi's `BhashyamAuthor` field is now a plain string (no longer
 * an enum), so this vocabulary is the sole guardrail against typos.
 */
export async function getBhashyamAuthorsAllowlist(): Promise<Set<string>> {
  const vocab = await getPortalVocabulary();
  return new Set(vocab.bhashyamAuthors);
}

/**
 * Map a draft `BhashyamAuthor` to an allowed value. Known prasthana spellings are
 * normalized to their canonical grantha spelling first (so a grantha shows one
 * consistent author). Returns `undefined` when the value is empty or unrecognized
 * — callers should omit the field entirely in that case. `allow` is the merged
 * vocabulary set from `getBhashyamAuthorsAllowlist()`.
 */
export function resolveAllowedBhashyamAuthor(
  author: string | undefined | null,
  allow: Set<string>,
): string | undefined {
  const normalized = normalizePortalVocabularyName(author);
  if (!normalized) return undefined;
  const alias = bhashyamAuthorAliases[portalVocabularyNameKey(normalized)];
  if (alias) return alias;
  return resolveAllowedName(normalized, allow);
}

export function bhashyamAuthorNotInVocabularyMessage(author: string): string {
  return (
    `Cannot publish: Bhashyam author "${author}" is not in the shared vocabulary. ` +
    `Add it under Shared lists → Bhashyam authors, then republish.`
  );
}

/**
 * The ONE rule for a grantha's `BhashyamAuthor` at publish time, shared by the enqueue
 * route (web process, so the editor gets an immediate 400 instead of a failed job) and
 * the publish walk (worker process, the authoritative check):
 *
 *   - empty / missing      → `undefined`: omit the field, granthas without a bhashyam publish
 *   - in the vocabulary    → the vocabulary's canonical spelling
 *   - anything else        → throws a 400 whose message names where to add the name
 *
 * A non-empty author that cannot be resolved must fail loudly rather than be dropped:
 * a dropped field makes Strapi keep the previous author, which the editor sees as the
 * author "reverting" to the old value.
 */
export function resolveBhashyamAuthorForPublish(
  author: unknown,
  allow: Set<string>,
): string | undefined {
  const raw = normalizePortalVocabularyName(author);
  const resolved = resolveAllowedBhashyamAuthor(raw, allow);
  if (resolved) return resolved;
  if (raw) {
    throw Object.assign(new Error(bhashyamAuthorNotInVocabularyMessage(raw)), {
      status: 400,
      code: "bhashyam_author_not_in_vocabulary",
    });
  }
  return undefined;
}

export async function addPortalVocabularyEntry(
  key: PortalVocabularyKey,
  value: string,
  userId: string,
): Promise<PortalVocabulary> {
  const trimmed = normalizePortalVocabularyName(value);
  if (!trimmed) {
    throw Object.assign(new Error("Name cannot be empty"), { status: 400 });
  }
  const custom = await storage.addPortalVocabularyEntry(key, trimmed, userId);
  return buildMerged(custom);
}

export async function removePortalVocabularyEntry(
  key: PortalVocabularyKey,
  value: string,
  userId: string,
): Promise<PortalVocabulary> {
  const trimmed = normalizePortalVocabularyName(value);
  if (!trimmed) {
    throw Object.assign(new Error("Name cannot be empty"), { status: 400 });
  }
  const custom = await storage.removePortalVocabularyEntry(key, trimmed, userId);
  return buildMerged(custom);
}

export function getPortalVocabularyDefaults(): PortalVocabulary {
  return { ...DEFAULTS };
}
