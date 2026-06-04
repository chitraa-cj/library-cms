/**
 * Guards against Strapi manthra rows with blank ShlokaManthraNumber ("No number" in Mantras tab).
 *
 * Root cause (2024–2026): slot sync and insert-between POSTed to Strapi before portal
 * verse titles were assigned, using ShlokaManthraNumber: "".
 */

export function isBlankMantraLabel(label: string | null | undefined): boolean {
  return !(label ?? "").trim();
}

/** Returns error message if label is invalid for CMS create/update. */
export function validateMantraLabelForCmsCreate(label: string | null | undefined): string | null {
  if (isBlankMantraLabel(label)) {
    return "ShlokaManthraNumber is required — cannot create a CMS row without a verse label.";
  }
  return null;
}

/** Placeholder label for Mantras-tab insert-between (user renames in the editor). */
export function provisionalMantraInsertLabel(afterLabel: string): string {
  const t = (afterLabel ?? "").trim();
  return t ? `${t} (new)` : "Mantra (new)";
}
