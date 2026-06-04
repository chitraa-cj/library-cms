import { useState, useEffect, useRef } from "react";
import { track } from "@/lib/posthog";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, ApiError, CMS_FETCH_INIT } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useDrafts } from "@/hooks/use-drafts";
import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import RichTextEditor from "@/components/rich-text-editor";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  granthaTypes,
  translationLanguages,
  type PortalVocabularyKey,
  type StrapiGrantha,
  type StrapiTeeka,
  type StrapiResponse,
  type StrapiBlock,
  type TextAndTranslation,
} from "@shared/schema";
import StrapiSyncBar from "@/components/strapi-sync-bar";
import { STRAPI_POLL_INTERVAL } from "@/hooks/use-strapi-sync";
import {
  blocksToText,
  entryContentCharCount,
  isPlaceholderVersusCms,
  isStubOrderOrPlaceholderText,
  stripStubTextAndTranslationEntry,
} from "@/lib/strapi-blocks";
import {
  fetchManthraForGranthaEditor,
  labelsShareVerseSuffix,
} from "@/lib/resolve-strapi-mantra-detail";
import { invalidateManthraCache } from "@/lib/mantra-cms-cache";
import { parsePublishScopeFromDraft } from "@/lib/grantha-publish-scope";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  cancelGranthaMantraPrefetch,
  prefetchGranthaMantrasFromHierarchy,
  prefetchManthraDocumentId,
  prefetchManthraNeighbors,
  setGranthaMantraPrefetchContext,
} from "@/lib/grantha-mantra-prefetch";
import {
  buildMantraShlokaIndexFromSections,
  hydrateManthraShlokaFromIndex,
  prepareManthraAfterStrapiResolve,
  mantraNodeHasHydratedShloka,
} from "@/lib/strapi-mantra-hydration";
import {
  sortNodesByOrder,
  isPublishedStrapiDocId,
  collectPublishedManthraDocIdsFromKhanda,
  collectPublishedManthraDocIdsFromAdhyaya,
  prepareHierarchyForContentStep,
  prepareHierarchyForSave,
  normalizeEditorHierarchy,
  editorOrdinalLabel,
  reindexMantraOrdersPreservingTitles,
  assignContiguousMantraOrders,
  reindexMantrasInListOrder,
  buildMantraTitleCtx,
  buildUniqueStrapiOrderMap,
  mantrasShareNumberSuffix,
  mantrasShareLeafAndSuffix,
  findStrapiMantraByLeafAndSuffix,
  MANTRA_LINK_MIN_CONTENT_SCORE,
  scoreStrapiManthraRowContent,
  resolvePortalMantraToStrapiDoc,
  collectKnownVerseSuffixesForLeaf,
  titleUsesConfiguredLeaf,
  mantraNumberSuffix,
  portalMantraTitleForLeaf,
  inferLeafNameFromStrapiMantras,
  strapiGranthaHasKhandaSections,
  sanitizeHierarchyPortalMeta,
  sortMantrasByDisplayOrder,
  countLeafMantrasInKhanda,
  countLeafMantrasInAdhyaya,
  countMantrasOnLeafSections,
  strapiMantrasForResolvedSection,
  mergeStrapiMantraRefsForPortalMantraOwner,
  dedupeManthrasForEditor,
  enforceUniqueStrapiDocumentIdsAmongMantras,
  insertPlaceholderRowsForMissingSuffixGaps,
  fillMissingVerseGapsInHierarchy,
  portalManthraShouldRetainInHierarchy,
  linkFlatGranthaAdhyayasToSoleStrapiSection,
  enforceMantraPlacementByStructure,
  repairDuplicateSuffixesInHierarchy,
  fillMissingSectionTitles,
  type GranthaStructureConfig,
  type StrapiMantraRef,
} from "@/lib/grantha-structure-sync";
import { hierarchyHasDuplicateMantraSuffixes } from "@shared/grantha-publish-integrity";
import {
  mergeMantraStrapiDocumentIds,
  syncMantraSectionAfterStructuralEdits,
  syncMantraSectionLabelsToStrapi,
  syncAllMantraSectionLabelsInGrantha,
  countLinkedMantrasForLabelSync,
  syncAllPendingNewMantrasToStrapi,
  collectMantraSectionSyncTargets,
  getSortedMantrasFromSnapshot,
  syncMantraSlotsViaServer,
  strapiDeleteMantrasBestEffort,
  type MantraSectionResolveContext,
  resolveMantraSectionStrapiDocumentId,
  type SnapshotAdhyaya,
} from "@/lib/grantha-strapi-mantra-sync";
import { invalidateGranthaCmsCaches, syncGranthaCmsCaches } from "@/lib/strapi-cache-sync";
import { resolveMantraOwnerSectionDocId } from "@shared/grantha-mantra-section-resolve";
import {
  flatMantraLabelFromSpacedSortKey,
  isBareLeafCounterTitle,
} from "@shared/grantha-publish-integrity";
import { STRAPI_SORT_GAP } from "@shared/mantra-sort-key";
import { usePortalVocabulary } from "@/hooks/use-portal-vocabulary";
import OtherTranslationsHermex from "@/components/other-translations-hermex";
import {
  postStrapiSection,
  collectSectionDocumentIdsChildToParentForAdhyaya,
  collectSectionDocumentIdsChildToParentForKhanda,
  strapiDeleteMantrasThenSections,
  deleteStrapiTeekaBestEffort,
  syncStrapiSectionOrderAndTitles,
  stripOrphanedSectionDocIdsFromAdhyayas,
  collectAllSectionOrderSyncRowsFromHierarchy,
} from "@/lib/grantha-strapi-section-sync";
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  ChevronRight,
  ChevronDown,
  BookOpen,
  ArrowLeft,
  Check,
  X,
  Hash,
  Layers,
  Send,
  FileText,
  ExternalLink,
  Eye,
  AlertTriangle,
  Lock,
  LockOpen,
  RotateCcw,
} from "lucide-react";

const STRAPI_ADMIN = "http://13.53.121.15:1337/admin";
function strapiAdminUrl(collection: string, documentId?: string) {
  const base = `${STRAPI_ADMIN}/content-manager/collection-types/${collection}`;
  return documentId ? `${base}/${documentId}` : base;
}

// ---------- Local Types ----------

interface TeekaDefinition {
  id: string;
  TeekaName: string;
  TeekaAuthor: string;
}

interface OtherTranslationEntry {
  id: string;
  language: string;
  text: StrapiBlock[];
}

interface GranthaNameTranslationEntry {
  id: string;
  language: string;
  name: string;
}

interface ManthraTeekaEntry {
  TeekaName: string;
  TeekaAuthor: string;
  /** Strapi documentId of the linked Teeka collection record.
   *  Stored when loading from Strapi so we can match by ID instead of name. */
  teekaDocId?: string;
  TeekaEntry?: TextAndTranslation;
}

interface ManthraNode {
  id: string;
  title: string;
  order: number;
  strapiDocumentId?: string;
  /** Set when inserted via + in this session; cleared after Save & Publish. */
  _isNewLocal?: boolean;
  ShlokaManthraEntry?: TextAndTranslation;
  BhashyamForShlokaManthra?: TextAndTranslation;
  Teekas?: ManthraTeekaEntry[];
}

interface PadaNode {
  id: string;
  title: string;
  order: number;
  manthras: ManthraNode[];
  expanded: boolean;
  documentId?: string;
}

interface KhandaNode {
  id: string;
  title: string;
  order: number;
  padas: PadaNode[];   // used when levelThreeEnabled
  manthras: ManthraNode[];  // used when levelThreeEnabled is false
  expanded: boolean;
  documentId?: string;
}

interface AdhyayaNode {
  id: string;
  title: string;
  order: number;
  khandas: KhandaNode[];
  expanded: boolean;
  documentId?: string;
}

// ---------- Helpers ----------

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

/** Delegates to shared portal ordinals in `@/lib/grantha-structure-sync`. */
function ordinal(n: number) {
  return editorOrdinalLabel(n);
}

/** After structural section edits: sort siblings, reindex all mantra titles from position. */
function withNormalizedHierarchy(nodes: AdhyayaNode[], cfg: GranthaStructureConfig): AdhyayaNode[] {
  return sanitizeHierarchyPortalMeta(
    normalizeEditorHierarchy(nodes, cfg) as AdhyayaNode[],
  );
}

/** Save/sync prep: fix order and dedupe without rewriting verse labels. */
function hierarchyForSave(nodes: AdhyayaNode[], cfg: GranthaStructureConfig): AdhyayaNode[] {
  return sanitizeHierarchyPortalMeta(
    prepareHierarchyForSave(nodes, cfg) as AdhyayaNode[],
  );
}

function findManthraInTree(
  tree: AdhyayaNode[],
  adhyayaId: string,
  khandaId: string,
  manthraId: string,
  padaId?: string,
): ManthraNode | undefined {
  const a = tree.find((x) => x.id === adhyayaId);
  const k = a?.khandas.find((x) => x.id === khandaId);
  if (padaId) {
    return k?.padas?.find((x) => x.id === padaId)?.manthras.find((x) => x.id === manthraId);
  }
  return k?.manthras.find((x) => x.id === manthraId);
}

function hasBlocks(v: StrapiBlock[] | string | null | undefined): boolean {
  if (!v) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.some((b) => b.children?.some((c) => (c.text ?? "").trim().length > 0));
  return false;
}

// ── Module-level teeka merge helpers ──
// These are used both by the per-dialog Strapi fetch (useEffect) and by the
// bulk grantha-load pre-populate so teeka data is ALWAYS in state from open.

function draftTextEntryIsOnlyStubs(entry: any | undefined): boolean {
  if (!entry || typeof entry !== "object") return false;
  const sans = blocksToText(entry.SanskritTextEntry).trim();
  const eng = blocksToText(entry.EnglishTranslationText).trim();
  const iast = blocksToText(entry.IASTTransliteration).trim();
  const fields = [sans, eng, iast].filter(Boolean);
  if (fields.length === 0) return false;
  return fields.every((t) => isStubOrderOrPlaceholderText(t));
}

function mergeEntry(draft: any | undefined, fromStrapi: any | undefined): any | undefined {
  if (!fromStrapi && !draft) return undefined;
  if (!fromStrapi) return draftTextEntryIsOnlyStubs(draft) ? undefined : draft;
  if (!draft) return fromStrapi;
  if (draftTextEntryIsOnlyStubs(draft) && !draftTextEntryIsOnlyStubs(fromStrapi)) return fromStrapi;

  // OtherTranslations: whenever Strapi has rows, Strapi is always the base and the draft
  // only overlays languages the user edited. Never prefer draft-by-length alone — after
  // repopulate / partial API the draft can have the same count as Strapi but a different
  // subset of languages, which used to wipe the rest when a new teeka was added.
  const draftOT: any[] = Array.isArray(draft.OtherTranslations) ? draft.OtherTranslations : [];
  const strapiOT: any[] = Array.isArray(fromStrapi.OtherTranslations) ? fromStrapi.OtherTranslations : [];
  let mergedOT: any[] | undefined;
  if (strapiOT.length === 0 && draftOT.length === 0) {
    mergedOT = undefined;
  } else if (strapiOT.length === 0) {
    mergedOT = draftOT;
  } else {
    const merged = strapiOT.map((sOT: any) => {
      const match = draftOT.find((d: any) => d.LanguageOfTranslation === sOT.LanguageOfTranslation);
      return match ?? sOT;
    });
    for (const dOT of draftOT) {
      if (!merged.some((m: any) => m.LanguageOfTranslation === dOT.LanguageOfTranslation)) {
        merged.push(dOT);
      }
    }
    mergedOT = merged;
  }

  const keepDraftSans =
    hasBlocks(draft.SanskritTextEntry) &&
    !isPlaceholderVersusCms(draft.SanskritTextEntry, fromStrapi.SanskritTextEntry);
  const keepDraftEng =
    hasBlocks(draft.EnglishTranslationText) &&
    !isPlaceholderVersusCms(draft.EnglishTranslationText, fromStrapi.EnglishTranslationText);

  const merged = {
    ...fromStrapi,
    ...(keepDraftSans && { SanskritTextEntry: draft.SanskritTextEntry }),
    ...(keepDraftEng && { EnglishTranslationText: draft.EnglishTranslationText }),
    ...(draft.IASTTransliteration && { IASTTransliteration: draft.IASTTransliteration }),
    ...(mergedOT !== undefined && { OtherTranslations: mergedOT }),
  };
  return stripStubTextAndTranslationEntry(merged) as typeof merged | undefined;
}

function shlokaManthraEntryRichness(entry: unknown): number {
  if (!entry || typeof entry !== "object") return 0;
  const e = entry as {
    SanskritTextEntry?: unknown;
    EnglishTranslationText?: unknown;
  };
  return (
    entryContentCharCount(e.SanskritTextEntry as any) +
    entryContentCharCount(e.EnglishTranslationText as any)
  );
}

function bhashyamEntryRichness(entry: unknown): number {
  if (!entry || typeof entry !== "object") return 0;
  const e = entry as {
    SanskritTextEntry?: unknown;
    EnglishTranslationText?: unknown;
  };
  return (
    entryContentCharCount(e.SanskritTextEntry as any) +
    entryContentCharCount(e.EnglishTranslationText as any)
  );
}

/** Do not pull CMS commentary when the editor only has shloka text filled (insert / partial edit). */
function shouldImportCmsBhashyam(
  local: ManthraNode,
  cmsBhashyam: unknown,
  strapiLabel: string,
): boolean {
  if (!cmsBhashyam) return false;
  if (bhashyamEntryRichness(local.BhashyamForShlokaManthra) > 0) return true;
  if (shlokaManthraEntryRichness(local.ShlokaManthraEntry) >= MANTRA_LINK_MIN_CONTENT_SCORE) {
    return false;
  }
  if (!labelsShareVerseSuffix(local.title, strapiLabel)) return false;
  return true;
}

function strapiManthraRowRichness(row: Record<string, unknown>): number {
  return shlokaManthraEntryRichness(row.ShlokaManthraEntry);
}

/** Draft-only teeka row worth keeping when Strapi list does not include it yet. */
function teekaEntryHasMergeableContent(entry: any): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (hasBlocks(entry.SanskritTextEntry) || hasBlocks(entry.EnglishTranslationText)) return true;
  if (hasBlocks(entry.IASTTransliteration)) return true;
  const ot = entry.OtherTranslations;
  if (Array.isArray(ot) && ot.length > 0) return true;
  return !!(entry.LanguageOfTranslation && entry.OtherLanguagesTranslation);
}

function mergeTeekas(draftTeekas: ManthraTeekaEntry[] | undefined, strapiTeekas: any[]): ManthraTeekaEntry[] {
  const matchedDraftIndices = new Set<number>();
  const result: ManthraTeekaEntry[] = strapiTeekas.map((t: any) => {
    const strapiName = t.teeka?.TeekaName || t.TeekaName || "";
    const strapiAuthor = t.teeka?.TeekaAuthor || t.TeekaAuthor || "";
    const strapiDocId = t.teeka?.documentId;
    const draftIdx = draftTeekas
      ? draftTeekas.findIndex(
          (d, i) =>
            !matchedDraftIndices.has(i) && (
              (strapiDocId && d.teekaDocId === strapiDocId) ||
              d.TeekaName === strapiName ||
              (!d.TeekaName && strapiAuthor && d.TeekaAuthor === strapiAuthor)
            )
        )
      : -1;
    if (draftIdx >= 0) matchedDraftIndices.add(draftIdx);
    const draft = draftIdx >= 0 ? draftTeekas![draftIdx] : undefined;
    return {
      TeekaName: draft?.TeekaName?.trim() || strapiName,
      TeekaAuthor: (draft?.TeekaAuthor || "").trim() || strapiAuthor,
      teekaDocId: strapiDocId || draft?.teekaDocId || undefined,
      TeekaEntry: mergeEntry(draft?.TeekaEntry, t.TeekaEntry),
    };
  });
  if (draftTeekas) {
    for (let i = 0; i < draftTeekas.length; i++) {
      if (!matchedDraftIndices.has(i)) {
        const d = draftTeekas[i];
        if (d.TeekaEntry && teekaEntryHasMergeableContent(d.TeekaEntry)) {
          result.push({ ...d });
        }
      }
    }
  }
  return result;
}

function normLangKey(l: string | undefined): string {
  return (l || "").trim().toLowerCase();
}

/** Strapi base + draft overlay by language (portal `otherTranslations` shape). */
function mergeBhashyakaraPortalOtherTranslations(
  draftRows: OtherTranslationEntry[],
  strapiBH: any | undefined
): OtherTranslationEntry[] {
  const strapiOT = Array.isArray(strapiBH?.OtherTranslations) ? strapiBH.OtherTranslations : [];
  const strapiAsPortal: OtherTranslationEntry[] = strapiOT.map((t: any) => ({
    id: uid(),
    language: t.LanguageOfTranslation || "",
    text:
      (Array.isArray(t.TranslationText) ? t.TranslationText : t.OtherLanguagesTranslation) || [],
  }));
  if (strapiAsPortal.length === 0) {
    return (draftRows || []).map((t) => ({ ...t, text: t.text || [] }));
  }
  const draftList = draftRows || [];
  const merged: OtherTranslationEntry[] = strapiAsPortal.map((row) => {
    const match = draftList.find((d) => normLangKey(d.language) === normLangKey(row.language));
    if (match && (hasBlocks(match.text) || (match.language && match.language.trim()))) {
      return {
        ...row,
        id: match.id,
        language: match.language || row.language,
        text: hasBlocks(match.text) ? match.text : row.text,
      };
    }
    return row;
  });
  for (const d of draftList) {
    if (!normLangKey(d.language)) continue;
    if (!merged.some((m) => normLangKey(m.language) === normLangKey(d.language))) {
      merged.push({ ...d, text: d.text || [] });
    }
  }
  return merged;
}

/** Strapi base + draft overlay by language (portal `granthaNameTranslations` shape). */
function mergeGranthaNameTranslationsPortal(
  draftRows: GranthaNameTranslationEntry[],
  strapiRows: any[] | undefined
): GranthaNameTranslationEntry[] {
  const strapiList = Array.isArray(strapiRows) ? strapiRows : [];
  const strapiAsPortal: GranthaNameTranslationEntry[] = strapiList.map((t: any) => ({
    id: uid(),
    language: t.LanguageOfTranslation || "",
    name:
      (Array.isArray(t.TranslationText) ? blocksToText(t.TranslationText) : null) ||
      t.GranthaNameTranslation ||
      t.name ||
      "",
  }));
  if (strapiAsPortal.length === 0) {
    return (draftRows || []).map((t) => ({ ...t, name: t.name || "" }));
  }
  const draftList = draftRows || [];
  const merged: GranthaNameTranslationEntry[] = strapiAsPortal.map((row) => {
    const match = draftList.find((d) => normLangKey(d.language) === normLangKey(row.language));
    if (match && ((match.name || "").trim() || (match.language || "").trim())) {
      return {
        ...row,
        id: match.id,
        language: match.language || row.language,
        name: (match.name || "").trim() ? match.name : row.name,
      };
    }
    return row;
  });
  for (const d of draftList) {
    if (!normLangKey(d.language)) continue;
    if (!merged.some((m) => normLangKey(m.language) === normLangKey(d.language))) {
      merged.push({ ...d, name: d.name || "" });
    }
  }
  return merged;
}

/**
 * Rebuilds the portal hierarchy (AdhyayaNode[]) from Strapi section data.
 * Used as a fallback when no local draft hierarchy exists (e.g. different user
 * trying to edit a grantha published by someone else, or draft was cleared).
 *
 * Strapi sections are a flat list; each section may have a `parent` field
 * (populated via populate[sections][populate][parent]=*) that identifies its
 * parent section, enabling us to reconstruct the nested tree.
 */
// When Strapi has two records with the same sort key in a section, keep one row per key.
// Prefer the row with richer ShlokaManthraEntry (matches editor linking), then lower Strapi id.
function deduplicateManthrasByOrder(manthras: any[]): any[] {
  const best = new Map<number, any>();
  const noOrder: any[] = [];
  for (const m of manthras) {
    const ord = typeof m.order === "number" ? m.order : null;
    if (ord === null) {
      noOrder.push(m);
      continue;
    }
    const existing = best.get(ord);
    if (!existing) {
      best.set(ord, m);
      continue;
    }
    const existingScore = scoreStrapiManthraRowContent(existing.ShlokaManthraEntry);
    const candidateScore = scoreStrapiManthraRowContent(m.ShlokaManthraEntry);
    if (candidateScore > existingScore) {
      best.set(ord, m);
    } else if (candidateScore === existingScore) {
      const existingId = typeof existing.id === "number" ? existing.id : Infinity;
      const candidateId = typeof m.id === "number" ? m.id : Infinity;
      if (candidateId < existingId) {
        best.set(ord, m);
      }
    }
  }
  return [...Array.from(best.values()), ...noOrder].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function reconstructHierarchyFromStrapi(sections: any[], leafName = "Mantra"): AdhyayaNode[] {
  const leafLabel = (leafName || "Mantra").trim() || "Mantra";
  if (!sections || sections.length === 0) return [];

  // Build a map of children by parent documentId for O(1) look-up at every level.
  const childrenByParent = new Map<string, any[]>();
  for (const s of sections) {
    const pid = s.parent?.documentId;
    if (!pid) continue;
    if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
    childrenByParent.get(pid)!.push(s);
  }

  // Top-level sections = those with no parent.
  const topLevel = sections.filter((s) => !s.parent?.documentId);

  // Shared helper: convert a Strapi manthra to a ManthraNode.
  const toManthra = (m: any, mi: number): ManthraNode => {
    const strapiLabel = (m.ShlokaManthraNumber ?? "").trim();
    const sortKey =
      typeof m.order === "number" && !Number.isNaN(m.order) ? m.order : (mi + 1) * STRAPI_SORT_GAP;
    const title =
      strapiLabel && !isBareLeafCounterTitle(strapiLabel)
        ? strapiLabel
        : flatMantraLabelFromSpacedSortKey(sortKey, leafLabel) || "";
    return {
      id: uid(),
      title,
      order: m.order ?? mi + 1,
      strapiDocumentId: m.documentId || undefined,
    };
  };

  // Build a KhandaNode from a Strapi section.
  // If the section has sub-children those become padas (3-level grantha);
  // otherwise the section's own manthras are placed directly on the khanda (2-level).
  const toKhanda = (k: any, ki: number): KhandaNode => {
    const subSections = (childrenByParent.get(k.documentId) ?? [])
      .sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));

    if (subSections.length > 0) {
      // 3-level: this khanda has sub-sections → they become padas.
      const padas: PadaNode[] = subSections.map((p: any, pi: number) => ({
        id: uid(),
        title: p.title || `Section ${pi + 1}`,
        order: p.order ?? pi + 1,
        expanded: true,
        documentId: p.documentId || undefined,
        manthras: deduplicateManthrasByOrder(
          [...(p.manthras || [])].sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0))
        ).map(toManthra),
      }));
      return {
        id: uid(),
        title: k.title || `Section ${ki + 1}`,
        order: k.order ?? ki + 1,
        expanded: true,
        padas,
        manthras: [],
        documentId: k.documentId || undefined,
      } as KhandaNode & { documentId?: string };
    }

    // 2-level: this khanda directly owns its manthras.
    return {
      id: uid(),
      title: k.title || `Section ${ki + 1}`,
      order: k.order ?? ki + 1,
      expanded: true,
      padas: [],
      manthras: deduplicateManthrasByOrder(
        [...(k.manthras || [])].sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0))
      ).map(toManthra),
      documentId: k.documentId || undefined,
    } as KhandaNode & { documentId?: string };
  };

  // If there are NO top-level sections (e.g. all sections are at one level
  // because the grantha has no adhyaya tier), treat them all as khandas
  // wrapped in a single implicit adhyaya.
  if (topLevel.length === 0) {
    const sorted = [...sections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return [
      {
        id: uid(),
        title: sorted[0]?.title || "Adhyaya",
        order: 1,
        expanded: true,
        khandas: sorted.map(toKhanda),
      },
    ];
  }

  return topLevel
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((adhyaya, ai) => {
      const khandas = (childrenByParent.get(adhyaya.documentId) ?? [])
        .sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));

      // If no children found, treat the adhyaya's own manthras as its content.
      const khandaNodes: KhandaNode[] =
        khandas.length > 0
          ? khandas.map(toKhanda)
          : [
              {
                id: uid(),
                title: "_default",
                order: 1,
                expanded: true,
                padas: [],
                manthras: deduplicateManthrasByOrder(
                  [...(adhyaya.manthras || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
                ).map(toManthra),
              },
            ];

      return {
        id: uid(),
        title: adhyaya.title || `Adhyaya ${ai + 1}`,
        order: adhyaya.order ?? ai + 1,
        expanded: true,
        khandas: khandaNodes,
        // Preserve the Strapi section documentId so enrichHierarchy can look up child sections
        // by parent docId (unique) rather than by title (non-unique across adhyayas).
        documentId: adhyaya.documentId || undefined,
      } as AdhyayaNode & { documentId?: string };
    });
}

/**
 * Vivekachudamani-style granthas store mantras under `_default` in the portal but on a real
 * khanda section in Strapi. enrichHierarchy used to also supplement that khanda — duplicating
 * the entire mantra list. Drop the redundant named khanda when `_default` already owns that section.
 */
function dropKhandasDuplicatingDefaultMantraSection(
  hier: AdhyayaNode[],
  cfg: GranthaStructureConfig,
  childrenByParentDocId: Map<string, { documentId: string; title?: string }[]>,
): AdhyayaNode[] {
  const ctx: MantraSectionResolveContext = { childrenByParentDocId };
  const snap = hier as SnapshotAdhyaya[];
  return hier.map((a) => {
    const defaultK = a.khandas?.find((k) => k.title === "_default");
    if (!defaultK || (defaultK.manthras?.length ?? 0) === 0) return a;
    const ownerDocId = resolveMantraOwnerSectionDocId(
      snap,
      a.id,
      defaultK.id,
      undefined,
      cfg,
      ctx,
    );
    if (!ownerDocId) return a;
    const khandas = (a.khandas ?? []).filter((k) => {
      if (k.title === "_default") return true;
      return k.documentId !== ownerDocId;
    });
    return khandas.length === (a.khandas ?? []).length ? a : { ...a, khandas };
  });
}

function hasManthraContent(m: ManthraNode): boolean {
  return (
    shlokaManthraEntryRichness(m.ShlokaManthraEntry) > 12 ||
    hasBlocks(m.BhashyamForShlokaManthra?.SanskritTextEntry) ||
    !!m.Teekas?.some((t) => hasBlocks(t.TeekaEntry?.SanskritTextEntry))
  );
}

function collectValidStrapiMantraDocIdsFromSections(sections: any[]): Set<string> {
  const out = new Set<string>();
  for (const sec of sections ?? []) {
    for (const m of sec.manthras ?? []) {
      if (m.documentId && isPublishedStrapiDocId(m.documentId)) {
        out.add(m.documentId);
      }
    }
  }
  return out;
}

/** Drop portal-only stubs and draft rows whose Strapi document was deleted. */
function shouldKeepManthraInEditor(
  m: ManthraNode,
  validStrapiMantraDocIds?: Set<string>,
): boolean {
  if (isNewLocalManthra(m)) return true;
  const docId = m.strapiDocumentId;
  if (validStrapiMantraDocIds && validStrapiMantraDocIds.size > 0) {
    if (docId && validStrapiMantraDocIds.has(docId)) return true;
    return hasManthraContent(m);
  }
  if (docId && isPublishedStrapiDocId(docId)) return true;
  return hasManthraContent(m);
}

function stripOrphanPortalMantrasFromHierarchy(
  hier: AdhyayaNode[],
  validStrapiMantraDocIds?: Set<string>,
): AdhyayaNode[] {
  const filterList = (list: ManthraNode[]) =>
    list.filter((m) => shouldKeepManthraInEditor(m, validStrapiMantraDocIds));
  return hier.map((a) => ({
    ...a,
    khandas: (a.khandas ?? []).map((k) => ({
      ...k,
      manthras: filterList(k.manthras ?? []),
      padas: (k.padas ?? []).map((p) => ({
        ...p,
        manthras: filterList(p.manthras ?? []),
      })),
    })),
  }));
}

function isNewLocalManthra(m: ManthraNode): boolean {
  return !!m._isNewLocal;
}

function manthraListRowClassName(m: ManthraNode): string {
  const base = "flex items-center gap-2 group py-0.5";
  return isNewLocalManthra(m)
    ? `${base} rounded-md bg-amber-50 dark:bg-amber-950/35 border border-amber-300/70 dark:border-amber-700/60 px-2 -mx-1`
    : base;
}

/** After publish, the server returns a structure-only hierarchy; keep loaded verse bodies from memory. */
function mergePublishedHierarchyPreservingContent(
  prev: AdhyayaNode[],
  next: AdhyayaNode[],
): AdhyayaNode[] {
  const prevById = new Map<string, ManthraNode>();
  for (const a of prev) {
    for (const k of a.khandas ?? []) {
      for (const m of k.manthras ?? []) prevById.set(m.id, m);
      for (const p of k.padas ?? []) {
        for (const m of p.manthras ?? []) prevById.set(m.id, m);
      }
    }
  }

  const mergeManthra = (m: ManthraNode): ManthraNode => {
    const prior = prevById.get(m.id);
    if (!prior) return m;
    if (!hasManthraContent(m) && hasManthraContent(prior)) {
      return {
        ...m,
        ShlokaManthraEntry: prior.ShlokaManthraEntry,
        BhashyamForShlokaManthra: prior.BhashyamForShlokaManthra,
        Teekas: prior.Teekas,
      };
    }
    return {
      ...m,
      ShlokaManthraEntry: mergeEntry(m.ShlokaManthraEntry, prior.ShlokaManthraEntry),
      BhashyamForShlokaManthra: mergeEntry(m.BhashyamForShlokaManthra, prior.BhashyamForShlokaManthra),
      Teekas:
        m.Teekas?.length || !prior.Teekas?.length
          ? m.Teekas
          : prior.Teekas,
    };
  };

  return next.map((a) => ({
    ...a,
    khandas: (a.khandas ?? []).map((k) => ({
      ...k,
      manthras: (k.manthras ?? []).map(mergeManthra),
      padas: (k.padas ?? []).map((p) => ({
        ...p,
        manthras: (p.manthras ?? []).map(mergeManthra),
      })),
    })),
  }));
}

type EditorOperationProgress = {
  title: string;
  done: number;
  total: number;
  current?: string;
  summary?: string;
};

function EditorOperationProgressBar({ progress }: { progress: EditorOperationProgress }) {
  const pct =
    progress.total > 0
      ? Math.min(100, Math.max(0, Math.round((progress.done / progress.total) * 100)))
      : null;
  return (
    <div
      className="w-full rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 shadow-sm"
      data-testid="editor-operation-progress"
    >
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 text-sm font-medium min-w-0">
          <Loader2 className="w-4 h-4 animate-spin flex-shrink-0 text-primary" />
          <span className="truncate">{progress.title}</span>
        </div>
        <span
          className="text-sm font-semibold tabular-nums text-primary flex-shrink-0"
          data-testid="editor-operation-progress-percent"
        >
          {pct != null ? `${pct}%` : "…"}
        </span>
      </div>
      <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
        {pct != null ? (
          <div
            className="bg-primary h-2 rounded-full transition-all duration-300 ease-out"
            style={{ width: `${pct}%` }}
            data-testid="editor-operation-progress-bar"
          />
        ) : (
          <div className="bg-primary/60 h-2 w-1/3 rounded-full animate-pulse" />
        )}
      </div>
      {progress.current && (
        <p className="text-xs text-muted-foreground mt-2 truncate" data-testid="editor-operation-progress-current">
          {progress.current}
        </p>
      )}
      {progress.total > 0 && (
        <p className="text-[11px] text-muted-foreground/80 mt-1 tabular-nums">
          {progress.done} / {progress.total} steps complete
        </p>
      )}
      {progress.summary && (
        <p className="text-[11px] text-muted-foreground/70 mt-0.5 truncate" title={progress.summary}>
          {progress.summary}
        </p>
      )}
    </div>
  );
}

// ---------- Grantha Card ----------

function GranthaCard({
  item,
  onEdit,
  onView,
  onDelete,
  onPublish,
  onResetDraftFromStrapi,
  isPublishing,
  publishProgress,
  isResettingDraft,
  currentUserId,
  isDuplicate,
  isLocked,
  isAdmin,
  onLock,
  onUnlock,
}: {
  item: any;
  onEdit: () => void;
  onView?: (item: any) => void;
  onDelete: () => void;
  onPublish: () => void;
  onResetDraftFromStrapi?: () => void;
  isPublishing: boolean;
  publishProgress?: {
    done: number;
    total: number;
    current: string;
    breakdown?: {
      grantha: number;
      teekas: number;
      adhyayas: number;
      khandas: number;
      padas: number;
      mantras: number;
      total: number;
    };
    summary?: string;
  } | null;
  isResettingDraft?: boolean;
  currentUserId?: string | null;
  isDuplicate?: boolean;
  isLocked?: boolean;
  isAdmin?: boolean;
  onLock?: () => void;
  onUnlock?: () => void;
}) {
  const isDraft = item._isDraft;
  const isLinkedPublishedDraft = isDraft && !!item._strapiDocId;
  const canDelete = !currentUserId || item._createdBy === currentUserId;

  return (
    <div
      className={`group relative border rounded-xl bg-card p-5 cursor-pointer hover:border-primary/50 hover:shadow-sm transition-all ${isLocked ? "border-orange-300 dark:border-orange-700/60" : ""}`}
      onClick={onEdit}
      data-testid={`card-grantha-${item.documentId || item._draftId}`}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex flex-wrap gap-1.5">
          {item.GranthaType && (
            <Badge variant="secondary" className="text-xs">
              {item.GranthaType}
            </Badge>
          )}
          <Badge
            variant="outline"
            className={`text-xs ${
              isDraft
                ? "border-amber-300 text-amber-700 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-400"
                : "border-green-300 text-green-700 bg-green-50 dark:bg-green-950/30 dark:text-green-400"
            }`}
          >
            {isDraft ? (isLinkedPublishedDraft ? "Draft overlay" : "Draft") : "Published"}
          </Badge>
          {isLocked && (
            <Badge
              variant="outline"
              className="text-xs border-orange-300 text-orange-700 bg-orange-50 dark:bg-orange-950/30 dark:text-orange-400 flex items-center gap-1"
              data-testid={`badge-locked-${item.documentId || item._draftId}`}
            >
              <Lock className="w-2.5 h-2.5" />
              Locked
            </Badge>
          )}
        </div>

        <div
          className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={onEdit}
            title={isLocked ? "View only (locked)" : "Edit"}
            data-testid={`button-edit-${item.documentId || item._draftId}`}
          >
            {isLocked ? <Eye className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
          </Button>
          {!isLocked && isDraft && item._strapiDocId && onResetDraftFromStrapi && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={onResetDraftFromStrapi}
              disabled={isPublishing || isResettingDraft}
              data-testid={`button-reset-draft-strapi-${item._draftId}`}
              title="Discard portal draft and show the published Strapi entry in the list"
            >
              {isResettingDraft ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RotateCcw className="w-3.5 h-3.5" />
              )}
            </Button>
          )}
          {!isLocked && isDraft && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-primary hover:text-primary"
              onClick={onPublish}
              disabled={isPublishing || isResettingDraft}
              data-testid={`button-publish-${item._draftId}`}
              title="Publish to Strapi"
            >
              {isPublishing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
            </Button>
          )}
          {!isDraft && item.documentId && onView && (
            <button
              type="button"
              onClick={() => onView(item)}
              title="View content (read-only)"
              className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              data-testid={`button-view-${item.documentId}`}
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          )}
          {isAdmin && item.documentId && (
            isLocked ? (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-orange-600 hover:text-orange-600"
                onClick={onUnlock}
                title="Remove blocker — allow editing"
                data-testid={`button-unlock-${item.documentId}`}
              >
                <LockOpen className="w-3.5 h-3.5" />
              </Button>
            ) : (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-muted-foreground hover:text-orange-600"
                onClick={onLock}
                title="Add blocker — prevent editing"
                data-testid={`button-lock-${item.documentId}`}
              >
                <Lock className="w-3.5 h-3.5" />
              </Button>
            )
          )}
          {!isLocked && canDelete && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={onDelete}
              data-testid={`button-delete-${item.documentId || item._draftId}`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      </div>

      <h3
        className="font-semibold text-base leading-tight"
        data-testid={`text-grantha-name-${item.documentId || item._draftId}`}
      >
        {item.GranthaName}
      </h3>
      {item.BhashyamName && (
        <p className="text-xs text-muted-foreground mt-1">{item.BhashyamName}</p>
      )}
      {isPublishing && publishProgress && publishProgress.total > 0 && (() => {
        const pct = Math.min(
          100,
          Math.max(0, Math.round((publishProgress.done / publishProgress.total) * 100)),
        );
        return (
          <div
            className="mt-3 px-2.5 py-2 rounded-md bg-primary/5 border border-primary/20"
            onClick={(e) => e.stopPropagation()}
            data-testid={`grantha-card-publish-progress-${item._draftId}`}
          >
            <div className="flex items-center justify-between gap-2 mb-1">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
                <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
                <span className="font-medium text-foreground">Publishing</span>
              </div>
              <span className="text-xs font-semibold tabular-nums text-primary">{pct}%</span>
            </div>
            <div className="w-full bg-muted rounded-full h-1.5">
              <div
                className="bg-primary rounded-full h-1.5 transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="text-[10px] text-muted-foreground mt-1 truncate">
              {publishProgress.done}/{publishProgress.total} · {publishProgress.current}
            </div>
            {publishProgress.summary && (
              <div className="text-[10px] text-muted-foreground/80 mt-0.5 truncate" title={publishProgress.summary}>
                {publishProgress.summary}
              </div>
            )}
          </div>
        );
      })()}
      {isDuplicate && (
        <div className="flex items-center gap-1.5 mt-2 px-2 py-1 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          <p className="text-xs text-amber-700 dark:text-amber-400 font-medium">
            Duplicate name detected — another entry with a similar name exists in Strapi
          </p>
        </div>
      )}
      {!isDraft && (
        <div className="mt-3 pt-3 border-t space-y-2">
          {Array.isArray(item.sections) && item.sections.length > 0 && (() => {
            const parentDocIds = new Set(
              item.sections
                .filter((s: any) => s.parent?.documentId)
                .map((s: any) => s.parent.documentId)
            );
            const leafSections = item.sections.filter(
              (s: any) => !parentDocIds.has(s.documentId)
            );
            const totalManthras = countMantrasOnLeafSections(item.sections);
            // Show leaf sections sorted by order; cap at 12 to keep card compact.
            const sorted = [...(leafSections.length > 0 ? leafSections : item.sections)]
              .sort((a: any, b: any) => (a.order ?? 999) - (b.order ?? 999));
            const SECTION_DISPLAY_CAP = 12;
            const visible = sorted.slice(0, SECTION_DISPLAY_CAP);
            const overflow = sorted.length - SECTION_DISPLAY_CAP;
            return (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">
                  Sections ({sorted.length}){totalManthras > 0 ? ` · ${totalManthras} mantra${totalManthras !== 1 ? "s" : ""}` : ""}
                </p>
                <div className="flex flex-wrap gap-1">
                  {visible.map((s: any) => (
                    <span
                      key={s.documentId || s.id}
                      className="inline-flex items-center text-xs bg-muted rounded px-1.5 py-0.5 text-foreground"
                    >
                      {s.title || "Untitled"}
                      {s.type && <span className="ml-1 text-muted-foreground">· {s.type}</span>}
                    </span>
                  ))}
                  {overflow > 0 && (
                    <span className="inline-flex items-center text-xs bg-muted/60 rounded px-1.5 py-0.5 text-muted-foreground">
                      +{overflow} more
                    </span>
                  )}
                </div>
              </div>
            );
          })()}
          {Array.isArray(item.teekas) && item.teekas.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">
                Teekas ({item.teekas.length})
              </p>
              <div className="flex flex-wrap gap-1">
                {item.teekas.map((t: any) => (
                  <span
                    key={t.documentId || t.id}
                    className="inline-flex items-center text-xs bg-muted rounded px-1.5 py-0.5 text-foreground"
                  >
                    {t.TeekaName || "Untitled"}
                  </span>
                ))}
              </div>
            </div>
          )}
          {(!Array.isArray(item.sections) || item.sections.length === 0) &&
           (!Array.isArray(item.teekas) || item.teekas.length === 0) && (
            <p className="text-xs text-muted-foreground">No sections or teekas linked</p>
          )}
        </div>
      )}
      {isDraft && (
        <p className="text-xs text-muted-foreground mt-3 pt-3 border-t">
          {isLinkedPublishedDraft
            ? "Portal draft overlay — Strapi is already published. Use ↺ to discard this draft and show the live entry."
            : "Draft — not yet published"}
        </p>
      )}
    </div>
  );
}

// ---------- Step Indicator ----------

function StepDot({
  n,
  active,
  done,
  label,
}: {
  n: number;
  active: boolean;
  done: boolean;
  label: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        className={`flex items-center justify-center w-8 h-8 rounded-full border-2 text-sm font-semibold transition-colors ${
          done
            ? "bg-primary border-primary text-primary-foreground"
            : active
            ? "border-primary text-primary"
            : "border-muted-foreground/30 text-muted-foreground"
        }`}
      >
        {done ? <Check className="w-4 h-4" /> : n}
      </div>
      <span
        className={`text-xs whitespace-nowrap ${
          active || done ? "text-foreground font-medium" : "text-muted-foreground"
        }`}
      >
        {label}
      </span>
    </div>
  );
}

// ---------- Main Page ----------

export default function GranthasPage() {
  const { toast } = useToast();
  const { user } = useAuth();

  const [view, setView] = useState<"list" | "form">("list");
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [viewOnly, setViewOnly] = useState(false);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [editingDraftId, setEditingDraftId] = useState<number | null>(null);
  /** True when portal draft on disk matches the editor (after Save or open). Required before Save & Publish. */
  const [draftSyncedForPublish, setDraftSyncedForPublish] = useState(false);
  /** Save / pre-publish Strapi work in flight (disables buttons while running). */
  const [persistInFlight, setPersistInFlight] = useState(false);
  const [persistProgress, setPersistProgress] = useState<EditorOperationProgress | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [resetDraftTarget, setResetDraftTarget] = useState<any>(null);
  const [resettingDraftId, setResettingDraftId] = useState<number | null>(null);

  // Step 1
  const [formData, setFormData] = useState<{
    GranthaName: string;
    GranthaType: string;
    BhashyamName: string;
    BhashyamAuthor: string;
    IntroductionToTextEnglish: StrapiBlock[];
    BhashyakaraIntroductionSanskrit: StrapiBlock[];
    BhashyakaraIntroductionEnglish: StrapiBlock[];
    BhashyakaraIntroductionIAST: StrapiBlock[];
    slug: string;
    order: string;
    introVideoId: string;
    introVideoTitle: string;
  }>({
    GranthaName: "",
    GranthaType: "",
    BhashyamName: "",
    BhashyamAuthor: "",
    IntroductionToTextEnglish: [],
    BhashyakaraIntroductionSanskrit: [],
    BhashyakaraIntroductionEnglish: [],
    BhashyakaraIntroductionIAST: [],
    slug: "",
    order: "",
    introVideoId: "",
    introVideoTitle: "",
  });
  const [teekas, setTeekas] = useState<TeekaDefinition[]>([]);
  const [otherTranslations, setOtherTranslations] = useState<OtherTranslationEntry[]>([]);
  const [granthaNameTranslations, setGranthaNameTranslations] = useState<GranthaNameTranslationEntry[]>([]);

  // Step 2 – Book structure
  const [structureConfig, setStructureConfig] = useState({
    levelOneEnabled: true,
    levelOneName: "Adhyaya",
    levelTwoEnabled: true,
    levelTwoName: "Khanda",
    levelThreeEnabled: false,
    levelThreeName: "Pada",
    leafName: "Mantra",
  });

  // Step 3
  const [adhyayas, setAdhyayas] = useState<AdhyayaNode[]>([]);
  // Tracks Strapi section documentIds that were explicitly removed by the user.
  // Used to prevent the supplement logic from re-adding them and to delete them on publish.
  const [deletedStrapiSectionDocIds, setDeletedStrapiSectionDocIds] = useState<string[]>([]);
  // Tracks Strapi manthra documentIds that were explicitly removed from the hierarchy.
  // Used to prevent enrichHierarchy from re-adding them from Strapi on every reload.
  const [deletedStrapiManthraDocIds, setDeletedStrapiManthraDocIds] = useState<string[]>([]);
  // Teeka rows removed in Teeka Management whose Strapi Teeka documentId must not be
  // re-supplemented from /teekas/by-grantha on reload, and removed from Strapi on publish.
  const [deletedStrapiTeekaDocIds, setDeletedStrapiTeekaDocIds] = useState<string[]>([]);

  const adhyayasRef = useRef<AdhyayaNode[]>([]);
  const structureConfigRef = useRef(structureConfig);
  const editingItemRef = useRef<any>(null);
  /** When true, portal hierarchy bodies/teekas win over CMS on enrich and mantra dialog fetch. */
  const preferPortalMantraContentRef = useRef(false);
  const formDataRef = useRef(formData);
  const strapiHierarchySyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mantraSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mantraSyncChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingMantraDeletesRef = useRef<Set<string>>(new Set());
  /** Coalesce rapid +/delete clicks: create all pending CMS rows, then one full label/order pass. */
  const pendingMantraSyncRef = useRef<{
    manthraIds: Set<string>;
    renumber: boolean;
    ctx: { adhyayaId: string; khandaId: string; padaId?: string } | null;
  }>({ manthraIds: new Set(), renumber: false, ctx: null });
  const strapiSectionIndexRef = useRef<MantraSectionResolveContext>({});
  const publishInProgressRef = useRef(false);
  /** Set after +/delete renumber; Save & Publish sends allowRenumber so CMS labels match portal order. */
  const structuralMantraRenumberPendingRef = useRef(false);

  /** Block debounced mantra slot sync while publish is running (avoids 504 during large publishes). */
  function armPublishSyncGuard() {
    publishInProgressRef.current = true;
    if (mantraSyncTimerRef.current) {
      clearTimeout(mantraSyncTimerRef.current);
      mantraSyncTimerRef.current = null;
    }
  }

  useEffect(() => {
    adhyayasRef.current = adhyayas;
  }, [adhyayas]);

  useEffect(() => {
    structureConfigRef.current = structureConfig;
  }, [structureConfig]);

  useEffect(() => {
    formDataRef.current = formData;
  }, [formData]);

  useEffect(() => {
    editingItemRef.current = editingItem;
  }, [editingItem]);

  function bindGranthaMantraPrefetchContext(): void {
    setGranthaMantraPrefetchContext({
      getGranthaDocId: () => {
        const item = editingItemRef.current;
        if (!item) return undefined;
        const raw = item._isDraft ? item._strapiDocId : item.documentId;
        return isPublishedStrapiDocId(raw) ? raw : undefined;
      },
      getStructureConfig: () => structureConfigRef.current,
      getAdhyayas: () => adhyayasRef.current,
    });
  }

  useEffect(() => {
    return () => {
      if (strapiHierarchySyncTimerRef.current) clearTimeout(strapiHierarchySyncTimerRef.current);
      if (mantraSyncTimerRef.current) clearTimeout(mantraSyncTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (view === "form") bindGranthaMantraPrefetchContext();
  }, [view, adhyayas, structureConfig, editingItem]);

  // Manthra content dialog
  const [editingManthra, setEditingManthra] = useState<{
    adhyayaId: string;
    khandaId: string;
    padaId?: string;  // only set when levelThreeEnabled
    manthraId: string;
    strapiDocumentId?: string; // set if this mantra is already published to Strapi
  } | null>(null);
  const [manthraDialogDirty, setManthraDialogDirty] = useState(false);
  const [manthraDialogViewOnly, setManthraDialogViewOnly] = useState(false);
  const [pendingCloseManthra, setPendingCloseManthra] = useState(false);
  const [mantraPublishStatus, setMantraPublishStatus] = useState<string | null>(null);
  const [newSharedOption, setNewSharedOption] = useState<Record<PortalVocabularyKey, string>>({
    teekaAuthors: "",
    bhashyamAuthors: "",
    structureLevelOneNames: "",
    structureLevelTwoNames: "",
    structureLevelThreeNames: "",
    structureLeafNames: "",
  });
  const [addingSharedOptionKey, setAddingSharedOptionKey] = useState<PortalVocabularyKey | null>(null);
  const [manthraLoading, setManthraLoading] = useState(false);
  const mantraFetchGenRef = useRef(0);
  /** Deep copy of the open mantra when the dialog opened — used to discard unsaved edits. */
  const mantraOpenSnapshotRef = useRef<{
    node: ManthraNode | null;
    wasNewLocal: boolean;
  } | null>(null);
  const openEditLoadGenRef = useRef(0);

  function isCurrentOpenEditLoad(gen: number): boolean {
    return openEditLoadGenRef.current === gen;
  }

  const changedManthraIdsRef = useRef(new Set<string>());
  const requiresFullPublishRef = useRef(false);
  const granthaMetaDirtyRef = useRef(false);
  const publishScopeReadyRef = useRef(false);

  function applyPublishScopeFromDraft(data: unknown) {
    const scope = parsePublishScopeFromDraft(data);
    changedManthraIdsRef.current = new Set(scope.changedManthraIds);
    requiresFullPublishRef.current = scope.requiresFullPublish;
    granthaMetaDirtyRef.current = scope.granthaMetaDirty;
  }

  function resetPublishScope() {
    changedManthraIdsRef.current.clear();
    requiresFullPublishRef.current = false;
    granthaMetaDirtyRef.current = false;
  }

  function markEditorUnsyncedForPublish() {
    if (viewOnly) return;
    setDraftSyncedForPublish(false);
  }

  function markEditorSyncedForPublish() {
    setDraftSyncedForPublish(true);
  }

  function markManthraContentChanged(manthraId: string) {
    if (!manthraId) return;
    changedManthraIdsRef.current.add(manthraId);
    markEditorUnsyncedForPublish();
  }

  function markRequiresFullPublish() {
    requiresFullPublishRef.current = true;
    markEditorUnsyncedForPublish();
  }

  function clearManthraFromChangedSet(manthraId: string) {
    changedManthraIdsRef.current.delete(manthraId);
  }

  function publishScopeForPayload() {
    return {
      changedManthraIds: [...changedManthraIdsRef.current],
      requiresFullPublish: requiresFullPublishRef.current,
      granthaMetaDirty: granthaMetaDirtyRef.current,
    };
  }

  const publishScopeMetaEffectSkipRef = useRef(true);
  useEffect(() => {
    if (!publishScopeReadyRef.current) return;
    if (publishScopeMetaEffectSkipRef.current) {
      publishScopeMetaEffectSkipRef.current = false;
      return;
    }
    granthaMetaDirtyRef.current = true;
    markEditorUnsyncedForPublish();
  }, [formData, teekas, otherTranslations, granthaNameTranslations, structureConfig]);

  const manthraDialogDirtyRef = useRef(false);
  const [verseLabelSyncPending, setVerseLabelSyncPending] = useState(false);
  const [editingGranthaSectionsLoading, setEditingGranthaSectionsLoading] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<{ adhyayaId: string; khandaId: string; manthraId: string; padaId?: string; title: string } | null>(null);

  useEffect(() => {
    manthraDialogDirtyRef.current = manthraDialogDirty;
  }, [manthraDialogDirty]);

  function openManthraEditor(
    ctx: {
      adhyayaId: string;
      khandaId: string;
      manthraId: string;
      padaId?: string;
      strapiDocumentId?: string;
    },
    opts?: { viewOnly?: boolean },
  ) {
    mantraFetchGenRef.current += 1;
    manthraDialogDirtyRef.current = false;
    setManthraDialogDirty(false);
    setManthraDialogViewOnly(!!opts?.viewOnly);
    const snap = adhyayasRef.current as AdhyayaNode[];
    const node = findManthraInTree(snap, ctx.adhyayaId, ctx.khandaId, ctx.manthraId, ctx.padaId);
    mantraOpenSnapshotRef.current = node
      ? {
          node: JSON.parse(JSON.stringify(node)) as ManthraNode,
          wasNewLocal: !!node._isNewLocal,
        }
      : { node: null, wasNewLocal: true };
    const needsCmsShloka =
      isPublishedStrapiDocId(ctx.strapiDocumentId) &&
      !(node && mantraNodeHasHydratedShloka(node));
    setManthraLoading(needsCmsShloka);
    setEditingManthra(ctx);
    prefetchManthraDocumentId(ctx.strapiDocumentId);
    prefetchManthraNeighbors(adhyayasRef.current as AdhyayaNode[], ctx);
  }

  function warmManthraOnHover(strapiDocumentId?: string) {
    prefetchManthraDocumentId(strapiDocumentId);
  }

  function renderManthraRowActions(params: {
    adhyayaId: string;
    khandaId: string;
    manthraId: string;
    padaId?: string;
    manthra: ManthraNode;
    testIdSuffix: string;
    onInsertAfter: () => void;
    onRemove: () => void;
  }) {
    const { adhyayaId, khandaId, manthraId, padaId, manthra, testIdSuffix, onInsertAfter, onRemove } =
      params;
    const ctx = {
      adhyayaId,
      khandaId,
      manthraId,
      padaId,
      strapiDocumentId: manthra.strapiDocumentId,
    };
    return (
      <>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-orange-600 hover:text-orange-700 dark:text-orange-400"
          onClick={() => openManthraEditor(ctx, { viewOnly: true })}
          title="View verse content"
          data-testid={`button-view-manthra-${testIdSuffix}`}
        >
          <Eye className="w-3 h-3" />
        </Button>
        {!viewOnly && (
          <>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
              onClick={() => openManthraEditor(ctx)}
              data-testid={`button-edit-manthra-${testIdSuffix}`}
              title="Edit verse content"
            >
              <Pencil className="w-3 h-3" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-blue-500 hover:text-blue-700"
              onClick={onInsertAfter}
              title={`Insert blank ${(structureConfigRef.current.leafName || "Mantra").trim() || "Mantra"} after this one`}
              data-testid={`button-insert-after-manthra-${testIdSuffix}`}
            >
              <Plus className="w-3 h-3" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive"
              onClick={onRemove}
              data-testid={`button-remove-manthra-${testIdSuffix}`}
            >
              <X className="w-3 h-3" />
            </Button>
          </>
        )}
      </>
    );
  }

  // When the mantra dialog opens for a published mantra (has strapiDocumentId),
  // fetch the live Strapi content and merge it with any portal-draft edits so
  // users always see the most complete version.
  //
  // MERGE STRATEGY (field-level): Strapi data is used as the BASE, but any
  // field that the portal draft already has non-empty content for is PRESERVED.
  // This prevents the draft's English translations (or other edits not yet
  // published to Strapi) from being silently overwritten by the Strapi fetch.
  useEffect(() => {
    if (!editingManthra) return;
    const snap = adhyayasRef.current as SnapshotAdhyaya[];
    const { adhyayaId, khandaId, manthraId, padaId } = editingManthra;
    const localNodeEarly = findManthraInTree(
      snap as AdhyayaNode[],
      adhyayaId,
      khandaId,
      manthraId,
      padaId,
    );
    // Newly inserted rows: never pull from CMS (avoids wrong verse / empty wipe).
    if (localNodeEarly?._isNewLocal) return;
    const docId = editingManthra.strapiDocumentId;
    if (!docId) return;
    // Avoid CMS fetch overwriting in-progress edits (e.g. after a wrong docId link is corrected).
    if (manthraDialogDirtyRef.current) return;
    // Portal draft: skip CMS fetch only when this verse already has local shloka content.
    if (preferPortalMantraContentRef.current) {
      const portalRich = shlokaManthraEntryRichness(localNodeEarly?.ShlokaManthraEntry);
      if (portalRich >= MANTRA_LINK_MIN_CONTENT_SCORE) {
        setManthraLoading(false);
        return;
      }
    }
    const fetchGen = mantraFetchGenRef.current;
    let cancelled = false;
    setManthraLoading(true);

    // mergeEntry and mergeTeekas are module-level functions (see top of file).

    const applyStrapiMantraToTree = (
      strapiRow: Record<string, unknown>,
      opts: { forceDocId?: string; heavyFieldsOnly?: boolean } = {},
    ) => {
      const configuredLeaf = (structureConfigRef.current.leafName || "Mantra").trim() || "Mantra";
      const strapiLabel = String(strapiRow.ShlokaManthraNumber ?? "");
      const cmsShloka = stripStubTextAndTranslationEntry(strapiRow.ShlokaManthraEntry);
      const cmsBhashyam = stripStubTextAndTranslationEntry(strapiRow.BhashyamEntry);
      const applyTitle = (mn: ManthraNode) =>
        portalMantraTitleForLeaf(mn.title, configuredLeaf, strapiLabel);
      const resolvedDocId =
        opts.forceDocId || (strapiRow.documentId as string) || docId;

      const patchManthra = (mn: ManthraNode): ManthraNode => {
        const suffixAligned = labelsShareVerseSuffix(mn.title, strapiLabel);
        if (!suffixAligned) {
          return {
            ...mn,
            title: applyTitle(mn),
          };
        }

        const localRich = shlokaManthraEntryRichness(mn.ShlokaManthraEntry);
        const remoteRich = shlokaManthraEntryRichness(cmsShloka);
        let shloka = mn.ShlokaManthraEntry;
        if (!opts.heavyFieldsOnly) {
          const preferPortalBodies = localRich >= MANTRA_LINK_MIN_CONTENT_SCORE;
          const mergedShloka = mergeEntry(mn.ShlokaManthraEntry, cmsShloka as any);
          const mergedRich = shlokaManthraEntryRichness(mergedShloka);
          if (preferPortalBodies) {
            shloka = mergedShloka ?? mn.ShlokaManthraEntry;
          } else {
            shloka =
              mergedRich >= localRich || remoteRich >= MANTRA_LINK_MIN_CONTENT_SCORE
                ? mergedShloka
                : stripStubTextAndTranslationEntry(mn.ShlokaManthraEntry) ?? mn.ShlokaManthraEntry;
          }
        } else {
          // Shloka SK/EN already came from sections/by-grantha — still merge OtherTranslations
          // (and IAST) from full CMS row. Bhashyam already did this; shloka OT was skipped before.
          const mergedShloka = mergeEntry(mn.ShlokaManthraEntry, cmsShloka as any);
          shloka = mergedShloka ?? mn.ShlokaManthraEntry;
        }

        const bhashyam = shouldImportCmsBhashyam(mn, cmsBhashyam, strapiLabel)
          ? mergeEntry(mn.BhashyamForShlokaManthra, cmsBhashyam as any)
          : mn.BhashyamForShlokaManthra;

        return {
          ...mn,
          title: applyTitle(mn),
          strapiDocumentId: resolvedDocId,
          ShlokaManthraEntry: shloka,
          BhashyamForShlokaManthra: bhashyam,
          Teekas:
            Array.isArray(strapiRow.Teekas) && (strapiRow.Teekas as unknown[]).length > 0
              ? mergeTeekas(mn.Teekas, strapiRow.Teekas as any)
              : mn.Teekas,
        };
      };

      setAdhyayas((prev) =>
        prev.map((a) => {
          if (a.id !== adhyayaId) return a;
          return {
            ...a,
            khandas: a.khandas.map((k) => {
              if (k.id !== khandaId) return k;
              if (padaId) {
                return {
                  ...k,
                  padas: (k.padas ?? []).map((p) => {
                    if (p.id !== padaId) return p;
                    return {
                      ...p,
                      manthras: p.manthras.map((mn) =>
                        mn.id !== manthraId ? mn : patchManthra(mn),
                      ),
                    };
                  }),
                };
              }
              return {
                ...k,
                manthras: k.manthras.map((mn) =>
                  mn.id !== manthraId ? mn : patchManthra(mn),
                ),
              };
            }),
          };
        }),
      );
    };

    const cfg = structureConfigRef.current;
    const localNode = localNodeEarly ?? findManthraInTree(snap as AdhyayaNode[], adhyayaId, khandaId, manthraId, padaId);
    const sectionDocId = resolveMantraSectionStrapiDocumentId(
      snap,
      adhyayaId,
      khandaId,
      padaId,
      cfg,
    );

    const granthaDocId = editingGranthaStrapiDocumentId();
    const localRich = shlokaManthraEntryRichness(localNode?.ShlokaManthraEntry);
    const hasHydratedShloka = mantraNodeHasHydratedShloka(localNode ?? {});

    const runFetch = (background: boolean) =>
      fetchManthraForGranthaEditor({
        documentId: docId,
        granthaDocId,
        sectionDocId,
        shlokaManthraNumber: localNode?.title,
        localContentScore: localRich,
        background,
        bypassCache: !background,
      });

    if (hasHydratedShloka) {
      setManthraLoading(false);
      runFetch(true)
        .then((result) => {
          if (!result || cancelled || fetchGen !== mantraFetchGenRef.current) return;
          if (manthraDialogDirtyRef.current) return;
          applyStrapiMantraToTree(result.data, {
            forceDocId: result.documentId,
            heavyFieldsOnly: true,
          });
          if (result.corrected) {
            setEditingManthra((prev) =>
              prev ? { ...prev, strapiDocumentId: result.documentId } : prev,
            );
          }
        })
        .catch(console.error);
      return () => {
        cancelled = true;
      };
    }

    runFetch(false)
      .then((result) => {
        if (!result || cancelled || fetchGen !== mantraFetchGenRef.current) return;
        if (manthraDialogDirtyRef.current) return;
        const remoteRich =
          result.contentScore ?? strapiManthraRowRichness(result.data);

        if (localRich >= MANTRA_LINK_MIN_CONTENT_SCORE && remoteRich < localRich) {
          const blockCorrection =
            structuralMantraRenumberPendingRef.current &&
            isPublishedStrapiDocId(localNode?.strapiDocumentId) &&
            result.corrected &&
            result.documentId !== localNode?.strapiDocumentId;
          if (result.corrected && !blockCorrection) {
            setEditingManthra((prev) =>
              prev ? { ...prev, strapiDocumentId: result.documentId } : prev,
            );
            setAdhyayas((prev) =>
              prev.map((a) => {
                if (a.id !== adhyayaId) return a;
                return {
                  ...a,
                  khandas: a.khandas.map((k) => {
                    if (k.id !== khandaId) return k;
                    const patchDoc = (mn: ManthraNode) =>
                      mn.id === manthraId
                        ? { ...mn, strapiDocumentId: result.documentId }
                        : mn;
                    if (padaId) {
                      return {
                        ...k,
                        padas: (k.padas ?? []).map((p) =>
                          p.id === padaId
                            ? { ...p, manthras: p.manthras.map(patchDoc) }
                            : p,
                        ),
                      };
                    }
                    return { ...k, manthras: k.manthras.map(patchDoc) };
                  }),
                };
              }),
            );
          }
          return;
        }

        if (
          !result.corrected &&
          remoteRich < MANTRA_LINK_MIN_CONTENT_SCORE &&
          localRich >= MANTRA_LINK_MIN_CONTENT_SCORE
        ) {
          return;
        }
        if (!result.corrected && remoteRich < localRich) {
          return;
        }

        const blockDocIdCorrection =
          structuralMantraRenumberPendingRef.current &&
          isPublishedStrapiDocId(localNode?.strapiDocumentId) &&
          result.corrected &&
          result.documentId !== localNode?.strapiDocumentId;

        applyStrapiMantraToTree(result.data, {
          forceDocId: blockDocIdCorrection
            ? localNode?.strapiDocumentId
            : result.documentId,
        });

        if (result.corrected && !blockDocIdCorrection) {
          setEditingManthra((prev) =>
            prev ? { ...prev, strapiDocumentId: result.documentId } : prev,
          );
          if (editingDraftId) {
            const leaf = (cfg.leafName ?? "Mantra").trim() || "Mantra";
            const cmsShloka = stripStubTextAndTranslationEntry(result.data.ShlokaManthraEntry);
            saveManthraPatchMutation.mutate({
              draftId: editingDraftId,
              title: formDataRef.current.GranthaName || "Grantha",
              adhyayaId,
              khandaId,
              padaId,
              manthraId,
              manthraData: {
                ...(localNode ?? { id: manthraId, title: "", order: 0 }),
                strapiDocumentId: result.documentId,
                title: portalMantraTitleForLeaf(
                  localNode?.title ?? "",
                  leaf,
                  String(result.data.ShlokaManthraNumber ?? ""),
                ),
                ShlokaManthraEntry: mergeEntry(localNode?.ShlokaManthraEntry, cmsShloka as any),
                BhashyamForShlokaManthra: mergeEntry(
                  localNode?.BhashyamForShlokaManthra,
                  stripStubTextAndTranslationEntry(result.data.BhashyamEntry) as any,
                ),
              },
            });
          }
          toast({
            title: "Mantra link corrected",
            description:
              "Linked to the CMS row with content for this verse. Mantras tab uses the same rule when duplicates exist.",
          });
        }
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setManthraLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Do not depend on strapiDocumentId — correcting the link must not re-fetch and wipe the editor.
  }, [
    editingManthra?.adhyayaId,
    editingManthra?.khandaId,
    editingManthra?.padaId,
    editingManthra?.manthraId,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset dirty flag when opening a different mantra (openManthraEditor also clears this).
  useEffect(() => {
    if (editingManthra) {
      setManthraDialogDirty(false);
      manthraDialogDirtyRef.current = false;
    }
  }, [editingManthra?.adhyayaId, editingManthra?.khandaId, editingManthra?.padaId, editingManthra?.manthraId]);

  // Data
  const { data, isLoading } = useQuery<StrapiResponse<StrapiGrantha>>({
    queryKey: ["/api/strapi", "granthas"],
    refetchInterval: STRAPI_POLL_INTERVAL,
    refetchOnWindowFocus: true,
  });

  const {
    drafts: allGranthaDrafts,
    unpublishedDrafts,
    isLoadingDrafts,
    saveDraft,
    publishDraft,
    publishProgress,
    deleteDraft,
    recoverDraft,
  } = useDrafts("granthas");

  useEffect(() => {
    publishInProgressRef.current = publishDraft.isPending;
  }, [publishDraft.isPending]);

  const saveManthraPatchMutation = useMutation({
    mutationFn: async (params: {
      draftId: number;
      title: string;
      adhyayaId: string;
      khandaId: string;
      padaId?: string;
      manthraId: string;
      manthraData: ManthraNode;
    }) => {
      const res = await apiRequest("PATCH", `/api/drafts/${params.draftId}/manthra`, params);
      return res.json();
    },
    onSuccess: (_data, params) => {
      markManthraContentChanged(params.manthraId);
      const docId = params.manthraData.strapiDocumentId;
      if (isPublishedStrapiDocId(docId)) invalidateManthraCache(docId);
    },
  });

  const deleteStrapiMutation = useMutation({
    mutationFn: async (documentId: string) => {
      const res = await apiRequest("DELETE", `/api/strapi/granthas/${documentId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "granthas"] });
      setDeleteTarget(null);
      toast({ title: "Grantha deleted" });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  // Grantha locks
  const { data: locksData } = useQuery<any[]>({
    queryKey: ["/api/granthas/locks"],
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
  });

  const lockedDocIds = new Set<string>((locksData ?? []).map((l: any) => l.granthaDocId));

  // All teekas in the system — used in the "Link Existing Teeka" dropdown
  const { data: allTeekasData } = useQuery<StrapiResponse<StrapiTeeka>>({
    queryKey: ["/api/strapi/teekas"],
    refetchOnWindowFocus: false,
  });
  const allStrapiTeekas: StrapiTeeka[] = (allTeekasData?.data ?? []) as StrapiTeeka[];

  const lockMutation = useMutation({
    mutationFn: async ({ docId, granthaName }: { docId: string; granthaName?: string }) => {
      const res = await apiRequest("POST", `/api/admin/granthas/${docId}/lock`, { granthaName });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to lock");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/granthas/locks"] });
      toast({ title: "Grantha locked", description: "Editing is now blocked for all users." });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  const unlockMutation = useMutation({
    mutationFn: async (docId: string) => {
      const res = await apiRequest("DELETE", `/api/admin/granthas/${docId}/lock`);
      if (!res.ok) throw new Error((await res.json()).message || "Failed to unlock");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/granthas/locks"] });
      toast({ title: "Grantha unblocked", description: "Editing is now allowed." });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  const isAdmin = user?.role === "admin";
  const { vocabulary } = usePortalVocabulary();
  const addSharedOptionMutation = useMutation({
    mutationFn: async (params: { key: PortalVocabularyKey; value: string }) => {
      const res = await apiRequest("POST", "/api/admin/cms/vocabulary", params);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cms/vocabulary"] });
    },
  });

  const withCurrentSelection = (options: string[], current: string | undefined) => {
    const cur = (current ?? "").trim();
    if (!cur) return options;
    if (options.some((o) => o.toLowerCase() === cur.toLowerCase())) return options;
    return [...options, cur];
  };

  const levelOneOptions = withCurrentSelection(
    vocabulary.structureLevelOneNames,
    structureConfig.levelOneName,
  );
  const levelTwoOptions = withCurrentSelection(
    vocabulary.structureLevelTwoNames,
    structureConfig.levelTwoName,
  );
  const levelThreeOptions = withCurrentSelection(
    vocabulary.structureLevelThreeNames,
    structureConfig.levelThreeName,
  );
  const leafNameOptions = withCurrentSelection(vocabulary.structureLeafNames, structureConfig.leafName);
  const bhashyamAuthorOptions = withCurrentSelection(
    vocabulary.bhashyamAuthors,
    formData.BhashyamAuthor,
  );

  const updateSharedOptionDraft = (key: PortalVocabularyKey, value: string) => {
    setNewSharedOption((prev) => ({ ...prev, [key]: value }));
  };

  const addSharedOption = async (
    key: PortalVocabularyKey,
    onApply?: (value: string) => void,
  ) => {
    const value = (newSharedOption[key] ?? "").trim();
    if (!value) {
      toast({ variant: "destructive", title: "Enter a value first" });
      return;
    }
    try {
      setAddingSharedOptionKey(key);
      await addSharedOptionMutation.mutateAsync({ key, value });
      updateSharedOptionDraft(key, "");
      onApply?.(value);
      toast({ title: "Added to shared list", description: `"${value}" is now available to all users.` });
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Could not add option",
        description: err?.message || "Please try again.",
      });
    } finally {
      setAddingSharedOptionKey(null);
    }
  };

  const publishChangedMantrasMutation = useMutation({
    mutationFn: async (params: {
      draftId: number;
      mantras: Array<{ adhyayaId: string; khandaId: string; padaId?: string; manthraId: string }>;
    }) => {
      const res = await apiRequest("POST", `/api/drafts/${params.draftId}/publish-manthras-batch`, {
        mantras: params.mantras,
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      const published = (data?.published ?? []) as Array<{ manthraId: string; strapiDocumentId?: string }>;
      for (const row of published) {
        if (row.strapiDocumentId) {
          clearManthraFromChangedSet(row.manthraId);
          invalidateManthraCache(row.strapiDocumentId);
        }
      }
      resetPublishScope();
      syncGranthaCmsCaches(queryClient);
      const failCount = data?.failureCount ?? 0;
      toast({
        title: "Changed verses published",
        description:
          failCount > 0
            ? `Published ${published.length} verse(s); ${failCount} failed. Use full Save & Publish to sync structure or metadata.`
            : `Published ${published.length} verse(s) to CMS. Other verses were not updated.`,
      });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Verse publish failed", description: err.message });
    },
  });

  // Per-manthra publish mutation
  const pollMantraPublishJob = async (
    draftId: number,
    jobId: string,
    onProgress?: (current: string) => void,
  ) => {
    const maxAttempts = 1200; // up to ~20 minutes for large OT/teeka payloads
    let authFailures = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const delayMs = attempt < 40 ? 500 : 1000;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const statusRes = await fetch(
          `/api/drafts/${draftId}/publish-status?jobId=${encodeURIComponent(jobId)}`,
          { credentials: "include", cache: "no-store" },
        );
        if (statusRes.status === 401) {
          authFailures += 1;
          if (authFailures >= 8) {
            throw new Error(
              "Session could not be verified while mantra publish was running. Your draft is saved — wait a few seconds and publish again without closing this tab.",
            );
          }
          continue;
        }
        authFailures = 0;
        if (!statusRes.ok) continue;
        const status = await statusRes.json();
        const current =
          typeof status.progress?.current === "string" ? status.progress.current : undefined;
        if (current) onProgress?.(current);
        if (status.status === "done") return status.result;
        if (status.status === "failed" || status.status === "failed_recoverable") {
          throw new Error(status.error || "Mantra publish failed");
        }
      } catch (pollErr: unknown) {
        const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
        if (msg && !msg.includes("fetch")) throw pollErr;
      }
    }
    throw new Error(
      "Mantra publish is taking longer than expected. It may still complete on the server — refresh and check Strapi before republishing.",
    );
  };

  const publishMantraMutation = useMutation({
    mutationFn: async (params: {
      draftId: number;
      adhyayaId: string;
      khandaId: string;
      padaId?: string;
      manthraId: string;
      manthraData: ManthraNode;
    }) => {
      setMantraPublishStatus("Starting publish…");
      const res = await apiRequest("POST", `/api/drafts/${params.draftId}/publish-manthra`, {
        adhyayaId: params.adhyayaId,
        khandaId: params.khandaId,
        padaId: params.padaId,
        manthraId: params.manthraId,
        manthraData: params.manthraData,
      });
      const data = await res.json();
      if (data.async && data.jobId) {
        return pollMantraPublishJob(params.draftId, data.jobId, (current) => {
          setMantraPublishStatus(current);
        });
      }
      return data;
    },
    onSuccess: (data: any, params) => {
      clearManthraFromChangedSet(params.manthraId);
      const priorDocId = params.manthraData.strapiDocumentId;
      if (isPublishedStrapiDocId(priorDocId)) invalidateManthraCache(priorDocId);
      if (data.strapiDocumentId) {
        if (
          isPublishedStrapiDocId(data.strapiDocumentId) &&
          data.strapiDocumentId !== priorDocId
        ) {
          invalidateManthraCache(data.strapiDocumentId);
        }
        updateManthraContent(
          params.adhyayaId,
          params.khandaId,
          params.manthraId,
          { strapiDocumentId: data.strapiDocumentId, _isNewLocal: false },
          params.padaId,
          { markDirty: false }
        );
      }
      setPendingCloseManthra(false);
      const warnCount = data.warnings?.length ?? 0;
      track("manthra_published", {
        grantha_name: formData.GranthaName,
        warnings: warnCount,
      });
      invalidateGranthaCmsCaches(queryClient);
      toast({
        title: "Mantra published to CMS",
        description:
          warnCount > 0
            ? `${warnCount} warning(s) — saved under "${findManthraInTree(adhyayasRef.current, params.adhyayaId, params.khandaId, params.manthraId, params.padaId)?.title ?? "this label"}" in Strapi.`
            : "This verse is live in Strapi.",
      });
      setEditingManthra(null);
    },
    onError: (err: any) => {
      track("manthra_publish_failed", { grantha_name: formData.GranthaName, error: err.message });
      toast({ variant: "destructive", title: "Publish failed", description: err.message });
    },
    onSettled: () => {
      setMantraPublishStatus(null);
    },
  });

  // ---------- Helpers ----------

  const EMPTY_FORM = {
    GranthaName: "",
    GranthaType: "",
    BhashyamName: "",
    BhashyamAuthor: "",
    IntroductionToTextEnglish: [] as StrapiBlock[],
    BhashyakaraIntroductionSanskrit: [] as StrapiBlock[],
    BhashyakaraIntroductionEnglish: [] as StrapiBlock[],
    BhashyakaraIntroductionIAST: [] as StrapiBlock[],
    slug: "",
    order: "",
    introVideoId: "",
    introVideoTitle: "",
  };

  const DEFAULT_STRUCTURE = {
    levelOneEnabled: true,
    levelOneName: "Adhyaya",
    levelTwoEnabled: true,
    levelTwoName: "Khanda",
    levelThreeEnabled: false,
    levelThreeName: "Pada",
    leafName: "Mantra",
  };

  // "Khanda" was mistakenly included as a leaf-name option in older versions.
  // When a draft was saved with leafName:"Khanda", migrate it to "Mantra" on load
  // and rename any manthra titles that already start with "Khanda ".
  function migrateStructureConfig(raw: any) {
    const cfg = raw || DEFAULT_STRUCTURE;
    if (cfg.leafName === "Khanda") return { ...cfg, leafName: "Mantra" };
    return cfg;
  }

  function migrateHierarchyLeafName(hierarchy: any[], oldLeaf: string, newLeaf: string) {
    if (!hierarchy?.length || oldLeaf === newLeaf) return hierarchy;
    const prefix = oldLeaf + " ";
    function rename(m: any) {
      if (typeof m.title === "string" && m.title.startsWith(prefix))
        return { ...m, title: newLeaf + " " + m.title.slice(prefix.length) };
      return m;
    }
    return hierarchy.map((a: any) => ({
      ...a,
      khandas: (a.khandas || []).map((k: any) => ({
        ...k,
        manthras: (k.manthras || []).map(rename),
        padas: (k.padas || []).map((p: any) => ({ ...p, manthras: (p.manthras || []).map(rename) })),
      })),
    }));
  }

  function resetForm() {
    cancelGranthaMantraPrefetch();
    invalidateManthraCache();
    publishScopeReadyRef.current = false;
    resetPublishScope();
    setFormData(EMPTY_FORM);
    setTeekas([]);
    setOtherTranslations([]);
    setGranthaNameTranslations([]);
    setStructureConfig(DEFAULT_STRUCTURE);
    setAdhyayas([]);
    setEditingDraftId(null);
    setDraftSyncedForPublish(false);
    setEditingItem(null);
    preferPortalMantraContentRef.current = false;
    structuralMantraRenumberPendingRef.current = false;
    pendingMantraSyncRef.current = { manthraIds: new Set(), renumber: false, ctx: null };
    setViewOnly(false);
    setDeletedStrapiSectionDocIds([]);
    setDeletedStrapiManthraDocIds([]);
    setDeletedStrapiTeekaDocIds([]);
  }

  function openAdd() {
    resetForm();
    setStep(1);
    setView("form");
  }

  async function openEdit(item: any) {
    cancelGranthaMantraPrefetch();
    invalidateManthraCache();
    const openEditLoadGen = ++openEditLoadGenRef.current;
    publishScopeReadyRef.current = false;
    publishScopeMetaEffectSkipRef.current = true;
    setDraftSyncedForPublish(false);
    let loadedDraftId: number | null = null;
    let publishScopeDraftData: unknown = item._draftData;
    const granthaDocId = item.documentId || item._strapiDocId;
    const isItemLocked = !!(granthaDocId && lockedDocIds.has(granthaDocId));

    track("grantha_editor_opened", {
      grantha_name: item.GranthaName || item._draftData?.GranthaName || item.title || "(unknown)",
      grantha_type: item.GranthaType || item._draftData?.GranthaType || "",
      is_draft: !!item._isDraft,
      has_strapi_link: !!granthaDocId,
      is_locked: isItemLocked,
    });
    setEditingItem(item);

    // If this grantha is locked, open in view-only mode
    if (isItemLocked) {
      setViewOnly(true);
    }

    // New drafts with no Strapi link: use draft hierarchy directly and return early.
    if (item._isDraft && !item._strapiDocId) {
      loadedDraftId = item._draftId;
      setEditingDraftId(item._draftId);
      const d = item._draftData as any;
      setFormData({
        GranthaName: d.GranthaName || "",
        GranthaType: d.GranthaType || "",
        BhashyamName: d.BhashyamName || "",
        BhashyamAuthor: d.BhashyamAuthor || "",
        IntroductionToTextEnglish: d.IntroductionToTextEnglish || [],
        BhashyakaraIntroductionSanskrit: d.BhashyakaraIntroduction?.SanskritTextEntry || [],
        BhashyakaraIntroductionEnglish: d.BhashyakaraIntroduction?.EnglishTranslationText || [],
        BhashyakaraIntroductionIAST: d.BhashyakaraIntroduction?.IASTTransliteration || [],
        slug: d.slug || "",
        order: d.order != null ? String(d.order) : "",
        introVideoId: d.introVideoId || "",
        introVideoTitle: d.introVideoTitle || "",
      });
      setTeekas(d.teekas || []);
      setOtherTranslations(
        (d.otherTranslations || []).map((t: any) => ({
          ...t,
          text: t.text || [],
        }))
      );
      setGranthaNameTranslations(d.granthaNameTranslations || []);
      setDeletedStrapiTeekaDocIds(
        Array.isArray(d.deletedStrapiTeekaDocIds) ? d.deletedStrapiTeekaDocIds : []
      );
      const rawCfg1 = d.structureConfig;
      const migratedCfg1 = migrateStructureConfig(rawCfg1);
      const rawHier1 = d.hierarchy || [];
      const hier1 =
        rawCfg1?.leafName === "Khanda" ? migrateHierarchyLeafName(rawHier1, "Khanda", "Mantra") : rawHier1;
      const prep1 = prepareHierarchyForContentStep(hier1, migratedCfg1);
      if (prep1.sectionDocIdsToMarkDeleted.length > 0) {
        setDeletedStrapiSectionDocIds((prev) => Array.from(new Set([...prev, ...prep1.sectionDocIdsToMarkDeleted])));
      }
      setStructureConfig(migratedCfg1);
      setAdhyayas(withNormalizedHierarchy(prep1.hierarchy as AdhyayaNode[], migratedCfg1));
      applyPublishScopeFromDraft(d);
      publishScopeMetaEffectSkipRef.current = true;
      publishScopeReadyRef.current = true;
      if (loadedDraftId != null) markEditorSyncedForPublish();
      preferPortalMantraContentRef.current = true;
      setStep(1);
      setView("form");
      return;
    }

    // All other cases — Strapi items AND local drafts linked to a Strapi grantha —
    // need section fetch + hierarchy enrichment. Declare shared variables up front.
    let rawCfg2: any = null;
    let rawHierForEnrich: AdhyayaNode[] = [];
    let hasSavedTeekas = false;
    let hasInlineTeekas = false;
    // Local copy used synchronously by enrichHierarchy (React state updates are async).
    let localDeletedSectionDocIds: string[] = [];
    // Local copy of deleted manthra docIds — used synchronously inside enrichHierarchy.
    let localDeletedManthraDocIds: string[] = [];
    // Local copy: Strapi Teeka documentIds removed in Teeka Management — skip Strapi supplement.
    let localDeletedTeekaDocIds: string[] = [];
    // Bhashyakara / grantha-name translations: merged after Strapi grantha fetch (Strapi base + draft overlay).
    let mergeDraftOther: OtherTranslationEntry[] = [];
    let mergeDraftName: GranthaNameTranslationEntry[] = [];
    let mergeStrapiBHForFallback: any = undefined;
    let mergeStrapiGTForFallback: any[] | undefined = undefined;

    if (item._isDraft) {
      // Local draft that is editing an existing Strapi grantha.
      loadedDraftId = item._draftId;
      setEditingDraftId(item._draftId);
      const d = item._draftData as any;
      setFormData({
        GranthaName: d.GranthaName || "",
        GranthaType: d.GranthaType || "",
        BhashyamName: d.BhashyamName || "",
        BhashyamAuthor: d.BhashyamAuthor || "",
        IntroductionToTextEnglish: d.IntroductionToTextEnglish || [],
        BhashyakaraIntroductionSanskrit: d.BhashyakaraIntroduction?.SanskritTextEntry || [],
        BhashyakaraIntroductionEnglish: d.BhashyakaraIntroduction?.EnglishTranslationText || [],
        BhashyakaraIntroductionIAST: d.BhashyakaraIntroduction?.IASTTransliteration || [],
        slug: d.slug || "",
        order: d.order != null ? String(d.order) : "",
        introVideoId: d.introVideoId || "",
        introVideoTitle: d.introVideoTitle || "",
      });
      setTeekas(d.teekas || []);
      mergeDraftOther = (d.otherTranslations || []).map((t: any) => ({
        ...t,
        text: t.text || [],
      }));
      mergeDraftName = d.granthaNameTranslations || [];
      rawCfg2 = d.structureConfig;
      rawHierForEnrich = d.hierarchy || [];
      if (Array.isArray(d.deletedStrapiSectionDocIds) && d.deletedStrapiSectionDocIds.length > 0) {
        localDeletedSectionDocIds = d.deletedStrapiSectionDocIds;
        setDeletedStrapiSectionDocIds(d.deletedStrapiSectionDocIds);
      }
      if (Array.isArray(d.deletedStrapiManthraDocIds) && d.deletedStrapiManthraDocIds.length > 0) {
        localDeletedManthraDocIds = d.deletedStrapiManthraDocIds;
        setDeletedStrapiManthraDocIds(d.deletedStrapiManthraDocIds);
      }
      if (Array.isArray(d.deletedStrapiTeekaDocIds) && d.deletedStrapiTeekaDocIds.length > 0) {
        localDeletedTeekaDocIds = d.deletedStrapiTeekaDocIds;
        setDeletedStrapiTeekaDocIds(d.deletedStrapiTeekaDocIds);
      } else {
        setDeletedStrapiTeekaDocIds([]);
      }
      // Only block the Strapi fetch when the draft actually has teekas configured.
      // An empty array means teekas were never set in this draft — fall through to fetch.
      hasSavedTeekas = Array.isArray(d.teekas) && d.teekas.length > 0;
      hasInlineTeekas = false;
    } else {
      // Look up any saved portal draft for this Strapi entry (including already-published ones)
      // to restore structureConfig and hierarchy which aren't stored in Strapi.
      // In-progress overlay only — published snapshot drafts must not mask live Strapi.
      const matchingDraft = allGranthaDrafts.find(
        (d) => d.strapiDocumentId === item.documentId && d.status !== "published",
      );
      const savedData = matchingDraft?.data as any;
      publishScopeDraftData = savedData ?? item._draftData;

      loadedDraftId = matchingDraft?.id ?? null;
      setEditingDraftId(loadedDraftId);

      // For each field: prefer saved portal draft value (already in portal format)
      // and fall back to Strapi data (which needs mapping) when draft has nothing.
      const hasDraft = !!savedData;

      setFormData({
        GranthaName: item.GranthaName || "",
        GranthaType: item.GranthaType || "",
        BhashyamName: item.BhashyamName || "",
        BhashyamAuthor: item.BhashyamAuthor || "",
        // Rich text: prefer draft blocks (portal format) if present, else Strapi
        IntroductionToTextEnglish:
          hasBlocks(savedData?.IntroductionToTextEnglish)
            ? savedData.IntroductionToTextEnglish
            : item.IntroductionToTextEnglish || [],
        BhashyakaraIntroductionSanskrit:
          hasBlocks(savedData?.BhashyakaraIntroductionSanskrit)
            ? savedData.BhashyakaraIntroductionSanskrit
            : item.BhashyakaraIntroduction?.SanskritTextEntry || [],
        BhashyakaraIntroductionEnglish:
          hasBlocks(savedData?.BhashyakaraIntroductionEnglish)
            ? savedData.BhashyakaraIntroductionEnglish
            : item.BhashyakaraIntroduction?.EnglishTranslationText || [],
        BhashyakaraIntroductionIAST:
          hasBlocks(savedData?.BhashyakaraIntroductionIAST)
            ? savedData.BhashyakaraIntroductionIAST
            : item.BhashyakaraIntroduction?.IASTTransliteration || [],
        slug: item.slug || "",
        order: item.order != null ? String(item.order) : "",
        introVideoId: item.introVideoId || "",
        introVideoTitle: item.introVideoTitle || "",
      });

      mergeDraftOther =
        hasDraft && Array.isArray(savedData.otherTranslations)
          ? savedData.otherTranslations.map((t: any) => ({
              id: t.id || uid(),
              language: t.language || "",
              text: t.text || [],
            }))
          : [];
      mergeDraftName =
        hasDraft && Array.isArray(savedData.granthaNameTranslations)
          ? savedData.granthaNameTranslations.map((t: any) => ({
              id: t.id || uid(),
              language: t.language || "",
              name: t.name || "",
            }))
          : [];
      mergeStrapiBHForFallback = item.BhashyakaraIntroduction;
      mergeStrapiGTForFallback = item.GranthaNameTranslations;

      rawCfg2 = savedData?.structureConfig;
      rawHierForEnrich = savedData?.hierarchy || [];
      if (Array.isArray(savedData?.deletedStrapiSectionDocIds) && savedData.deletedStrapiSectionDocIds.length > 0) {
        localDeletedSectionDocIds = savedData.deletedStrapiSectionDocIds;
        setDeletedStrapiSectionDocIds(savedData.deletedStrapiSectionDocIds);
      }
      if (Array.isArray(savedData?.deletedStrapiManthraDocIds) && savedData.deletedStrapiManthraDocIds.length > 0) {
        localDeletedManthraDocIds = savedData.deletedStrapiManthraDocIds;
        setDeletedStrapiManthraDocIds(savedData.deletedStrapiManthraDocIds);
      }
      if (Array.isArray(savedData?.deletedStrapiTeekaDocIds) && savedData.deletedStrapiTeekaDocIds.length > 0) {
        localDeletedTeekaDocIds = savedData.deletedStrapiTeekaDocIds;
        setDeletedStrapiTeekaDocIds(savedData.deletedStrapiTeekaDocIds);
      } else {
        setDeletedStrapiTeekaDocIds([]);
      }
      hasSavedTeekas = Array.isArray(savedData?.teekas) && savedData.teekas.length > 0;
      hasInlineTeekas = Array.isArray(item.teekas) && item.teekas.length > 0;
      // Set teekas synchronously when available; otherwise they'll be fetched below.
      if (hasSavedTeekas) {
        setTeekas(savedData.teekas);
      } else if (hasInlineTeekas) {
        const teekaDel = new Set(localDeletedTeekaDocIds);
        setTeekas(
          item.teekas
            .filter((t: any) => {
              const docId =
                t.documentId || (typeof t.id === "string" && t.id.length >= 10 ? t.id : "");
              return !docId || !teekaDel.has(docId);
            })
            .map((t: any) => ({
              id: t.documentId || (typeof t.id === "string" && t.id.length >= 10 ? t.id : uid()),
              TeekaName: t.TeekaName || "",
              TeekaAuthor: t.TeekaAuthor || "",
            }))
        );
      }
    }

    const preferPortalMantraContent =
      !!item._isDraft ||
      (!!loadedDraftId &&
        Array.isArray(rawHierForEnrich) &&
        rawHierForEnrich.length > 0);
    preferPortalMantraContentRef.current = preferPortalMantraContent;

    // Shared for all cases: Strapi items AND local drafts linked to Strapi.
    let effectiveStructureConfig = migrateStructureConfig(rawCfg2);
    const effectiveDocId = item._isDraft ? item._strapiDocId : item.documentId;

    // Show saved hierarchy immediately while CMS sections load in the background.
    if (rawHierForEnrich.length > 0 && isCurrentOpenEditLoad(openEditLoadGen)) {
      let hierEarly = rawHierForEnrich;
      if (rawCfg2?.leafName === "Khanda") {
        hierEarly = migrateHierarchyLeafName(hierEarly, "Khanda", "Mantra");
      }
      const leafEarly = (effectiveStructureConfig.leafName || "Mantra").trim() || "Mantra";
      for (const oldPrefix of ["Mantra", "Manthra", "Khanda"] as const) {
        if (oldPrefix !== leafEarly) {
          hierEarly = migrateHierarchyLeafName(hierEarly, oldPrefix, leafEarly);
        }
      }
      const prepEarly = prepareHierarchyForContentStep(hierEarly, effectiveStructureConfig);
      if (prepEarly.sectionDocIdsToMarkDeleted.length > 0) {
        setDeletedStrapiSectionDocIds((prev) =>
          Array.from(new Set([...prev, ...prepEarly.sectionDocIdsToMarkDeleted])),
        );
      }
      setStructureConfig(effectiveStructureConfig);
      setAdhyayas(
        hierarchyForSave(prepEarly.hierarchy as AdhyayaNode[], effectiveStructureConfig),
      );
      setStep(1);
      setView("form");
    }

    // Fetch sections + teekas in parallel.
    // Always fetch teekas from Strapi so new ones added after the last draft save are picked up.
    if (isCurrentOpenEditLoad(openEditLoadGen)) {
      setEditingGranthaSectionsLoading(true);
    }
    let fetchedSections: any[] = [];
    let strapiGranthaOne: any = null;
    try {
      const [sectionsRes, teekasRes, granthaRes] = await Promise.all([
        fetch(`/api/strapi/sections/by-grantha/${effectiveDocId}`, CMS_FETCH_INIT),
        fetch(`/api/strapi/teekas/by-grantha/${effectiveDocId}`, CMS_FETCH_INIT),
        fetch(`/api/strapi/granthas/${effectiveDocId}`, CMS_FETCH_INIT),
      ]);

      if (granthaRes.ok) {
        try {
          const gj = await granthaRes.json();
          strapiGranthaOne = gj?.data ?? null;
        } catch {
          strapiGranthaOne = null;
        }
      }

      if (sectionsRes.ok) {
        const sectionsData = await sectionsRes.json();
        fetchedSections = sectionsData?.data || [];
      }

      if (teekasRes?.ok && isCurrentOpenEditLoad(openEditLoadGen)) {
        const teekasData = await teekasRes.json();
        const strapiTeekas: any[] = teekasData?.data || [];

        if (!hasSavedTeekas && !hasInlineTeekas) {
          // No draft teekas at all — use Strapi list directly (minus rows user removed from management).
          const teekaDeletedSet = new Set(localDeletedTeekaDocIds);
          setTeekas(
            strapiTeekas
              .filter((t: any) => !t.documentId || !teekaDeletedSet.has(t.documentId))
              .map((t: any) => ({
                id: t.documentId || uid(),
                TeekaName: t.TeekaName || "",
                TeekaAuthor: t.TeekaAuthor || "",
              }))
          );
        } else {
          // Draft already has teekas — supplement with any new ones added to Strapi since last save.
          // Preserve draft teeka order/data; append only teekas not already present (match by TeekaName or documentId).
          // Never re-append teekas the user explicitly removed (deletedStrapiTeekaDocIds).
          setTeekas((prev) => {
            const teekaDeletedSet = new Set(localDeletedTeekaDocIds);
            const existingNames = new Set(prev.map((t) => (t.TeekaName || "").trim().toLowerCase()));
            const existingDocIds = new Set(prev.map((t) => t.id));
            const newTeekas = strapiTeekas
              .filter((t: any) => {
                if (t.documentId && teekaDeletedSet.has(t.documentId)) return false;
                const name = (t.TeekaName || "").trim().toLowerCase();
                const docId = t.documentId || "";
                return !existingDocIds.has(docId) && !existingNames.has(name);
              })
              .map((t: any) => ({
                id: t.documentId || uid(),
                TeekaName: t.TeekaName || "",
                TeekaAuthor: t.TeekaAuthor || "",
              }));
            return newTeekas.length > 0 ? [...prev, ...newTeekas] : prev;
          });
        }
      } else if (!hasSavedTeekas && !hasInlineTeekas && isCurrentOpenEditLoad(openEditLoadGen)) {
        setTeekas([]);
      }
    } catch (e) {
      console.warn("[granthas] openEdit: sections/teekas/grantha fetch failed:", e);
      if (isCurrentOpenEditLoad(openEditLoadGen)) {
        if (!hasSavedTeekas && !hasInlineTeekas) setTeekas([]);
        setEditingGranthaSectionsLoading(false);
      }
    }

    if (!isCurrentOpenEditLoad(openEditLoadGen)) {
      return;
    }

    const bhMergeSource = strapiGranthaOne?.BhashyakaraIntroduction ?? mergeStrapiBHForFallback;
    const gtMergeSource = strapiGranthaOne?.GranthaNameTranslations ?? mergeStrapiGTForFallback;
    setOtherTranslations(mergeBhashyakaraPortalOtherTranslations(mergeDraftOther, bhMergeSource));
    setGranthaNameTranslations(mergeGranthaNameTranslationsPortal(mergeDraftName, gtMergeSource));

    // Hierarchy: prefer portal draft (or linked-draft hierarchy); fall back to reconstructing from Strapi sections.
    const hierToUse2 =
      rawHierForEnrich.length > 0
        ? rawHierForEnrich
        : reconstructHierarchyFromStrapi(fetchedSections, effectiveStructureConfig.leafName);

      // Auto-detect flat granthas (no real khanda level).
      // When every adhyaya has exactly one "_default" synthetic khanda, this grantha
      // has no actual sub-section tier — disable levelTwo so manthras render directly
      // under their adhyaya. This covers both fresh loads (no draft) and old drafts
      // that were saved before this auto-detection was added.
      if (hierToUse2.length > 0) {
        const strapiHasKhandaLevel = strapiGranthaHasKhandaSections(fetchedSections);
        const isFlat = hierToUse2.every(
          (a) => a.khandas.length === 1 && a.khandas[0]?.title === "_default",
        );
        // Only treat as flat when Strapi also has no child sections — otherwise mantras get
        // published onto the adhyaya documentId and the Mantras tab shows "Adhyaya → mantras".
        if (isFlat && !strapiHasKhandaLevel && effectiveStructureConfig.levelTwoEnabled) {
          effectiveStructureConfig = { ...effectiveStructureConfig, levelTwoEnabled: false };
        }
        if (strapiHasKhandaLevel && !effectiveStructureConfig.levelTwoEnabled) {
          effectiveStructureConfig = { ...effectiveStructureConfig, levelTwoEnabled: true };
        }

        // Auto-detect 3-level granthas (e.g. Brahma Sutra: Adhyaya → Pada → Adhikarana).
        // When any khanda has non-empty padas, enable levelThree so they render correctly.
        const hasPadas = hierToUse2.some((a) =>
          a.khandas.some((k) => (k.padas?.length ?? 0) > 0)
        );
        if (hasPadas && !effectiveStructureConfig.levelThreeEnabled) {
          effectiveStructureConfig = { ...effectiveStructureConfig, levelThreeEnabled: true };
        }

        // Auto-detect L2/L3 display names from section titles when the saved config
        // still has the defaults ("Khanda" / "Pada"). This handles older drafts that
        // were saved before the name was chosen, and granthas loaded straight from Strapi.
        // Strategy: scan every L2 (or L3) title for known Sanskrit section-type words
        // and use the most frequently occurring one.
        const L2_KEYWORDS = ["Brahmana", "Valli", "Anuvaka", "Adhikarana", "Adhikaranam", "Varnaka", "Pada", "Sukta", "Kanda"];
        const L3_KEYWORDS = ["Pada", "Anuvaka", "Varga", "Sukta", "Adhikaranam", "Adhikarana"];

        const detectNameFromTitles = (titles: string[], keywords: string[]): string | undefined => {
          const counts = new Map<string, number>();
          for (const title of titles) {
            const words = title.split(/[\s\-–—]+/);
            for (const word of words) {
              const cap = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
              if (keywords.includes(cap)) counts.set(cap, (counts.get(cap) || 0) + 1);
            }
          }
          if (!counts.size) return undefined;
          return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
        };

        // L2 name auto-detect: only when still at default "Khanda"
        if (effectiveStructureConfig.levelTwoEnabled && effectiveStructureConfig.levelTwoName === "Khanda") {
          const l2Titles = hierToUse2
            .flatMap((a: any) => a.khandas || [])
            .filter((k: any) => k.title && k.title !== "_default")
            .map((k: any) => k.title as string);
          const detected = detectNameFromTitles(l2Titles, L2_KEYWORDS);
          if (detected) {
            effectiveStructureConfig = { ...effectiveStructureConfig, levelTwoName: detected };
          }
        }

        // L3 name auto-detect: only when still at default "Pada" and L3 is enabled
        const hasPadasForName = hierToUse2.some((a: any) =>
          (a.khandas || []).some((k: any) => (k.padas?.length ?? 0) > 0)
        );
        if (
          (effectiveStructureConfig.levelThreeEnabled || hasPadasForName) &&
          effectiveStructureConfig.levelThreeName === "Pada"
        ) {
          const l3Titles = hierToUse2
            .flatMap((a: any) => a.khandas || [])
            .flatMap((k: any) => k.padas || [])
            .filter((p: any) => p.title)
            .map((p: any) => p.title as string);
          const detected = detectNameFromTitles(l3Titles, L3_KEYWORDS);
          if (detected && detected !== "Pada") {
            effectiveStructureConfig = { ...effectiveStructureConfig, levelThreeName: detected };
          }
        }
      }

      // Build lookup maps from fetched sections so we can enrich hierarchy nodes
      // with strapiDocumentIds and supplement any Strapi mantras/sections missing from the draft.
      const strapiMantrasBySecTitle = new Map<string, StrapiMantraRef[]>();
      // DocId-based map: section documentId → its manthras (always unique, preferred over title map).
      const strapiMantrasBySecDocId = new Map<string, StrapiMantraRef[]>();
      // Map: parent section documentId → child sections (for supplementing missing khandas)
      const strapiChildSectionsByParentDocId = new Map<string, any[]>();
      // Map: section title → section (for matching draft adhyayas to Strapi adhyayas)
      const strapiSectionByTitle = new Map<string, any>();
      const shlokaIndex = buildMantraShlokaIndexFromSections(fetchedSections);
      const mantraNodeFromStrapiRef = (
        sm: { docId: string; title: string; order?: number },
        orderFallback?: number,
      ): ManthraNode =>
        hydrateManthraShlokaFromIndex(
          {
            id: uid(),
            title: sm.title,
            order: sm.order ?? orderFallback ?? 0,
            strapiDocumentId: sm.docId,
          },
          shlokaIndex,
          sm.docId,
        );

      const leafForStrapiIndex =
        (effectiveStructureConfig.leafName || "Mantra").trim() || "Mantra";
      for (const sec of fetchedSections) {
        if (sec.title) strapiSectionByTitle.set(sec.title, sec);
        if (Array.isArray(sec.manthras)) {
          const list: StrapiMantraRef[] = [];
          for (const m of sec.manthras) {
            if (!m.documentId) continue;
            const sortKey =
              typeof m.order === "number" && !Number.isNaN(m.order)
                ? m.order
                : (list.length + 1) * STRAPI_SORT_GAP;
            const title =
              (m.ShlokaManthraNumber ?? "").trim() ||
              flatMantraLabelFromSpacedSortKey(sortKey, leafForStrapiIndex) ||
              "";
            if (!title) continue;
            list.push({
              title,
              docId: m.documentId,
              order: m.order ?? 0,
              contentScore: scoreStrapiManthraRowContent(m.ShlokaManthraEntry),
            });
          }
          if (sec.title) strapiMantrasBySecTitle.set(sec.title, list);
          if (sec.documentId) strapiMantrasBySecDocId.set(sec.documentId, list);
        }
        // Index by parent documentId for section-level supplementation
        const parentDocId = sec.parent?.documentId;
        if (parentDocId) {
          if (!strapiChildSectionsByParentDocId.has(parentDocId)) strapiChildSectionsByParentDocId.set(parentDocId, []);
          strapiChildSectionsByParentDocId.get(parentDocId)!.push(sec);
        }
      }

      const childrenByParentDocId = new Map<string, { documentId: string; title?: string }[]>();
      for (const [parentId, secs] of strapiChildSectionsByParentDocId) {
        childrenByParentDocId.set(
          parentId,
          secs
            .filter((s) => typeof s.documentId === "string")
            .map((s) => ({ documentId: s.documentId as string, title: s.title })),
        );
      }
      strapiSectionIndexRef.current = { childrenByParentDocId };

      const allStrapiMantraRefs: StrapiMantraRef[] = [];
      const seenStrapiMantraDocIds = new Set<string>();
      for (const list of strapiMantrasBySecDocId.values()) {
        for (const sm of list) {
          if (seenStrapiMantraDocIds.has(sm.docId)) continue;
          seenStrapiMantraDocIds.add(sm.docId);
          allStrapiMantraRefs.push(sm);
        }
      }
      const inferredLeaf = inferLeafNameFromStrapiMantras(
        allStrapiMantraRefs,
        effectiveStructureConfig.leafName || "Mantra",
      );
      if (inferredLeaf !== (effectiveStructureConfig.leafName || "Mantra")) {
        effectiveStructureConfig = { ...effectiveStructureConfig, leafName: inferredLeaf };
      }

      // Track all shloka numbers already present in the hierarchy so we never duplicate
      function collectKnownShlokas(hier: AdhyayaNode[]): Set<string> {
        const known = new Set<string>();
        for (const a of hier) {
          for (const k of a.khandas) {
            for (const m of k.manthras) if (m.title) known.add(m.title);
            for (const p of k.padas ?? []) {
              for (const m of p.manthras) if (m.title) known.add(m.title);
            }
          }
        }
        return known;
      }

      const configuredLeafLabel =
        (effectiveStructureConfig.leafName || "Mantra").trim() || "Mantra";

      function collectKnownSuffixes(hier: AdhyayaNode[]): Set<string> {
        const titles: string[] = [];
        for (const a of hier) {
          for (const k of a.khandas) {
            for (const m of k.manthras) titles.push(m.title);
            for (const p of k.padas ?? []) {
              for (const m of p.manthras) titles.push(m.title);
            }
          }
        }
        return collectKnownVerseSuffixesForLeaf(titles, configuredLeafLabel);
      }

      function enrichHierarchy(hier: AdhyayaNode[]): AdhyayaNode[] {
        const knownShlokas = collectKnownShlokas(hier);
        const knownSuffixes = collectKnownSuffixes(hier);
        const leafLabel = configuredLeafLabel;
        // Build once at function scope so it's available in all supplement blocks.
        const deletedManthraDocIdsSet = new Set(localDeletedManthraDocIds);
        return hier.map((a, ai) => {
          // ── Enrich existing khandas ──────────────────────────────────────────────────
          // Resolve this adhyaya's Strapi documentId once (used for child-section lookup below).
          const adhyaDocId: string | undefined =
            (a as any).documentId || strapiSectionByTitle.get(a.title)?.documentId;

          const enrichedKhandas = a.khandas.map((k, ki) => {
            // Determine which Strapi section's manthras belong to this khanda node.
            // IMPORTANT: We look up by (adhyaya docId + khanda title), NOT by khanda title alone.
            // Multiple khandas across different adhyayas can share the same title, so a plain
            // title-keyed map would return manthras from the wrong adhyaya (e.g. Mundaka bug
            // where "Prathama Khanda" existed under all 3 Mundikas — the last writer won and
            // ALL three rendered Tritiya Mundaka's "Mantra 3.1.X" manthras).
            const adhyayaDocId: string | undefined = (a as any).documentId;
            const khandaDocId: string | undefined = (k as any).documentId;
            const partialSnap = [{ ...a, khandas: a.khandas }] as SnapshotAdhyaya[];
            const sectionCtx = { childrenByParentDocId: strapiChildSectionsByParentDocId };
            const resolvedSecId = resolveMantraOwnerSectionDocId(
              partialSnap,
              a.id,
              k.id,
              undefined,
              effectiveStructureConfig,
              sectionCtx,
            );
            let strapiMantrasForKhanda: StrapiMantraRef[] = [];
            if (k.title === "_default" || adhyaDocId || khandaDocId) {
              const primary = strapiMantrasForResolvedSection(
                strapiMantrasBySecDocId,
                resolvedSecId,
                adhyayaDocId,
              );
              strapiMantrasForKhanda = mergeStrapiMantraRefsForPortalMantraOwner(
                primary,
                strapiMantrasBySecDocId,
                {
                  resolvedSecId,
                  adhyayaDocId,
                  khandaTitle: k.title,
                  khandaDocId,
                  cfg: effectiveStructureConfig,
                  childrenByParentDocId: strapiChildSectionsByParentDocId,
                },
              );
            } else if (adhyaDocId) {
              const childSecs = strapiChildSectionsByParentDocId.get(adhyaDocId) ?? [];
              const matchSec =
                (khandaDocId ? childSecs.find((c: any) => c.documentId === khandaDocId) : undefined)
                ?? childSecs.find((c: any) => c.title === k.title);
              const primary = matchSec?.documentId
                ? strapiMantrasForResolvedSection(
                    strapiMantrasBySecDocId,
                    matchSec.documentId,
                    adhyaDocId,
                  )
                : [];
              strapiMantrasForKhanda = mergeStrapiMantraRefsForPortalMantraOwner(
                primary,
                strapiMantrasBySecDocId,
                {
                  resolvedSecId: matchSec?.documentId,
                  adhyayaDocId,
                  khandaTitle: k.title,
                  khandaDocId,
                  cfg: effectiveStructureConfig,
                  childrenByParentDocId: strapiChildSectionsByParentDocId,
                },
              );
            }

            const { byOrder: strapiByOrder, ambiguousOrders } = buildUniqueStrapiOrderMap(
              strapiMantrasForKhanda,
            );
            const resolveOpts = {
              configuredLeaf: leafLabel,
              sectionMantras: strapiMantrasForKhanda,
              byOrder: strapiByOrder,
              ambiguousOrders,
            };
            const matchedDocIds = new Set<string>();

            function resolveDocId(m: ManthraNode): { docId: string | undefined; strapiTitle?: string } | undefined {
              const linked = (m.strapiDocumentId ?? "").trim();
              if (isPublishedStrapiDocId(linked) && !matchedDocIds.has(linked)) {
                matchedDocIds.add(linked);
                return { docId: linked };
              }
              const resolved = resolvePortalMantraToStrapiDoc(m, {
                ...resolveOpts,
                claimedDocIds: matchedDocIds,
              });
              if (!resolved) {
                const hasLocalDraftContent = !!(
                  m.ShlokaManthraEntry ||
                  m.BhashyamForShlokaManthra ||
                  (Array.isArray(m.Teekas) &&
                    m.Teekas.some((t) => teekaEntryHasMergeableContent(t.TeekaEntry)))
                );
                if (hasLocalDraftContent) return { docId: undefined };
                return undefined;
              }
              if (resolved.docId) matchedDocIds.add(resolved.docId);
              return resolved;
            }

            const khandaDocIdResolved: string | undefined =
              khandaDocId
              ?? (adhyaDocId
                ? (strapiChildSectionsByParentDocId.get(adhyaDocId) ?? []).find(
                    (s: any) => s.title === k.title
                  )?.documentId
                : undefined);
            const strapiPadaChildCount = khandaDocIdResolved
              ? (strapiChildSectionsByParentDocId.get(khandaDocIdResolved) ?? []).length
              : 0;
            /** L3 books: mantras live on pada sections — never duplicate onto khanda.manthras. */
            const mantraRowsOnPadasOnly =
              !!effectiveStructureConfig.levelThreeEnabled &&
              ((k.padas ?? []).length > 0 || strapiPadaChildCount > 0);

            const enrichedManthras = mantraRowsOnPadasOnly
              ? []
              : k.manthras.reduce<ManthraNode[]>((acc, m) => {
              const resolved = resolveDocId(m);
              if (!resolved) {
                if (!portalManthraShouldRetainInHierarchy(m)) return acc;
                const row = prepareManthraAfterStrapiResolve(
                  m,
                  undefined,
                  shlokaIndex,
                  portalMantraTitleForLeaf(m.title, leafLabel),
                  { preferPortalContent: preferPortalMantraContent },
                );
                if (!shouldKeepManthraInEditor(row, seenStrapiMantraDocIds)) return acc;
                acc.push(row);
                return acc;
              }
              const { docId } = resolved;
              const row = prepareManthraAfterStrapiResolve(
                m,
                docId,
                shlokaIndex,
                portalMantraTitleForLeaf(m.title, leafLabel),
                { preferPortalContent: preferPortalMantraContent },
              );
              if (docId) delete row._isNewLocal;
              if (!shouldKeepManthraInEditor(row, seenStrapiMantraDocIds)) return acc;
              acc.push(row);
              return acc;
            }, []);
            // Enrich existing padas (3-level granthas: khanda → pada → manthra).
            // Prefer docId-based lookup for the pada's own section to avoid title collisions.
            // FALLBACK: if draft khanda has no stored documentId, look it up from Strapi by title
            // under the parent adhyaya — needed so the L3 supplement can find missing Adhikaranas.
            const enrichedPadas = (k.padas ?? []).map((p) => {
              // FALLBACK: if draft pada has no stored documentId, look it up from Strapi by title
              // under the parent khanda (Pada-level section) — needed for manthra supplement.
              const padaDocId: string | undefined =
                (p as any).documentId
                ?? (khandaDocIdResolved
                  ? (strapiChildSectionsByParentDocId.get(khandaDocIdResolved) ?? []).find(
                      (s: any) => s.title === p.title
                    )?.documentId
                  : undefined);
              const padaPrimary = strapiMantrasForResolvedSection(
                strapiMantrasBySecDocId,
                padaDocId,
                khandaDocIdResolved,
              );
              const padaStrapi = mergeStrapiMantraRefsForPortalMantraOwner(
                padaPrimary,
                strapiMantrasBySecDocId,
                {
                  resolvedSecId: padaDocId,
                  adhyayaDocId,
                  khandaTitle: k.title,
                  khandaDocId: khandaDocIdResolved,
                  padaDocId,
                  cfg: effectiveStructureConfig,
                  childrenByParentDocId: strapiChildSectionsByParentDocId,
                },
              );
              const { byOrder: padaByOrder, ambiguousOrders: padaAmbiguousOrders } =
                buildUniqueStrapiOrderMap(padaStrapi);
              const padaResolveOpts = {
                configuredLeaf: leafLabel,
                sectionMantras: padaStrapi,
                byOrder: padaByOrder,
                ambiguousOrders: padaAmbiguousOrders,
              };
              const padaMatchedDocIds = new Set<string>();
              const enrichedPadaManthras = p.manthras.reduce<ManthraNode[]>((acc, m) => {
                const linked = (m.strapiDocumentId ?? "").trim();
                let resolved: { docId: string | undefined } | undefined;
                if (isPublishedStrapiDocId(linked) && !padaMatchedDocIds.has(linked)) {
                  padaMatchedDocIds.add(linked);
                  resolved = { docId: linked };
                } else {
                  resolved = resolvePortalMantraToStrapiDoc(m, {
                    ...padaResolveOpts,
                    claimedDocIds: padaMatchedDocIds,
                  });
                }
                if (!resolved) {
                  if (!portalManthraShouldRetainInHierarchy(m)) return acc;
                  const row = prepareManthraAfterStrapiResolve(
                    m,
                    undefined,
                    shlokaIndex,
                    portalMantraTitleForLeaf(m.title, leafLabel),
                    { preferPortalContent: preferPortalMantraContent },
                  );
                  if (!shouldKeepManthraInEditor(row, seenStrapiMantraDocIds)) return acc;
                  acc.push(row);
                  return acc;
                }
                if (resolved.docId) padaMatchedDocIds.add(resolved.docId);
                const row = prepareManthraAfterStrapiResolve(
                  m,
                  resolved.docId,
                  shlokaIndex,
                  portalMantraTitleForLeaf(m.title, leafLabel),
                  { preferPortalContent: preferPortalMantraContent },
                );
                if (resolved.docId) delete row._isNewLocal;
                if (!shouldKeepManthraInEditor(row, seenStrapiMantraDocIds)) return acc;
                acc.push(row);
                return acc;
              }, []);
              // Supplement: Strapi manthras on this pada not yet in the local list.
              const newPadaManthras: ManthraNode[] = [];
              for (const sm of padaStrapi) {
                if (deletedManthraDocIdsSet.has(sm.docId)) continue;
                if (padaMatchedDocIds.has(sm.docId)) continue;
                if (knownShlokas.has(sm.title)) continue;
                if (!deletedManthraDocIdsSet.has(sm.docId)) {
                  newPadaManthras.push(
                    hydrateManthraShlokaFromIndex(
                      { id: uid(), title: sm.title, order: sm.order, strapiDocumentId: sm.docId },
                      shlokaIndex,
                      sm.docId,
                    ),
                  );
                  knownShlokas.add(sm.title);
                  const suf = mantraNumberSuffix(sm.title);
                  if (suf) knownSuffixes.add(suf);
                }
              }
              const finalPadaManthras = dedupeManthrasForEditor(
                enforceUniqueStrapiDocumentIdsAmongMantras(
                  [...enrichedPadaManthras, ...newPadaManthras],
                  padaStrapi,
                ),
                leafLabel,
              );
              return { ...p, manthras: finalPadaManthras };
            });
            // Supplement: Strapi padas missing from the draft (3-level granthas only).
            const padaDeletedDocIdsSet = new Set(localDeletedSectionDocIds);
            const existingPadaTitles = new Set(enrichedPadas.map((p) => p.title));
            const supplementPadas: PadaNode[] = [];
            if (khandaDocId) {
              const strapiPadaSections = (strapiChildSectionsByParentDocId.get(khandaDocId) ?? [])
                .sort((x: any, y: any) => (x.order ?? 0) - (y.order ?? 0));
              for (const padaSec of strapiPadaSections) {
                if (!padaSec.title || existingPadaTitles.has(padaSec.title)) continue;
                // Skip explicitly deleted sections — do not re-add them from Strapi
                if (padaSec.documentId && padaDeletedDocIdsSet.has(padaSec.documentId)) continue;
                const padaList = padaSec.documentId
                  ? (strapiMantrasBySecDocId.get(padaSec.documentId) ?? [])
                  : [];
                const padaManthras = padaList
                  .sort((x: any, y: any) => (x.order ?? 0) - (y.order ?? 0))
                  .map(
                    (sm: any) =>
                      hydrateManthraShlokaFromIndex(
                        {
                          id: uid(),
                          title: sm.title,
                          order: sm.order,
                          strapiDocumentId: sm.docId,
                        } as ManthraNode,
                        shlokaIndex,
                        sm.docId,
                      ) as ManthraNode,
                  );
                supplementPadas.push({ id: uid(), title: padaSec.title, order: padaSec.order ?? 0, expanded: true, documentId: padaSec.documentId || undefined, manthras: padaManthras });
              }
            }
            const finalPadas = [...enrichedPadas, ...supplementPadas].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

            // Supplement: add Strapi mantras that aren't already covered by a local node.
            const portalSuffixesPresent = new Set(
              enrichedManthras
                .map((m) => mantraNumberSuffix(m.title))
                .filter((s): s is string => !!s),
            );
            const newManthras: ManthraNode[] = [];
            if (!mantraRowsOnPadasOnly) {
            for (const sm of strapiMantrasForKhanda) {
              if (deletedManthraDocIdsSet.has(sm.docId)) continue;
              if (matchedDocIds.has(sm.docId)) continue;
              if (knownShlokas.has(sm.title)) continue;
              const smSuf = mantraNumberSuffix(sm.title);
              if (smSuf && portalSuffixesPresent.has(smSuf)) continue;
              if (
                !deletedManthraDocIdsSet.has(sm.docId)
              ) {
                newManthras.push(
                  hydrateManthraShlokaFromIndex(
                    { id: uid(), title: sm.title, order: sm.order, strapiDocumentId: sm.docId },
                    shlokaIndex,
                    sm.docId,
                  ),
                );
                knownShlokas.add(sm.title);
                const suf = mantraNumberSuffix(sm.title);
                if (suf) knownSuffixes.add(suf);
              }
            }
            }

            const khandaTitleCtx = buildMantraTitleCtx(ai, k, ki, effectiveStructureConfig);
            const hasPendingInsert = enrichedManthras.some((m) => m._isNewLocal);
            const mergedKhandaMantras = hasPendingInsert
              ? [...enrichedManthras, ...newManthras]
              : insertPlaceholderRowsForMissingSuffixGaps(
                  [...enrichedManthras, ...newManthras],
                  khandaTitleCtx,
                  uid,
                );
            const finalManthras = mantraRowsOnPadasOnly
              ? []
              : dedupeManthrasForEditor(
              enforceUniqueStrapiDocumentIdsAmongMantras(
                mergedKhandaMantras,
                strapiMantrasForKhanda,
              ),
              leafLabel,
            );
            return {
              ...k,
              manthras: finalManthras,
              padas: finalPadas,
            };
          }); // end of enrichedKhandas.map

          // ── Supplement: add Strapi khandas completely absent from the draft ─────────
          // Match this draft adhyaya to its Strapi counterpart by title, then find
          // Strapi child sections (khandas/brahmanas) that were never saved in the draft.
          // Skip any section whose Strapi docId was explicitly deleted by the user.
          const deletedDocIdsSet = new Set(localDeletedSectionDocIds);
          const existingKhandaTitles = new Set(enrichedKhandas.map((k) => k.title));
          const existingKhandaDocIds = new Set(enrichedKhandas.map((k) => (k as any).documentId).filter(Boolean));
          const aDraftDocId: string | undefined = (a as any).documentId;
          const strapiAdhyaya = strapiSectionByTitle.get(a.title)
            ?? (aDraftDocId ? fetchedSections.find((s: any) => s.documentId === aDraftDocId) : undefined);
          const supplementKhandas: KhandaNode[] = [];
          const defaultKhandaForSupplement = enrichedKhandas.find((k) => k.title === "_default");
          if (strapiAdhyaya?.documentId) {
            const strapiChildren = (strapiChildSectionsByParentDocId.get(strapiAdhyaya.documentId) ?? [])
              .sort((x: any, y: any) => (x.order ?? 0) - (y.order ?? 0));
            for (const sec of strapiChildren) {
              if (!sec.title || existingKhandaTitles.has(sec.title)) continue;
              // Also skip if already matched by documentId (handles title renames in Strapi)
              if (sec.documentId && existingKhandaDocIds.has(sec.documentId)) continue;
              // Skip explicitly deleted sections — do not re-add them from Strapi
              if (sec.documentId && deletedDocIdsSet.has(sec.documentId)) continue;
              // _default already holds mantras for this Strapi khanda — do not duplicate the tree.
              if (
                defaultKhandaForSupplement &&
                (defaultKhandaForSupplement.manthras?.length ?? 0) > 0 &&
                sec.documentId
              ) {
                const partialSnap = [{ ...a, khandas: enrichedKhandas }] as SnapshotAdhyaya[];
                const ownerSec = resolveMantraOwnerSectionDocId(
                  partialSnap,
                  a.id,
                  defaultKhandaForSupplement.id,
                  undefined,
                  effectiveStructureConfig,
                  { childrenByParentDocId: strapiChildSectionsByParentDocId },
                );
                if (ownerSec === sec.documentId) continue;
              }
              // Check if this section has level-3 sub-sections (e.g. Adhikaranams under a Pada).
              const secGrandChildren = sec.documentId
                ? (strapiChildSectionsByParentDocId.get(sec.documentId) ?? [])
                    .sort((x: any, y: any) => (x.order ?? 0) - (y.order ?? 0))
                : [];
              let supplementPadas: PadaNode[] = [];
              let supplementManthras: ManthraNode[] = [];
              if (secGrandChildren.length > 0) {
                // Level-3: this khanda's manthras live inside its sub-sections (padas).
                supplementPadas = secGrandChildren.map((gc: any) => ({
                  id: uid(),
                  title: gc.title,
                  order: gc.order ?? 0,
                  expanded: true,
                  documentId: gc.documentId || undefined,
                  manthras: (gc.documentId ? (strapiMantrasBySecDocId.get(gc.documentId) ?? []) : [])
                    .sort((x: any, y: any) => (x.order ?? 0) - (y.order ?? 0))
                    .filter((sm: any) => !deletedManthraDocIdsSet.has(sm.docId))
                    .map((sm: any) => mantraNodeFromStrapiRef(sm, sm.order)),
                } as PadaNode));
              } else {
                // Level-2: manthras live directly on this khanda section.
                const secList = sec.documentId ? (strapiMantrasBySecDocId.get(sec.documentId) ?? []) : [];
                supplementManthras = secList
                  .sort((x, y) => (x.order ?? 0) - (y.order ?? 0))
                  .filter((sm) => !deletedManthraDocIdsSet.has(sm.docId))
                  .map((sm) => mantraNodeFromStrapiRef(sm, sm.order));
              }
              supplementKhandas.push({
                id: uid(),
                title: sec.title,
                order: sec.order ?? 0,
                expanded: true,
                documentId: sec.documentId || undefined,
                padas: supplementPadas,
                manthras: supplementManthras,
              });
            }
          }

          return {
            ...a,
            khandas: [...enrichedKhandas, ...supplementKhandas].sort((x, y) => (x.order ?? 0) - (y.order ?? 0)),
          };
        }); // end of hier.map
      }
      let hierInputForEnrich = linkFlatGranthaAdhyayasToSoleStrapiSection(
        hierToUse2,
        fetchedSections,
      );
      const configuredLeaf = (effectiveStructureConfig.leafName || "Mantra").trim() || "Mantra";
      if (rawCfg2?.leafName === "Khanda") {
        hierInputForEnrich = migrateHierarchyLeafName(hierInputForEnrich, "Khanda", "Mantra");
      }
      for (const oldPrefix of ["Mantra", "Manthra", "Khanda"] as const) {
        if (oldPrefix !== configuredLeaf) {
          hierInputForEnrich = migrateHierarchyLeafName(hierInputForEnrich, oldPrefix, configuredLeaf);
        }
      }
      const hierarchyBeforeEnrich = hierInputForEnrich as AdhyayaNode[];
      const enrichedHier2 = enrichHierarchy(hierInputForEnrich);

      // ── Supplement: add top-level Strapi sections absent from the draft ──────────
      // The enrichHierarchy above only supplements missing *khandas within existing
      // adhyayas*. If the draft itself is missing entire top-level adhyayas (e.g. the
      // user published 3 more khandas in Strapi after saving a portal draft that only
      // had 1), those adhyayas are never shown. Fix: append them here.
      const topLevelDeletedDocIdsSet = new Set(localDeletedSectionDocIds);
      const topLevelDeletedManthraDocIdsSet = new Set(localDeletedManthraDocIds);
      const existingAdhyayaTitles = new Set(enrichedHier2.map((a) => a.title));
      const topLevelStrapiSections = fetchedSections
        .filter((s: any) => !s.parent?.documentId)
        .sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
      const missingAdhyayas: AdhyayaNode[] = [];
      for (const sec of topLevelStrapiSections) {
        if (!sec.title || existingAdhyayaTitles.has(sec.title)) continue;
        // Skip explicitly deleted sections — do not re-add them from Strapi
        if (sec.documentId && topLevelDeletedDocIdsSet.has(sec.documentId)) continue;
        // Child sections of this Strapi section → become khandas
        const strapiChildren = (strapiChildSectionsByParentDocId.get(sec.documentId) ?? [])
          .sort((x: any, y: any) => (x.order ?? 0) - (y.order ?? 0));
        let khandas: KhandaNode[];
        if (strapiChildren.length > 0) {
          khandas = strapiChildren.map((child: any) => {
            // Check for level-3 sub-sections (e.g. Adhikaranams under Padas in Brahma Sutra).
            const grandChildren = child.documentId
              ? (strapiChildSectionsByParentDocId.get(child.documentId) ?? [])
                  .sort((x: any, y: any) => (x.order ?? 0) - (y.order ?? 0))
              : [];
            if (grandChildren.length > 0) {
              // Level-3: build padas for each grandchild section
              const padas: PadaNode[] = grandChildren.map((gc: any) => ({
                id: uid(),
                title: gc.title,
                order: gc.order ?? 0,
                expanded: true,
                documentId: gc.documentId || undefined,
                manthras: (gc.documentId ? (strapiMantrasBySecDocId.get(gc.documentId) ?? []) : [])
                  .sort((x: any, y: any) => (x.order ?? 0) - (y.order ?? 0))
                  .filter((sm: any) => !topLevelDeletedManthraDocIdsSet.has(sm.docId))
                  .map((sm: any, mi: number) => mantraNodeFromStrapiRef(sm, sm.order ?? mi + 1)),
              } as PadaNode));
              return {
                id: uid(),
                title: child.title,
                order: child.order ?? 0,
                expanded: true,
                documentId: child.documentId || undefined,
                padas,
                manthras: [],
              } as KhandaNode;
            }
            // Level-2: manthras live directly on this child section
            return {
              id: uid(),
              title: child.title,
              order: child.order ?? 0,
              expanded: true,
              documentId: child.documentId || undefined,
              padas: [],
              manthras: (child.documentId ? (strapiMantrasBySecDocId.get(child.documentId) ?? []) : [])
                .sort((x: any, y: any) => (x.order ?? 0) - (y.order ?? 0))
                .filter((sm: any) => !topLevelDeletedManthraDocIdsSet.has(sm.docId))
                .map((sm: any, mi: number) => mantraNodeFromStrapiRef(sm, sm.order ?? mi + 1)),
            } as KhandaNode;
          });
        } else {
          // Flat section — create a synthetic "_default" khanda with this section's manthras
          const manthrasForSec = (sec.documentId ? (strapiMantrasBySecDocId.get(sec.documentId) ?? []) : [])
            .sort((x: any, y: any) => (x.order ?? 0) - (y.order ?? 0))
            .filter((sm: any) => !topLevelDeletedManthraDocIdsSet.has(sm.docId))
            .map((sm: any, mi: number) => mantraNodeFromStrapiRef(sm, sm.order ?? mi + 1));
          khandas = [{
            id: uid(),
            title: "_default",
            order: 0,
            expanded: true,
            padas: [],
            manthras: manthrasForSec,
          } as KhandaNode];
        }
        missingAdhyayas.push({
          id: uid(),
          title: sec.title,
          order: sec.order ?? 0,
          expanded: true,
          documentId: sec.documentId || undefined,
          khandas,
        } as AdhyayaNode);
      }
      const finalHier2 = missingAdhyayas.length > 0
        ? [...enrichedHier2, ...missingAdhyayas].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        : enrichedHier2;

      const collapsedHier2 = dropKhandasDuplicatingDefaultMantraSection(
        finalHier2,
        effectiveStructureConfig,
        strapiChildSectionsByParentDocId,
      );

      const prunedHier2 = stripOrphanPortalMantrasFromHierarchy(collapsedHier2, seenStrapiMantraDocIds);
      const placedHier2 = enforceMantraPlacementByStructure(prunedHier2, effectiveStructureConfig);
      const prep = prepareHierarchyForContentStep(placedHier2, effectiveStructureConfig);
      if (!isCurrentOpenEditLoad(openEditLoadGen)) {
        return;
      }
      if (prep.sectionDocIdsToMarkDeleted.length > 0) {
        setDeletedStrapiSectionDocIds((prev) => Array.from(new Set([...prev, ...prep.sectionDocIdsToMarkDeleted])));
      }
      setStructureConfig(effectiveStructureConfig);
      const normalizedOpen = hierarchyForSave(prep.hierarchy as AdhyayaNode[], effectiveStructureConfig);
      const withVerseGaps = fillMissingVerseGapsInHierarchy(
        normalizedOpen,
        effectiveStructureConfig,
        uid,
      );
      const withPreservedContent = mergePublishedHierarchyPreservingContent(
        hierarchyBeforeEnrich,
        withVerseGaps,
      );
      adhyayasRef.current = withPreservedContent;
      setAdhyayas(withPreservedContent);

      bindGranthaMantraPrefetchContext();
      prefetchGranthaMantrasFromHierarchy(normalizedOpen);
      if (isPublishedStrapiDocId(granthaDocId)) {
        flushStrapiFullHierarchySectionOrderSyncNow(normalizedOpen, effectiveStructureConfig, true);
      }
      applyPublishScopeFromDraft(publishScopeDraftData);
      publishScopeMetaEffectSkipRef.current = true;
      publishScopeReadyRef.current = true;
      if (loadedDraftId != null) markEditorSyncedForPublish();
      setStep(1);
      setView("form");
      setEditingGranthaSectionsLoading(false);

    // ── Bulk teeka pre-populate ──
    // After the hierarchy is in state, fetch ALL manthras' teeka data from
    // Strapi in one request and merge it into the hierarchy. This guarantees
    // that teeka content (especially OtherTranslations) is ALWAYS present in
    // state from the moment the grantha opens — not just after each dialog
    // is individually opened. Without this, any "Save" before opening every
    // dialog would clear teeka content in the draft.
    if (granthaDocId && isCurrentOpenEditLoad(openEditLoadGen)) {
      fetch(`/api/strapi/manthras/teekas-by-grantha/${granthaDocId}`, CMS_FETCH_INIT)
        .then((r) => r.ok ? r.json() : null)
        .then((payload) => {
          if (!isCurrentOpenEditLoad(openEditLoadGen)) return;
          if (!payload?.data || typeof payload.data !== "object") return;
          const teekaMap: Record<string, any[]> = payload.data;
          setAdhyayas((prev) =>
            prev.map((a) => ({
              ...a,
              khandas: a.khandas.map((k) => ({
                ...k,
                manthras: k.manthras.map((m) => {
                  const st = m.strapiDocumentId ? teekaMap[m.strapiDocumentId] : null;
                  if (!st?.length) return m;
                  return { ...m, Teekas: mergeTeekas(m.Teekas, st) };
                }),
                padas: (k.padas ?? []).map((p) => ({
                  ...p,
                  manthras: p.manthras.map((m) => {
                    const st = m.strapiDocumentId ? teekaMap[m.strapiDocumentId] : null;
                    if (!st?.length) return m;
                    return { ...m, Teekas: mergeTeekas(m.Teekas, st) };
                  }),
                })),
              })),
            }))
          );
        })
        .catch(() => {
          // Silent — per-dialog fetch still acts as fallback
        });
    }
  }

  async function openView(item: any) {
    setViewOnly(true);
    await openEdit(item);
    setStep(3);
  }

  // ---------- Teeka handlers ----------

  function addTeeka() {
    track("teeka_added", { grantha_name: formData.GranthaName });
    setTeekas([...teekas, { id: uid(), TeekaName: "", TeekaAuthor: "" }]);
  }

  function updateTeeka(id: string, field: keyof Omit<TeekaDefinition, "id">, value: string) {
    setTeekas(teekas.map((t) => (t.id === id ? { ...t, [field]: value } : t)));
  }

  function removeTeeka(id: string) {
    const removed = teekas.find((t) => t.id === id);
    track("teeka_removed", { grantha_name: formData.GranthaName, teeka_name: removed?.TeekaName || "" });
    const strapiTeekaId = removed && isPublishedStrapiDocId(removed.id) ? removed.id : undefined;
    const gdoc = editingGranthaStrapiDocumentId();

    if (strapiTeekaId && gdoc) {
      void deleteStrapiTeekaBestEffort(strapiTeekaId).then((ok) => {
        if (!ok) {
          setDeletedStrapiTeekaDocIds((prev) => Array.from(new Set([...prev, strapiTeekaId])));
        }
      });
    } else if (strapiTeekaId) {
      setDeletedStrapiTeekaDocIds((prev) => Array.from(new Set([...prev, strapiTeekaId])));
    }
    setTeekas((prev) => prev.filter((t) => t.id !== id));
  }

  // ---------- OtherTranslations handlers ----------

  function addOtherTranslation() {
    setOtherTranslations([...otherTranslations, { id: uid(), language: "", text: [] }]);
  }

  function updateOtherTranslation(id: string, field: keyof Omit<OtherTranslationEntry, "id">, value: string | StrapiBlock[]) {
    setOtherTranslations(otherTranslations.map((t) => (t.id === id ? { ...t, [field]: value } : t)));
  }

  function removeOtherTranslation(id: string) {
    setOtherTranslations(otherTranslations.filter((t) => t.id !== id));
  }

  // ---------- GranthaNameTranslations handlers ----------

  function addGranthaNameTranslation() {
    setGranthaNameTranslations([...granthaNameTranslations, { id: uid(), language: "", name: "" }]);
  }

  function updateGranthaNameTranslation(id: string, field: keyof Omit<GranthaNameTranslationEntry, "id">, value: string) {
    setGranthaNameTranslations(granthaNameTranslations.map((t) => (t.id === id ? { ...t, [field]: value } : t)));
  }

  function removeGranthaNameTranslation(id: string) {
    setGranthaNameTranslations(granthaNameTranslations.filter((t) => t.id !== id));
  }

  // ---------- Hierarchy handlers ----------

  function addAdhyaya() {
    markRequiresFullPublish();
    const sorted = sortNodesByOrder(adhyayas);
    const nextOrder = sorted.reduce((mx, a) => Math.max(mx, a.order ?? 0), 0) + 1;
    const L1 = structureConfig.levelOneName;
    const newAdhyayaId = uid();
    const defaultKhanda = !structureConfig.levelTwoEnabled
      ? [{ id: uid(), title: "_default", order: 1, padas: [], manthras: [], expanded: true }]
      : [];
    const next = withNormalizedHierarchy(
      [
        ...adhyayas,
        {
          id: newAdhyayaId,
          title: `${ordinal(nextOrder)} ${L1}`,
          order: nextOrder,
          khandas: defaultKhanda,
          expanded: true,
        },
      ],
      structureConfig,
    );
    setAdhyayas(next);

    const gdoc = editingGranthaStrapiDocumentId();
    if (!gdoc) return;
    const node = next.find((x) => x.id === newAdhyayaId);
    if (!node?.title?.trim()) return;
    void postStrapiSection({
      title: node.title,
      order: node.order ?? nextOrder,
      granthaDocumentId: gdoc,
      portalTypeName: structureConfig.levelOneName,
    })
      .then(async (docId) => {
        if (!docId) return;
        const merged = next.map((a) => (a.id === newAdhyayaId ? { ...a, documentId: docId } : a));
        setAdhyayas(merged);
        try {
          await runStrapiFullHierarchySectionOrderSync(merged, structureConfig);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          toast({
            variant: "destructive",
            title: "Strapi section ordering failed",
            description: msg,
          });
        }
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        toast({ variant: "destructive", title: "Strapi section create failed", description: msg });
      });
  }

  function updateAdhyaya(id: string, title: string) {
    markRequiresFullPublish();
    setAdhyayas(adhyayas.map((a) => (a.id === id ? { ...a, title } : a)));
    queueStrapiFullHierarchySectionOrderSync();
  }

  function removeAdhyaya(id: string) {
    markRequiresFullPublish();
    const target = adhyayas.find((a) => a.id === id);
    const mantraDocIds = target ? collectPublishedManthraDocIdsFromAdhyaya(target) : [];
    const sectionDocIdsOrdered = target
      ? collectSectionDocumentIdsChildToParentForAdhyaya(target)
      : [];
    const next = withNormalizedHierarchy(adhyayas.filter((a) => a.id !== id), structureConfig);
    setAdhyayas(next);

    const gdoc = editingGranthaStrapiDocumentId();
    if (!gdoc) {
      if (target?.documentId) {
        const docIdsToDelete: string[] = [target.documentId];
        for (const k of target.khandas) {
          if (k.documentId) docIdsToDelete.push(k.documentId);
          for (const p of k.padas ?? []) {
            if (p.documentId) docIdsToDelete.push(p.documentId);
          }
        }
        setDeletedStrapiSectionDocIds((prev) => Array.from(new Set([...prev, ...docIdsToDelete])));
      }
      if (mantraDocIds.length > 0) {
        setDeletedStrapiManthraDocIds((prev) => Array.from(new Set([...prev, ...mantraDocIds])));
      }
      return;
    }

    if (mantraDocIds.length === 0 && sectionDocIdsOrdered.length === 0) return;
    void strapiDeleteMantrasThenSections({
      mantraDocumentIds: mantraDocIds,
      sectionDocumentIdsChildToParent: sectionDocIdsOrdered,
    }).then(async ({ failedMantraIds, failedSectionIds }) => {
      if (failedMantraIds.length > 0) {
        setDeletedStrapiManthraDocIds((prev) => Array.from(new Set([...prev, ...failedMantraIds])));
      }
      if (failedSectionIds.length > 0) {
        setDeletedStrapiSectionDocIds((prev) => Array.from(new Set([...prev, ...failedSectionIds])));
      }
      try {
        await runStrapiFullHierarchySectionOrderSync(next, structureConfig);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        toast({
          variant: "destructive",
          title: "Strapi section ordering failed",
          description: msg,
        });
      }
    });
  }

  function toggleAdhyaya(id: string) {
    setAdhyayas(adhyayas.map((a) => (a.id === id ? { ...a, expanded: !a.expanded } : a)));
  }

  function addKhanda(adhyayaId: string) {
    markRequiresFullPublish();
    const L2 = structureConfig.levelTwoName;
    const newKhandaId = uid();
    const next = withNormalizedHierarchy(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        const sortedK = sortNodesByOrder(a.khandas);
        const nextOrder = sortedK.reduce((mx, k) => Math.max(mx, k.order ?? 0), 0) + 1;
        return {
          ...a,
          khandas: [
            ...a.khandas,
            {
              id: newKhandaId,
              title: `${ordinal(nextOrder)} ${L2}`,
              order: nextOrder,
              padas: [],
              manthras: [],
              expanded: true,
            },
          ],
        };
      }),
      structureConfig,
    );
    setAdhyayas(next);

    const gdoc = editingGranthaStrapiDocumentId();
    if (!gdoc) return;
    const adhyaya = next.find((x) => x.id === adhyayaId);
    const khanda = adhyaya?.khandas.find((k) => k.id === newKhandaId);
    if (!adhyaya || !khanda?.title?.trim()) return;
    if (!isPublishedStrapiDocId(adhyaya.documentId)) return;

    void postStrapiSection({
      title: khanda.title,
      order: khanda.order ?? 1,
      granthaDocumentId: gdoc,
      parentDocumentId: adhyaya.documentId,
      portalTypeName: structureConfig.levelTwoName,
    })
      .then(async (docId) => {
        if (!docId) return;
        const merged = next.map((a) => {
          if (a.id !== adhyayaId) return a;
          return {
            ...a,
            khandas: a.khandas.map((kk) =>
              kk.id === newKhandaId ? { ...kk, documentId: docId } : kk,
            ),
          };
        });
        setAdhyayas(merged);
        try {
          await runStrapiFullHierarchySectionOrderSync(merged, structureConfig);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          toast({
            variant: "destructive",
            title: "Strapi section ordering failed",
            description: msg,
          });
        }
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        toast({ variant: "destructive", title: "Strapi section create failed", description: msg });
      });
  }

  function updateKhanda(adhyayaId: string, khandaId: string, title: string) {
    markRequiresFullPublish();
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        return { ...a, khandas: a.khandas.map((k) => (k.id === khandaId ? { ...k, title } : k)) };
      })
    );
    queueStrapiFullHierarchySectionOrderSync();
  }

  function removeKhanda(adhyayaId: string, khandaId: string) {
    markRequiresFullPublish();
    const a = adhyayas.find((x) => x.id === adhyayaId);
    const target = a?.khandas.find((k) => k.id === khandaId);
    const mantraDocIds = target ? collectPublishedManthraDocIdsFromKhanda(target) : [];
    const sectionDocIdsOrdered = target
      ? collectSectionDocumentIdsChildToParentForKhanda(target)
      : [];

    const next = withNormalizedHierarchy(
      adhyayas.map((ad) => {
        if (ad.id !== adhyayaId) return ad;
        return { ...ad, khandas: ad.khandas.filter((k) => k.id !== khandaId) };
      }),
      structureConfig,
    );
    setAdhyayas(next);

    const gdoc = editingGranthaStrapiDocumentId();
    if (!gdoc) {
      if (target?.documentId) {
        const docIdsToDelete: string[] = [target.documentId];
        for (const p of target.padas ?? []) {
          if (p.documentId) docIdsToDelete.push(p.documentId);
        }
        setDeletedStrapiSectionDocIds((prev) => Array.from(new Set([...prev, ...docIdsToDelete])));
      }
      if (mantraDocIds.length > 0) {
        setDeletedStrapiManthraDocIds((prev) => Array.from(new Set([...prev, ...mantraDocIds])));
      }
      return;
    }

    if (mantraDocIds.length === 0 && sectionDocIdsOrdered.length === 0) return;
    void strapiDeleteMantrasThenSections({
      mantraDocumentIds: mantraDocIds,
      sectionDocumentIdsChildToParent: sectionDocIdsOrdered,
    }).then(async ({ failedMantraIds, failedSectionIds }) => {
      if (failedMantraIds.length > 0) {
        setDeletedStrapiManthraDocIds((prev) => Array.from(new Set([...prev, ...failedMantraIds])));
      }
      if (failedSectionIds.length > 0) {
        setDeletedStrapiSectionDocIds((prev) => Array.from(new Set([...prev, ...failedSectionIds])));
      }
      try {
        await runStrapiFullHierarchySectionOrderSync(next, structureConfig);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        toast({
          variant: "destructive",
          title: "Strapi section ordering failed",
          description: msg,
        });
      }
    });
  }

  function toggleKhanda(adhyayaId: string, khandaId: string) {
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        return {
          ...a,
          khandas: a.khandas.map((k) =>
            k.id === khandaId ? { ...k, expanded: !k.expanded } : k,
          ),
        };
      }),
    );
  }

  // ── Level 3 (Pada) functions ──
  function addPada(adhyayaId: string, khandaId: string) {
    markRequiresFullPublish();
    const L3 = structureConfig.levelThreeName;
    const newPadaId = uid();
    const next = withNormalizedHierarchy(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        return {
          ...a,
          khandas: a.khandas.map((k) => {
            if (k.id !== khandaId) return k;
            const sortedP = sortNodesByOrder(k.padas ?? []);
            const nextOrder = sortedP.reduce((mx, p) => Math.max(mx, p.order ?? 0), 0) + 1;
            return {
              ...k,
              padas: [
                ...(k.padas ?? []),
                {
                  id: newPadaId,
                  title: `${ordinal(nextOrder)} ${L3}`,
                  order: nextOrder,
                  manthras: [],
                  expanded: true,
                },
              ],
            };
          }),
        };
      }),
      structureConfig,
    );
    setAdhyayas(next);

    const gdoc = editingGranthaStrapiDocumentId();
    if (!gdoc) return;
    const adhyaya = next.find((x) => x.id === adhyayaId);
    const khanda = adhyaya?.khandas.find((x) => x.id === khandaId);
    const pada = khanda?.padas?.find((p) => p.id === newPadaId);
    if (!khanda || !pada?.title?.trim()) return;
    if (!isPublishedStrapiDocId(khanda.documentId)) return;

    void postStrapiSection({
      title: pada.title,
      order: pada.order ?? 1,
      granthaDocumentId: gdoc,
      parentDocumentId: khanda.documentId,
      portalTypeName: structureConfig.levelThreeName,
    })
      .then(async (docId) => {
        if (!docId) return;
        const merged = next.map((a) => {
          if (a.id !== adhyayaId) return a;
          return {
            ...a,
            khandas: a.khandas.map((kk) => {
              if (kk.id !== khandaId) return kk;
              return {
                ...kk,
                padas: (kk.padas ?? []).map((p) =>
                  p.id === newPadaId ? { ...p, documentId: docId } : p,
                ),
              };
            }),
          };
        });
        setAdhyayas(merged);
        try {
          await runStrapiFullHierarchySectionOrderSync(merged, structureConfig);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          toast({
            variant: "destructive",
            title: "Strapi section ordering failed",
            description: msg,
          });
        }
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        toast({ variant: "destructive", title: "Strapi section create failed", description: msg });
      });
  }

  /** Insert a new L1 section immediately after `afterAdhyayaId` (portal + Strapi order). */
  function insertAdhyayaAfter(afterAdhyayaId: string) {
    const sorted = sortNodesByOrder(adhyayas);
    const j = sorted.findIndex((a) => a.id === afterAdhyayaId);
    if (j < 0) return;
    const newAdhyayaId = uid();
    const defaultKhanda = !structureConfig.levelTwoEnabled
      ? [{ id: uid(), title: "_default", order: 1, padas: [], manthras: [], expanded: true }]
      : [];
    const newNode: AdhyayaNode = {
      id: newAdhyayaId,
      title: "",
      order: 0,
      khandas: defaultKhanda,
      expanded: true,
    };
    const mergedInput = [...sorted.slice(0, j + 1), newNode, ...sorted.slice(j + 1)];
    const next = withNormalizedHierarchy(mergedInput, structureConfig);
    setAdhyayas(next);

    const gdoc = editingGranthaStrapiDocumentId();
    if (!gdoc) return;
    const node = next.find((x) => x.id === newAdhyayaId);
    if (!node?.title?.trim()) return;
    void postStrapiSection({
      title: node.title,
      order: node.order ?? j + 2,
      granthaDocumentId: gdoc,
      portalTypeName: structureConfig.levelOneName,
    })
      .then(async (docId) => {
        if (!docId) return;
        const merged = next.map((a) => (a.id === newAdhyayaId ? { ...a, documentId: docId } : a));
        setAdhyayas(merged);
        try {
          await runStrapiFullHierarchySectionOrderSync(merged, structureConfig);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          toast({
            variant: "destructive",
            title: "Strapi section ordering failed",
            description: msg,
          });
        }
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        toast({ variant: "destructive", title: "Strapi section create failed", description: msg });
      });
  }

  function insertKhandaAfter(adhyayaId: string, afterKhandaId: string) {
    const newKhandaId = uid();
    const next = withNormalizedHierarchy(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        const sortedK = sortNodesByOrder(a.khandas);
        const j = sortedK.findIndex((k) => k.id === afterKhandaId);
        if (j < 0) return a;
        const newNode: KhandaNode = {
          id: newKhandaId,
          title: "",
          order: 0,
          padas: [],
          manthras: [],
          expanded: true,
        };
        return { ...a, khandas: [...sortedK.slice(0, j + 1), newNode, ...sortedK.slice(j + 1)] };
      }),
      structureConfig,
    );
    setAdhyayas(next);

    const gdoc = editingGranthaStrapiDocumentId();
    if (!gdoc) return;
    const adhyaya = next.find((x) => x.id === adhyayaId);
    const khanda = adhyaya?.khandas.find((k) => k.id === newKhandaId);
    if (!adhyaya || !khanda?.title?.trim()) return;
    if (!isPublishedStrapiDocId(adhyaya.documentId)) return;

    void postStrapiSection({
      title: khanda.title,
      order: khanda.order ?? 1,
      granthaDocumentId: gdoc,
      parentDocumentId: adhyaya.documentId,
      portalTypeName: structureConfig.levelTwoName,
    })
      .then(async (docId) => {
        if (!docId) return;
        const merged = next.map((a) => {
          if (a.id !== adhyayaId) return a;
          return {
            ...a,
            khandas: a.khandas.map((kk) =>
              kk.id === newKhandaId ? { ...kk, documentId: docId } : kk,
            ),
          };
        });
        setAdhyayas(merged);
        try {
          await runStrapiFullHierarchySectionOrderSync(merged, structureConfig);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          toast({
            variant: "destructive",
            title: "Strapi section ordering failed",
            description: msg,
          });
        }
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        toast({ variant: "destructive", title: "Strapi section create failed", description: msg });
      });
  }

  function insertPadaAfter(adhyayaId: string, khandaId: string, afterPadaId: string) {
    const newPadaId = uid();
    const next = withNormalizedHierarchy(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        return {
          ...a,
          khandas: a.khandas.map((k) => {
            if (k.id !== khandaId) return k;
            const sortedP = sortNodesByOrder(k.padas ?? []);
            const j = sortedP.findIndex((p) => p.id === afterPadaId);
            if (j < 0) return k;
            const newNode: PadaNode = {
              id: newPadaId,
              title: "",
              order: 0,
              manthras: [],
              expanded: true,
            };
            return { ...k, padas: [...sortedP.slice(0, j + 1), newNode, ...sortedP.slice(j + 1)] };
          }),
        };
      }),
      structureConfig,
    );
    setAdhyayas(next);

    const gdoc = editingGranthaStrapiDocumentId();
    if (!gdoc) return;
    const adhyaya = next.find((x) => x.id === adhyayaId);
    const khanda = adhyaya?.khandas.find((x) => x.id === khandaId);
    const pada = khanda?.padas?.find((p) => p.id === newPadaId);
    if (!khanda || !pada?.title?.trim()) return;
    if (!isPublishedStrapiDocId(khanda.documentId)) return;

    void postStrapiSection({
      title: pada.title,
      order: pada.order ?? 1,
      granthaDocumentId: gdoc,
      parentDocumentId: khanda.documentId,
      portalTypeName: structureConfig.levelThreeName,
    })
      .then(async (docId) => {
        if (!docId) return;
        const merged = next.map((a) => {
          if (a.id !== adhyayaId) return a;
          return {
            ...a,
            khandas: a.khandas.map((kk) => {
              if (kk.id !== khandaId) return kk;
              return {
                ...kk,
                padas: (kk.padas ?? []).map((p) =>
                  p.id === newPadaId ? { ...p, documentId: docId } : p,
                ),
              };
            }),
          };
        });
        setAdhyayas(merged);
        try {
          await runStrapiFullHierarchySectionOrderSync(merged, structureConfig);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          toast({
            variant: "destructive",
            title: "Strapi section ordering failed",
            description: msg,
          });
        }
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        toast({ variant: "destructive", title: "Strapi section create failed", description: msg });
      });
  }

  function updatePada(adhyayaId: string, khandaId: string, padaId: string, title: string) {
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        return {
          ...a,
          khandas: a.khandas.map((k) => {
            if (k.id !== khandaId) return k;
            return {
              ...k,
              padas: (k.padas ?? []).map((p) => (p.id === padaId ? { ...p, title } : p)),
            };
          }),
        };
      })
    );
    queueStrapiFullHierarchySectionOrderSync();
  }

  function removePada(adhyayaId: string, khandaId: string, padaId: string) {
    markRequiresFullPublish();
    const a = adhyayas.find((x) => x.id === adhyayaId);
    const k = a?.khandas.find((x) => x.id === khandaId);
    const target = k?.padas?.find((p) => p.id === padaId);
    const mantraDocIds = (target?.manthras ?? [])
      .filter((m) => isPublishedStrapiDocId(m.strapiDocumentId))
      .map((m) => m.strapiDocumentId!);
    const sectionDocIdsOrdered =
      target?.documentId && isPublishedStrapiDocId(target.documentId) ? [target.documentId] : [];

    const next = withNormalizedHierarchy(
      adhyayas.map((ad) => {
        if (ad.id !== adhyayaId) return ad;
        return {
          ...ad,
          khandas: ad.khandas.map((kh) => {
            if (kh.id !== khandaId) return kh;
            return { ...kh, padas: (kh.padas ?? []).filter((p) => p.id !== padaId) };
          }),
        };
      }),
      structureConfig,
    );
    setAdhyayas(next);

    const gdoc = editingGranthaStrapiDocumentId();
    if (!gdoc) {
      if (target?.documentId) {
        setDeletedStrapiSectionDocIds((prev) => Array.from(new Set([...prev, target.documentId!])));
      }
      if (mantraDocIds.length > 0) {
        setDeletedStrapiManthraDocIds((prev) => Array.from(new Set([...prev, ...mantraDocIds])));
      }
      return;
    }

    if (mantraDocIds.length === 0 && sectionDocIdsOrdered.length === 0) return;
    void strapiDeleteMantrasThenSections({
      mantraDocumentIds: mantraDocIds,
      sectionDocumentIdsChildToParent: sectionDocIdsOrdered,
    }).then(async ({ failedMantraIds, failedSectionIds }) => {
      if (failedMantraIds.length > 0) {
        setDeletedStrapiManthraDocIds((prev) => Array.from(new Set([...prev, ...failedMantraIds])));
      }
      if (failedSectionIds.length > 0) {
        setDeletedStrapiSectionDocIds((prev) => Array.from(new Set([...prev, ...failedSectionIds])));
      }
      try {
        await runStrapiFullHierarchySectionOrderSync(next, structureConfig);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        toast({
          variant: "destructive",
          title: "Strapi section ordering failed",
          description: msg,
        });
      }
    });
  }

  function togglePada(adhyayaId: string, khandaId: string, padaId: string) {
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        return {
          ...a,
          khandas: a.khandas.map((k) => {
            if (k.id !== khandaId) return k;
            return {
              ...k,
              padas: (k.padas ?? []).map((p) =>
                p.id === padaId ? { ...p, expanded: !p.expanded } : p
              ),
            };
          }),
        };
      })
    );
  }

  // ── Manthra functions (handle L2 and L3 paths) ──

  function applyMantraSlotSyncResult(
    patches: Array<{ manthraId: string; strapiDocumentId: string }>,
    ctx: { adhyayaId: string; khandaId: string; padaId?: string },
    hierarchy?: unknown[],
  ) {
    if (Array.isArray(hierarchy)) {
      const next = mergePublishedHierarchyPreservingContent(
        adhyayasRef.current,
        hierarchy as AdhyayaNode[],
      );
      adhyayasRef.current = next;
      setAdhyayas(next);
    } else if (patches.length > 0) {
      setAdhyayas((prev) => {
        const merged = mergeMantraStrapiDocumentIds(
          prev as SnapshotAdhyaya[],
          ctx.adhyayaId,
          ctx.khandaId,
          ctx.padaId,
          patches,
        ) as AdhyayaNode[];
        adhyayasRef.current = merged;
        return merged.map((a) => {
          if (a.id !== ctx.adhyayaId) return a;
          return {
            ...a,
            khandas: a.khandas.map((k) => {
              if (k.id !== ctx.khandaId) return k;
              const patchIds = new Set(patches.map((p) => p.manthraId));
              const clearNew = (m: ManthraNode) =>
                patchIds.has(m.id) ? { ...m, _isNewLocal: false } : m;
              if (ctx.padaId) {
                return {
                  ...k,
                  padas: (k.padas ?? []).map((p) =>
                    p.id === ctx.padaId
                      ? { ...p, manthras: (p.manthras ?? []).map(clearNew) }
                      : p,
                  ),
                };
              }
              return { ...k, manthras: (k.manthras ?? []).map(clearNew) };
            }),
          };
        });
      });
    }
    for (const p of patches) clearManthraFromChangedSet(p.manthraId);
    if (patches.length > 0) invalidateGranthaCmsCaches(queryClient);
  }

  function queuePendingMantraSync(
    ctx: { adhyayaId: string; khandaId: string; padaId?: string },
    opts?: { onlyManthraIds?: string[]; renumberSectionLabels?: boolean },
  ) {
    const pending = pendingMantraSyncRef.current;
    if (opts?.onlyManthraIds) {
      for (const id of opts.onlyManthraIds) pending.manthraIds.add(id);
    }
    if (opts?.renumberSectionLabels) pending.renumber = true;
    pending.ctx = ctx;
  }

  /** Snapshot queued +/delete ops into one Strapi pass (all new rows when renumbering). */
  function takePendingMantraSyncOpts(
    fallbackCtx: { adhyayaId: string; khandaId: string; padaId?: string },
  ): {
    ctx: { adhyayaId: string; khandaId: string; padaId?: string };
    syncOpts: { onlyManthraIds?: string[]; renumberSectionLabels?: boolean };
  } {
    const pending = pendingMantraSyncRef.current;
    const ctx = pending.ctx ?? fallbackCtx;
    const renumber = pending.renumber;
    const syncOpts = {
      renumberSectionLabels: renumber,
      onlyManthraIds: renumber
        ? undefined
        : pending.manthraIds.size > 0
          ? [...pending.manthraIds]
          : undefined,
    };
    pending.manthraIds.clear();
    pending.renumber = false;
    pending.ctx = null;
    return { ctx, syncOpts };
  }

  /**
   * Queue +/delete CMS work for the next Save & Publish (draft-first).
   * Portal draft owns verse order/labels during editing; Strapi batch label sync runs once at publish.
   */
  function scheduleStrapiMantraSectionIdentitySync(
    snapshot: AdhyayaNode[],
    ctx: { adhyayaId: string; khandaId: string; padaId?: string },
    opts?: { onlyManthraIds?: string[]; renumberSectionLabels?: boolean },
  ) {
    const granthaDoc =
      editingItem && !editingItem._isDraft
        ? editingItem.documentId
        : editingItem?._strapiDocId;
    if (!isPublishedStrapiDocId(granthaDoc)) return;
    if (publishInProgressRef.current) return;

    adhyayasRef.current = snapshot;
    queuePendingMantraSync(ctx, opts);
  }

  /** Run queued mantra CMS sync immediately (used before Save / Save & Publish). */
  async function flushMantraStructuralSyncNow(
    fallbackCtx: { adhyayaId: string; khandaId: string; padaId?: string },
  ) {
    if (mantraSyncTimerRef.current) {
      clearTimeout(mantraSyncTimerRef.current);
      mantraSyncTimerRef.current = null;
    }
    const granthaDoc =
      editingItemRef.current && !editingItemRef.current._isDraft
        ? editingItemRef.current.documentId
        : editingItemRef.current?._strapiDocId;
    if (!isPublishedStrapiDocId(granthaDoc) || publishInProgressRef.current) return;

    const { ctx, syncOpts } = takePendingMantraSyncOpts(fallbackCtx);
    const snap = adhyayasRef.current as SnapshotAdhyaya[];
    const cfg = structureConfigRef.current;
    const toDelete = [...pendingMantraDeletesRef.current];
    pendingMantraDeletesRef.current.clear();

    await (mantraSyncChainRef.current = mantraSyncChainRef.current.then(async () => {
      if (publishInProgressRef.current) return;

      let draftId = editingDraftId;
      if (!draftId && isPublishedStrapiDocId(granthaDoc)) {
        try {
          const payload = buildSavePayload();
          const saved = await saveDraft.mutateAsync({
            title: formDataRef.current.GranthaName || payload.GranthaName || "Grantha",
            data: payload,
            strapiDocumentId: granthaDoc,
          });
          draftId = saved?.id ?? null;
          if (draftId) setEditingDraftId(draftId);
        } catch {
          return;
        }
      }

      if (draftId && isPublishedStrapiDocId(granthaDoc)) {
        if (toDelete.length > 0) {
          const failedDeleteIds = await strapiDeleteMantrasBestEffort(toDelete);
          if (failedDeleteIds.length > 0) {
            setDeletedStrapiManthraDocIds((prev) =>
              Array.from(new Set([...prev, ...failedDeleteIds])),
            );
          }
        }
        if (syncOpts.renumberSectionLabels) {
          applyHierarchyRenumberToEditorState(cfg);
        }
        const snapForSlots = adhyayasRef.current as SnapshotAdhyaya[];
        if (syncOpts.renumberSectionLabels) {
          await syncMantraSectionLabelsToStrapi(
            snapForSlots,
            ctx.adhyayaId,
            ctx.khandaId,
            ctx.padaId,
            cfg,
            { allowRenumber: true },
          );
        }
        const result = await syncMantraSlotsViaServer(draftId, {
          adhyayaId: ctx.adhyayaId,
          khandaId: ctx.khandaId,
          padaId: ctx.padaId,
          hierarchy: snapForSlots,
          onlyManthraIds: syncOpts.renumberSectionLabels ? undefined : syncOpts.onlyManthraIds,
        });
        const patches = (result.patches ?? []).map((p) => ({
          manthraId: p.manthraId,
          strapiDocumentId: p.strapiDocumentId,
        }));
        applyMantraSlotSyncResult(patches, ctx, result.hierarchy);
        if (syncOpts.renumberSectionLabels) {
          const snapAfter = adhyayasRef.current as SnapshotAdhyaya[];
          const labelSummary = await syncMantraSectionLabelsToStrapi(
            snapAfter,
            ctx.adhyayaId,
            ctx.khandaId,
            ctx.padaId,
            cfg,
            { allowRenumber: true },
          );
          syncGranthaCmsCaches(queryClient);
          const n = labelSummary.labelsUpdated + labelSummary.orderOnly;
          if (n > 0 || patches.length > 0) {
            toast({
              title: "Verses synced to CMS",
              description:
                patches.length > 0
                  ? `Created ${patches.length} row(s) and updated ${labelSummary.labelsUpdated} label(s) in Strapi (spreadsheet-style renumber).`
                  : `Updated ${labelSummary.labelsUpdated} ${cfg.leafName} label(s) in Strapi.`,
            });
          }
        } else if (patches.length > 0) {
          toast({
            title: "Verse slot synced to CMS",
            description: result.message ?? `Created ${patches.length} row(s) in Strapi.`,
          });
        } else if ((result.errors ?? []).length > 0) {
          toast({
            variant: "destructive",
            title: "CMS row not created",
            description: result.errors!.join("; "),
          });
        } else {
          const fixed = repairDuplicateSuffixesInHierarchy(
            adhyayasRef.current as AdhyayaNode[],
            cfg,
          );
          if (fixed !== adhyayasRef.current) {
            adhyayasRef.current = fixed;
            setAdhyayas(fixed);
          }
        }
        return;
      }

      if (syncOpts.renumberSectionLabels) {
        applyHierarchyRenumberToEditorState(cfg);
      }

      const snapForSync = adhyayasRef.current as SnapshotAdhyaya[];
      const { patches, failedDeleteIds, sortKeysUpdated, labelsUpdated, labelSyncOrderOnly } =
        await syncMantraSectionAfterStructuralEdits(
          snapForSync,
          ctx.adhyayaId,
          ctx.khandaId,
          ctx.padaId,
          cfg,
          toDelete,
          strapiSectionIndexRef.current,
          syncOpts,
        );
      if (failedDeleteIds.length > 0) {
        setDeletedStrapiManthraDocIds((prev) =>
          Array.from(new Set([...prev, ...failedDeleteIds])),
        );
      }
      applyMantraSlotSyncResult(patches, ctx);
      if (
        (patches.length > 0 ||
          sortKeysUpdated > 0 ||
          labelsUpdated > 0 ||
          labelSyncOrderOnly > 0) &&
        editingGranthaStrapiDocumentId()
      ) {
        const leaf = cfg.leafName || "Mantra";
        toast({
          title: syncOpts.renumberSectionLabels ? "Verses synced to CMS" : "Verse slot synced to CMS",
          description:
            syncOpts.renumberSectionLabels && labelsUpdated > 0
              ? `Created ${patches.length} row(s) where needed; updated ${labelsUpdated} ${leaf} label(s) in Strapi.`
              : patches.length > 0
                ? `Created ${patches.length} row(s) in Strapi${sortKeysUpdated > 0 ? ` and updated sort order for ${sortKeysUpdated} row(s)` : ""}.`
                : labelsUpdated > 0
                  ? `Updated ${labelsUpdated} ${leaf} label(s) in Strapi.`
                  : `Updated sort order for ${sortKeysUpdated || labelSyncOrderOnly} row(s) in Strapi.`,
        });
      } else if (patches.length === 0 && editingGranthaStrapiDocumentId()) {
        const sorted = getSortedMantrasFromSnapshot(
          snap,
          ctx.adhyayaId,
          ctx.khandaId,
          ctx.padaId,
          cfg,
        );
        const pendingRows = sorted.filter((m) => !isPublishedStrapiDocId(m.strapiDocumentId));
        if (pendingRows.length > 0) {
          toast({
            variant: "destructive",
            title: "CMS row not created",
            description:
              `${pendingRows.length} new verse(s) are still portal-only. Save the grantha to retry, or check that the section is linked to Strapi.`,
          });
        }
      }
      const fixed = repairDuplicateSuffixesInHierarchy(
        adhyayasRef.current as AdhyayaNode[],
        cfg,
      );
      if (fixed !== adhyayasRef.current) {
        adhyayasRef.current = fixed;
        setAdhyayas(fixed);
      }
    }));
  }


  /**
   * `draft` — portal JSON only (fast Save). `publish` — flush +/delete, CMS slots, label sync.
   */
  async function ensureMantraSlotsAndLabelsSyncedBeforePersist(
    mode: "draft" | "publish" = "publish",
  ): Promise<void> {
    const granthaDoc = editingGranthaStrapiDocumentId();
    if (!isPublishedStrapiDocId(granthaDoc)) return;

    const snap = adhyayasRef.current as SnapshotAdhyaya[];
    const cfg = structureConfigRef.current;
    const targets = collectMantraSectionSyncTargets(snap, cfg);
    const fallbackCtx = targets[0] ?? {
      adhyayaId: snap[0]?.id ?? "",
      khandaId: snap[0]?.khandas?.[0]?.id ?? "",
    };

    // Insert-between already renumbers in **list order**; full-tree normalize on draft Save
    // sorts by `order` and rewrites every label — that scrambles the editor vs what the user saw.
    if (mode === "publish") {
      applyHierarchyRenumberToEditorState(cfg);
    }

    if (mode === "publish" && structuralMantraRenumberPendingRef.current) {
      setPersistProgress({
        title: "Preparing fresh publish",
        done: 0,
        total: 1,
        current:
          "Structural verse changes detected — publishing as a new CMS grantha (skipping incremental label sync)…",
      });
      return;
    }

    if (mode === "draft") {
      setPersistProgress({
        title: "Saving draft",
        done: 0,
        total: 1,
        current: "Writing portal draft to database…",
      });
      return;
    }

    const mantraTotal = Math.max(
      1,
      countLinkedMantrasForLabelSync(adhyayasRef.current as SnapshotAdhyaya[], cfg),
    );
    const reportSync = (done: number, total: number, current: string) => {
      setPersistProgress({
        title: "Syncing verses to CMS",
        done,
        total: Math.max(total, 1),
        current,
      });
    };

    setPersistProgress({
      title: "Preparing CMS sync",
      done: 0,
      total: mantraTotal,
      current: "Flushing insert/delete queue…",
    });

    const pending = pendingMantraSyncRef.current;
    if (
      mantraSyncTimerRef.current ||
      pending.manthraIds.size > 0 ||
      pending.renumber ||
      pendingMantraDeletesRef.current.size > 0
    ) {
      await flushMantraStructuralSyncNow(pending.ctx ?? fallbackCtx);
    }
    await mantraSyncChainRef.current;

    await syncAllMantraSectionLabelsInGrantha(adhyayasRef.current as SnapshotAdhyaya[], cfg, {
      allowRenumber: true,
      onProgress: reportSync,
    });
    reportSync(0, mantraTotal, "Creating CMS slots for new verses…");
    const flushResult = await flushPendingNewMantrasToStrapi(adhyayasRef.current as AdhyayaNode[]);
    let snapAfter = adhyayasRef.current as AdhyayaNode[];
    let repaired = repairDuplicateSuffixesInHierarchy(snapAfter, cfg);
    const suffixRepaired = repaired !== snapAfter;
    if (suffixRepaired) {
      snapAfter = repaired;
      adhyayasRef.current = repaired;
      setAdhyayas(repaired);
    }
    // Pass 1 already labelled every existing row. A second full re-sync only matters when
    // the slot flush created new rows, a suffix repair rewrote labels, or the flush errored
    // (partial state). Re-syncing all sections otherwise is pure wasted remote round-trips —
    // the dominant cost when publishing large granthas against a remote Strapi.
    if (flushResult.created > 0 || flushResult.errored || suffixRepaired) {
      await syncAllMantraSectionLabelsInGrantha(snapAfter, cfg, {
        allowRenumber: true,
        onProgress: reportSync,
      });
      repaired = repairDuplicateSuffixesInHierarchy(adhyayasRef.current as AdhyayaNode[], cfg);
      if (repaired !== adhyayasRef.current) {
        adhyayasRef.current = repaired;
        setAdhyayas(repaired);
      }
    }
    syncGranthaCmsCaches(queryClient);
    reportSync(mantraTotal, mantraTotal, "CMS sync complete — continuing…");
  }

  function applyHierarchyRenumberToEditorState(cfg: GranthaStructureConfig = structureConfigRef.current) {
    setAdhyayas((prev) => {
      const next = withNormalizedHierarchy(prev, cfg);
      adhyayasRef.current = next;
      return next;
    });
  }

  function markStructuralMantraRenumberPending() {
    structuralMantraRenumberPendingRef.current = true;
  }

  /**
   * Retry CMS row creation for any portal-only verses (e.g. after a failed insert sync).
   * Returns how many CMS rows were created and whether an error interrupted the flush, so
   * callers can skip a redundant full label re-sync when nothing actually changed.
   */
  async function flushPendingNewMantrasToStrapi(
    snapshot?: AdhyayaNode[],
    onlyManthraIds?: string[],
  ): Promise<{ created: number; errored: boolean }> {
    if (!editingGranthaStrapiDocumentId()) return { created: 0, errored: false };
    if (publishInProgressRef.current) return { created: 0, errored: false };
    const snap = (snapshot ?? adhyayasRef.current) as SnapshotAdhyaya[];
    const draftId = editingDraftId;
    let created = 0;
    try {
      if (draftId) {
        for (let round = 0; round < 12; round++) {
          const result = await syncMantraSlotsViaServer(draftId, {
            hierarchy: adhyayasRef.current as SnapshotAdhyaya[],
            onlyManthraIds: round === 0 ? onlyManthraIds : undefined,
          });
          const patchCount = (result.patches ?? []).length;
          if (patchCount > 0 && Array.isArray(result.hierarchy)) {
            created += patchCount;
            adhyayasRef.current = result.hierarchy as AdhyayaNode[];
            setAdhyayas(result.hierarchy as AdhyayaNode[]);
            invalidateGranthaCmsCaches(queryClient);
          }
          const remaining = result.remainingPending ?? 0;
          if (remaining <= 0 && patchCount === 0) break;
        }
        return { created, errored: false };
      }
      const cfg = structureConfigRef.current;
      const patches = await syncAllPendingNewMantrasToStrapi(
        snap,
        cfg,
        strapiSectionIndexRef.current,
      );
      if (patches.length === 0) return { created: 0, errored: false };
      created = patches.length;
      setAdhyayas((prev) => {
        let merged = prev as SnapshotAdhyaya[];
        for (const p of patches) {
          merged = mergeMantraStrapiDocumentIds(
            merged,
            p.adhyayaId,
            p.khandaId,
            p.padaId,
            [{ manthraId: p.manthraId, strapiDocumentId: p.strapiDocumentId }],
          ) as AdhyayaNode[];
        }
        adhyayasRef.current = merged as AdhyayaNode[];
        return merged as AdhyayaNode[];
      });
      invalidateGranthaCmsCaches(queryClient);
      toast({
        title: "Pending verses synced to CMS",
        description: `Created ${patches.length} row(s) in Strapi. They appear in the Mantras tab as "No number" until you run Sync verse numbers to CMS.`,
      });
      return { created, errored: false };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ variant: "destructive", title: "Could not sync new verses to CMS", description: msg });
      return { created, errored: true };
    }
  }

  /** Explicit action: write portal verse titles + spaced CMS sort keys (not run on every + insert). */
  async function handleSyncVerseNumbersToCms() {
    markRequiresFullPublish();
    if (!editingGranthaStrapiDocumentId()) {
      toast({
        variant: "destructive",
        title: "Grantha not in CMS yet",
        description: "Save & Publish the grantha first, then sync verse numbers.",
      });
      return;
    }
    setVerseLabelSyncPending(true);
    try {
      const snap = adhyayasRef.current as SnapshotAdhyaya[];
      const mantraTotal = Math.max(1, countLinkedMantrasForLabelSync(snap, structureConfigRef.current));
      setPersistProgress({
        title: "Syncing verse numbers to CMS",
        done: 0,
        total: mantraTotal,
        current: "Starting…",
      });
      const summary = await syncAllMantraSectionLabelsInGrantha(snap, structureConfigRef.current, {
        allowRenumber: true,
        onProgress: (done, total, current) => {
          setPersistProgress({
            title: "Syncing verse numbers to CMS",
            done,
            total: Math.max(total, 1),
            current,
          });
        },
      });
      syncGranthaCmsCaches(queryClient);
      const total = summary.labelsUpdated + summary.orderOnly;
      toast({
        title: "Verse numbers synced to CMS",
        description:
          total > 0
            ? summary.orderOnly > 0 && summary.labelsUpdated === 0
              ? `Updated sort order for ${summary.orderOnly} row(s); Strapi verse labels unchanged (suffix mismatch — use full publish to renumber).`
              : summary.orderOnly > 0
                ? `Updated ${summary.labelsUpdated} label(s) and sort order for ${summary.orderOnly} row(s) where the verse number could not change.`
                : `Updated ${summary.labelsUpdated} ${structureConfigRef.current.leafName} label(s) in Strapi.`
            : "No linked CMS rows in this draft needed updating.",
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ variant: "destructive", title: "Verse number sync failed", description: msg });
    } finally {
      setVerseLabelSyncPending(false);
      setPersistProgress(null);
    }
  }

  function editingGranthaStrapiDocumentId(): string | undefined {
    const raw =
      editingItem && !editingItem._isDraft ? editingItem.documentId : editingItem?._strapiDocId;
    return isPublishedStrapiDocId(raw) ? raw : undefined;
  }

  async function runStrapiFullHierarchySectionOrderSync(
    snapshot: AdhyayaNode[],
    cfg: GranthaStructureConfig = structureConfigRef.current,
    force = false,
  ): Promise<void> {
    if (!force && !editingGranthaStrapiDocumentId()) return;
    const { updated, notFoundDocumentIds } = await syncStrapiSectionOrderAndTitles(
      collectAllSectionOrderSyncRowsFromHierarchy(snapshot, cfg),
    );
    if (notFoundDocumentIds.length > 0) {
      const cleaned = stripOrphanedSectionDocIdsFromAdhyayas(snapshot, notFoundDocumentIds);
      setAdhyayas(cleaned);
      console.warn(
        `[grantha] Cleared ${notFoundDocumentIds.length} stale section link(s) missing in Strapi`,
        notFoundDocumentIds,
      );
      toast({
        title: "Some CMS section links were stale",
        description:
          `${notFoundDocumentIds.length} section(s) no longer exist in Strapi and were unlinked in this draft ` +
          `(${notFoundDocumentIds.slice(0, 3).join(", ")}${notFoundDocumentIds.length > 3 ? "…" : ""}). ` +
          "Use Save & Publish to recreate structure if needed.",
      });
    }
    if (updated > 0) {
      invalidateGranthaCmsCaches(queryClient);
    }
  }

  /** Debounced: mirror full section tree order+titles to Strapi (e.g. after renaming sections). */
  function queueStrapiFullHierarchySectionOrderSync() {
    if (!editingGranthaStrapiDocumentId()) return;
    if (strapiHierarchySyncTimerRef.current) clearTimeout(strapiHierarchySyncTimerRef.current);
    strapiHierarchySyncTimerRef.current = setTimeout(() => {
      strapiHierarchySyncTimerRef.current = null;
      const snap = adhyayasRef.current;
      void runStrapiFullHierarchySectionOrderSync(snap, structureConfigRef.current, false).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        toast({
          variant: "destructive",
          title: "Strapi hierarchy sync failed",
          description: msg,
        });
      });
    }, 500);
  }

  /** Immediate full-tree section PUTs; cancels any pending debounced sync. */
  function flushStrapiFullHierarchySectionOrderSyncNow(
    snapshot: AdhyayaNode[],
    cfg?: GranthaStructureConfig,
    force = false,
  ) {
    if (!force && !editingGranthaStrapiDocumentId()) return;
    if (strapiHierarchySyncTimerRef.current) {
      clearTimeout(strapiHierarchySyncTimerRef.current);
      strapiHierarchySyncTimerRef.current = null;
    }
    const effectiveCfg = cfg ?? structureConfigRef.current;
    void runStrapiFullHierarchySectionOrderSync(snapshot, effectiveCfg, force).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      toast({
        variant: "destructive",
        title: "Strapi hierarchy sync failed",
        description: msg,
      });
    });
  }

  function spliceMantraIntoKhanda(
    prev: AdhyayaNode[],
    adhyayaId: string,
    khandaId: string,
    padaId: string | undefined,
    newManthra: ManthraNode,
    afterManthraId?: string,
    options?: { renumberTitles?: boolean },
  ): AdhyayaNode[] {
    const cfg = structureConfigRef.current;
    const adhyayaIndex = prev.findIndex((a) => a.id === adhyayaId);
    return prev.map((a, aIdx) => {
      if (a.id !== adhyayaId) return a;
      return {
        ...a,
        khandas: a.khandas.map((k, kIdx) => {
          if (k.id !== khandaId) return k;

          const mergeIntoList = (list: ManthraNode[], padaIndex?: number) => {
            // Insert-after: keep editor list sequence (sort-by-order would move order:0 rows to the front).
            const base = afterManthraId != null ? list : sortMantrasByDisplayOrder(list);
            let spliced: ManthraNode[];
            if (afterManthraId) {
              const j = base.findIndex((m) => m.id === afterManthraId);
              if (j < 0) return sortMantrasByDisplayOrder(list);
              spliced = [
                ...base.slice(0, j + 1),
                newManthra,
                ...base.slice(j + 1),
              ];
            } else {
              spliced = [...base, newManthra];
            }
            if (options?.renumberTitles && adhyayaIndex >= 0) {
              const titleCtx = buildMantraTitleCtx(
                adhyayaIndex,
                k,
                kIdx,
                cfg,
                padaIndex,
              );
              return reindexMantrasInListOrder(spliced, titleCtx);
            }
            return assignContiguousMantraOrders(spliced);
          };

          if (cfg.levelThreeEnabled && padaId) {
            return {
              ...k,
              padas: (k.padas ?? []).map((p, pIdx) =>
                p.id === padaId ? { ...p, manthras: mergeIntoList(p.manthras, pIdx) } : p,
              ),
            };
          }
          return { ...k, manthras: mergeIntoList(k.manthras) };
        }),
      };
    });
  }

  function addManthra(adhyayaId: string, khandaId: string, padaId?: string) {
    const newManthraId = uid();
    const adhyayaTitle = adhyayas.find((a) => a.id === adhyayaId)?.title || "";
    track("manthra_added", { grantha_name: formData.GranthaName, adhyaya: adhyayaTitle });
    markRequiresFullPublish();
    setAdhyayas((prev) => {
      const newManthra: ManthraNode = {
        id: newManthraId,
        title: "",
        order: 0,
        _isNewLocal: true,
        Teekas: teekas.map((t) => ({ TeekaName: t.TeekaName, TeekaAuthor: t.TeekaAuthor })),
      };
      const spliced = spliceMantraIntoKhanda(prev, adhyayaId, khandaId, padaId, newManthra);
      const next = mergePublishedHierarchyPreservingContent(prev, spliced);
      adhyayasRef.current = next;
      scheduleStrapiMantraSectionIdentitySync(next, { adhyayaId, khandaId, padaId }, {
        onlyManthraIds: [newManthraId],
      });
      return next;
    });
    openManthraEditor({ adhyayaId, khandaId, manthraId: newManthraId, padaId });
  }

  /**
   * Insert a blank manthra after `afterManthraId` (spreadsheet-style): renumber portal titles
   * in the section, create the CMS row, then batch-update all linked labels in Strapi.
   */
  function insertManthraAfter(
    adhyayaId: string,
    khandaId: string,
    afterManthraId: string,
    padaId?: string,
  ) {
    const newManthraId = uid();
    markRequiresFullPublish();
    markStructuralMantraRenumberPending();
    setAdhyayas((prev) => {
      const anchor = findManthraInTree(prev, adhyayaId, khandaId, afterManthraId, padaId);
      const newManthra: ManthraNode = {
        id: newManthraId,
        title: "",
        order: (anchor?.order ?? 0) + 0.5,
        _isNewLocal: true,
        Teekas: teekas.map((t) => ({ TeekaName: t.TeekaName, TeekaAuthor: t.TeekaAuthor })),
      };
      const spliced = spliceMantraIntoKhanda(
        prev,
        adhyayaId,
        khandaId,
        padaId,
        newManthra,
        afterManthraId,
        { renumberTitles: true },
      );
      const next = mergePublishedHierarchyPreservingContent(prev, spliced);
      adhyayasRef.current = next;
      scheduleStrapiMantraSectionIdentitySync(next, { adhyayaId, khandaId, padaId }, {
        onlyManthraIds: [newManthraId],
        renumberSectionLabels: true,
      });
      return next;
    });
    openManthraEditor({ adhyayaId, khandaId, manthraId: newManthraId, padaId });
  }

  function confirmRemoveManthra(renumber: boolean) {
    if (!pendingRemove) return;
    markRequiresFullPublish();
    if (renumber) markStructuralMantraRenumberPending();
    const { adhyayaId, khandaId, manthraId, padaId } = pendingRemove;
    setPendingRemove(null);

    const granthaDoc =
      editingItem && !editingItem._isDraft
        ? editingItem.documentId
        : editingItem?._strapiDocId;

    let tombstoneForPublish: string | undefined;

    setAdhyayas((prev) => {
      const target = findManthraInTree(prev, adhyayaId, khandaId, manthraId, padaId);
      const strapiMantraId = target?.strapiDocumentId;

      if (isPublishedStrapiDocId(strapiMantraId)) {
        if (isPublishedStrapiDocId(granthaDoc)) {
          pendingMantraDeletesRef.current.add(strapiMantraId);
        } else {
          tombstoneForPublish = strapiMantraId;
        }
      }

      const nextTree = prev.map((a) => {
        if (a.id !== adhyayaId) return a;
        return {
          ...a,
          khandas: a.khandas.map((kh) => {
            if (kh.id !== khandaId) return kh;
            if (padaId) {
              return {
                ...kh,
                padas: (kh.padas ?? []).map((p) => {
                  if (p.id !== padaId) return p;
                  return {
                    ...p,
                    manthras: p.manthras.filter((m) => m.id !== manthraId),
                  };
                }),
              };
            }
            return {
              ...kh,
              manthras: kh.manthras.filter((m) => m.id !== manthraId),
            };
          }),
        };
      });

      const cfg = structureConfigRef.current;
      const finalTree: AdhyayaNode[] = renumber
        ? withNormalizedHierarchy(nextTree, cfg)
        : nextTree.map((a) => {
            if (a.id !== adhyayaId) return a;
            return {
              ...a,
              khandas: a.khandas.map((kh) => {
                if (kh.id !== khandaId) return kh;
                if (padaId) {
                  return {
                    ...kh,
                    padas: (kh.padas ?? []).map((p) => {
                      if (p.id !== padaId) return p;
                      return { ...p, manthras: reindexMantraOrdersPreservingTitles(p.manthras) };
                    }),
                  };
                }
                return { ...kh, manthras: reindexMantraOrdersPreservingTitles(kh.manthras) };
              }),
            };
          });

      scheduleStrapiMantraSectionIdentitySync(finalTree, { adhyayaId, khandaId, padaId }, {
        renumberSectionLabels: renumber,
      });
      return finalTree;
    });

    if (tombstoneForPublish) {
      setDeletedStrapiManthraDocIds((ids) => Array.from(new Set([...ids, tombstoneForPublish!])));
    }
  }

  function updateManthraContent(
    adhyayaId: string,
    khandaId: string,
    manthraId: string,
    updates: Partial<ManthraNode>,
    padaId?: string,
    options?: { markDirty?: boolean }
  ) {
    if (options?.markDirty !== false) {
      setManthraDialogDirty(true);
      markManthraContentChanged(manthraId);
    }
    setAdhyayas((prev) =>
      prev.map((a) => {
        if (a.id !== adhyayaId) return a;
        return {
          ...a,
          khandas: a.khandas.map((k) => {
            if (k.id !== khandaId) return k;
            if (padaId) {
              return {
                ...k,
                padas: (k.padas ?? []).map((p) => {
                  if (p.id !== padaId) return p;
                  return {
                    ...p,
                    manthras: p.manthras.map((m) =>
                      m.id === manthraId ? { ...m, ...updates } : m
                    ),
                  };
                }),
              };
            }
            return {
              ...k,
              manthras: k.manthras.map((m) =>
                m.id === manthraId ? { ...m, ...updates } : m
              ),
            };
          }),
        };
      })
    );
  }

  // Get the currently edited manthra object
  const currentManthra: ManthraNode | null = (() => {
    if (!editingManthra) return null;
    const a = adhyayas.find((x) => x.id === editingManthra.adhyayaId);
    const k = a?.khandas.find((x) => x.id === editingManthra.khandaId);
    const raw =
      editingManthra.padaId
        ? k?.padas?.find((x) => x.id === editingManthra.padaId)?.manthras.find(
            (x) => x.id === editingManthra.manthraId,
          )
        : k?.manthras.find((x) => x.id === editingManthra.manthraId);
    if (!raw) return null;
    const shloka = stripStubTextAndTranslationEntry(raw.ShlokaManthraEntry);
    const bhashyam = stripStubTextAndTranslationEntry(raw.BhashyamForShlokaManthra);
    return {
      ...raw,
      ShlokaManthraEntry: shloka as TextAndTranslation | undefined,
      BhashyamForShlokaManthra: bhashyam as TextAndTranslation | undefined,
    };
  })();

  // ---------- Validation ----------

  function validateSectionTitles(
    nodes: AdhyayaNode[] = adhyayas,
    cfg: typeof structureConfig = structureConfig,
  ): string[] {
    const errors: string[] = [];
    const L1name = cfg?.levelOneName || "Adhyaya";
    const L2name = cfg?.levelTwoName || "Khanda";
    const L3name = cfg?.levelThreeName || "Pada";
    const levelTwoEnabled = cfg?.levelTwoEnabled !== false;
    const levelThreeEnabled = !!cfg?.levelThreeEnabled;
    const levelOneEnabled = cfg?.levelOneEnabled !== false;

    const filled = fillMissingSectionTitles(nodes, cfg);

    filled.forEach((a, ai) => {
      if (levelOneEnabled && !a.title?.trim()) {
        errors.push(`${L1name} #${ai + 1} has no title`);
      }
      if (levelTwoEnabled) {
        (a.khandas ?? []).forEach((k, ki) => {
          if (k.title === "_default") return;
          if (!k.title?.trim()) {
            errors.push(`${L2name} #${ki + 1} inside "${a.title || `${L1name} #${ai + 1}`}" has no title`);
          }
          if (levelThreeEnabled) {
            (k.padas ?? []).forEach((p, pi) => {
              if (!p.title?.trim()) {
                errors.push(`${L3name} #${pi + 1} inside "${k.title || `${L2name} #${ki + 1}`}" has no title`);
              }
            });
          }
        });
      }
    });
    return errors;
  }

  // ---------- Save / Delete / Publish ----------

  async function confirmResetDraftFromStrapi() {
    const item = resetDraftTarget;
    if (!item?._draftId || !item._strapiDocId) {
      setResetDraftTarget(null);
      return;
    }
    const draftId = item._draftId as number;
    const strapiDocId = item._strapiDocId as string;
    setResettingDraftId(draftId);
    try {
      await apiRequest("DELETE", `/api/drafts/${draftId}`);
      await queryClient.invalidateQueries({ queryKey: ["/api/drafts", "granthas"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/strapi", "granthas"] });
      syncGranthaCmsCaches(queryClient);
      closeMantraDialog();
      if (editingDraftId === draftId) {
        const published = (data?.data ?? []).find((g) => g.documentId === strapiDocId);
        if (published && view === "form") {
          await openEdit({ ...published, _isDraft: false });
          toast({
            title: "Portal draft discarded",
            description:
              "Reloaded the published CMS version in the editor. No publish was run.",
          });
        } else {
          resetForm();
          setView("list");
          toast({
            title: "Portal draft discarded",
            description:
              "The published Strapi entry is shown again in the list. Open it to work from live CMS data.",
          });
        }
      } else {
        toast({
          title: "Portal draft discarded",
          description:
            "The published Strapi entry is shown again in the list. Open it to work from live CMS data.",
        });
      }
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Could not discard draft",
        description: err?.message || "Delete draft failed",
      });
    } finally {
      setResettingDraftId(null);
      setResetDraftTarget(null);
    }
  }

  async function handleRecoverSnapshot() {
    if (!editingDraftId) return;
    recoverDraft.mutate(editingDraftId, {
      onSuccess: (data: { draft?: { data?: Record<string, unknown> }; recoveredFrom?: string | null }) => {
        const d = data.draft?.data as Record<string, any> | undefined;
        if (d) {
          applyDraftPayloadToEditor(d, { renormalize: true });
        }
        queryClient.invalidateQueries({ queryKey: ["/api/drafts", "granthas"] });
        toast({
          title: "Draft recovered",
          description: data.recoveredFrom
            ? `Reloaded editor from server snapshot (${new Date(data.recoveredFrom).toLocaleString()}).`
            : "Reloaded editor from the latest server snapshot.",
        });
      },
      onError: (err: Error) => {
        toast({
          variant: "destructive",
          title: "Recover failed",
          description: err.message || "Could not recover the draft snapshot.",
        });
      },
    });
  }

  /** Apply saved draft JSON to the open editor (recover snapshot, without re-fetching Strapi). */
  function applyDraftPayloadToEditor(d: Record<string, any>, opts?: { renormalize?: boolean }) {
    setFormData({
      GranthaName: d.GranthaName || "",
      GranthaType: d.GranthaType || "",
      BhashyamName: d.BhashyamName || "",
      BhashyamAuthor: d.BhashyamAuthor || "",
      IntroductionToTextEnglish: d.IntroductionToTextEnglish || [],
      BhashyakaraIntroductionSanskrit: d.BhashyakaraIntroduction?.SanskritTextEntry || [],
      BhashyakaraIntroductionEnglish: d.BhashyakaraIntroduction?.EnglishTranslationText || [],
      BhashyakaraIntroductionIAST: d.BhashyakaraIntroduction?.IASTTransliteration || [],
      slug: d.slug || "",
      order: d.order != null ? String(d.order) : "",
      introVideoId: d.introVideoId || "",
      introVideoTitle: d.introVideoTitle || "",
    });
    setTeekas(d.teekas || []);
    setOtherTranslations(
      (d.otherTranslations || []).map((t: any) => ({
        ...t,
        text: t.text || [],
      })),
    );
    setGranthaNameTranslations(d.granthaNameTranslations || []);
    setDeletedStrapiSectionDocIds(
      Array.isArray(d.deletedStrapiSectionDocIds) ? d.deletedStrapiSectionDocIds : [],
    );
    setDeletedStrapiManthraDocIds(
      Array.isArray(d.deletedStrapiManthraDocIds) ? d.deletedStrapiManthraDocIds : [],
    );
    setDeletedStrapiTeekaDocIds(
      Array.isArray(d.deletedStrapiTeekaDocIds) ? d.deletedStrapiTeekaDocIds : [],
    );
    const migratedCfg = migrateStructureConfig(d.structureConfig);
    const rawHier = d.hierarchy || [];
    const hier =
      d.structureConfig?.leafName === "Khanda"
        ? migrateHierarchyLeafName(rawHier, "Khanda", "Mantra")
        : rawHier;
    const prep = prepareHierarchyForContentStep(hier, migratedCfg);
    setStructureConfig(migratedCfg);
    const base = sanitizeHierarchyPortalMeta(prep.hierarchy as AdhyayaNode[]);
    const normalized = opts?.renormalize
      ? withNormalizedHierarchy(base, migratedCfg)
      : base;
    adhyayasRef.current = normalized;
    setAdhyayas(normalized);
    applyPublishScopeFromDraft(d);
    publishScopeMetaEffectSkipRef.current = true;
    setEditingManthra(null);
    setManthraDialogViewOnly(false);
  }

  function buildSavePayload(): Record<string, any> {
    const cfg = structureConfigRef.current ?? structureConfig;
    const tree = fillMissingSectionTitles(
      (adhyayasRef.current.length > 0 ? adhyayasRef.current : adhyayas) as AdhyayaNode[],
      cfg,
    );
    let hierarchyForPayload = hierarchyForSave(tree, cfg);
    // Spreadsheet insert/delete already ran list-order renumber; only run full-tree normalize
    // when duplicate verse suffixes remain (not on every structural edit flag).
    if (
      hierarchyHasDuplicateMantraSuffixes(hierarchyForPayload, cfg.leafName || "Mantra", {
        levelThreeEnabled: cfg.levelThreeEnabled,
      })
    ) {
      hierarchyForPayload = withNormalizedHierarchy(hierarchyForPayload, cfg);
    }
    hierarchyForPayload = repairDuplicateSuffixesInHierarchy(hierarchyForPayload, cfg);
    if (strapiSectionIndexRef.current.childrenByParentDocId?.size) {
      hierarchyForPayload = dropKhandasDuplicatingDefaultMantraSection(
        hierarchyForPayload,
        cfg,
        strapiSectionIndexRef.current.childrenByParentDocId!,
      );
    }
    adhyayasRef.current = hierarchyForPayload;

    const payload: Record<string, any> = {
      GranthaName: formData.GranthaName,
      GranthaType: formData.GranthaType || undefined,
      BhashyamName: formData.BhashyamName || undefined,
      BhashyamAuthor: formData.BhashyamAuthor || undefined,
      teekas,
      otherTranslations,
      granthaNameTranslations,
      structureConfig: cfg,
      hierarchy: hierarchyForPayload,
      deletedStrapiSectionDocIds: deletedStrapiSectionDocIds.length > 0 ? deletedStrapiSectionDocIds : undefined,
      deletedStrapiManthraDocIds: deletedStrapiManthraDocIds.length > 0 ? deletedStrapiManthraDocIds : undefined,
      deletedStrapiTeekaDocIds: deletedStrapiTeekaDocIds.length > 0 ? deletedStrapiTeekaDocIds : undefined,
      publishScope: publishScopeForPayload(),
    };

    if (formData.slug.trim()) payload.slug = formData.slug.trim();
    if (formData.order.trim()) {
      const n = parseInt(formData.order, 10);
      if (!isNaN(n)) payload.order = n;
    }
    if (formData.introVideoId.trim()) payload.introVideoId = formData.introVideoId.trim();
    if (formData.introVideoTitle.trim()) payload.introVideoTitle = formData.introVideoTitle.trim();

    if (hasBlocks(formData.IntroductionToTextEnglish)) {
      payload.IntroductionToTextEnglish = formData.IntroductionToTextEnglish;
    }

    if (
      hasBlocks(formData.BhashyakaraIntroductionSanskrit) ||
      hasBlocks(formData.BhashyakaraIntroductionEnglish) ||
      hasBlocks(formData.BhashyakaraIntroductionIAST) ||
      otherTranslations.length > 0
    ) {
      payload.BhashyakaraIntroduction = {
        ...(hasBlocks(formData.BhashyakaraIntroductionSanskrit)
          ? { SanskritTextEntry: formData.BhashyakaraIntroductionSanskrit }
          : {}),
        ...(hasBlocks(formData.BhashyakaraIntroductionEnglish)
          ? { EnglishTranslationText: formData.BhashyakaraIntroductionEnglish }
          : {}),
        ...(hasBlocks(formData.BhashyakaraIntroductionIAST)
          ? { IASTTransliteration: formData.BhashyakaraIntroductionIAST }
          : {}),
        ...(otherTranslations.length > 0
          ? {
              OtherTranslations: otherTranslations.map((t) => ({
                LanguageOfTranslation: t.language,
                TranslationText: hasBlocks(t.text) ? t.text : undefined,
              })),
            }
          : {}),
      };
    }

    return payload;
  }

  // "Save" — persist portal draft only (labels/order/content); CMS sync waits for Save & Publish
  function handleSave() {
    if (!formData.GranthaName.trim()) {
      toast({ variant: "destructive", title: "Grantha Name is required" });
      return;
    }
    setPersistInFlight(true);
    void (async () => {
      try {
        await ensureMantraSlotsAndLabelsSyncedBeforePersist("draft");
        const payload = buildSavePayload();
        setAdhyayas(payload.hierarchy as AdhyayaNode[]);
        const strapiDocId =
          editingItem && !editingItem._isDraft
            ? editingItem.documentId
            : editingItem?._strapiDocId || undefined;

        const saved = await saveDraft.mutateAsync({
          title: formData.GranthaName,
          data: payload,
          strapiDocumentId: strapiDocId,
          draftId: editingDraftId ?? undefined,
        });
        track("draft_saved", {
          grantha_name: formData.GranthaName,
          grantha_type: formData.GranthaType,
          has_strapi_link: !!strapiDocId,
          teeka_count: teekas.length,
        });
        if (!editingDraftId && saved?.id) {
          setEditingDraftId(saved.id);
        }
        markEditorSyncedForPublish();
        setPersistProgress({
          title: "Saving draft",
          done: 1,
          total: 1,
          current: "Draft saved",
        });
        toast({
          title: "Draft saved",
          description:
            "Portal draft updated. Use Save & Publish when ready to sync verse labels to CMS.",
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        toast({
          variant: "destructive",
          title: "Save failed",
          description: msg,
        });
      } finally {
        setPersistInFlight(false);
        setTimeout(() => setPersistProgress(null), 800);
      }
    })();
  }

  function runGranthaPublishAfterPreflight(resolvedDraftId: number) {
    void (async () => {
      setPersistInFlight(true);
      try {
        toast({
          title: "Preparing publish",
          description: structuralMantraRenumberPendingRef.current
            ? "Structural verse changes detected — publishing your draft as a fresh CMS grantha with all verses and content. This may take several minutes…"
            : "Syncing verse slots and labels to CMS from your draft (large granthas may take several minutes)…",
        });
        await ensureMantraSlotsAndLabelsSyncedBeforePersist("publish");
        setPersistProgress({
          title: "Saving draft before publish",
          done: 0,
          total: 1,
          current: "Writing portal draft…",
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        toast({
          variant: "destructive",
          title: "Could not sync verses before publish",
          description: msg,
        });
        setPersistProgress(null);
        return;
      } finally {
        setPersistInFlight(false);
      }
      try {
        const payload = buildSavePayload();
        await saveDraft.mutateAsync({
          title: formData.GranthaName,
          data: payload,
          strapiDocumentId:
            editingItem && !editingItem._isDraft
              ? editingItem.documentId
              : editingItem?._strapiDocId || undefined,
          draftId: resolvedDraftId,
        });
        markEditorSyncedForPublish();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        toast({
          variant: "destructive",
          title: "Could not save draft before publish",
          description: msg,
        });
        setPersistProgress(null);
        return;
      }

      try {
        setPersistProgress({
          title: "Publish preflight",
          done: 0,
          total: 1,
          current: "Checking verse integrity…",
        });
        const preRes = await apiRequest(
          "POST",
          `/api/drafts/${resolvedDraftId}/publish-preflight`,
        );
        const pre = await preRes.json();
        if (!pre.ok) {
          setPersistProgress(null);
          toast({
            variant: "destructive",
            title: "Publish blocked — integrity check",
            description:
              pre.message ||
              "Fix verse labels and content issues shown in the draft before publishing.",
          });
          return;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setPersistProgress(null);
        toast({
          variant: "destructive",
          title: "Publish preflight failed",
          description: msg,
        });
        return;
      }

      armPublishSyncGuard();
      const allowRenumber = structuralMantraRenumberPendingRef.current;
      setPersistProgress({
        title: "Publishing to Strapi",
        done: 0,
        total: 1,
        current: "Starting publish job…",
      });
      publishDraft.mutate(
        allowRenumber ? { draftId: resolvedDraftId, allowRenumber: true } : resolvedDraftId,
        {
        onSuccess: (result: any) => {
          setPersistProgress(null);
          structuralMantraRenumberPendingRef.current = false;
          resetPublishScope();
          markEditorSyncedForPublish();
          track("grantha_published", {
            grantha_name: formData.GranthaName,
            grantha_type: formData.GranthaType,
            teeka_count: teekas.length,
          });
          const updatedHierarchy = result?.draft?.data?.hierarchy;
          const newStrapiDocId = result?.draft?.strapiDocumentId;
          const granthaSidForFlush =
            newStrapiDocId ||
            (editingItem && !editingItem._isDraft ? editingItem.documentId : editingItem?._strapiDocId);
          if (Array.isArray(updatedHierarchy)) {
            const merged = mergePublishedHierarchyPreservingContent(
              adhyayasRef.current,
              updatedHierarchy as AdhyayaNode[],
            );
            const nh = repairDuplicateSuffixesInHierarchy(
              hierarchyForSave(merged as AdhyayaNode[], structureConfig),
              structureConfig,
            );
            adhyayasRef.current = nh;
            setAdhyayas(nh);
            if (isPublishedStrapiDocId(granthaSidForFlush)) {
              void runStrapiFullHierarchySectionOrderSync(nh, structureConfig, true);
            }
          }
          syncGranthaCmsCaches(queryClient);
          queryClient.setQueryData(["/api/drafts", "granthas"], (old: any[] | undefined) =>
            old?.map((d) =>
              d.id === resolvedDraftId ? { ...d, status: "published", strapiDocumentId: newStrapiDocId ?? d.strapiDocumentId } : d,
            ),
          );
          if (newStrapiDocId && editingItem) {
            setEditingItem({
              ...editingItem,
              _isDraft: false,
              documentId: newStrapiDocId,
              _strapiDocId: newStrapiDocId,
            });
          } else if (editingItem) {
            setEditingItem({ ...editingItem, _isDraft: false });
          }
          setDeletedStrapiSectionDocIds([]);
          setDeletedStrapiTeekaDocIds([]);
          setDeletedStrapiManthraDocIds([]);
        },
        onError: (err: any) => {
          setPersistProgress(null);
          track("publish_failed", {
            grantha_name: formData.GranthaName,
            error: err?.message || "unknown",
          });
          const violations = err?.violations as Array<{ message?: string }> | undefined;
          if (Array.isArray(violations) && violations.length > 0) {
            toast({
              variant: "destructive",
              title: "Publish blocked",
              description: violations
                .slice(0, 3)
                .map((v) => v.message)
                .filter(Boolean)
                .join(" "),
            });
          }
        },
      });
    })();
  }

  // "Save & Publish" — requires an up-to-date portal draft, then full publish to Strapi
  function handleSaveAndPublish() {
    if (!formData.GranthaName.trim()) {
      toast({ variant: "destructive", title: "Grantha Name is required" });
      return;
    }
    if (!editingDraftId) {
      toast({
        variant: "destructive",
        title: "Save draft first",
        description: "Use Save to store your work in the portal before publishing to the CMS.",
      });
      return;
    }
    if (!draftSyncedForPublish) {
      toast({
        variant: "destructive",
        title: "Unsaved changes",
        description: "Save draft first — your latest edits are not in the portal draft yet.",
      });
      return;
    }
    runGranthaPublishAfterPreflight(editingDraftId);
  }

  // Save the full grantha draft from inside the manthra modal (prevents data loss on session timeout)
  function handleSaveManthra(onDone?: () => void) {
    if (!formData.GranthaName.trim()) {
      toast({ variant: "destructive", title: "Grantha Name is required" });
      return;
    }
    if (!editingManthra || !currentManthra) {
      toast({ variant: "destructive", title: "No mantra selected" });
      return;
    }

    // Fast path: patch only the edited mantra node into the existing draft.
    if (editingDraftId) {
      saveManthraPatchMutation.mutate(
        {
          draftId: editingDraftId,
          title: formData.GranthaName,
          adhyayaId: editingManthra.adhyayaId,
          khandaId: editingManthra.khandaId,
          padaId: editingManthra.padaId,
          manthraId: editingManthra.manthraId,
          manthraData: currentManthra,
        },
        {
          onSuccess: () => {
            setManthraDialogDirty(false);
            markEditorSyncedForPublish();
            toast({ title: "Draft saved", description: "Content saved to database." });
            onDone?.();
          },
          onError: () => {
            // Fallback to full draft save to guarantee no data loss if patch path fails.
            const payload = buildSavePayload();
            const strapiDocId =
              editingItem && !editingItem._isDraft
                ? editingItem.documentId
                : editingItem?._strapiDocId || undefined;
            saveDraft.mutate(
              { title: formData.GranthaName, data: payload, strapiDocumentId: strapiDocId, draftId: editingDraftId },
              {
                onSuccess: (saved: any) => {
                  if (!editingDraftId && saved?.id) setEditingDraftId(saved.id);
                  setManthraDialogDirty(false);
                  markEditorSyncedForPublish();
                  toast({ title: "Draft saved", description: "Content saved to database." });
                  onDone?.();
                },
              }
            );
          },
        }
      );
      return;
    }

    const payload = buildSavePayload();
    const strapiDocId =
      editingItem && !editingItem._isDraft
        ? editingItem.documentId
        : editingItem?._strapiDocId || undefined;
    saveDraft.mutate(
      { title: formData.GranthaName, data: payload, strapiDocumentId: strapiDocId, draftId: editingDraftId ?? undefined },
      {
        onSuccess: (saved: any) => {
          if (!editingDraftId && saved?.id) setEditingDraftId(saved.id);
          setManthraDialogDirty(false);
          markEditorSyncedForPublish();
          toast({ title: "Draft saved", description: "Content saved to database." });
          onDone?.();
        },
      }
    );
  }

  // Auto-save the draft silently then close the mantra dialog.
  // Closing the dialog should NEVER persist data implicitly.
  // Draft persistence is allowed only via explicit Save / Save & Publish actions.
  function closeMantraDialog() {
    setEditingManthra(null);
    setManthraDialogDirty(false);
    setManthraDialogViewOnly(false);
    setPendingCloseManthra(false);
    mantraOpenSnapshotRef.current = null;
  }

  /** Remove one mantra row from the tree (portal order only; titles unchanged). */
  function removeManthraRowFromTree(
    adhyayaId: string,
    khandaId: string,
    manthraId: string,
    padaId?: string,
  ) {
    setAdhyayas((prev) =>
      prev.map((a) => {
        if (a.id !== adhyayaId) return a;
        return {
          ...a,
          khandas: a.khandas.map((kh) => {
            if (kh.id !== khandaId) return kh;
            if (padaId) {
              return {
                ...kh,
                padas: (kh.padas ?? []).map((p) => {
                  if (p.id !== padaId) return p;
                  return {
                    ...p,
                    manthras: reindexMantraOrdersPreservingTitles(
                      p.manthras.filter((m) => m.id !== manthraId),
                    ),
                  };
                }),
              };
            }
            return {
              ...kh,
              manthras: reindexMantraOrdersPreservingTitles(
                kh.manthras.filter((m) => m.id !== manthraId),
              ),
            };
          }),
        };
      }),
    );
    clearManthraFromChangedSet(manthraId);
  }

  /** Revert this verse to how it was when the dialog opened; close without save or publish. */
  function discardMantraEditsAndClose() {
    if (!editingManthra) {
      closeMantraDialog();
      return;
    }
    const { adhyayaId, khandaId, manthraId, padaId } = editingManthra;
    const openSnap = mantraOpenSnapshotRef.current;
    setPendingCloseManthra(false);

    if (openSnap?.wasNewLocal && !openSnap.node?.strapiDocumentId) {
      removeManthraRowFromTree(adhyayaId, khandaId, manthraId, padaId);
    } else if (openSnap?.node) {
      const prior = openSnap.node;
      updateManthraContent(
        adhyayaId,
        khandaId,
        manthraId,
        {
          title: prior.title,
          order: prior.order,
          strapiDocumentId: prior.strapiDocumentId,
          ShlokaManthraEntry: prior.ShlokaManthraEntry,
          BhashyamForShlokaManthra: prior.BhashyamForShlokaManthra,
          Teekas: prior.Teekas,
          _isNewLocal: prior._isNewLocal,
        },
        padaId,
        { markDirty: false },
      );
      clearManthraFromChangedSet(manthraId);
    }

    manthraDialogDirtyRef.current = false;
    setManthraDialogDirty(false);
    closeMantraDialog();
    toast({
      title: "Changes discarded",
      description: "This verse was restored to how it was when you opened it.",
    });
  }

  /** Reload this verse from published CMS content — no publish. */
  async function restoreMantraFromPublishedCms() {
    if (!editingManthra) return;
    const docId =
      editingManthra.strapiDocumentId ||
      findManthraInTree(
        adhyayasRef.current,
        editingManthra.adhyayaId,
        editingManthra.khandaId,
        editingManthra.manthraId,
        editingManthra.padaId,
      )?.strapiDocumentId;
    if (!isPublishedStrapiDocId(docId)) {
      toast({
        variant: "destructive",
        title: "Not in CMS yet",
        description: "This verse has no published Strapi row to restore from.",
      });
      return;
    }

    setPendingCloseManthra(false);
    setManthraLoading(true);
    try {
      const result = await fetchManthraForGranthaEditor({ documentId: docId });
      if (!result?.data) {
        toast({
          variant: "destructive",
          title: "Restore failed",
          description: "Could not load this verse from the CMS.",
        });
        return;
      }
      const configuredLeaf = (structureConfigRef.current.leafName || "Mantra").trim() || "Mantra";
      const strapiLabel = String(result.data.ShlokaManthraNumber ?? "");
      const cmsShloka = stripStubTextAndTranslationEntry(result.data.ShlokaManthraEntry);
      const cmsBhashyam = stripStubTextAndTranslationEntry(result.data.BhashyamEntry);
      updateManthraContent(
        editingManthra.adhyayaId,
        editingManthra.khandaId,
        editingManthra.manthraId,
        {
          strapiDocumentId: docId,
          title: portalMantraTitleForLeaf("", configuredLeaf, strapiLabel),
          ShlokaManthraEntry: cmsShloka as TextAndTranslation | undefined,
          BhashyamForShlokaManthra: cmsBhashyam as TextAndTranslation | undefined,
          _isNewLocal: false,
        },
        editingManthra.padaId,
        { markDirty: false },
      );
      clearManthraFromChangedSet(editingManthra.manthraId);
      manthraDialogDirtyRef.current = false;
      setManthraDialogDirty(false);
      closeMantraDialog();
      toast({
        title: "Restored from CMS",
        description: "This verse now matches the published Strapi version. Nothing was published.",
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ variant: "destructive", title: "Restore failed", description: msg });
    } finally {
      setManthraLoading(false);
    }
  }

  /** Reload entire grantha editor from the last server draft snapshot (admin). */
  function restoreDraftSnapshotAndCloseMantra() {
    if (!editingDraftId) return;
    setPendingCloseManthra(false);
    recoverDraft.mutate(editingDraftId, {
      onSuccess: (data: { draft?: { data?: Record<string, unknown> }; recoveredFrom?: string | null }) => {
        const d = data.draft?.data as Record<string, any> | undefined;
        if (d) {
          applyDraftPayloadToEditor(d, { renormalize: false });
        }
        manthraDialogDirtyRef.current = false;
        setManthraDialogDirty(false);
        closeMantraDialog();
        toast({
          title: "Draft restored",
          description: data.recoveredFrom
            ? `Reloaded from server snapshot (${new Date(data.recoveredFrom).toLocaleString()}). No publish was run.`
            : "Reloaded from the latest server snapshot. No publish was run.",
        });
      },
    });
  }

  function requestDiscardPortalDraftFromMantra() {
    if (!editingDraftId || !editingGranthaStrapiDocumentId()) return;
    setPendingCloseManthra(false);
    setResetDraftTarget({
      ...(editingItem ?? {}),
      _draftId: editingDraftId,
      _strapiDocId: editingGranthaStrapiDocumentId(),
      GranthaName: formData.GranthaName || editingItem?.GranthaName,
    });
  }

  function requestCloseMantraDialog() {
    const node = currentManthra;
    const needsConfirm =
      !manthraDialogViewOnly &&
      (manthraDialogDirty || isNewLocalManthra(node ?? ({} as ManthraNode)));
    if (needsConfirm) {
      setPendingCloseManthra(true);
      return;
    }
    closeMantraDialog();
  }

  // Publish the open manthra in one request (server merges into draft + Strapi PUT).
  function handleSaveAndPublishManthra() {
    if (!editingManthra || !currentManthra) return;
    if (!formData.GranthaName.trim()) {
      toast({ variant: "destructive", title: "Grantha Name is required" });
      return;
    }
    if (!editingDraftId) {
      toast({
        variant: "destructive",
        title: "Save draft first",
        description: "Save the grantha draft before publishing this verse to the CMS.",
      });
      return;
    }
    if (manthraDialogDirty) {
      toast({
        variant: "destructive",
        title: "Unsaved verse changes",
        description: "Use Save in this dialog before publishing this verse.",
      });
      return;
    }

    publishMantraMutation.mutate({
      draftId: editingDraftId,
      adhyayaId: editingManthra.adhyayaId,
      khandaId: editingManthra.khandaId,
      padaId: editingManthra.padaId,
      manthraId: editingManthra.manthraId,
      manthraData: currentManthra,
    });
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    if (deleteTarget._isDraft) {
      deleteDraft.mutate(deleteTarget._draftId, {
        onSuccess: () => setDeleteTarget(null),
      });
    } else {
      deleteStrapiMutation.mutate(deleteTarget.documentId);
    }
  }

  function handlePublish(item: any) {
    if (item._draftId) {
      armPublishSyncGuard();
      publishDraft.mutate(item._draftId);
    }
  }

  // Collect which Strapi documentIds are currently being edited by a draft
  // so we can hide the "published" card and only show the draft.
  const draftedStrapiIds = new Set(
    unpublishedDrafts.map((d) => d.strapiDocumentId).filter(Boolean) as string[]
  );

  // Deduplicate drafts by Grantha name — keep only the most recently updated
  // one per name so the list doesn't show multiple Draft cards for the same text.
  const seenDraftNames = new Set<string>();
  const deduplicatedDrafts = [...unpublishedDrafts]
    .sort((a, b) => {
      const tb = b.updatedAt != null ? new Date(b.updatedAt).getTime() : 0;
      const ta = a.updatedAt != null ? new Date(a.updatedAt).getTime() : 0;
      return tb - ta;
    })
    .filter((d) => {
      const name = ((d.data as any)?.GranthaName ?? "").toLowerCase().trim() || String(d.id);
      if (seenDraftNames.has(name)) return false;
      seenDraftNames.add(name);
      return true;
    });

  const saveAndPublishReady =
    editingDraftId != null &&
    draftSyncedForPublish &&
    !saveDraft.isPending &&
    !publishDraft.isPending &&
    !persistInFlight;
  const saveAndPublishHint = !editingDraftId
    ? "Save draft first to enable Save & Publish"
    : !draftSyncedForPublish
      ? "Save your latest changes before publishing"
      : persistInFlight
        ? "Finishing draft or CMS sync…"
        : structuralMantraRenumberPendingRef.current
          ? "+/delete changes are in the draft; Save then Save & Publish to push labels to CMS"
          : undefined;
  const mantraSaveAndPublishReady =
    editingDraftId != null &&
    !manthraDialogDirty &&
    !saveDraft.isPending &&
    !saveManthraPatchMutation.isPending &&
    !publishMantraMutation.isPending;
  const mantraSaveAndPublishHint = !editingDraftId
    ? "Save the grantha draft first"
    : manthraDialogDirty
      ? "Save this verse before publishing"
      : undefined;

  const activeEditorProgress: EditorOperationProgress | null =
    publishDraft.isPending && publishProgress && publishProgress.total > 0
      ? {
          title: "Publishing to Strapi",
          done: publishProgress.done,
          total: publishProgress.total,
          current: publishProgress.current,
          summary: publishProgress.summary,
        }
      : persistProgress;

  const mergedData = [
    ...deduplicatedDrafts.map((d) => ({
      ...(d.data as any),
      _isDraft: true,
      _draftId: d.id,
      _draftStatus: d.status,
      _strapiDocId: d.strapiDocumentId,
      _draftData: d.data,
      _createdBy: d.createdBy,
    })),
    // Suppress published Strapi entry when a local draft is editing it
    ...(data?.data || [])
      .filter((item) => !draftedStrapiIds.has(item.documentId))
      .map((item) => {
        const linkedDraft = allGranthaDrafts.find(
          (d) => d.strapiDocumentId === item.documentId
        );
        return {
          ...item,
          _isDraft: false,
          _draftStatus: "published",
          _createdBy: linkedDraft?.createdBy ?? null,
        };
      }),
  ];

  // ---------- Render: List ----------

  if (view === "list") {
    return (
      <div className="p-6 lg:p-8 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">All the Granthas</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Browse library to update existing content
            </p>
          </div>
          <div className="flex items-center gap-3">
            <StrapiSyncBar />
            <Button onClick={openAdd} data-testid="button-new-grantha">
              <Plus className="w-4 h-4 mr-2" />
              New Entry
            </Button>
          </div>
        </div>

        {isLoading || isLoadingDrafts ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="rounded-xl border bg-card p-5 h-36 animate-pulse" />
            ))}
          </div>
        ) : mergedData.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-muted-foreground gap-4">
            <BookOpen className="w-14 h-14 opacity-20" />
            <p className="text-sm">No granthas yet — create your first entry.</p>
            <Button onClick={openAdd} variant="outline">
              <Plus className="w-4 h-4 mr-2" />
              New Entry
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {(() => {
              // Detect duplicate grantha names (case-insensitive, trimmed)
              const normalizedNames = mergedData.map((item) =>
                (item.GranthaName || "").trim().toLowerCase()
              );
              const nameCounts: Record<string, number> = {};
              normalizedNames.forEach((n) => {
                if (n) nameCounts[n] = (nameCounts[n] || 0) + 1;
              });
              const duplicateSet = new Set(
                Object.entries(nameCounts)
                  .filter(([, count]) => count > 1)
                  .map(([name]) => name)
              );
              return mergedData.map((item, idx) => {
                const norm = (item.GranthaName || "").trim().toLowerCase();
                return (
                  <GranthaCard
                    key={item.documentId || item._draftId || idx}
                    item={item}
                    onEdit={() => openEdit(item)}
                    onView={openView}
                    onDelete={() => setDeleteTarget(item)}
                    onPublish={() => handlePublish(item)}
                    onResetDraftFromStrapi={
                      item._isDraft && item._strapiDocId
                        ? () => setResetDraftTarget(item)
                        : undefined
                    }
                    isPublishing={
                      publishDraft.isPending &&
                      (publishDraft.variables as number) === item._draftId
                    }
                    publishProgress={
                      publishDraft.isPending &&
                      (publishDraft.variables as number) === item._draftId
                        ? publishProgress
                        : null
                    }
                    isResettingDraft={resettingDraftId === item._draftId}
                    currentUserId={user?.id}
                    isDuplicate={norm ? duplicateSet.has(norm) : false}
                    isLocked={!!(item.documentId && lockedDocIds.has(item.documentId))}
                    isAdmin={isAdmin}
                    onLock={() => lockMutation.mutate({ docId: item.documentId, granthaName: item.GranthaName })}
                    onUnlock={() => unlockMutation.mutate(item.documentId)}
                  />
                );
              });
            })()}
          </div>
        )}

        <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Delete {deleteTarget?._isDraft ? "Draft" : "Grantha"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete &quot;{deleteTarget?.GranthaName}&quot;?
                {!deleteTarget?._isDraft && " This will remove it from the CMS."}
                {deleteTarget?._isDraft && " This draft has not been published yet."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                data-testid="button-confirm-delete"
              >
                {(deleteStrapiMutation.isPending || deleteDraft.isPending) && (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                )}
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={!!resetDraftTarget} onOpenChange={(open) => { if (!open) setResetDraftTarget(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard portal draft?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes the portal draft for &quot;{resetDraftTarget?.GranthaName}&quot; only. Published
                content in Strapi is unchanged. The card will show as <strong>Published</strong> again in the list.
                Open that entry to edit from live CMS data. (Not the same as Recover Snapshot.)
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={resettingDraftId != null}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => void confirmResetDraftFromStrapi()}
                disabled={resettingDraftId != null}
                data-testid="button-confirm-reset-draft-strapi"
              >
                {resettingDraftId != null && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Discard draft
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

      </div>
    );
  }

  // ---------- Render: Form ----------

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto">
      {/* View-only banner */}
      {viewOnly && (() => {
        const itemDocId = editingItem?.documentId || editingItem?._strapiDocId;
        const lockInfo = itemDocId ? (locksData ?? []).find((l: any) => l.granthaDocId === itemDocId) : null;
        const isItemLocked = !!lockInfo;
        return (
          <div className={`flex items-center justify-between gap-3 mb-6 px-4 py-3 rounded-lg border ${isItemLocked ? "bg-orange-50 dark:bg-orange-950/20 border-orange-200 dark:border-orange-800" : "bg-muted/60 border-border"}`}>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {isItemLocked ? <Lock className="w-4 h-4 shrink-0 text-orange-600 dark:text-orange-400" /> : <Eye className="w-4 h-4 shrink-0" />}
              <span>
                {isItemLocked
                  ? <>
                      <strong>{formData.GranthaName}</strong> is <strong className="text-orange-700 dark:text-orange-400">blocked from editing</strong>.
                      {lockInfo.lockedByUsername && <> Locked by <strong>{lockInfo.lockedByUsername}</strong>.</>}
                      {lockInfo.reason && <> Reason: {lockInfo.reason}.</>}
                      {isAdmin && " You can remove the blocker from the grantha list."}
                    </>
                  : <>You are viewing <strong>{formData.GranthaName}</strong> in read-only mode. No changes can be made.</>
                }
              </span>
            </div>
            <Button size="sm" variant="outline" onClick={() => { setView("list"); resetForm(); }} data-testid="button-close-view">
              Close
            </Button>
          </div>
        );
      })()}

      {/* Step indicator — hidden in view-only mode */}
      {!viewOnly && (
        <div className="flex items-end gap-0 mb-10">
          <StepDot n={1} active={step === 1} done={step > 1} label="Configuration" />
          <div className={`flex-1 h-0.5 mb-5 transition-colors ${step > 1 ? "bg-primary" : "bg-border"}`} />
          <StepDot n={2} active={step === 2} done={step > 2} label="Book Structure" />
          <div className={`flex-1 h-0.5 mb-5 transition-colors ${step > 2 ? "bg-primary" : "bg-border"}`} />
          <StepDot n={3} active={step === 3} done={false} label="Build Content" />
        </div>
      )}

      {step === 1 ? (
        /* ====== STEP 1 ====== */
        <div className="space-y-6">
          <div>
            <h2 className="text-xl font-semibold">Grantha Configuration</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Set up the basic details of the sacred text
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>Grantha Name *</Label>
              <Input
                value={formData.GranthaName}
                onChange={(e) => setFormData({ ...formData, GranthaName: e.target.value })}
                placeholder="e.g., Chandogya Upanishad"
                className="mt-1.5"
                data-testid="input-grantha-name"
              />
            </div>
            <div>
              <Label>Grantha Type</Label>
              <Select
                value={formData.GranthaType}
                onValueChange={(val) => setFormData({ ...formData, GranthaType: val })}
              >
                <SelectTrigger className="mt-1.5" data-testid="select-grantha-type">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {granthaTypes.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Bhashyam Name</Label>
              <Input
                value={formData.BhashyamName}
                onChange={(e) => setFormData({ ...formData, BhashyamName: e.target.value })}
                placeholder="e.g., Chandogya Bhashyam"
                className="mt-1.5"
                data-testid="input-bhashyam-name"
              />
            </div>
            <div>
              <Label>Bhashyam Author</Label>
              <Select
                value={formData.BhashyamAuthor}
                onValueChange={(val) => setFormData({ ...formData, BhashyamAuthor: val })}
              >
                <SelectTrigger className="mt-1.5" data-testid="select-bhashyam-author">
                  <SelectValue placeholder="Select author" />
                </SelectTrigger>
                <SelectContent>
                  {bhashyamAuthorOptions.map((a) => (
                    <SelectItem key={a} value={a}>{a}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isAdmin && (
                <div className="mt-2 flex gap-2">
                  <Input
                    value={newSharedOption.bhashyamAuthors}
                    onChange={(e) => updateSharedOptionDraft("bhashyamAuthors", e.target.value)}
                    placeholder="Add new Bhashyam author"
                    className="h-9"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void addSharedOption("bhashyamAuthors", (value) =>
                          setFormData({ ...formData, BhashyamAuthor: value }),
                        );
                      }
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={addingSharedOptionKey === "bhashyamAuthors"}
                    onClick={() =>
                      void addSharedOption("bhashyamAuthors", (value) =>
                        setFormData({ ...formData, BhashyamAuthor: value }),
                      )
                    }
                  >
                    {addingSharedOptionKey === "bhashyamAuthors" ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Plus className="w-4 h-4" />
                    )}
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Introductions */}
          <div className="border rounded-xl p-5 space-y-4">
            <div>
              <h3 className="font-semibold">Introductions</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                English introduction to the text and the Bhashyakara's introduction in Sanskrit &amp; English
              </p>
            </div>

            <div>
              <Label>Introduction to Text (English)</Label>
              <RichTextEditor
                value={formData.IntroductionToTextEnglish}
                onChange={(v) => setFormData({ ...formData, IntroductionToTextEnglish: v })}
                placeholder="Brief English introduction to this Grantha..."
                className="mt-1.5"
                minHeight={100}
                data-testid="textarea-introduction-english"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t">
              <div>
                <Label className="flex items-center gap-1.5">
                  Bhashyakara Introduction
                  <span className="text-xs text-muted-foreground font-normal">(Sanskrit)</span>
                </Label>
                <RichTextEditor
                  value={formData.BhashyakaraIntroductionSanskrit}
                  onChange={(v) => setFormData({ ...formData, BhashyakaraIntroductionSanskrit: v })}
                  placeholder="Sanskrit commentary introduction..."
                  className="mt-1.5"
                  minHeight={130}
                  data-testid="textarea-bhashyakara-sanskrit"
                />
              </div>
              <div>
                <Label className="flex items-center gap-1.5">
                  Bhashyakara Introduction
                  <span className="text-xs text-muted-foreground font-normal">(English)</span>
                </Label>
                <RichTextEditor
                  value={formData.BhashyakaraIntroductionEnglish}
                  onChange={(v) => setFormData({ ...formData, BhashyakaraIntroductionEnglish: v })}
                  placeholder="English translation of commentary introduction..."
                  className="mt-1.5"
                  minHeight={130}
                  data-testid="textarea-bhashyakara-english"
                />
              </div>
            </div>

            {/* IAST Transliteration */}
            <div className="pt-2 border-t">
              <Label className="flex items-center gap-1.5">
                Bhashyakara Introduction
                <span className="text-xs text-muted-foreground font-normal">(IAST Romanisation)</span>
              </Label>
              <RichTextEditor
                value={formData.BhashyakaraIntroductionIAST}
                onChange={(v) => setFormData({ ...formData, BhashyakaraIntroductionIAST: v })}
                placeholder="IAST transliteration of the commentary introduction..."
                className="mt-1.5"
                minHeight={100}
                data-testid="textarea-bhashyakara-iast"
              />
            </div>

            {/* Other Language Translations (repeatable) */}
            <div className="pt-2 border-t">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <Label>Other Language Translations</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Translations of the Bhashyakara Introduction in other languages
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={addOtherTranslation}
                  data-testid="button-add-other-translation"
                >
                  <Plus className="w-3.5 h-3.5 mr-1.5" />
                  Add Translation
                </Button>
              </div>

              {otherTranslations.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No other translations added yet
                </p>
              ) : (
                <div className="space-y-3">
                  {otherTranslations.map((t, i) => (
                    <div
                      key={t.id}
                      className="p-3 bg-muted/40 rounded-lg space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <Select
                          value={t.language}
                          onValueChange={(val) => updateOtherTranslation(t.id, "language", val)}
                        >
                          <SelectTrigger
                            className="h-8 text-sm w-48"
                            data-testid={`select-other-translation-language-${i}`}
                          >
                            <SelectValue placeholder="Select language" />
                          </SelectTrigger>
                          <SelectContent>
                            {translationLanguages.map((l) => (
                              <SelectItem key={l} value={l}>{l}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          onClick={() => removeOtherTranslation(t.id)}
                          data-testid={`button-remove-other-translation-${i}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                      <RichTextEditor
                        value={t.text}
                        onChange={(v) => updateOtherTranslation(t.id, "text", v)}
                        placeholder="Translation text..."
                        minHeight={80}
                        data-testid={`textarea-other-translation-text-${i}`}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Teeka Management */}
          <div className="border rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold">Teeka Management</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Define commentary works associated with this Grantha
                </p>
              </div>
              <div className="flex items-center gap-2">
                {(() => {
                  const linkedDocIds = new Set(teekas.map((t) => t.id));
                  const linkedNames = new Set(teekas.map((t) => (t.TeekaName || "").trim().toLowerCase()));
                  const unlinkable = allStrapiTeekas.filter((t: any) => {
                    const docId = t.documentId || "";
                    const name = (t.TeekaName || "").trim().toLowerCase();
                    return !linkedDocIds.has(docId) && !linkedNames.has(name);
                  });
                  if (unlinkable.length === 0) return null;
                  return (
                    <Select
                      value=""
                      onValueChange={(docId) => {
                        const t = allStrapiTeekas.find((x: any) => x.documentId === docId);
                        if (!t) return;
                        setDeletedStrapiTeekaDocIds((prev) => prev.filter((x) => x !== docId));
                        setTeekas((prev) => [
                          ...prev,
                          { id: (t as any).documentId || uid(), TeekaName: (t as any).TeekaName || "", TeekaAuthor: (t as any).TeekaAuthor || "" },
                        ]);
                      }}
                    >
                      <SelectTrigger className="h-8 text-sm w-48" data-testid="select-link-existing-teeka">
                        <SelectValue placeholder="Link Existing…" />
                      </SelectTrigger>
                      <SelectContent>
                        {unlinkable.map((t: any) => (
                          <SelectItem key={t.documentId} value={t.documentId}>
                            {t.TeekaName || "(unnamed)"}
                            {t.TeekaAuthor ? ` — ${t.TeekaAuthor}` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  );
                })()}
                <Button size="sm" variant="outline" onClick={addTeeka} data-testid="button-add-teeka">
                  <Plus className="w-3.5 h-3.5 mr-1.5" />
                  Add New
                </Button>
              </div>
            </div>

            {teekas.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No teekas added yet
              </p>
            ) : (
              <div className="space-y-3">
                {teekas.map((teeka, i) => (
                  <div
                    key={teeka.id}
                    className="flex gap-3 items-start p-3 bg-muted/40 rounded-lg"
                  >
                    <span className="text-xs font-semibold text-muted-foreground mt-2.5 w-5 shrink-0 text-center">
                      {i + 1}
                    </span>
                    <div className="flex-1 grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs">Teeka Name</Label>
                        <Input
                          value={teeka.TeekaName}
                          onChange={(e) => updateTeeka(teeka.id, "TeekaName", e.target.value)}
                          placeholder="e.g., Nyaya-Nirnaya"
                          className="mt-1 h-8 text-sm"
                          data-testid={`input-teeka-name-${i}`}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Author</Label>
                        <Select
                          value={teeka.TeekaAuthor}
                          onValueChange={(val) => updateTeeka(teeka.id, "TeekaAuthor", val)}
                        >
                          <SelectTrigger className="mt-1 h-8 text-sm" data-testid={`select-teeka-author-${i}`}>
                            <SelectValue placeholder="Select author" />
                          </SelectTrigger>
                          <SelectContent>
                            {vocabulary.teekaAuthors.map((a) => (
                              <SelectItem key={a} value={a}>{a}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="shrink-0 h-8 w-8 text-destructive hover:text-destructive mt-0.5"
                      onClick={() => removeTeeka(teeka.id)}
                      data-testid={`button-remove-teeka-${i}`}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Grantha Name Translations (repeatable) */}
          <div className="border rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold">Grantha Name Translations</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Name of the Grantha in other languages
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={addGranthaNameTranslation}
                data-testid="button-add-grantha-name-translation"
              >
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                Add Translation
              </Button>
            </div>

            {granthaNameTranslations.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No Grantha name translations added yet
              </p>
            ) : (
              <div className="space-y-3">
                {granthaNameTranslations.map((t, i) => (
                  <div
                    key={t.id}
                    className="flex gap-3 items-start p-3 bg-muted/40 rounded-lg"
                  >
                    <span className="text-xs font-semibold text-muted-foreground mt-2.5 w-5 shrink-0 text-center">
                      {i + 1}
                    </span>
                    <div className="flex-1 grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs">Language</Label>
                        <Select
                          value={t.language}
                          onValueChange={(val) => updateGranthaNameTranslation(t.id, "language", val)}
                        >
                          <SelectTrigger
                            className="mt-1 h-8 text-sm"
                            data-testid={`select-grantha-name-language-${i}`}
                          >
                            <SelectValue placeholder="Select language" />
                          </SelectTrigger>
                          <SelectContent>
                            {translationLanguages.map((l) => (
                              <SelectItem key={l} value={l}>{l}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-xs">Translated Name</Label>
                        <Input
                          value={t.name}
                          onChange={(e) => updateGranthaNameTranslation(t.id, "name", e.target.value)}
                          placeholder="Name in the selected language..."
                          className="mt-1 h-8 text-sm"
                          data-testid={`input-grantha-name-translation-${i}`}
                        />
                      </div>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="shrink-0 h-8 w-8 text-destructive hover:text-destructive mt-0.5"
                      onClick={() => removeGranthaNameTranslation(t.id)}
                      data-testid={`button-remove-grantha-name-translation-${i}`}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Additional Details */}
          <div className="border rounded-xl p-5 space-y-4">
            <div>
              <h3 className="font-semibold">Additional Details</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                SEO slug, display order, and intro video information
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>Slug</Label>
                <Input
                  value={formData.slug}
                  onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
                  placeholder="e.g., chandogya-upanishad"
                  className="mt-1.5"
                  data-testid="input-slug"
                />
              </div>
              <div>
                <Label>Display Order</Label>
                <Input
                  type="number"
                  value={formData.order}
                  onChange={(e) => setFormData({ ...formData, order: e.target.value })}
                  placeholder="e.g., 1"
                  className="mt-1.5"
                  data-testid="input-order"
                />
              </div>
              <div>
                <Label>Intro Video ID</Label>
                <Input
                  value={formData.introVideoId}
                  onChange={(e) => setFormData({ ...formData, introVideoId: e.target.value })}
                  placeholder="YouTube or Vimeo video ID..."
                  className="mt-1.5"
                  data-testid="input-intro-video-id"
                />
              </div>
              <div>
                <Label>Intro Video Title</Label>
                <Input
                  value={formData.introVideoTitle}
                  onChange={(e) => setFormData({ ...formData, introVideoTitle: e.target.value })}
                  placeholder="Title of the intro video..."
                  className="mt-1.5"
                  data-testid="input-intro-video-title"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-between items-center pt-2">
            <Button
              variant="outline"
              onClick={() => { setView("list"); resetForm(); }}
              data-testid="button-cancel"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!formData.GranthaName.trim()) {
                  toast({ variant: "destructive", title: "Grantha Name is required" });
                  return;
                }
                setStep(2);
              }}
              data-testid="button-next-structure"
            >
              Next: Book Structure
              <ChevronRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
        </div>
      ) : step === 2 ? (
        /* ====== STEP 2: Book Structure ====== */
        <div className="space-y-6">
          {editingGranthaSectionsLoading ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              <span>Syncing structure and verses from CMS…</span>
            </div>
          ) : null}
          <div>
            <h2 className="text-xl font-semibold">Book Structure</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Tell us how <strong>{formData.GranthaName || "this Grantha"}</strong> is organized — we'll build the content editor accordingly.
            </p>
          </div>

          {/* Level 1 */}
          <div className="border rounded-xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-semibold">Top-level Divisions</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Does this Grantha have top-level chapters or sections (e.g. Adhyaya)?
                </p>
              </div>
              <button
                type="button"
                onClick={() => setStructureConfig({ ...structureConfig, levelOneEnabled: !structureConfig.levelOneEnabled })}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                  structureConfig.levelOneEnabled ? "bg-primary" : "bg-muted"
                }`}
                data-testid="toggle-level1"
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                    structureConfig.levelOneEnabled ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
            {structureConfig.levelOneEnabled && (
              <div>
                <p className="text-xs text-muted-foreground mb-2">What are these top-level divisions called?</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {levelOneOptions.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setStructureConfig({ ...structureConfig, levelOneName: name })}
                      className={`px-3 py-2 rounded-lg border text-sm font-medium transition-colors text-left ${
                        structureConfig.levelOneName === name
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border hover:border-primary/50 hover:bg-muted/50"
                      }`}
                      data-testid={`select-level1-${name}`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
                {isAdmin && (
                  <div className="mt-3 flex gap-2">
                    <Input
                      value={newSharedOption.structureLevelOneNames}
                      onChange={(e) =>
                        updateSharedOptionDraft("structureLevelOneNames", e.target.value)
                      }
                      placeholder="Add new top-level heading"
                      className="h-9"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void addSharedOption("structureLevelOneNames", (value) =>
                            setStructureConfig({ ...structureConfig, levelOneName: value }),
                          );
                        }
                      }}
                    />
                    <Button
                      type="button"
                      size="sm"
                      disabled={addingSharedOptionKey === "structureLevelOneNames"}
                      onClick={() =>
                        void addSharedOption("structureLevelOneNames", (value) =>
                          setStructureConfig({ ...structureConfig, levelOneName: value }),
                        )
                      }
                    >
                      {addingSharedOptionKey === "structureLevelOneNames" ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Plus className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Level 2 */}
          <div className="border rounded-xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-semibold">Sub-sections</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {structureConfig.levelOneEnabled
                    ? `Does each ${structureConfig.levelOneName} have smaller sub-divisions?`
                    : "Does this Grantha have sections that group entries together?"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setStructureConfig({ ...structureConfig, levelTwoEnabled: !structureConfig.levelTwoEnabled })}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                  structureConfig.levelTwoEnabled ? "bg-primary" : "bg-muted"
                }`}
                data-testid="toggle-level2"
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                    structureConfig.levelTwoEnabled ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
            {structureConfig.levelTwoEnabled && (
              <div>
                <p className="text-xs text-muted-foreground mb-2">What are these sub-sections called?</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {levelTwoOptions.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setStructureConfig({ ...structureConfig, levelTwoName: name })}
                      className={`px-3 py-2 rounded-lg border text-sm font-medium transition-colors text-left ${
                        structureConfig.levelTwoName === name
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border hover:border-primary/50 hover:bg-muted/50"
                      }`}
                      data-testid={`select-level2-${name}`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
                {isAdmin && (
                  <div className="mt-3 flex gap-2">
                    <Input
                      value={newSharedOption.structureLevelTwoNames}
                      onChange={(e) =>
                        updateSharedOptionDraft("structureLevelTwoNames", e.target.value)
                      }
                      placeholder="Add new sub-section heading"
                      className="h-9"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void addSharedOption("structureLevelTwoNames", (value) =>
                            setStructureConfig({ ...structureConfig, levelTwoName: value }),
                          );
                        }
                      }}
                    />
                    <Button
                      type="button"
                      size="sm"
                      disabled={addingSharedOptionKey === "structureLevelTwoNames"}
                      onClick={() =>
                        void addSharedOption("structureLevelTwoNames", (value) =>
                          setStructureConfig({ ...structureConfig, levelTwoName: value }),
                        )
                      }
                    >
                      {addingSharedOptionKey === "structureLevelTwoNames" ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Plus className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Level 3 — only shown when L2 is enabled */}
          {structureConfig.levelTwoEnabled && (
            <div className="border rounded-xl p-5 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-semibold">Sub-sub-sections</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Does each {structureConfig.levelTwoName} have even smaller divisions?
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setStructureConfig({ ...structureConfig, levelThreeEnabled: !structureConfig.levelThreeEnabled })}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                    structureConfig.levelThreeEnabled ? "bg-primary" : "bg-muted"
                  }`}
                  data-testid="toggle-level3"
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                      structureConfig.levelThreeEnabled ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
              {structureConfig.levelThreeEnabled && (
                <div>
                  <p className="text-xs text-muted-foreground mb-2">What are these sub-sub-sections called?</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {levelThreeOptions.map((name) => (
                      <button
                        key={name}
                        type="button"
                        onClick={() => setStructureConfig({ ...structureConfig, levelThreeName: name })}
                        className={`px-3 py-2 rounded-lg border text-sm font-medium transition-colors text-left ${
                          structureConfig.levelThreeName === name
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border hover:border-primary/50 hover:bg-muted/50"
                        }`}
                        data-testid={`select-level3-${name}`}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                  {isAdmin && (
                    <div className="mt-3 flex gap-2">
                      <Input
                        value={newSharedOption.structureLevelThreeNames}
                        onChange={(e) =>
                          updateSharedOptionDraft("structureLevelThreeNames", e.target.value)
                        }
                        placeholder="Add new sub-sub-section heading"
                        className="h-9"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void addSharedOption("structureLevelThreeNames", (value) =>
                              setStructureConfig({ ...structureConfig, levelThreeName: value }),
                            );
                          }
                        }}
                      />
                      <Button
                        type="button"
                        size="sm"
                        disabled={addingSharedOptionKey === "structureLevelThreeNames"}
                        onClick={() =>
                          void addSharedOption("structureLevelThreeNames", (value) =>
                            setStructureConfig({ ...structureConfig, levelThreeName: value }),
                          )
                        }
                      >
                        {addingSharedOptionKey === "structureLevelThreeNames" ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Plus className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Leaf level */}
          <div className="border rounded-xl p-5 space-y-4">
            <div>
              <h3 className="font-semibold">Individual Entries</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                What are the individual text entries called?
              </p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {leafNameOptions.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => {
                    const prevLeaf = structureConfig.leafName;
                    const nextCfg = { ...structureConfig, leafName: name };
                    setStructureConfig(nextCfg);
                    if (prevLeaf !== name && adhyayas.length > 0) {
                      setAdhyayas((prev) => {
                        const migrated =
                          prevLeaf !== name ? migrateHierarchyLeafName(prev, prevLeaf, name) : prev;
                        return normalizeEditorHierarchy(migrated, nextCfg);
                      });
                    }
                  }}
                  className={`px-3 py-2 rounded-lg border text-sm font-medium transition-colors text-left ${
                    structureConfig.leafName === name
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:border-primary/50 hover:bg-muted/50"
                  }`}
                  data-testid={`select-leaf-${name}`}
                >
                  {name}
                </button>
              ))}
            </div>
            {isAdmin && (
              <div className="mt-3 flex gap-2">
                <Input
                  value={newSharedOption.structureLeafNames}
                  onChange={(e) => updateSharedOptionDraft("structureLeafNames", e.target.value)}
                  placeholder="Add new entry type"
                  className="h-9"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void addSharedOption("structureLeafNames", (value) => {
                        const prevLeaf = structureConfig.leafName;
                        const nextCfg = { ...structureConfig, leafName: value };
                        setStructureConfig(nextCfg);
                        if (prevLeaf !== value && adhyayas.length > 0) {
                          setAdhyayas((prev) => {
                            const migrated =
                              prevLeaf !== value ? migrateHierarchyLeafName(prev, prevLeaf, value) : prev;
                            return normalizeEditorHierarchy(migrated, nextCfg);
                          });
                        }
                      });
                    }
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={addingSharedOptionKey === "structureLeafNames"}
                  onClick={() =>
                    void addSharedOption("structureLeafNames", (value) => {
                      const prevLeaf = structureConfig.leafName;
                      const nextCfg = { ...structureConfig, leafName: value };
                      setStructureConfig(nextCfg);
                      if (prevLeaf !== value && adhyayas.length > 0) {
                        setAdhyayas((prev) => {
                          const migrated =
                            prevLeaf !== value ? migrateHierarchyLeafName(prev, prevLeaf, value) : prev;
                          return normalizeEditorHierarchy(migrated, nextCfg);
                        });
                      }
                    })
                  }
                >
                  {addingSharedOptionKey === "structureLeafNames" ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Plus className="w-4 h-4" />
                  )}
                </Button>
              </div>
            )}
          </div>

          {/* Preview */}
          <div className="bg-muted/40 rounded-xl p-4 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Structure preview: </span>
            {formData.GranthaName || "Grantha"}
            {structureConfig.levelOneEnabled && (
              <>
                <span className="mx-1.5 text-muted-foreground">→</span>
                <span className="font-medium text-primary">{structureConfig.levelOneName}</span>
              </>
            )}
            {structureConfig.levelTwoEnabled && (
              <>
                <span className="mx-1.5 text-muted-foreground">→</span>
                <span className="font-medium text-primary">{structureConfig.levelTwoName}</span>
              </>
            )}
            {structureConfig.levelTwoEnabled && structureConfig.levelThreeEnabled && (
              <>
                <span className="mx-1.5 text-muted-foreground">→</span>
                <span className="font-medium text-primary">{structureConfig.levelThreeName}</span>
              </>
            )}
            <span className="mx-1.5 text-muted-foreground">→</span>
            <span className="font-medium text-primary">{structureConfig.leafName}</span>
          </div>

          <div className="flex justify-between items-center pt-2">
            <Button variant="outline" onClick={() => setStep(1)} data-testid="button-back-to-config">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back
            </Button>
            <Button
              onClick={() => {
                const L1 = structureConfig.levelOneName;
                let tree = adhyayas;
                if (tree.length === 0) {
                  const defaultKhanda = !structureConfig.levelTwoEnabled
                    ? [{ id: uid(), title: "_default", order: 1, padas: [], manthras: [], expanded: true }]
                    : [];
                  tree = [
                    {
                      id: uid(),
                      title: `${editorOrdinalLabel(1)} ${L1}`,
                      order: 1,
                      khandas: defaultKhanda,
                      expanded: true,
                    },
                  ];
                }
                tree = fillMissingSectionTitles(tree, structureConfig);
                const { hierarchy: prepared, sectionDocIdsToMarkDeleted } = prepareHierarchyForContentStep(
                  tree,
                  structureConfig,
                );
                const titled = fillMissingSectionTitles(prepared as AdhyayaNode[], structureConfig);
                const errs = validateSectionTitles(titled, structureConfig);
                if (errs.length > 0) {
                  toast({
                    variant: "destructive",
                    title: "Some sections are missing titles",
                    description: errs.slice(0, 3).join(" • ") + (errs.length > 3 ? ` (+${errs.length - 3} more)` : ""),
                  });
                  return;
                }
                if (sectionDocIdsToMarkDeleted.length > 0) {
                  setDeletedStrapiSectionDocIds((prev) => Array.from(new Set([...prev, ...sectionDocIdsToMarkDeleted])));
                }
                const normalizedStep = withNormalizedHierarchy(titled, structureConfig);
                setAdhyayas(normalizedStep);
                setStep(3);
                flushStrapiFullHierarchySectionOrderSyncNow(normalizedStep, structureConfig);
              }}
              data-testid="button-next-content"
            >
              Next: Build Content
              <ChevronRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
        </div>
      ) : (
        /* ====== STEP 3: Build Content ====== */
        <div className="space-y-6">
          {editingGranthaSectionsLoading ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              <span>Syncing structure and verses from CMS…</span>
            </div>
          ) : null}
          <div>
            <h2 className="text-xl font-semibold">
              {formData.GranthaName || "Grantha"} — Content
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {structureConfig.levelOneEnabled && `${structureConfig.levelOneName} → `}
              {structureConfig.levelTwoEnabled && `${structureConfig.levelTwoName} → `}
              {structureConfig.levelTwoEnabled && structureConfig.levelThreeEnabled && `${structureConfig.levelThreeName} → `}
              {structureConfig.leafName}
              {" — click any "}
              {structureConfig.leafName}
              {" to enter its text content. "}
              <strong>+ between verses</strong>
              {" renumbers labels and syncs them to CMS for every grantha. The editor lists every linked CMS row (same as the Mantras tab). "}
              <strong>Sync verse numbers to CMS</strong>
              {" refreshes every section if labels drifted."}
            </p>
          </div>

          {/* Tree */}
          <div className="space-y-3">
            {sortNodesByOrder(adhyayas).map((adhyaya, aIdx) => {
              const L1 = structureConfig.levelOneName;
              const L2 = structureConfig.levelTwoName;
              const leaf = structureConfig.leafName;
              const hideL1Row = !structureConfig.levelOneEnabled;
              const sortedKhandasForAdhyaya = sortNodesByOrder(adhyaya.khandas);
              const flatFirstKhanda = sortedKhandasForAdhyaya[0];
              const flatLeafCount = flatFirstKhanda
                ? dedupeManthrasForEditor(
                    sortMantrasByDisplayOrder(flatFirstKhanda.manthras),
                    leaf,
                  ).length
                : countLeafMantrasInAdhyaya(adhyaya, structureConfig);
              return (
              <div key={adhyaya.id} className={hideL1Row ? "space-y-3" : "border rounded-xl overflow-hidden"} data-testid={`adhyaya-${aIdx}`}>
                {/* Level-1 row — hidden when L1 is disabled */}
                {!hideL1Row && (
                <div
                  className="flex items-center gap-3 px-4 py-3 bg-muted/30 cursor-pointer select-none"
                  onClick={() => toggleAdhyaya(adhyaya.id)}
                >
                  <span className="flex items-center justify-center w-7 h-7 rounded-full bg-primary/10 text-primary text-xs font-bold shrink-0">
                    {aIdx + 1}
                  </span>
                  <Input
                    value={adhyaya.title}
                    onChange={(e) => { e.stopPropagation(); updateAdhyaya(adhyaya.id, e.target.value); }}
                    onClick={(e) => e.stopPropagation()}
                    className="h-8 text-sm font-medium border-0 bg-transparent shadow-none focus-visible:ring-1 focus-visible:ring-primary/50 px-2"
                    data-testid={`input-adhyaya-title-${aIdx}`}
                  />
                  <div className="flex items-center gap-1 ml-auto shrink-0">
                    <span className="text-xs text-muted-foreground mr-1">
                      {structureConfig.levelTwoEnabled
                        ? `${adhyaya.khandas.length} ${L2.toLowerCase()}${adhyaya.khandas.length !== 1 ? "s" : ""}`
                        : `${flatLeafCount} ${leaf.toLowerCase()}${flatLeafCount !== 1 ? "s" : ""}`
                      }
                    </span>
                    {!viewOnly && (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-blue-500 hover:text-blue-700"
                          onClick={(e) => {
                            e.stopPropagation();
                            insertAdhyayaAfter(adhyaya.id);
                            toast({
                              title: `${L1} inserted`,
                              description: `A new ${L1.toLowerCase()} was added after "${adhyaya.title}".`,
                            });
                          }}
                          title={`Insert ${L1} after this`}
                          data-testid={`button-insert-after-adhyaya-${aIdx}`}
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={(e) => { e.stopPropagation(); removeAdhyaya(adhyaya.id); }}
                          data-testid={`button-remove-adhyaya-${aIdx}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </>
                    )}
                    {adhyaya.expanded
                      ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
                      : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                  </div>
                </div>
                )}

                {/* Flat mode: show leaves directly under L1 */}
                {!structureConfig.levelTwoEnabled && adhyaya.expanded && flatFirstKhanda && (
                  <div className="px-4 pt-2 pb-3 border-t bg-muted/10">
                    <p className="text-xs font-medium text-muted-foreground mb-2">
                      {leaf}s in this {L1}
                    </p>
                    <div className="space-y-1">
                      {dedupeManthrasForEditor(
                        sortMantrasByDisplayOrder(flatFirstKhanda.manthras),
                        leaf,
                      ).map((manthra, mIdx) => {
                        const hasContent = hasManthraContent(manthra);
                        return (
                          <div
                            key={manthra.id}
                            className={manthraListRowClassName(manthra)}
                            onMouseEnter={() => warmManthraOnHover(manthra.strapiDocumentId)}
                          >
                            <Hash className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                            <span className="text-sm flex-1">{manthra.title}</span>
                            {isNewLocalManthra(manthra) && (
                              <Badge variant="outline" className="text-[10px] h-4 px-1 border-amber-400 text-amber-800 dark:text-amber-300">
                                New
                              </Badge>
                            )}
                            {hasContent && <FileText className="w-3.5 h-3.5 text-primary" />}
                            {renderManthraRowActions({
                              adhyayaId: adhyaya.id,
                              khandaId: flatFirstKhanda.id,
                              manthraId: manthra.id,
                              manthra,
                              testIdSuffix: `${aIdx}-0-${mIdx}`,
                              onInsertAfter: () => {
                                insertManthraAfter(adhyaya.id, flatFirstKhanda.id, manthra.id);
                                toast({
                                  title: `${leaf} inserted`,
                                  description: `A new blank ${leaf} was added after "${manthra.title}".`,
                                });
                              },
                              onRemove: () =>
                                setPendingRemove({
                                  adhyayaId: adhyaya.id,
                                  khandaId: flatFirstKhanda.id,
                                  manthraId: manthra.id,
                                  title: manthra.title,
                                }),
                            })}
                          </div>
                        );
                      })}
                      {!viewOnly && (
                        <Button
                          size="sm" variant="ghost"
                          className="w-full justify-start text-muted-foreground hover:text-foreground text-xs h-7 mt-1 pl-0"
                          onClick={() => addManthra(adhyaya.id, flatFirstKhanda.id)}
                          data-testid={`button-add-manthra-${aIdx}-0`}
                        >
                          <Plus className="w-3.5 h-3.5 mr-1" />
                          Add {leaf}
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                {/* Hierarchical mode: Level 2 sections */}
                {structureConfig.levelTwoEnabled && adhyaya.expanded && (
                  <div className="p-4 space-y-2.5">
                    {sortedKhandasForAdhyaya.map((khanda, kIdx) => {
                      const L3 = structureConfig.levelThreeName;
                      const sortedPadas = sortNodesByOrder(khanda.padas ?? []);
                      return (
                      <div key={khanda.id} className="border rounded-lg overflow-hidden" data-testid={`khanda-${aIdx}-${kIdx}`}>
                        {/* Level-2 row */}
                        <div
                          className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer select-none hover:bg-muted/20"
                          onClick={() => toggleKhanda(adhyaya.id, khanda.id)}
                        >
                          <Layers className="w-4 h-4 text-muted-foreground shrink-0" />
                          <Input
                            value={khanda.title}
                            onChange={(e) => { e.stopPropagation(); updateKhanda(adhyaya.id, khanda.id, e.target.value); }}
                            onClick={(e) => e.stopPropagation()}
                            className="h-7 text-sm border-0 bg-transparent shadow-none focus-visible:ring-1 focus-visible:ring-primary/50 px-1.5"
                            data-testid={`input-khanda-title-${aIdx}-${kIdx}`}
                          />
                          <div className="flex items-center gap-1 ml-auto shrink-0">
                            <span className="text-xs text-muted-foreground">
                              {(() => {
                                const n = countLeafMantrasInKhanda(khanda, structureConfig);
                                return `${n} ${leaf.toLowerCase()}${n !== 1 ? "s" : ""}`;
                              })()}
                            </span>
                            {!viewOnly && (
                              <>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-6 w-6 text-blue-500 hover:text-blue-700"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    insertKhandaAfter(adhyaya.id, khanda.id);
                                    toast({
                                      title: `${L2} inserted`,
                                      description: `A new ${L2.toLowerCase()} was added after "${khanda.title}".`,
                                    });
                                  }}
                                  title={`Insert ${L2} after this`}
                                  data-testid={`button-insert-after-khanda-${aIdx}-${kIdx}`}
                                >
                                  <Plus className="w-3 h-3" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-6 w-6 text-destructive hover:text-destructive"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const totalManthras = countLeafMantrasInKhanda(khanda, structureConfig);
                                    if (totalManthras > 0 && !window.confirm(`Delete "${khanda.title}" and all ${totalManthras} ${leaf.toLowerCase()}${totalManthras !== 1 ? "s" : ""} inside? This cannot be undone.`)) return;
                                    removeKhanda(adhyaya.id, khanda.id);
                                  }}
                                  data-testid={`button-remove-khanda-${aIdx}-${kIdx}`}
                                >
                                  <Trash2 className="w-3 h-3" />
                                </Button>
                              </>
                            )}
                            {khanda.expanded
                              ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                              : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
                          </div>
                        </div>

                        {/* L3 enabled: show Padas inside Khanda */}
                        {structureConfig.levelThreeEnabled && khanda.expanded && (
                          <div className="px-4 pt-2 pb-3 border-t bg-muted/10 space-y-2">
                            {sortedPadas.map((pada, pIdx) => (
                              <div key={pada.id} className="border rounded-md overflow-hidden" data-testid={`pada-${aIdx}-${kIdx}-${pIdx}`}>
                                <div
                                  className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none hover:bg-muted/30"
                                  onClick={() => togglePada(adhyaya.id, khanda.id, pada.id)}
                                >
                                  <BookOpen className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                  <Input
                                    value={pada.title}
                                    onChange={(e) => { e.stopPropagation(); updatePada(adhyaya.id, khanda.id, pada.id, e.target.value); }}
                                    onClick={(e) => e.stopPropagation()}
                                    className="h-6 text-sm border-0 bg-transparent shadow-none focus-visible:ring-1 focus-visible:ring-primary/50 px-1"
                                    data-testid={`input-pada-title-${aIdx}-${kIdx}-${pIdx}`}
                                  />
                                  <div className="flex items-center gap-1 ml-auto shrink-0">
                                    <span className="text-xs text-muted-foreground">
                                      {pada.manthras.length} {leaf.toLowerCase()}{pada.manthras.length !== 1 ? "s" : ""}
                                    </span>
                                    {!viewOnly && (
                                      <>
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          className="h-5 w-5 text-blue-500 hover:text-blue-700"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            insertPadaAfter(adhyaya.id, khanda.id, pada.id);
                                            toast({
                                              title: `${L3} inserted`,
                                              description: `A new ${L3.toLowerCase()} was added after "${pada.title}".`,
                                            });
                                          }}
                                          title={`Insert ${L3} after this`}
                                          data-testid={`button-insert-after-pada-${aIdx}-${kIdx}-${pIdx}`}
                                        >
                                          <Plus className="w-3 h-3" />
                                        </Button>
                                        <Button
                                          size="icon"
                                          variant="ghost"
                                          className="h-5 w-5 text-destructive hover:text-destructive"
                                          onClick={(e) => { e.stopPropagation(); removePada(adhyaya.id, khanda.id, pada.id); }}
                                          data-testid={`button-remove-pada-${aIdx}-${kIdx}-${pIdx}`}
                                        >
                                          <Trash2 className="w-3 h-3" />
                                        </Button>
                                      </>
                                    )}
                                    {pada.expanded
                                      ? <ChevronDown className="w-3 h-3 text-muted-foreground" />
                                      : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
                                  </div>
                                </div>
                                {pada.expanded && (
                                  <div className="px-4 pt-1.5 pb-2.5 border-t bg-muted/5">
                                    <div className="space-y-1">
                                      {dedupeManthrasForEditor(sortMantrasByDisplayOrder(pada.manthras), leaf).map((manthra, mIdx) => {
                                        const hasContent = hasManthraContent(manthra);
                                        return (
                                          <div
                                            key={manthra.id}
                                            className={manthraListRowClassName(manthra)}
                                            onMouseEnter={() => warmManthraOnHover(manthra.strapiDocumentId)}
                                          >
                                            <Hash className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                            <span className="text-sm flex-1">{manthra.title}</span>
                                            {isNewLocalManthra(manthra) && (
                                              <Badge variant="outline" className="text-[10px] h-4 px-1 border-amber-400 text-amber-800 dark:text-amber-300">
                                                New
                                              </Badge>
                                            )}
                                            {hasContent && <FileText className="w-3.5 h-3.5 text-primary" />}
                                            {renderManthraRowActions({
                                              adhyayaId: adhyaya.id,
                                              khandaId: khanda.id,
                                              padaId: pada.id,
                                              manthraId: manthra.id,
                                              manthra,
                                              testIdSuffix: `${aIdx}-${kIdx}-${pIdx}-${mIdx}`,
                                              onInsertAfter: () => {
                                                insertManthraAfter(adhyaya.id, khanda.id, manthra.id, pada.id);
                                                toast({
                                                  title: `${leaf} inserted`,
                                                  description: `A new blank ${leaf} was added after "${manthra.title}".`,
                                                });
                                              },
                                              onRemove: () =>
                                                setPendingRemove({
                                                  adhyayaId: adhyaya.id,
                                                  khandaId: khanda.id,
                                                  manthraId: manthra.id,
                                                  padaId: pada.id,
                                                  title: manthra.title,
                                                }),
                                            })}
                                          </div>
                                        );
                                      })}
                                      {!viewOnly && (
                                        <Button
                                          size="sm" variant="ghost"
                                          className="w-full justify-start text-muted-foreground hover:text-foreground text-xs h-7 mt-1 pl-0"
                                          onClick={() => addManthra(adhyaya.id, khanda.id, pada.id)}
                                          data-testid={`button-add-manthra-${aIdx}-${kIdx}-${pIdx}`}
                                        >
                                          <Plus className="w-3.5 h-3.5 mr-1" />
                                          Add {leaf}
                                        </Button>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            ))}
                            {!viewOnly && (
                              <Button
                                size="sm" variant="outline"
                                className="w-full border-dashed text-muted-foreground hover:text-foreground mt-1"
                                onClick={() => addPada(adhyaya.id, khanda.id)}
                                data-testid={`button-add-pada-${aIdx}-${kIdx}`}
                              >
                                <Plus className="w-3.5 h-3.5 mr-1.5" />
                                Add New {L3}
                              </Button>
                            )}
                          </div>
                        )}

                        {/* L3 disabled: Manthras directly inside Khanda */}
                        {!structureConfig.levelThreeEnabled && khanda.expanded && (
                          <div className="px-4 pt-2 pb-3 border-t bg-muted/10">
                            <p className="text-xs font-medium text-muted-foreground mb-2">
                              Manage {leaf}s
                            </p>
                            <div className="space-y-1">
                              {dedupeManthrasForEditor(sortMantrasByDisplayOrder(khanda.manthras), leaf).map((manthra, mIdx) => {
                                const hasContent = hasManthraContent(manthra);
                                return (
                                  <div
                                    key={manthra.id}
                                    className={manthraListRowClassName(manthra)}
                                    onMouseEnter={() => warmManthraOnHover(manthra.strapiDocumentId)}
                                  >
                                    <Hash className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                    <span className="text-sm flex-1">{manthra.title}</span>
                                    {isNewLocalManthra(manthra) && (
                                      <Badge variant="outline" className="text-[10px] h-4 px-1 border-amber-400 text-amber-800 dark:text-amber-300">
                                        New
                                      </Badge>
                                    )}
                                    {hasContent && (
                                      <span className="text-xs text-primary font-medium" title="Has content">
                                        <FileText className="w-3.5 h-3.5" />
                                      </span>
                                    )}
                                    {renderManthraRowActions({
                                      adhyayaId: adhyaya.id,
                                      khandaId: khanda.id,
                                      manthraId: manthra.id,
                                      manthra,
                                      testIdSuffix: `${aIdx}-${kIdx}-${mIdx}`,
                                      onInsertAfter: () => {
                                        insertManthraAfter(adhyaya.id, khanda.id, manthra.id);
                                        toast({
                                          title: `${leaf} inserted`,
                                          description: `A new blank ${leaf} was added after "${manthra.title}".`,
                                        });
                                      },
                                      onRemove: () =>
                                        setPendingRemove({
                                          adhyayaId: adhyaya.id,
                                          khandaId: khanda.id,
                                          manthraId: manthra.id,
                                          title: manthra.title,
                                        }),
                                    })}
                                  </div>
                                );
                              })}
                              {!viewOnly && (
                                <Button
                                  size="sm" variant="ghost"
                                  className="w-full justify-start text-muted-foreground hover:text-foreground text-xs h-7 mt-1 pl-0"
                                  onClick={() => addManthra(adhyaya.id, khanda.id)}
                                  data-testid={`button-add-manthra-${aIdx}-${kIdx}`}
                                >
                                  <Plus className="w-3.5 h-3.5 mr-1" />
                                  Add {leaf}
                                </Button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                      );
                    })}

                    {!viewOnly && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full border-dashed text-muted-foreground hover:text-foreground"
                        onClick={() => addKhanda(adhyaya.id)}
                        data-testid={`button-add-khanda-${aIdx}`}
                      >
                        <Plus className="w-3.5 h-3.5 mr-1.5" />
                        Add New {L2}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ); })}

            {structureConfig.levelOneEnabled && !viewOnly && (
              <Button
                variant="outline"
                className="w-full border-dashed text-muted-foreground hover:text-foreground"
                onClick={addAdhyaya}
                data-testid="button-add-adhyaya"
              >
                <Plus className="w-4 h-4 mr-2" />
                New {structureConfig.levelOneName}
              </Button>
            )}
          </div>

          {!viewOnly && activeEditorProgress && (
            <EditorOperationProgressBar progress={activeEditorProgress} />
          )}

          <div className="flex justify-between items-center pt-2">
            {viewOnly ? (
              <Button variant="outline" onClick={() => { setView("list"); resetForm(); }} data-testid="button-close-view-bottom">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to List
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setStep(2)} data-testid="button-back-to-structure">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back
                </Button>
                <div className="relative flex items-center gap-2">
                {editingDraftId && editingGranthaStrapiDocumentId() && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      editingItem &&
                      setResetDraftTarget({
                        ...editingItem,
                        _draftId: editingDraftId,
                        _strapiDocId: editingGranthaStrapiDocumentId(),
                        GranthaName: formData.GranthaName || editingItem.GranthaName,
                      })
                    }
                    disabled={
                      resettingDraftId != null ||
                      saveDraft.isPending ||
                      publishDraft.isPending
                    }
                    title="Discard portal draft and return to the published Strapi entry in the list"
                    data-testid="button-reset-draft-strapi-editor"
                  >
                    {resettingDraftId === editingDraftId && (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    )}
                    <RotateCcw className="w-4 h-4 mr-2" />
                    Discard draft
                  </Button>
                )}
                {editingGranthaStrapiDocumentId() && (
                  <Button
                    variant="outline"
                    onClick={() => void handleSyncVerseNumbersToCms()}
                    disabled={
                      verseLabelSyncPending || saveDraft.isPending || publishDraft.isPending || persistInFlight
                    }
                    data-testid="button-sync-verse-numbers-cms"
                  >
                    {verseLabelSyncPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    Sync verse numbers to CMS
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={handleSave}
                  disabled={saveDraft.isPending || publishDraft.isPending || persistInFlight}
                  data-testid="button-save-draft"
                >
                  {(saveDraft.isPending || persistInFlight) && !publishDraft.isPending && (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  )}
                  Save
                </Button>
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Button
                          onClick={handleSaveAndPublish}
                          disabled={!saveAndPublishReady || publishDraft.isPending}
                          data-testid="button-save-and-publish"
                        >
                          {publishDraft.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                          {publishDraft.isPending ? "Publishing…" : "Save & Publish"}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {saveAndPublishHint && (
                      <TooltipContent side="top" className="max-w-xs text-xs">
                        {saveAndPublishHint}
                      </TooltipContent>
                    )}
                  </Tooltip>
                </TooltipProvider>
                {isAdmin && editingDraftId && (
                  <Button
                    variant="secondary"
                    onClick={() => void handleRecoverSnapshot()}
                    disabled={recoverDraft.isPending || saveDraft.isPending || publishDraft.isPending}
                    data-testid="button-recover-latest-snapshot"
                  >
                    {recoverDraft.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    Recover Snapshot
                  </Button>
                )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Manthra content dialog */}
      <Dialog
        open={!!editingManthra}
        onOpenChange={(open) => { if (!open) requestCloseMantraDialog(); }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {manthraDialogViewOnly ? "View" : "Edit"}: {currentManthra?.title ?? "Manthra"}
              {manthraLoading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
            </DialogTitle>
            <DialogDescription>
              {manthraDialogViewOnly
                ? manthraLoading && editingManthra?.strapiDocumentId
                  ? "Loading verse from the CMS…"
                  : "Read-only preview of this verse (draft and CMS content). Nothing is saved until you use Edit, then Save or Save & Publish."
                : manthraLoading && editingManthra?.strapiDocumentId
                  ? "Loading verse from the CMS…"
                  : currentManthra?._isNewLocal
                    ? editingGranthaStrapiDocumentId()
                      ? "New verse — the CMS row is created in order. Add text here, then Save in this dialog (or Save & Publish) to push content."
                      : "New verse — edit here, then Save & Publish the grantha so it appears in the Mantras tab."
                    : editingManthra?.strapiDocumentId
                      ? "Showing live content from the CMS. Use Save & Publish to push edits to Strapi."
                      : "Enter the Sanskrit text and translations, then Save & Publish to create the CMS record."}
            </DialogDescription>
          </DialogHeader>

          {currentManthra && editingManthra ? (
            <fieldset
              disabled={manthraDialogViewOnly || (manthraLoading && !!editingManthra.strapiDocumentId)}
              className={`relative space-y-5 pt-1 border-0 p-0 m-0 min-w-0${manthraLoading && editingManthra.strapiDocumentId ? " pointer-events-none" : ""}`}
            >
              {manthraLoading && editingManthra.strapiDocumentId ? (
                <div
                  className="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-background/70 pointer-events-auto"
                  aria-busy="true"
                >
                  <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                </div>
              ) : null}
              {/* Shloka / Manthra Text */}
              <section className="space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-2">
                  <Hash className="w-4 h-4 text-primary" />
                  Shloka / Manthra Text
                  <span className="text-xs text-muted-foreground font-normal">(ShlokaManthraEntry)</span>
                </h4>
                <div>
                  <Label className="text-xs">Sanskrit (Devanagari)</Label>
                  <RichTextEditor
                    key={`shloka-sans-${editingManthra.manthraId}`}
                    value={currentManthra.ShlokaManthraEntry?.SanskritTextEntry}
                    onChange={(v) =>
                      updateManthraContent(
                        editingManthra.adhyayaId,
                        editingManthra.khandaId,
                        editingManthra.manthraId,
                        { ShlokaManthraEntry: { ...currentManthra.ShlokaManthraEntry, SanskritTextEntry: v } },
                        editingManthra.padaId
                      )
                    }
                    placeholder="Sanskrit text in Devanagari..."
                    className="mt-1.5"
                    minHeight={80}
                    data-testid="textarea-shloka-sanskrit"
                  />
                </div>
                <div>
                  <Label className="text-xs">English Translation</Label>
                  <RichTextEditor
                    key={`shloka-eng-${editingManthra.manthraId}`}
                    value={currentManthra.ShlokaManthraEntry?.EnglishTranslationText}
                    onChange={(v) =>
                      updateManthraContent(
                        editingManthra.adhyayaId,
                        editingManthra.khandaId,
                        editingManthra.manthraId,
                        { ShlokaManthraEntry: { ...currentManthra.ShlokaManthraEntry, EnglishTranslationText: v } },
                        editingManthra.padaId
                      )
                    }
                    placeholder="English translation..."
                    className="mt-1.5"
                    minHeight={80}
                    data-testid="textarea-shloka-english"
                  />
                </div>

                {/* Other Language Translations for Shloka */}
                <div className="pt-2 border-t">
                  {isAdmin && (
                    <OtherTranslationsHermex
                      sectionLabel={`Shloka ${currentManthra.title}`}
                      sanskritBlocks={currentManthra.ShlokaManthraEntry?.SanskritTextEntry}
                      englishBlocks={currentManthra.ShlokaManthraEntry?.EnglishTranslationText}
                      existing={currentManthra.ShlokaManthraEntry?.OtherTranslations ?? []}
                      onApply={(merged) =>
                        updateManthraContent(
                          editingManthra.adhyayaId,
                          editingManthra.khandaId,
                          editingManthra.manthraId,
                          { ShlokaManthraEntry: { ...currentManthra.ShlokaManthraEntry, OtherTranslations: merged } },
                          editingManthra.padaId,
                        )
                      }
                    />
                  )}
                  <div className={`flex items-center justify-between mb-2 ${isAdmin ? "mt-3" : ""}`}>
                    <Label className="text-xs">Other Language Translations</Label>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs px-2"
                      onClick={() => {
                        const existing = currentManthra.ShlokaManthraEntry?.OtherTranslations ?? [];
                        updateManthraContent(
                          editingManthra.adhyayaId,
                          editingManthra.khandaId,
                          editingManthra.manthraId,
                          { ShlokaManthraEntry: { ...currentManthra.ShlokaManthraEntry, OtherTranslations: [...existing, { LanguageOfTranslation: "" }] } },
                          editingManthra.padaId
                        );
                      }}
                      data-testid="button-add-shloka-translation"
                    >
                      <Plus className="w-3 h-3 mr-1" />
                      Add Language
                    </Button>
                  </div>
                  {(currentManthra.ShlokaManthraEntry?.OtherTranslations ?? []).length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-2">No other language translations added yet</p>
                  ) : (
                    <div className="space-y-2">
                      {(currentManthra.ShlokaManthraEntry?.OtherTranslations ?? []).map((ot, i) => (
                        <div key={i} className="p-3 bg-muted/40 rounded-lg space-y-2">
                          <div className="flex items-center justify-between">
                            <Select
                              value={ot.LanguageOfTranslation ?? ""}
                              onValueChange={(val) => {
                                const updated = (currentManthra.ShlokaManthraEntry?.OtherTranslations ?? []).map((x, idx) =>
                                  idx === i ? { ...x, LanguageOfTranslation: val } : x
                                );
                                updateManthraContent(editingManthra.adhyayaId, editingManthra.khandaId, editingManthra.manthraId, { ShlokaManthraEntry: { ...currentManthra.ShlokaManthraEntry, OtherTranslations: updated } }, editingManthra.padaId);
                              }}
                            >
                              <SelectTrigger className="h-7 text-xs w-44" data-testid={`select-shloka-otlang-${i}`}>
                                <SelectValue placeholder="Select language" />
                              </SelectTrigger>
                              <SelectContent>
                                {translationLanguages.map((l) => (
                                  <SelectItem key={l} value={l}>{l}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive"
                              onClick={() => {
                                const updated = (currentManthra.ShlokaManthraEntry?.OtherTranslations ?? []).filter((_, idx) => idx !== i);
                                updateManthraContent(editingManthra.adhyayaId, editingManthra.khandaId, editingManthra.manthraId, { ShlokaManthraEntry: { ...currentManthra.ShlokaManthraEntry, OtherTranslations: updated } }, editingManthra.padaId);
                              }}
                              data-testid={`button-remove-shloka-otlang-${i}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                          <RichTextEditor
                            value={ot.TranslationText ?? []}
                            onChange={(v) => {
                              const updated = (currentManthra.ShlokaManthraEntry?.OtherTranslations ?? []).map((x, idx) =>
                                idx === i ? { ...x, TranslationText: v as any } : x
                              );
                              updateManthraContent(editingManthra.adhyayaId, editingManthra.khandaId, editingManthra.manthraId, { ShlokaManthraEntry: { ...currentManthra.ShlokaManthraEntry, OtherTranslations: updated } }, editingManthra.padaId);
                            }}
                            placeholder={`${ot.LanguageOfTranslation || "Translation"} text...`}
                            minHeight={70}
                            data-testid={`textarea-shloka-ottext-${i}`}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              {/* Bhashyam */}
              <section className="space-y-3 border-t pt-4">
                <h4 className="text-sm font-semibold flex items-center gap-2">
                  <FileText className="w-4 h-4 text-primary" />
                  Bhashyam for this Manthra
                  <span className="text-xs text-muted-foreground font-normal">(BhashyamForShlokaManthra)</span>
                </h4>
                <div>
                  <Label className="text-xs">Sanskrit Commentary</Label>
                  <RichTextEditor
                    value={currentManthra.BhashyamForShlokaManthra?.SanskritTextEntry}
                    onChange={(v) =>
                      updateManthraContent(
                        editingManthra.adhyayaId,
                        editingManthra.khandaId,
                        editingManthra.manthraId,
                        { BhashyamForShlokaManthra: { ...currentManthra.BhashyamForShlokaManthra, SanskritTextEntry: v } },
                        editingManthra.padaId
                      )
                    }
                    placeholder="Sanskrit bhashyam commentary..."
                    className="mt-1.5"
                    minHeight={100}
                    data-testid="textarea-bhashyam-sanskrit"
                  />
                </div>
                <div>
                  <Label className="text-xs">English Translation</Label>
                  <RichTextEditor
                    value={currentManthra.BhashyamForShlokaManthra?.EnglishTranslationText}
                    onChange={(v) =>
                      updateManthraContent(
                        editingManthra.adhyayaId,
                        editingManthra.khandaId,
                        editingManthra.manthraId,
                        { BhashyamForShlokaManthra: { ...currentManthra.BhashyamForShlokaManthra, EnglishTranslationText: v } },
                        editingManthra.padaId
                      )
                    }
                    placeholder="English translation of bhashyam..."
                    className="mt-1.5"
                    minHeight={100}
                    data-testid="textarea-bhashyam-english"
                  />
                </div>

                {/* Other Language Translations for Bhashyam */}
                <div className="pt-2 border-t">
                  {isAdmin && (
                    <OtherTranslationsHermex
                      sectionLabel={`Bhashyam ${currentManthra.title}`}
                      sanskritBlocks={currentManthra.BhashyamForShlokaManthra?.SanskritTextEntry}
                      englishBlocks={currentManthra.BhashyamForShlokaManthra?.EnglishTranslationText}
                      existing={currentManthra.BhashyamForShlokaManthra?.OtherTranslations ?? []}
                      onApply={(merged) =>
                        updateManthraContent(
                          editingManthra.adhyayaId,
                          editingManthra.khandaId,
                          editingManthra.manthraId,
                          {
                            BhashyamForShlokaManthra: {
                              ...currentManthra.BhashyamForShlokaManthra,
                              OtherTranslations: merged,
                            },
                          },
                          editingManthra.padaId,
                        )
                      }
                    />
                  )}
                  <div className={`flex items-center justify-between mb-2 ${isAdmin ? "mt-3" : ""}`}>
                    <Label className="text-xs">Other Language Translations</Label>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs px-2"
                      onClick={() => {
                        const existing = currentManthra.BhashyamForShlokaManthra?.OtherTranslations ?? [];
                        updateManthraContent(
                          editingManthra.adhyayaId,
                          editingManthra.khandaId,
                          editingManthra.manthraId,
                          { BhashyamForShlokaManthra: { ...currentManthra.BhashyamForShlokaManthra, OtherTranslations: [...existing, { LanguageOfTranslation: "" }] } },
                          editingManthra.padaId
                        );
                      }}
                      data-testid="button-add-bhashyam-translation"
                    >
                      <Plus className="w-3 h-3 mr-1" />
                      Add Language
                    </Button>
                  </div>
                  {(currentManthra.BhashyamForShlokaManthra?.OtherTranslations ?? []).length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-2">No other language translations added yet</p>
                  ) : (
                    <div className="space-y-2">
                      {(currentManthra.BhashyamForShlokaManthra?.OtherTranslations ?? []).map((ot, i) => (
                        <div key={i} className="p-3 bg-muted/40 rounded-lg space-y-2">
                          <div className="flex items-center justify-between">
                            <Select
                              value={ot.LanguageOfTranslation ?? ""}
                              onValueChange={(val) => {
                                const updated = (currentManthra.BhashyamForShlokaManthra?.OtherTranslations ?? []).map((x, idx) =>
                                  idx === i ? { ...x, LanguageOfTranslation: val } : x
                                );
                                updateManthraContent(editingManthra.adhyayaId, editingManthra.khandaId, editingManthra.manthraId, { BhashyamForShlokaManthra: { ...currentManthra.BhashyamForShlokaManthra, OtherTranslations: updated } }, editingManthra.padaId);
                              }}
                            >
                              <SelectTrigger className="h-7 text-xs w-44" data-testid={`select-bhashyam-otlang-${i}`}>
                                <SelectValue placeholder="Select language" />
                              </SelectTrigger>
                              <SelectContent>
                                {translationLanguages.map((l) => (
                                  <SelectItem key={l} value={l}>{l}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive"
                              onClick={() => {
                                const updated = (currentManthra.BhashyamForShlokaManthra?.OtherTranslations ?? []).filter((_, idx) => idx !== i);
                                updateManthraContent(editingManthra.adhyayaId, editingManthra.khandaId, editingManthra.manthraId, { BhashyamForShlokaManthra: { ...currentManthra.BhashyamForShlokaManthra, OtherTranslations: updated } }, editingManthra.padaId);
                              }}
                              data-testid={`button-remove-bhashyam-otlang-${i}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                          <RichTextEditor
                            value={ot.TranslationText ?? []}
                            onChange={(v) => {
                              const updated = (currentManthra.BhashyamForShlokaManthra?.OtherTranslations ?? []).map((x, idx) =>
                                idx === i ? { ...x, TranslationText: v as any } : x
                              );
                              updateManthraContent(editingManthra.adhyayaId, editingManthra.khandaId, editingManthra.manthraId, { BhashyamForShlokaManthra: { ...currentManthra.BhashyamForShlokaManthra, OtherTranslations: updated } }, editingManthra.padaId);
                            }}
                            placeholder={`${ot.LanguageOfTranslation || "Translation"} text...`}
                            minHeight={80}
                            data-testid={`textarea-bhashyam-ottext-${i}`}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              {/* Teekas — driven by the grantha's configured teekas list so entries
                   always appear even when the mantra hasn't stored content yet.
                   Content is matched by TeekaName and merged on every edit. */}
              {teekas.length > 0 && (
                <section className="space-y-3 border-t pt-4">
                  <h4 className="text-sm font-semibold flex items-center gap-2">
                    <Layers className="w-4 h-4 text-primary" />
                    Teeka Entries
                    <span className="text-xs text-muted-foreground font-normal">(Teekas)</span>
                  </h4>
                  {teekas.map((granthaTeeka, tIdx) => {
                    const ts = currentManthra.Teekas ?? [];
                    // Match priority:
                    // 1. Strapi teeka documentId (most reliable — survives name typos)
                    // 2. TeekaName equality
                    // 3. TeekaAuthor equality (for cases where TeekaName is blank but Author is set)
                    // granthaTeeka.id is a Strapi documentId when loaded from Strapi (≥20 chars)
                    // or a local nanoid when loaded from an old draft (<20 chars).
                    const granthaTeekaStrapiId = granthaTeeka.id && granthaTeeka.id.length >= 20 ? granthaTeeka.id : undefined;
                    let existingIdx = granthaTeekaStrapiId
                      ? ts.findIndex((t) => t.teekaDocId === granthaTeekaStrapiId)
                      : -1;
                    if (existingIdx < 0 && granthaTeeka.TeekaName) {
                      existingIdx = ts.findIndex((t) => t.TeekaName === granthaTeeka.TeekaName);
                    }
                    if (existingIdx < 0 && granthaTeeka.TeekaAuthor) {
                      existingIdx = ts.findIndex((t) => t.TeekaAuthor === granthaTeeka.TeekaAuthor);
                    }
                    // Only stamp the Strapi teeka documentId when we actually have a real one.
                    // If granthaTeeka.id is a short local nanoid, preserve the existing teekaDocId.
                    const resolvedTeekaDocId = granthaTeekaStrapiId
                      ?? (existingIdx >= 0 ? ts[existingIdx].teekaDocId : undefined);
                    const teeka: ManthraTeekaEntry =
                      existingIdx >= 0
                        ? { ...ts[existingIdx], teekaDocId: resolvedTeekaDocId }
                        : { TeekaName: granthaTeeka.TeekaName, TeekaAuthor: granthaTeeka.TeekaAuthor, teekaDocId: resolvedTeekaDocId };

                    // Rebuild the full Teekas array with the updated entry merged in
                    function buildUpdated(updated: ManthraTeekaEntry): ManthraTeekaEntry[] {
                      const existing = currentManthra?.Teekas ?? [];
                      if (existingIdx >= 0) {
                        return existing.map((t, i) => (i === existingIdx ? updated : t));
                      }
                      return [...existing, updated];
                    }

                    return (
                      <div key={tIdx} className="rounded-lg border p-4 space-y-3">
                        <p className="text-xs font-semibold text-foreground">
                          {teeka.TeekaName || `Teeka ${tIdx + 1}`}
                          {teeka.TeekaAuthor && (
                            <span className="font-normal text-muted-foreground ml-1">
                              — {teeka.TeekaAuthor}
                            </span>
                          )}
                        </p>
                        <div>
                          <Label className="text-xs">Sanskrit Commentary</Label>
                          <RichTextEditor
                            value={teeka.TeekaEntry?.SanskritTextEntry}
                            onChange={(v) => {
                              const updated = { ...teeka, TeekaEntry: { ...teeka.TeekaEntry, SanskritTextEntry: v } };
                              updateManthraContent(editingManthra.adhyayaId, editingManthra.khandaId, editingManthra.manthraId, { Teekas: buildUpdated(updated) }, editingManthra.padaId);
                            }}
                            placeholder={`${teeka.TeekaName || "Teeka"} Sanskrit commentary...`}
                            className="mt-1.5"
                            minHeight={80}
                            data-testid={`textarea-teeka-sanskrit-${tIdx}`}
                          />
                        </div>
                        <div>
                          <Label className="text-xs">English Translation</Label>
                          <RichTextEditor
                            value={teeka.TeekaEntry?.EnglishTranslationText}
                            onChange={(v) => {
                              const updated = { ...teeka, TeekaEntry: { ...teeka.TeekaEntry, EnglishTranslationText: v } };
                              updateManthraContent(editingManthra.adhyayaId, editingManthra.khandaId, editingManthra.manthraId, { Teekas: buildUpdated(updated) }, editingManthra.padaId);
                            }}
                            placeholder="English translation..."
                            className="mt-1.5"
                            minHeight={80}
                            data-testid={`textarea-teeka-english-${tIdx}`}
                          />
                        </div>
                        <div className="pt-2 border-t">
                          {isAdmin && (
                            <OtherTranslationsHermex
                              sectionLabel={`Teeka ${teeka.TeekaName || tIdx + 1} — ${currentManthra.title}`}
                              sanskritBlocks={teeka.TeekaEntry?.SanskritTextEntry}
                              englishBlocks={teeka.TeekaEntry?.EnglishTranslationText}
                              existing={teeka.TeekaEntry?.OtherTranslations ?? []}
                              onApply={(merged) => {
                                const updated = {
                                  ...teeka,
                                  TeekaEntry: { ...teeka.TeekaEntry, OtherTranslations: merged },
                                };
                                updateManthraContent(
                                  editingManthra.adhyayaId,
                                  editingManthra.khandaId,
                                  editingManthra.manthraId,
                                  { Teekas: buildUpdated(updated) },
                                  editingManthra.padaId,
                                );
                              }}
                            />
                          )}
                          <div className={`flex items-center justify-between mb-2 ${isAdmin ? "mt-3" : ""}`}>
                            <Label className="text-xs">Other Language Translations</Label>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs px-2"
                              onClick={() => {
                                const existing = teeka.TeekaEntry?.OtherTranslations ?? [];
                                const updated = { ...teeka, TeekaEntry: { ...teeka.TeekaEntry, OtherTranslations: [...existing, { LanguageOfTranslation: "" }] } };
                                updateManthraContent(editingManthra.adhyayaId, editingManthra.khandaId, editingManthra.manthraId, { Teekas: buildUpdated(updated) }, editingManthra.padaId);
                              }}
                              data-testid={`button-add-teeka-translation-${tIdx}`}
                            >
                              <Plus className="w-3 h-3 mr-1" />
                              Add Language
                            </Button>
                          </div>
                          {(teeka.TeekaEntry?.OtherTranslations ?? []).length === 0 ? (
                            <p className="text-xs text-muted-foreground text-center py-2">No other language translations added yet</p>
                          ) : (
                            <div className="space-y-2">
                              {(teeka.TeekaEntry?.OtherTranslations ?? []).map((ot: any, i: number) => (
                                <div key={i} className="p-3 bg-muted/40 rounded-lg space-y-2">
                                  <div className="flex items-center justify-between">
                                    <Select
                                      value={ot.LanguageOfTranslation ?? ""}
                                      onValueChange={(val) => {
                                        const otUpdated = (teeka.TeekaEntry?.OtherTranslations ?? []).map((x: any, idx: number) =>
                                          idx === i ? { ...x, LanguageOfTranslation: val } : x
                                        );
                                        const updated = { ...teeka, TeekaEntry: { ...teeka.TeekaEntry, OtherTranslations: otUpdated } };
                                        updateManthraContent(editingManthra.adhyayaId, editingManthra.khandaId, editingManthra.manthraId, { Teekas: buildUpdated(updated) }, editingManthra.padaId);
                                      }}
                                    >
                                      <SelectTrigger className="h-7 text-xs w-44" data-testid={`select-teeka-otlang-${tIdx}-${i}`}>
                                        <SelectValue placeholder="Select language" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {translationLanguages.map((l) => (
                                          <SelectItem key={l} value={l}>{l}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7 text-destructive"
                                      onClick={() => {
                                        const otUpdated = (teeka.TeekaEntry?.OtherTranslations ?? []).filter((_: any, idx: number) => idx !== i);
                                        const updated = { ...teeka, TeekaEntry: { ...teeka.TeekaEntry, OtherTranslations: otUpdated } };
                                        updateManthraContent(editingManthra.adhyayaId, editingManthra.khandaId, editingManthra.manthraId, { Teekas: buildUpdated(updated) }, editingManthra.padaId);
                                      }}
                                      data-testid={`button-remove-teeka-otlang-${tIdx}-${i}`}
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </Button>
                                  </div>
                                  <RichTextEditor
                                    value={ot.TranslationText ?? []}
                                    onChange={(v) => {
                                      const otUpdated = (teeka.TeekaEntry?.OtherTranslations ?? []).map((x: any, idx: number) =>
                                        idx === i ? { ...x, TranslationText: v as any } : x
                                      );
                                      const updated = { ...teeka, TeekaEntry: { ...teeka.TeekaEntry, OtherTranslations: otUpdated } };
                                      updateManthraContent(editingManthra.adhyayaId, editingManthra.khandaId, editingManthra.manthraId, { Teekas: buildUpdated(updated) }, editingManthra.padaId);
                                    }}
                                    placeholder={`${ot.LanguageOfTranslation || "Translation"} text...`}
                                    minHeight={80}
                                    data-testid={`textarea-teeka-ottext-${tIdx}-${i}`}
                                  />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </section>
              )}

              <div className="flex items-center justify-between pt-2 gap-2 border-t mt-2">
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => requestCloseMantraDialog()}
                    data-testid="button-manthra-close"
                    disabled={
                      !manthraDialogViewOnly &&
                      (saveDraft.isPending ||
                        saveManthraPatchMutation.isPending ||
                        publishMantraMutation.isPending)
                    }
                  >
                    Close
                  </Button>
                  {!manthraDialogViewOnly &&
                    (manthraDialogDirty || isNewLocalManthra(currentManthra ?? ({} as ManthraNode))) && (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          className="text-muted-foreground"
                          onClick={() => discardMantraEditsAndClose()}
                          data-testid="button-manthra-discard-changes"
                        >
                          Discard changes
                        </Button>
                        {isPublishedStrapiDocId(
                          editingManthra?.strapiDocumentId || currentManthra?.strapiDocumentId,
                        ) && (
                          <Button
                            type="button"
                            variant="ghost"
                            className="text-muted-foreground"
                            onClick={() => void restoreMantraFromPublishedCms()}
                            disabled={manthraLoading}
                            data-testid="button-manthra-restore-cms"
                          >
                            Restore from CMS
                          </Button>
                        )}
                      </>
                    )}
                </div>
                {manthraDialogViewOnly ? (
                  !viewOnly && (
                    <Button
                      onClick={() => {
                        setManthraDialogViewOnly(false);
                        manthraDialogDirtyRef.current = false;
                        setManthraDialogDirty(false);
                      }}
                      data-testid="button-manthra-switch-to-edit"
                    >
                      <Pencil className="w-4 h-4 mr-2" />
                      Edit
                    </Button>
                  )
                ) : (
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex gap-2">
                      <Button
                        variant="secondary"
                        onClick={() => handleSaveManthra()}
                        disabled={
                          saveDraft.isPending ||
                          saveManthraPatchMutation.isPending ||
                          publishMantraMutation.isPending
                        }
                        data-testid="button-manthra-save"
                      >
                        {(saveDraft.isPending || saveManthraPatchMutation.isPending) &&
                          !publishMantraMutation.isPending && (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          )}
                        Save
                      </Button>
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex">
                              <Button
                                onClick={handleSaveAndPublishManthra}
                                disabled={!mantraSaveAndPublishReady || publishMantraMutation.isPending}
                                data-testid="button-manthra-save-publish"
                              >
                                {publishMantraMutation.isPending && (
                                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                )}
                                <Send className="w-4 h-4 mr-2" />
                                Save & Publish
                              </Button>
                            </span>
                          </TooltipTrigger>
                          {mantraSaveAndPublishHint && (
                            <TooltipContent side="top" className="max-w-xs text-xs">
                              {mantraSaveAndPublishHint}
                            </TooltipContent>
                          )}
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    {mantraPublishStatus && publishMantraMutation.isPending && (
                      <p className="text-xs text-muted-foreground max-w-[280px] text-right">
                        {mantraPublishStatus}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </fieldset>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Unsaved / new verse — confirm before closing mantra dialog */}
      <AlertDialog open={pendingCloseManthra} onOpenChange={(open) => { if (!open) setPendingCloseManthra(false); }}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Save this verse before closing?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  {currentManthra?._isNewLocal
                    ? "This is a newly inserted verse. Save to keep it in the portal draft, or publish to push it to the CMS."
                    : "You have unsaved edits on this verse."}
                </p>
                <p>
                  To undo without publishing: discard changes (this verse only), restore from CMS
                  (published text), or discard portal draft (whole grantha overlay — returns to the
                  live CMS version).
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
            <div className="flex flex-wrap gap-2 justify-end w-full">
              <AlertDialogCancel data-testid="button-manthra-close-cancel">Keep editing</AlertDialogCancel>
              <Button
                type="button"
                variant="outline"
                onClick={() => discardMantraEditsAndClose()}
                data-testid="button-manthra-close-discard-changes"
              >
                Discard changes
              </Button>
              {isPublishedStrapiDocId(
                editingManthra?.strapiDocumentId ||
                  findManthraInTree(
                    adhyayas,
                    editingManthra?.adhyayaId ?? "",
                    editingManthra?.khandaId ?? "",
                    editingManthra?.manthraId ?? "",
                    editingManthra?.padaId,
                  )?.strapiDocumentId,
              ) && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void restoreMantraFromPublishedCms()}
                  disabled={manthraLoading}
                  data-testid="button-manthra-close-restore-cms"
                >
                  Restore from CMS
                </Button>
              )}
            </div>
            <div className="flex flex-wrap gap-2 justify-end w-full">
              {isAdmin && editingDraftId && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => restoreDraftSnapshotAndCloseMantra()}
                  disabled={recoverDraft.isPending}
                  data-testid="button-manthra-close-restore-snapshot"
                >
                  {recoverDraft.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Restore draft snapshot
                </Button>
              )}
              {editingDraftId && editingGranthaStrapiDocumentId() && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => requestDiscardPortalDraftFromMantra()}
                  data-testid="button-manthra-close-discard-portal-draft"
                >
                  Discard portal draft
                </Button>
              )}
            </div>
            <div className="flex flex-wrap gap-2 justify-end w-full border-t pt-2">
              <AlertDialogAction
                onClick={() => {
                  setPendingCloseManthra(false);
                  handleSaveManthra(() => closeMantraDialog());
                }}
                data-testid="button-manthra-close-save-draft"
              >
                Save draft
              </AlertDialogAction>
              <AlertDialogAction
                onClick={() => {
                  setPendingCloseManthra(false);
                  handleSaveAndPublishManthra();
                }}
                data-testid="button-manthra-close-save-publish"
              >
                Save &amp; Publish
              </AlertDialogAction>
            </div>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remove manthra confirmation */}
      <AlertDialog open={!!pendingRemove} onOpenChange={(open) => { if (!open) setPendingRemove(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {structureConfig.leafName}?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span className="block">
                Remove <strong>&quot;{pendingRemove?.title}&quot;</strong> from the list?
                {" "}If it has been published to the CMS it will be deleted from Strapi on the next save.
              </span>
              <span className="block text-muted-foreground">
                <strong>Remove &amp; Renumber</strong> updates verse labels and list order. <strong>Remove</strong> only deletes
                the row and keeps existing labels, but still sets each remaining row&apos;s order to 1, 2, 3… in list sequence
                so saves stay consistent.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col sm:flex-row gap-2">
            <AlertDialogCancel data-testid="button-cancel-remove-manthra">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmRemoveManthra(false)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-remove-manthra-keep"
            >
              <X className="w-4 h-4 mr-2" />
              Remove
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => confirmRemoveManthra(true)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-remove-manthra-renumber"
            >
              <X className="w-4 h-4 mr-2" />
              Remove &amp; Renumber
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!resetDraftTarget} onOpenChange={(open) => { if (!open) setResetDraftTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard portal draft?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the portal draft for &quot;{resetDraftTarget?.GranthaName}&quot; only. Published
              content in Strapi is unchanged. The card will show as <strong>Published</strong> again in the list.
              Open that entry to edit from live CMS data. (Not the same as Recover Snapshot.)
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resettingDraftId != null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirmResetDraftFromStrapi()}
              disabled={resettingDraftId != null}
              data-testid="button-confirm-reset-draft-strapi-form"
            >
              {resettingDraftId != null && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Discard draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
