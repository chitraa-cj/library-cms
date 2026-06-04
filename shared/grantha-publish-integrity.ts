/**
 * Publish-time integrity checks for all granthas — blocks cross-text overwrites,
 * verse-number renames on identity sync, and duplicate suffix rows in a section.
 */

import { STRAPI_SORT_GAP } from "./mantra-sort-key";

export function mantraNumberSuffix(title: string | undefined): string | null {
  const t = (title ?? "").trim();
  if (!t) return null;
  const m = t.match(/(\d+(?:\.\d+)+)\s*$/);
  return m ? m[1] : null;
}

function mantraTitleLeafPrefix(title: string | undefined): string | null {
  const t = (title ?? "").trim();
  if (!t) return null;
  const m = t.match(/^(.+?)\s+[\d.]+$/);
  return m ? m[1].trim() : null;
}

export function titleUsesConfiguredLeaf(title: string | undefined, configuredLeaf: string): boolean {
  const leaf = (configuredLeaf ?? "").trim();
  if (!leaf) return true;
  const prefix = mantraTitleLeafPrefix(title);
  if (!prefix) return !(title ?? "").trim();
  return prefix.toLowerCase() === leaf.toLowerCase();
}

export function canonicalMantraTitle(configuredLeaf: string, numericSuffix: string): string {
  return `${(configuredLeaf || "Mantra").trim()} ${numericSuffix}`.trim();
}

/** True for placeholder labels like "Mantra 1" / "Shloka 2" — leaf + integer, no x.y verse suffix. */
export function isBareLeafCounterLabel(title: string | undefined, configuredLeaf: string): boolean {
  const t = (title ?? "").trim();
  if (!t || mantraNumberSuffix(t)) return false;
  const prefix = mantraTitleLeafPrefix(t);
  const leaf = (configuredLeaf || "Mantra").trim();
  return !!prefix && prefix.toLowerCase() === leaf.toLowerCase();
}

/** Infer leaf from title and test for bare counter — e.g. "Vaakhyaa 1", "Mantra 2". */
export function isBareLeafCounterTitle(title: string | undefined): boolean {
  const t = (title ?? "").trim();
  if (!t || mantraNumberSuffix(t)) return false;
  const leaf = mantraTitleLeafPrefix(t);
  if (!leaf) return false;
  return isBareLeafCounterLabel(t, leaf);
}

/** Flat grantha: derive Mantra 1.N from spaced Strapi sort key N × 100_000. */
export function flatMantraLabelFromSpacedSortKey(
  order: number,
  configuredLeaf: string,
  suffixPrefix = "1",
): string {
  if (order < STRAPI_SORT_GAP || order % STRAPI_SORT_GAP !== 0) return "";
  const n = Math.round(order / STRAPI_SORT_GAP);
  if (n < 1) return "";
  return canonicalMantraTitle(configuredLeaf, `${suffixPrefix}.${n}`);
}

/** Rewrite portal/Strapi label to use the grantha's configured leaf while keeping the verse suffix. */
export function portalMantraTitleForConfiguredLeaf(
  portalTitle: string | undefined,
  configuredLeaf: string,
  strapiTitle?: string,
): string {
  const leaf = (configuredLeaf || "Mantra").trim() || "Mantra";
  const suffix = mantraNumberSuffix(portalTitle) ?? mantraNumberSuffix(strapiTitle);
  if (suffix) return canonicalMantraTitle(leaf, suffix);
  const st = (strapiTitle ?? "").trim();
  if (st && titleUsesConfiguredLeaf(st, leaf) && mantraNumberSuffix(st)) return st;
  const pt = (portalTitle ?? "").trim();
  if (pt && titleUsesConfiguredLeaf(pt, leaf) && mantraNumberSuffix(pt)) return pt;
  if (isBareLeafCounterLabel(pt, leaf) || isBareLeafCounterLabel(st, leaf)) return "";
  // Never invent "Mantra 1" from a blank title — positional label must come from
  // mantraLabelForCmsSync / prepareHierarchyForSave with sibling index.
  return pt || st || "";
}

/** In-place: align all hierarchy mantra titles with configuredLeaf (Shloka ↔ Mantra relabel). */
export function normalizeHierarchyMantraLeafTitles(
  hierarchy: unknown[],
  configuredLeaf: string,
): void {
  const leaf = (configuredLeaf || "Mantra").trim() || "Mantra";
  const fix = (m: HierarchyMantraNode) => {
    const next = portalMantraTitleForConfiguredLeaf(m.title, leaf, m.title);
    if (next && next !== (m.title ?? "").trim()) {
      m.title = next;
    }
  };
  for (const a of hierarchy ?? []) {
    const adhyaya = a as { khandas?: unknown[] };
    for (const k of adhyaya.khandas ?? []) {
      const khanda = k as {
        manthras?: HierarchyMantraNode[];
        padas?: { manthras?: HierarchyMantraNode[] }[];
      };
      for (const m of khanda.manthras ?? []) fix(m);
      for (const p of khanda.padas ?? []) {
        for (const m of p.manthras ?? []) fix(m);
      }
    }
  }
}

export type PublishIntegritySeverity = "error" | "warning";

export type PublishIntegrityViolation = {
  code: string;
  severity: PublishIntegritySeverity;
  message: string;
  mantraLabel?: string;
  documentId?: string;
};

export type MantraPublishScanInput = {
  portalLabel: string;
  configuredLeaf: string;
  granthaName?: string;
  targetDocumentId?: string;
  existingStrapiLabel?: string;
  sanskritPlain?: string;
  englishPlain?: string;
  /** When true, allow changing only the leaf prefix (Shloka ↔ Mantra) but not the numeric suffix. */
  allowLeafPrefixOnlyRelabel?: boolean;
  /** When true, the editor has explicitly approved a verse renumber (e.g. an intentional
   *  deletion shifted every following verse down by one). Skips the suffix-stability check
   *  only; duplicate-suffix and cross-grantha checks still apply. */
  allowRenumber?: boolean;
  /** Portal hierarchy `strapiDocumentId` — when it matches `targetDocumentId`, suffix
   *  changes are intentional renumber on the same CMS row (not a cross-verse overwrite). */
  portalLinkedDocumentId?: string;
};

/** Plain text from Strapi blocks or string. */
export function blocksToPlainText(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") return v.trim();
  if (!Array.isArray(v)) return "";
  return (v as any[])
    .map((block) =>
      ((block?.children ?? []) as any[])
        .map((c) => (typeof c?.text === "string" ? c.text : ""))
        .join(""),
    )
    .join("\n")
    .trim();
}

export function plainTextFromManthraEntry(entry: unknown): { sk: string; en: string } {
  if (!entry || typeof entry !== "object") return { sk: "", en: "" };
  const e = entry as Record<string, unknown>;
  return {
    sk: blocksToPlainText(e.SanskritTextEntry),
    en: blocksToPlainText(e.EnglishTranslationText),
  };
}

/**
 * True when `newSuf` adds hierarchy depth without renumbering the logical path
 * (e.g. after inserting Khanda: `1.1` → `1.1.1`, or flat `1` → `1.1`).
 * Blocks arbitrary renumber such as `1.372` → `1.2.4`.
 */
export function isStructuralSuffixExtension(oldSuf: string, newSuf: string): boolean {
  if (!oldSuf || !newSuf) return false;
  if (oldSuf === newSuf) return true;
  return newSuf.startsWith(`${oldSuf}.`);
}

/** Verse suffix must not change when updating an existing CMS row (prevents 1.372 → 1.2.4). */
export function assertVerseSuffixStable(
  existingLabel: string,
  newLabel: string,
): PublishIntegrityViolation | null {
  const oldSuf = mantraNumberSuffix(existingLabel);
  const newSuf = mantraNumberSuffix(newLabel);
  if (!oldSuf || !newSuf || oldSuf === newSuf) return null;
  if (isStructuralSuffixExtension(oldSuf, newSuf)) return null;
  return {
    code: "suffix_changed",
    severity: "error",
    message: `Verse number cannot change from ${oldSuf} to ${newSuf} on an existing row (${existingLabel} → ${newLabel}). Use the correct portal title or restore from backup.`,
    mantraLabel: newLabel,
  };
}

export function assertConfiguredLeafOnLabel(
  label: string,
  configuredLeaf: string,
): PublishIntegrityViolation | null {
  const leaf = (configuredLeaf || "Mantra").trim() || "Mantra";
  if (!label.trim()) return null;
  if (titleUsesConfiguredLeaf(label, leaf)) return null;
  return {
    code: "wrong_leaf_prefix",
    severity: "error",
    message: `Label "${label}" must use the grantha's configured leaf "${leaf}".`,
    mantraLabel: label,
  };
}

/** Heuristic markers: text that strongly suggests Bhagavad Gita in a non-BG grantha. */
const BG_SANSKRIT_MARKERS = [
  /अयनेषु\s+च\s+सर्वेषु/,
  /भीष्ममेवाभिरक्षन्तु/,
  /धर्मक्षेत्रे\s+कुरुक्षेत्रे/,
];

const BG_ENGLISH_MARKERS = [
  /protect\s+bhishma/i,
  /venerable\s+sirs,\s+all\s+of\s+you/i,
  /dharmakshetra/i,
  /field\s+of\s+kuru/i,
];

export function detectSuspectCrossGranthaContent(
  granthaName: string | undefined,
  sanskritPlain: string,
  englishPlain: string,
): PublishIntegrityViolation | null {
  const name = (granthaName ?? "").trim();
  if (/bhagavad\s*gita/i.test(name)) return null;
  const sk = sanskritPlain.trim();
  const en = englishPlain.trim();
  if (!sk && !en) return null;
  for (const re of BG_SANSKRIT_MARKERS) {
    if (re.test(sk)) {
      return {
        code: "suspect_bg_sanskrit",
        severity: "error",
        message:
          "Sanskrit text matches a known Bhagavad Gita verse pattern but this grantha is not Bhagavad Gita. Publish blocked.",
        mantraLabel: undefined,
      };
    }
  }
  for (const re of BG_ENGLISH_MARKERS) {
    if (re.test(en)) {
      return {
        code: "suspect_bg_english",
        severity: "error",
        message:
          "English text matches a known Bhagavad Gita verse pattern but this grantha is not Bhagavad Gita. Publish blocked.",
        mantraLabel: undefined,
      };
    }
  }
  return null;
}

export function scanMantraForPublish(input: MantraPublishScanInput): PublishIntegrityViolation[] {
  const out: PublishIntegrityViolation[] = [];
  const label = (input.portalLabel ?? "").trim();
  const leaf = (input.configuredLeaf || "Mantra").trim() || "Mantra";

  const leafViolation = assertConfiguredLeafOnLabel(label, leaf);
  if (leafViolation) out.push(leafViolation);

  const existing = (input.existingStrapiLabel ?? "").trim();
  const portalLinked = (input.portalLinkedDocumentId ?? "").trim();
  const targetDoc = (input.targetDocumentId ?? "").trim();
  const portalOwnsTargetRow =
    portalLinked.length >= 10 && targetDoc.length >= 10 && portalLinked === targetDoc;
  if (existing && label && !input.allowRenumber && !portalOwnsTargetRow) {
    const suffixViolation = assertVerseSuffixStable(existing, label);
    if (suffixViolation) {
      out.push({ ...suffixViolation, documentId: input.targetDocumentId });
    }
  }

  const cross = detectSuspectCrossGranthaContent(
    input.granthaName,
    input.sanskritPlain ?? "",
    input.englishPlain ?? "",
  );
  if (cross) {
    out.push({ ...cross, mantraLabel: label || cross.mantraLabel, documentId: input.targetDocumentId });
  }

  return out;
}

export type SectionMantraRow = { documentId: string; label: string };

/** Case-insensitive ShlokaManthraNumber match within a section listing. */
export function findDocIdByExactLabelInRows(
  rows: SectionMantraRow[],
  label: string,
  preferredDocId?: string,
): string | undefined {
  const t = label.trim().toLowerCase();
  if (!t) return undefined;
  const matches = rows.filter((r) => r.label.trim().toLowerCase() === t);
  if (matches.length === 0) return undefined;
  if (preferredDocId && matches.some((m) => m.documentId === preferredDocId)) return preferredDocId;
  return matches[0]!.documentId;
}

/**
 * One Strapi row per verse suffix per section — leaf prefix may change (Mantra → Vaakhyaa).
 * Used on publish to update the existing row instead of treating a relabel as a duplicate.
 */
export function pickDocIdForSuffixInSectionRows(
  rows: SectionMantraRow[],
  portalLabel: string,
  preferredDocId?: string,
): string | undefined {
  const suffix = mantraNumberSuffix(portalLabel);
  if (!suffix) return undefined;
  const hits = rows.filter((r) => mantraNumberSuffix(r.label) === suffix);
  if (hits.length === 0) return undefined;
  if (preferredDocId && hits.some((h) => h.documentId === preferredDocId)) return preferredDocId;
  return hits[0]!.documentId;
}

export function sectionSuffixCollision(
  sectionLabels: Iterable<string | undefined>,
  newLabel: string,
  excludeDocumentId?: string,
  labelToDocId?: Map<string, string>,
): PublishIntegrityViolation | null {
  const newSuf = mantraNumberSuffix(newLabel);
  if (!newSuf) return null;
  for (const existing of sectionLabels) {
    const lab = (existing ?? "").trim();
    if (!lab) continue;
    if (mantraNumberSuffix(lab) !== newSuf) continue;
    if (excludeDocumentId && labelToDocId?.get(lab) === excludeDocumentId) continue;
    return {
      code: "duplicate_suffix_in_section",
      severity: "error",
      message: `Section already has a mantra with verse number ${newSuf} ("${lab}"). Cannot create or publish "${newLabel}" as a second row.`,
      mantraLabel: newLabel,
    };
  }
  return null;
}

export type HierarchyMantraNode = {
  id?: string;
  title?: string;
  strapiDocumentId?: string;
  ShlokaManthraEntry?: unknown;
  order?: number;
};

export function scanGranthaHierarchyMantras(
  hierarchy: unknown[],
  configuredLeaf: string,
  granthaName: string | undefined,
  options?: { maxErrors?: number; levelThreeEnabled?: boolean },
): PublishIntegrityViolation[] {
  const max = options?.maxErrors ?? 25;
  const violations: PublishIntegrityViolation[] = [];
  /** Per Strapi section bucket — suffixes may repeat across different sections (e.g. 1.4 in adhyaya 1 vs 2). */
  const seenBySection = new Map<string, Map<string, { id?: string; label: string }>>();

  const visit = (m: HierarchyMantraNode, sectionKey: string) => {
    if (violations.filter((v) => v.severity === "error").length >= max) return;
    const label = (m.title ?? "").trim();
    if (!label) return;
    const suf = mantraNumberSuffix(label);
    if (suf && titleUsesConfiguredLeaf(label, configuredLeaf)) {
      let seenSuffix = seenBySection.get(sectionKey);
      if (!seenSuffix) {
        seenSuffix = new Map();
        seenBySection.set(sectionKey, seenSuffix);
      }
      const prev = seenSuffix.get(suf);
      if (prev && prev.id !== m.id) {
        violations.push({
          code: "duplicate_suffix_in_draft",
          severity: "error",
          message: `Draft has two mantras with verse number ${suf} ("${prev.label}" and "${label}"). Re-index the section (add/remove a verse with renumber) or fix titles.`,
          mantraLabel: label,
        });
      } else if (suf) {
        seenSuffix.set(suf, { id: m.id, label });
      }
    }
    const { sk, en } = plainTextFromManthraEntry(m.ShlokaManthraEntry);
    for (const v of scanMantraForPublish({
      portalLabel: label,
      configuredLeaf,
      granthaName,
      targetDocumentId: m.strapiDocumentId,
      sanskritPlain: sk,
      englishPlain: en,
    })) {
      violations.push({ ...v, mantraLabel: label, documentId: m.strapiDocumentId });
    }
  };

  const levelThree = !!options?.levelThreeEnabled;

  for (const a of hierarchy ?? []) {
    const adhyaya = a as { id?: string; khandas?: unknown[] };
    const adhyayaKey = adhyaya.id ?? "adhyaya";
    for (const k of adhyaya.khandas ?? []) {
      const khanda = k as {
        id?: string;
        manthras?: HierarchyMantraNode[];
        padas?: { id?: string; manthras?: HierarchyMantraNode[] }[];
      };
      const khandaKey = khanda.id ?? "khanda";
      const padas = khanda.padas ?? [];
      const skipKhandaMantras = levelThree && padas.length > 0;
      if (!skipKhandaMantras) {
        const sectionKey = `${adhyayaKey}/${khandaKey}`;
        for (const m of khanda.manthras ?? []) visit(m, sectionKey);
      }
      for (const p of padas) {
        const padaKey = p.id ?? "pada";
        const sectionKey = `${adhyayaKey}/${khandaKey}/${padaKey}`;
        for (const m of p.manthras ?? []) visit(m, sectionKey);
      }
    }
  }
  return violations;
}

/** True when the portal hierarchy has two+ rows with the same verse suffix in one section. */
export function hierarchyHasDuplicateMantraSuffixes(
  hierarchy: unknown[],
  configuredLeaf: string,
  options?: { levelThreeEnabled?: boolean },
): boolean {
  return scanGranthaHierarchyMantras(hierarchy, configuredLeaf, undefined, {
    maxErrors: 1,
    levelThreeEnabled: options?.levelThreeEnabled,
  }).some((v) => v.code === "duplicate_suffix_in_draft");
}

export function formatIntegrityFailures(violations: PublishIntegrityViolation[]): string {
  const errors = violations.filter((v) => v.severity === "error");
  if (errors.length === 0) return "";
  return errors
    .slice(0, 8)
    .map((v) => (v.mantraLabel ? `${v.mantraLabel}: ${v.message}` : v.message))
    .join("; ");
}

export function isPublishIntegrityEnabled(): boolean {
  const v = process.env.PUBLISH_INTEGRITY_CHECKS;
  if (v === "0" || v === "false") return false;
  return true;
}
