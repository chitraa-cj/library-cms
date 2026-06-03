/**
 * Grantha full-publish progress accounting.
 *
 * Each Strapi write that reports progress counts as one unit:
 *   grantha root + teekas + section nodes (adhyaya/khanda/pada) + mantras.
 */

export type GranthaPublishProgressBreakdown = {
  grantha: number;
  teekas: number;
  adhyayas: number;
  khandas: number;
  padas: number;
  mantras: number;
  total: number;
};

export type GranthaPublishProgressPlan = GranthaPublishProgressBreakdown & {
  /** Human-readable one-liner for the progress UI. */
  summary: string;
};

type HierarchyCountOpts = {
  levelThreeEnabled?: boolean;
  levelTwoEnabled?: boolean;
};

/** Count section + mantra units that receive a progress tick during hierarchy publish. */
export function countHierarchyPublishUnits(
  hierarchy: unknown[] | undefined,
  opts: HierarchyCountOpts = {},
): Pick<GranthaPublishProgressBreakdown, "adhyayas" | "khandas" | "padas" | "mantras"> {
  const levelThree = !!opts.levelThreeEnabled;
  const levelTwo = opts.levelTwoEnabled !== false;
  let adhyayas = 0;
  let khandas = 0;
  let padas = 0;
  let mantras = 0;

  for (const a of hierarchy ?? []) {
    const adhyaya = a as { khandas?: unknown[] };
    adhyayas++;
    for (const k of adhyaya.khandas ?? []) {
      const khanda = k as { title?: string; manthras?: unknown[]; padas?: unknown[] };
      const isDefault = khanda.title === "_default" || !levelTwo;
      if (!isDefault && khanda.title) khandas++;
      if (levelThree && Array.isArray(khanda.padas) && khanda.padas.length > 0) {
        for (const p of khanda.padas) {
          const pada = p as { manthras?: unknown[] };
          padas++;
          mantras += (pada.manthras ?? []).length;
        }
      } else {
        mantras += (khanda.manthras ?? []).length;
      }
    }
  }

  return { adhyayas, khandas, padas, mantras };
}

/** Teeka slots that will emit a progress tick (named / authored entries, deduped). */
export function countPublishableTeekaSlots(teekaDefinitions: unknown[] | undefined): number {
  if (!Array.isArray(teekaDefinitions)) return 0;
  const seen = new Set<string>();
  let n = 0;
  for (const raw of teekaDefinitions) {
    const teeka = raw as { TeekaName?: string; TeekaAuthor?: string };
    const name = (teeka.TeekaName ?? "").trim();
    const author = (teeka.TeekaAuthor ?? "").trim();
    const effectiveName = name || (author ? `${author} Teeka` : "");
    if (!effectiveName) continue;
    const key = effectiveName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    n++;
  }
  return n;
}

export function formatPublishProgressSummary(b: GranthaPublishProgressBreakdown): string {
  const parts: string[] = [];
  if (b.grantha > 0) parts.push(`Grantha (${b.grantha})`);
  if (b.teekas > 0) parts.push(`Teekas (${b.teekas})`);
  const sections = b.adhyayas + b.khandas + b.padas;
  if (sections > 0) parts.push(`Sections (${sections})`);
  if (b.mantras > 0) parts.push(`Mantras (${b.mantras})`);
  return parts.join(" · ");
}

export function buildGranthaPublishProgressPlan(input: {
  hierarchy?: unknown[];
  teekaDefinitions?: unknown[];
  levelThreeEnabled?: boolean;
  levelTwoEnabled?: boolean;
}): GranthaPublishProgressPlan {
  const hierarchyUnits = countHierarchyPublishUnits(input.hierarchy, {
    levelThreeEnabled: input.levelThreeEnabled,
    levelTwoEnabled: input.levelTwoEnabled,
  });
  const grantha = 1;
  const teekas = countPublishableTeekaSlots(input.teekaDefinitions);
  const breakdown: GranthaPublishProgressBreakdown = {
    grantha,
    teekas,
    ...hierarchyUnits,
    total:
      grantha +
      teekas +
      hierarchyUnits.adhyayas +
      hierarchyUnits.khandas +
      hierarchyUnits.padas +
      hierarchyUnits.mantras,
  };
  return {
    ...breakdown,
    summary: formatPublishProgressSummary(breakdown),
  };
}
