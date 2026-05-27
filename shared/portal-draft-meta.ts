/**
 * Fields stored on portal `content_drafts.data` for editor/publish orchestration.
 * Must never be sent to Strapi document APIs (Strapi rejects unknown keys).
 */
export const PORTAL_DRAFT_DATA_KEYS = [
  "hierarchy",
  "structureConfig",
  "teekas",
  "otherTranslations",
  "granthaNameTranslations",
  "deletedStrapiSectionDocIds",
  "deletedStrapiManthraDocIds",
  "deletedStrapiTeekaDocIds",
  "publishScope",
] as const;

export type PortalDraftDataKey = (typeof PORTAL_DRAFT_DATA_KEYS)[number];

const PORTAL_DRAFT_DATA_KEY_SET = new Set<string>(PORTAL_DRAFT_DATA_KEYS);

/** Remove portal-only top-level keys before building a Strapi grantha payload. */
export function stripPortalMetaFromGranthaPayload<T extends Record<string, unknown>>(
  data: T,
): Omit<T, PortalDraftDataKey> {
  const out = { ...data };
  for (const key of PORTAL_DRAFT_DATA_KEYS) {
    delete (out as Record<string, unknown>)[key];
  }
  return out as Omit<T, PortalDraftDataKey>;
}

export function isPortalDraftDataKey(key: string): boolean {
  return PORTAL_DRAFT_DATA_KEY_SET.has(key);
}

/** Last-line guard before Strapi document write — removes any portal keys that leaked through. */
export function scrubLeakedPortalKeysFromStrapiPayload(
  payload: Record<string, unknown>,
  context: string,
): string[] {
  const removed: string[] = [];
  for (const key of PORTAL_DRAFT_DATA_KEYS) {
    if (key in payload) {
      delete payload[key];
      removed.push(key);
    }
  }
  if (removed.length > 0) {
    console.error(
      `[publish] Stripped portal-only keys from Strapi payload (${context}): ${removed.join(", ")}`,
    );
  }
  return removed;
}
