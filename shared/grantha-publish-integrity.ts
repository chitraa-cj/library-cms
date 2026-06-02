/**
 * Publish-time integrity checks for all granthas — blocks cross-text overwrites,
 * verse-number renames on identity sync, and duplicate suffix rows in a section.
 */

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
  if (st && titleUsesConfiguredLeaf(st, leaf)) return st;
  const pt = (portalTitle ?? "").trim();
  if (pt && titleUsesConfiguredLeaf(pt, leaf)) return pt;
  return pt || canonicalMantraTitle(leaf, "1");
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

/** Verse suffix must not change when updating an existing CMS row (prevents 1.372 → 1.2.4). */
export function assertVerseSuffixStable(
  existingLabel: string,
  newLabel: string,
): PublishIntegrityViolation | null {
  const oldSuf = mantraNumberSuffix(existingLabel);
  const newSuf = mantraNumberSuffix(newLabel);
  if (!oldSuf || !newSuf || oldSuf === newSuf) return null;
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
  if (existing && label && !input.allowRenumber) {
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
