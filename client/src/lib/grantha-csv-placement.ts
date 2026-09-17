/**
 * Where CSV-imported verses land in the grantha editor tree.
 *
 * Kept out of `pages/granthas.tsx` so the placement rules can be unit-tested without
 * React — see `tests/grantha-csv-placement.test.mjs`.
 *
 * The rule that matters: a leading number token in a verse number IS that section's
 * number. "5.19" belongs to section 5, whatever the tree currently holds. The earlier
 * implementation resolved a token by ARRAY POSITION among the current siblings, which
 * only holds when the CSV's sections arrive in ascending order into an empty grantha.
 * A file sorted as text ("1.x, 10.x, 11.x, 2.x, …") made token "2" resolve to the node
 * token "10" had just appended: two chapters merged into one, later ones vanished, and
 * the verses of both interleaved. That is how an 11-chapter Ganesha Gita import became
 * 8 mislabelled chapters with 95 verses attached to nothing.
 */

import { editorOrdinalLabel } from "./grantha-structure-sync";

export interface PlacementManthra {
  id: string;
  title: string;
  order: number;
}
export interface PlacementPada {
  id: string;
  title: string;
  order: number;
  manthras: PlacementManthra[];
}
export interface PlacementKhanda {
  id: string;
  title: string;
  order: number;
  padas: PlacementPada[];
  manthras: PlacementManthra[];
}
export interface PlacementAdhyaya {
  id: string;
  title: string;
  order: number;
  khandas: PlacementKhanda[];
}

export interface PlacementStructureConfig {
  levelOneName: string;
  levelTwoName: string;
  levelThreeName: string;
  levelTwoEnabled: boolean;
  levelThreeEnabled: boolean;
}

/** Where new verses go. Null ids mean "auto-create". */
export interface PlacementTargetRef {
  adhyayaId: string | null;
  khandaId: string | null;
  padaId?: string;
}

export type CsvPlacement =
  | { mode: "single"; target: PlacementTargetRef }
  /** Derive the section path from the first `sectionLevels` number tokens of each verse number. */
  | { mode: "group"; sectionLevels: number };

export interface PlacementDeps<C> {
  uid: () => string;
  /** Build the verse node for one CSV row. `order` is its 1-based slot in the section. */
  buildManthra: (create: C, order: number) => PlacementManthra;
}

/** Split a dotted/hyphenated verse number into tokens, e.g. "1.2.3" → ["1","2","3"]. */
export function splitNumberTokens(s: string): string[] {
  return s.trim().split(/[.\-/:|\s]+/).filter(Boolean);
}

/** A section number from one path token, or null when it isn't a positive integer. */
export function sectionNumberFromToken(token: string): number | null {
  const n = Number.parseInt(token, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/** Every digit group of a verse label, in order: "Shloka 1.42" → [1, 42], "1.42" → [1, 42]. */
export function verseNumberKey(title: string | undefined): number[] | null {
  const groups = (title ?? "").match(/\d+/g);
  return groups ? groups.map((g) => Number.parseInt(g, 10)) : null;
}

export function compareVerseNumberKey(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Put a section's verses in verse-number order.
 *
 * Returns null when that order is not well defined — a verse with no number in its label,
 * or two verses sharing one — so the caller can keep file order rather than guess. Without
 * this, a CSV sorted as text lands its verses as 1.1, 1.10, 1.11, …, 1.2: correct labels in
 * a shuffled sequence.
 */
export function sortManthrasByVerseNumber<M extends PlacementManthra>(list: readonly M[]): M[] | null {
  const keyed: Array<{ node: M; key: number[] }> = [];
  const seen = new Set<string>();
  for (const node of list) {
    const key = verseNumberKey(node.title);
    if (!key) return null;
    const id = key.join(".");
    if (seen.has(id)) return null;
    seen.add(id);
    keyed.push({ node, key });
  }
  keyed.sort((x, y) => compareVerseNumberKey(x.key, y.key));
  return keyed.map((k) => k.node);
}

/**
 * Section numbers the CSV skips: numbers "1.x, 2.x, 5.x" → [3, 4].
 *
 * A gap means the file is incomplete or its numbers were misread. Importing it anyway
 * leaves the grantha with sections whose ordinal name no longer matches their position
 * (a "Panchama Adhyaya" sitting third), so the dialog warns before anything is written.
 */
export function missingLeadingSectionNumbers(numbers: readonly string[]): number[] {
  const present = new Set<number>();
  for (const n of numbers) {
    const num = sectionNumberFromToken(splitNumberTokens(n)[0] ?? "");
    if (num != null) present.add(num);
  }
  if (present.size === 0) return [];
  const max = Math.max(...present);
  const missing: number[] = [];
  for (let i = 1; i < max; i++) if (!present.has(i)) missing.push(i);
  return missing;
}

type AnySection = { id: string; title: string; order: number };

/** 1-based number of each sibling: its `order` (portal trees are normalized 1…n), else its position. */
function siblingNumber(node: AnySection, index0: number): number {
  const o = node.order;
  return Number.isFinite(o) && o >= 1 ? Math.round(o) : index0 + 1;
}

function nextOrder(siblings: readonly AnySection[]): number {
  return siblings.reduce((m, x) => Math.max(m, x.order ?? 0), 0) + 1;
}

/**
 * The sibling section carrying `token` as its number, created in that numbered slot when absent.
 *
 * Never resolves by array position — see the file header for what that cost. A token past the
 * current sibling count creates its own numbered node, so a later, smaller token still finds
 * (or creates) its own rather than adopting a stranger's.
 */
function ensureNumberedChild<T extends AnySection>(
  siblings: T[],
  token: string,
  titleForNumber: (n: number) => string,
  makeExtra: () => Partial<T>,
  uid: () => string,
): T {
  const num = sectionNumberFromToken(token);
  if (num == null) {
    // No usable number (the "single" placement's auto-create passes ""): append.
    const order = nextOrder(siblings);
    const node = { id: uid(), title: titleForNumber(order), order, ...makeExtra() } as unknown as T;
    siblings.push(node);
    return node;
  }
  const sorted = [...siblings].sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
  const existing = sorted.find((s, i) => siblingNumber(s, i) === num);
  if (existing) return existing;
  const node = { id: uid(), title: titleForNumber(num), order: num, ...makeExtra() } as unknown as T;
  siblings.push(node);
  return node;
}

function cloneTree<A extends PlacementAdhyaya>(tree: readonly A[]): A[] {
  return tree.map((a) => ({
    ...a,
    khandas: (a.khandas ?? []).map((k) => ({
      ...k,
      manthras: [...(k.manthras ?? [])],
      padas: (k.padas ?? []).map((p) => ({ ...p, manthras: [...(p.manthras ?? [])] })),
    })),
  })) as A[];
}

/**
 * Append the CSV's new verses to a copy of `tree`, creating sections as needed.
 *
 * Returns a new tree; `tree` is not mutated. Verse labels are left exactly as the CSV
 * wrote them — only placement and `order` are decided here.
 */
export function placeCsvCreates<C extends { number: string }, A extends PlacementAdhyaya>(
  tree: readonly A[],
  creates: readonly C[],
  placement: CsvPlacement,
  cfg: PlacementStructureConfig,
  deps: PlacementDeps<C>,
): A[] {
  const next = cloneTree(tree);
  if (creates.length === 0) return next;

  const { uid, buildManthra } = deps;
  const touched = new Set<PlacementManthra[]>();

  const leafListFor = (aTok: string, kTok: string, pTok: string): PlacementManthra[] => {
    const a = ensureNumberedChild<PlacementAdhyaya>(
      next as unknown as PlacementAdhyaya[],
      aTok,
      (n) => `${editorOrdinalLabel(n)} ${cfg.levelOneName}`,
      () => ({ khandas: [], expanded: true }) as Partial<PlacementAdhyaya>,
      uid,
    );
    const k = ensureNumberedChild<PlacementKhanda>(
      a.khandas,
      kTok,
      (n) => (cfg.levelTwoEnabled ? `${editorOrdinalLabel(n)} ${cfg.levelTwoName}` : "_default"),
      () => ({ padas: [], manthras: [], expanded: true }) as Partial<PlacementKhanda>,
      uid,
    );
    if (cfg.levelThreeEnabled) {
      const p = ensureNumberedChild<PlacementPada>(
        k.padas,
        pTok,
        (n) => `${editorOrdinalLabel(n)} ${cfg.levelThreeName}`,
        () => ({ manthras: [], expanded: true }) as Partial<PlacementPada>,
        uid,
      );
      return p.manthras;
    }
    return k.manthras;
  };

  if (placement.mode === "group") {
    const depth = placement.sectionLevels;
    // Resolve each distinct section path once — purely a cost saving now that resolution
    // is number-keyed and therefore idempotent.
    const leafByPath = new Map<string, PlacementManthra[]>();
    for (const c of creates) {
      const toks = splitNumberTokens(c.number);
      const aTok = depth >= 1 ? (toks[0] ?? "1") : "1";
      const kTok = depth >= 2 ? (toks[1] ?? "1") : "1";
      const pTok = depth >= 3 ? (toks[2] ?? "1") : "1";
      const pathKey = `${aTok}|${kTok}|${pTok}`;
      let list = leafByPath.get(pathKey);
      if (!list) {
        list = leafListFor(aTok, kTok, pTok);
        leafByPath.set(pathKey, list);
      }
      list.push(buildManthra(c, nextOrder(list as unknown as AnySection[])));
      touched.add(list);
    }
  } else {
    // Single section — honour explicit ids, auto-create whatever's missing.
    const t = placement.target;
    const roots = next as unknown as PlacementAdhyaya[];
    const a =
      (t.adhyayaId ? roots.find((x) => x.id === t.adhyayaId) : undefined) ??
      ensureNumberedChild<PlacementAdhyaya>(
        roots,
        "",
        (n) => `${editorOrdinalLabel(n)} ${cfg.levelOneName}`,
        () => ({ khandas: [], expanded: true }) as Partial<PlacementAdhyaya>,
        uid,
      );
    const k =
      (t.khandaId ? a.khandas.find((x) => x.id === t.khandaId) : undefined) ??
      ensureNumberedChild<PlacementKhanda>(
        a.khandas,
        "",
        (n) => (cfg.levelTwoEnabled ? `${editorOrdinalLabel(n)} ${cfg.levelTwoName}` : "_default"),
        () => ({ padas: [], manthras: [], expanded: true }) as Partial<PlacementKhanda>,
        uid,
      );
    const pada = t.padaId ? (k.padas ?? []).find((x) => x.id === t.padaId) : undefined;
    const list = pada ? pada.manthras : k.manthras;
    for (const c of creates) list.push(buildManthra(c, nextOrder(list as unknown as AnySection[])));
    touched.add(list);
  }

  // Verse-number order within every section we appended to, so a CSV whose rows are sorted
  // as text ("1.1, 1.10, 1.11, 1.2, …") still reads 1, 2, 3 … in the editor.
  for (const list of touched) {
    const sorted = sortManthrasByVerseNumber(list);
    if (!sorted) continue;
    list.splice(0, list.length, ...sorted.map((m, i) => ({ ...m, order: i + 1 })));
  }

  return next;
}
