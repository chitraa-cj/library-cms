import { useState, useEffect, useRef } from "react";
import { track } from "@/lib/posthog";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, ApiError } from "@/lib/queryClient";
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
  bhashyamAuthors,
  teekaAuthors,
  translationLanguages,
  type StrapiGrantha,
  type StrapiTeeka,
  type StrapiResponse,
  type StrapiBlock,
  type TextAndTranslation,
} from "@shared/schema";
import StrapiSyncBar from "@/components/strapi-sync-bar";
import { STRAPI_POLL_INTERVAL } from "@/hooks/use-strapi-sync";
import { blocksToText } from "@/lib/strapi-blocks";
import {
  sortNodesByOrder,
  isPublishedStrapiDocId,
  collectPublishedManthraDocIdsFromKhanda,
  collectPublishedManthraDocIdsFromAdhyaya,
  prepareHierarchyForContentStep,
  normalizeEditorHierarchy,
  editorOrdinalLabel,
  reindexMantraOrdersPreservingTitles,
  assignContiguousMantraOrders,
  buildUniqueStrapiOrderMap,
  mantrasShareNumberSuffix,
  mantrasShareLeafAndSuffix,
  findStrapiMantraByLeafAndSuffix,
  resolvePortalMantraToStrapiDoc,
  collectKnownVerseSuffixesForLeaf,
  strapiVerseTakenForConfiguredLeaf,
  titleUsesConfiguredLeaf,
  mantraNumberSuffix,
  type GranthaStructureConfig,
  type StrapiMantraRef,
} from "@/lib/grantha-structure-sync";
import {
  mergeMantraStrapiDocumentIds,
  syncMantraSectionAfterStructuralEdits,
  syncAllMantraSectionsInGrantha,
  applyMantraDocIdPatches,
  resolveMantraSectionStrapiDocumentId,
  type SnapshotAdhyaya,
} from "@/lib/grantha-strapi-mantra-sync";
import { invalidateGranthaCmsCaches } from "@/lib/strapi-cache-sync";
import OtherTranslationsHermex from "@/components/other-translations-hermex";
import {
  postStrapiSection,
  collectSectionDocumentIdsChildToParentForAdhyaya,
  collectSectionDocumentIdsChildToParentForKhanda,
  strapiDeleteMantrasThenSections,
  deleteStrapiTeekaBestEffort,
  syncStrapiSectionOrderAndTitles,
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

/** After structural edits: sort siblings, contiguous section `order`, reindex all mantra titles. */
function withNormalizedHierarchy(nodes: AdhyayaNode[], cfg: GranthaStructureConfig): AdhyayaNode[] {
  return normalizeEditorHierarchy(nodes, cfg) as AdhyayaNode[];
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

function mergeEntry(draft: any | undefined, fromStrapi: any | undefined): any | undefined {
  if (!fromStrapi && !draft) return undefined;
  if (!fromStrapi) return draft;
  if (!draft) return fromStrapi;

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

  return {
    ...fromStrapi,
    ...(hasBlocks(draft.SanskritTextEntry) && { SanskritTextEntry: draft.SanskritTextEntry }),
    ...(hasBlocks(draft.EnglishTranslationText) && { EnglishTranslationText: draft.EnglishTranslationText }),
    ...(draft.IASTTransliteration && { IASTTransliteration: draft.IASTTransliteration }),
    ...(mergedOT !== undefined && { OtherTranslations: mergedOT }),
  };
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
      TeekaName: strapiName,
      TeekaAuthor: t.teeka?.TeekaAuthor || t.TeekaAuthor || "",
      teekaDocId: strapiDocId || undefined,
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
// When Strapi has two records with the same order in a section (e.g. a manually-created
// "Mantra 1.1.1" and a portal-published "Manthra 1.1.1" both at order=1), keep one row
// per order. Prefer the entry with the lower numeric Strapi id (earlier publish).
function deduplicateManthrasByOrder(manthras: any[]): any[] {
  // Build a map from order → best manthra (lower numeric Strapi id wins on duplicate order)
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
    } else {
      // Keep the one with the LOWER numeric id (first-published = portal version).
      // The portal always publishes before anyone adds a manual duplicate in Strapi.
      const existingId = typeof existing.id === "number" ? existing.id : Infinity;
      const candidateId = typeof m.id === "number" ? m.id : Infinity;
      if (candidateId < existingId) {
        best.set(ord, m);
      }
    }
  }
  return [...Array.from(best.values()), ...noOrder];
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
  const toManthra = (m: any, mi: number): ManthraNode => ({
    id: uid(),
    title: m.ShlokaManthraNumber || `${leafLabel} ${mi + 1}`,
    order: m.order ?? mi + 1,
    strapiDocumentId: m.documentId || undefined,
  });

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

/** Keep only rows for the configured leaf; one row per verse number. */
function dedupeManthrasForEditor(manthras: ManthraNode[], leaf: string): ManthraNode[] {
  const configured = (leaf || "Mantra").trim();
  const bySuffix = new Map<string, ManthraNode>();
  const score = (x: ManthraNode) => {
    let s = 0;
    if (hasManthraContent(x)) s += 100;
    if (isPublishedStrapiDocId(x.strapiDocumentId)) s += 1;
    return s;
  };
  for (const m of sortNodesByOrder(manthras)) {
    if (!titleUsesConfiguredLeaf(m.title, configured)) continue;
    const suffix = mantraNumberSuffix(m.title);
    const key = suffix ?? m.id;
    const prev = bySuffix.get(key);
    if (!prev || score(m) > score(prev)) bySuffix.set(key, m);
  }
  return sortNodesByOrder([...bySuffix.values()]);
}

function hasManthraContent(m: ManthraNode) {
  return !!(
    hasBlocks(m.ShlokaManthraEntry?.SanskritTextEntry) ||
    hasBlocks(m.ShlokaManthraEntry?.EnglishTranslationText) ||
    hasBlocks(m.BhashyamForShlokaManthra?.SanskritTextEntry) ||
    m.Teekas?.some((t) => hasBlocks(t.TeekaEntry?.SanskritTextEntry))
  );
}

// ---------- Grantha Card ----------

function GranthaCard({
  item,
  onEdit,
  onView,
  onDelete,
  onPublish,
  isPublishing,
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
  isPublishing: boolean;
  currentUserId?: string | null;
  isDuplicate?: boolean;
  isLocked?: boolean;
  isAdmin?: boolean;
  onLock?: () => void;
  onUnlock?: () => void;
}) {
  const isDraft = item._isDraft;
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
            {isDraft ? "Draft" : "Published"}
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
          {!isLocked && isDraft && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-primary hover:text-primary"
              onClick={onPublish}
              disabled={isPublishing}
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
            const totalManthras = item.sections.reduce(
              (sum: number, s: any) => sum + (Array.isArray(s.manthras) ? s.manthras.length : 0),
              0
            );
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
        <p className="text-xs text-muted-foreground mt-3 pt-3 border-t">Draft — not yet published</p>
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
  const [deleteTarget, setDeleteTarget] = useState<any>(null);

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
  const strapiHierarchySyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mantraSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mantraSyncChainRef = useRef<Promise<void>>(Promise.resolve());
  const fullMantraAlignTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fullMantraAlignChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingMantraDeletesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    adhyayasRef.current = adhyayas;
  }, [adhyayas]);

  useEffect(() => {
    structureConfigRef.current = structureConfig;
  }, [structureConfig]);

  useEffect(() => {
    return () => {
      if (strapiHierarchySyncTimerRef.current) clearTimeout(strapiHierarchySyncTimerRef.current);
      if (mantraSyncTimerRef.current) clearTimeout(mantraSyncTimerRef.current);
      if (fullMantraAlignTimerRef.current) clearTimeout(fullMantraAlignTimerRef.current);
    };
  }, []);

  // Manthra content dialog
  const [editingManthra, setEditingManthra] = useState<{
    adhyayaId: string;
    khandaId: string;
    padaId?: string;  // only set when levelThreeEnabled
    manthraId: string;
    strapiDocumentId?: string; // set if this mantra is already published to Strapi
  } | null>(null);
  const [manthraDialogDirty, setManthraDialogDirty] = useState(false);
  const [manthraLoading, setManthraLoading] = useState(false);
  const [editingGranthaSectionsLoading, setEditingGranthaSectionsLoading] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<{ adhyayaId: string; khandaId: string; manthraId: string; padaId?: string; title: string } | null>(null);

  // When the mantra dialog opens for a published mantra (has strapiDocumentId),
  // fetch the live Strapi content and merge it with any portal-draft edits so
  // users always see the most complete version.
  //
  // MERGE STRATEGY (field-level): Strapi data is used as the BASE, but any
  // field that the portal draft already has non-empty content for is PRESERVED.
  // This prevents the draft's English translations (or other edits not yet
  // published to Strapi) from being silently overwritten by the Strapi fetch.
  useEffect(() => {
    const docId = editingManthra?.strapiDocumentId;
    if (!docId || !editingManthra) return;
    let cancelled = false;
    setManthraLoading(true);

    // mergeEntry and mergeTeekas are module-level functions (see top of file).

    const { adhyayaId, khandaId, manthraId, padaId } = editingManthra;

    const applyStrapiMantraToTree = (strapiRow: Record<string, unknown>) => {
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
                          mn.id !== manthraId ? mn : {
                            ...mn,
                            title:
                              mn.title ||
                              (strapiRow.ShlokaManthraNumber as string) ||
                              "",
                            strapiDocumentId: (strapiRow.documentId as string) || mn.strapiDocumentId,
                            ShlokaManthraEntry: mergeEntry(mn.ShlokaManthraEntry, strapiRow.ShlokaManthraEntry as any),
                            BhashyamForShlokaManthra: mergeEntry(mn.BhashyamForShlokaManthra, strapiRow.BhashyamEntry as any),
                            Teekas: Array.isArray(strapiRow.Teekas) && (strapiRow.Teekas as unknown[]).length > 0
                              ? mergeTeekas(mn.Teekas, strapiRow.Teekas as any)
                              : mn.Teekas,
                          }
                        ),
                      };
                    }),
                  };
                }
                return {
                  ...k,
                  manthras: k.manthras.map((mn) =>
                    mn.id !== manthraId ? mn : {
                      ...mn,
                      title:
                        mn.title ||
                        (strapiRow.ShlokaManthraNumber as string) ||
                        "",
                      strapiDocumentId: (strapiRow.documentId as string) || mn.strapiDocumentId,
                      ShlokaManthraEntry: mergeEntry(mn.ShlokaManthraEntry, strapiRow.ShlokaManthraEntry as any),
                      BhashyamForShlokaManthra: mergeEntry(mn.BhashyamForShlokaManthra, strapiRow.BhashyamEntry as any),
                      Teekas: Array.isArray(strapiRow.Teekas) && (strapiRow.Teekas as unknown[]).length > 0
                        ? mergeTeekas(mn.Teekas, strapiRow.Teekas as any)
                        : mn.Teekas,
                    }
                  ),
                };
              }),
            };
          })
      );
    };

    const loadMantraFromStrapi = async (): Promise<{
      row: Record<string, unknown>;
      corrected: boolean;
    } | null> => {
      const snap = adhyayasRef.current as SnapshotAdhyaya[];
      const cfg = structureConfigRef.current;
      const localNode = findManthraInTree(snap as AdhyayaNode[], adhyayaId, khandaId, manthraId, padaId);
      const sectionDocId = resolveMantraSectionStrapiDocumentId(snap, adhyayaId, khandaId, padaId, cfg);

      const primaryRes = await fetch(`/api/strapi/manthras/${docId}`, { credentials: "include" });
      const primaryJson = await primaryRes.json();
      const primary = primaryJson?.data as Record<string, unknown> | undefined;
      if (!primary) return null;

      const primaryNum = (primary.ShlokaManthraNumber as string) || "";
      if (
        localNode?.title &&
        primaryNum &&
        !mantrasShareLeafAndSuffix(localNode.title, primaryNum, cfg.leafName ?? "Mantra") &&
        sectionDocId
      ) {
        const listRes = await fetch(
          `/api/strapi/manthras?filters[Section][documentId][$eq]=${encodeURIComponent(sectionDocId)}&pagination[pageSize]=250`,
          { credentials: "include" },
        );
        const listJson = await listRes.json().catch(() => ({}));
        const rows = (listJson?.data ?? []) as Array<Record<string, unknown>>;
        const refs: StrapiMantraRef[] = rows
          .filter((r) => typeof r.documentId === "string")
          .map((r) => ({
            title: String(r.ShlokaManthraNumber ?? ""),
            docId: String(r.documentId),
            order: typeof r.order === "number" ? r.order : 0,
          }));
        const correct = findStrapiMantraByLeafAndSuffix(
          refs,
          localNode.title,
          cfg.leafName ?? "Mantra",
        );
        if (correct && correct.docId !== docId) {
          const fixRes = await fetch(`/api/strapi/manthras/${correct.docId}`, { credentials: "include" });
          const fixJson = await fixRes.json();
          const fixed = (fixJson?.data as Record<string, unknown>) ?? primary;
          return { row: fixed, corrected: true };
        }
      }
      return { row: primary, corrected: false };
    };

    loadMantraFromStrapi()
      .then((result) => {
        if (cancelled || !result) return;
        applyStrapiMantraToTree(result.row);
        if (result.corrected) {
          const fixedDocId = result.row.documentId as string | undefined;
          if (fixedDocId) {
            setEditingManthra((prev) =>
              prev ? { ...prev, strapiDocumentId: fixedDocId } : prev,
            );
          }
          toast({
            title: "Mantra link corrected",
            description:
              "This row was pointing at the wrong CMS record after renumbering. Content now loads from the record matching this label.",
          });
        }
      })
      .catch(console.error)
      .finally(() => { if (!cancelled) setManthraLoading(false); });
    return () => { cancelled = true; };
  }, [editingManthra?.manthraId, editingManthra?.strapiDocumentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset dirty flag when opening a mantra for view/edit.
  useEffect(() => {
    if (editingManthra) setManthraDialogDirty(false);
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

  // Per-manthra publish mutation
  const publishMantraMutation = useMutation({
    mutationFn: async (params: { draftId: number; adhyayaId: string; khandaId: string; padaId?: string; manthraId: string }) => {
      const res = await apiRequest("POST", `/api/drafts/${params.draftId}/publish-manthra`, {
        adhyayaId: params.adhyayaId,
        khandaId: params.khandaId,
        padaId: params.padaId,
        manthraId: params.manthraId,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Failed to publish mantra");
      }
      return res.json();
    },
    onSuccess: (data: any, params) => {
      if (data.strapiDocumentId) {
        updateManthraContent(
          params.adhyayaId,
          params.khandaId,
          params.manthraId,
          { strapiDocumentId: data.strapiDocumentId },
          params.padaId,
          { markDirty: false }
        );
      }
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
            : "Content and verse label are now live in Strapi under the name shown in the editor.",
      });
      setEditingManthra(null);
    },
    onError: (err: any) => {
      track("manthra_publish_failed", { grantha_name: formData.GranthaName, error: err.message });
      toast({ variant: "destructive", title: "Publish failed", description: err.message });
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
    setFormData(EMPTY_FORM);
    setTeekas([]);
    setOtherTranslations([]);
    setGranthaNameTranslations([]);
    setStructureConfig(DEFAULT_STRUCTURE);
    setAdhyayas([]);
    setEditingDraftId(null);
    setEditingItem(null);
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
      const matchingDraft = allGranthaDrafts.find(
        (d) => d.strapiDocumentId === item.documentId
      );
      const savedData = matchingDraft?.data as any;

      setEditingDraftId(matchingDraft?.id ?? null);

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

    // Shared for all cases: Strapi items AND local drafts linked to Strapi.
    let effectiveStructureConfig = migrateStructureConfig(rawCfg2);
    const effectiveDocId = item._isDraft ? item._strapiDocId : item.documentId;

    // Fetch sections + teekas in parallel.
    // Always fetch teekas from Strapi so new ones added after the last draft save are picked up.
    setEditingGranthaSectionsLoading(true);
    let fetchedSections: any[] = [];
    let strapiGranthaOne: any = null;
    try {
      const [sectionsRes, teekasRes, granthaRes] = await Promise.all([
        fetch(`/api/strapi/sections/by-grantha/${effectiveDocId}`, { credentials: "include" }),
        fetch(`/api/strapi/teekas/by-grantha/${effectiveDocId}`, { credentials: "include" }),
        fetch(`/api/strapi/granthas/${effectiveDocId}`, { credentials: "include" }),
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

      if (teekasRes?.ok) {
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
      } else if (!hasSavedTeekas && !hasInlineTeekas) {
        setTeekas([]);
      }
    } catch (e) {
      console.warn("[granthas] openEdit: sections/teekas/grantha fetch failed:", e);
      if (!hasSavedTeekas && !hasInlineTeekas) setTeekas([]);
    }

    const bhMergeSource = strapiGranthaOne?.BhashyakaraIntroduction ?? mergeStrapiBHForFallback;
    const gtMergeSource = strapiGranthaOne?.GranthaNameTranslations ?? mergeStrapiGTForFallback;
    setOtherTranslations(mergeBhashyakaraPortalOtherTranslations(mergeDraftOther, bhMergeSource));
    setGranthaNameTranslations(mergeGranthaNameTranslationsPortal(mergeDraftName, gtMergeSource));

    setEditingGranthaSectionsLoading(false);

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
        const isFlat = hierToUse2.every(
          (a) => a.khandas.length === 1 && a.khandas[0]?.title === "_default"
        );
        if (isFlat && effectiveStructureConfig.levelTwoEnabled) {
          effectiveStructureConfig = { ...effectiveStructureConfig, levelTwoEnabled: false };
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
      const strapiManthraByShloka = new Map<string, string>(); // shlokaNr → documentId
      // Title-based map (kept for flat-grantha adhyaya lookups where titles ARE unique at root level).
      // NOTE: NOT safe for khanda-level lookups — multiple khandas across different adhyayas can
      // share the same title (e.g. "Prathama Khanda" under every Mundika in Mundaka Upanishad).
      const strapiMantrasBySecTitle = new Map<string, { title: string; docId: string; order: number }[]>();
      // DocId-based map: section documentId → its manthras (always unique, preferred over title map).
      const strapiMantrasBySecDocId = new Map<string, { title: string; docId: string; order: number }[]>();
      // Map: parent section documentId → child sections (for supplementing missing khandas)
      const strapiChildSectionsByParentDocId = new Map<string, any[]>();
      // Map: section title → section (for matching draft adhyayas to Strapi adhyayas)
      const strapiSectionByTitle = new Map<string, any>();
      for (const sec of fetchedSections) {
        if (sec.title) strapiSectionByTitle.set(sec.title, sec);
        if (Array.isArray(sec.manthras)) {
          const list: { title: string; docId: string; order: number }[] = [];
          for (const m of sec.manthras) {
            if (m.ShlokaManthraNumber && m.documentId) {
              strapiManthraByShloka.set(m.ShlokaManthraNumber, m.documentId);
              list.push({ title: m.ShlokaManthraNumber, docId: m.documentId, order: m.order ?? 0 });
            }
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

      function markStrapiDocsMatchedByLeaf(
        portalTitle: string | undefined,
        sectionList: { title: string; docId: string }[],
        matched: Set<string>,
      ) {
        const suffix = mantraNumberSuffix(portalTitle);
        if (!suffix || !titleUsesConfiguredLeaf(portalTitle, configuredLeafLabel)) return;
        for (const sm of sectionList) {
          if (
            mantraNumberSuffix(sm.title) === suffix &&
            titleUsesConfiguredLeaf(sm.title, configuredLeafLabel)
          ) {
            matched.add(sm.docId);
          }
        }
      }

      function enrichHierarchy(hier: AdhyayaNode[]): AdhyayaNode[] {
        const knownShlokas = collectKnownShlokas(hier);
        const knownSuffixes = collectKnownSuffixes(hier);
        const leafLabel = configuredLeafLabel;
        // Build once at function scope so it's available in all supplement blocks.
        const deletedManthraDocIdsSet = new Set(localDeletedManthraDocIds);
        return hier.map((a) => {
          // ── Enrich existing khandas ──────────────────────────────────────────────────
          // Resolve this adhyaya's Strapi documentId once (used for child-section lookup below).
          const adhyaDocId: string | undefined =
            (a as any).documentId || strapiSectionByTitle.get(a.title)?.documentId;

          const enrichedKhandas = a.khandas.map((k) => {
            // Determine which Strapi section's manthras belong to this khanda node.
            // IMPORTANT: We look up by (adhyaya docId + khanda title), NOT by khanda title alone.
            // Multiple khandas across different adhyayas can share the same title, so a plain
            // title-keyed map would return manthras from the wrong adhyaya (e.g. Mundaka bug
            // where "Prathama Khanda" existed under all 3 Mundikas — the last writer won and
            // ALL three rendered Tritiya Mundaka's "Mantra 3.1.X" manthras).
            let strapiMantrasForKhanda: { title: string; docId: string; order: number }[];
            if (k.title === "_default") {
              // Flat section: the "_default" synthetic khanda maps to the adhyaya itself.
              // Prefer docId-based lookup (survives title renames), fall back to title.
              const kDocId: string | undefined = (a as any).documentId;
              strapiMantrasForKhanda = (kDocId ? (strapiMantrasBySecDocId.get(kDocId) ?? null) : null)
                ?? strapiMantrasBySecTitle.get(a.title) ?? [];
            } else if (adhyaDocId) {
              // Real khanda: find this khanda's specific Strapi section.
              // Try documentId first (most reliable — survives title changes in Strapi),
              // then fall back to title matching under the parent.
              const childSecs = strapiChildSectionsByParentDocId.get(adhyaDocId) ?? [];
              const kDocId: string | undefined = (k as any).documentId;
              const matchSec =
                (kDocId ? childSecs.find((c: any) => c.documentId === kDocId) : undefined)
                ?? childSecs.find((c: any) => c.title === k.title);
              strapiMantrasForKhanda = matchSec?.documentId
                ? (strapiMantrasBySecDocId.get(matchSec.documentId) ?? [])
                : [];
            } else {
              // No adhyaya docId available (very rare) — fall back to title-based lookup.
              strapiMantrasForKhanda = strapiMantrasBySecTitle.get(k.title) ?? [];
            }

            const { byOrder: strapiByOrder, ambiguousOrders } = buildUniqueStrapiOrderMap(
              strapiMantrasForKhanda,
            );
            const resolveOpts = {
              configuredLeaf: leafLabel,
              byExactTitle: strapiManthraByShloka,
              sectionMantras: strapiMantrasForKhanda,
              byOrder: strapiByOrder,
              ambiguousOrders,
            };
            const matchedDocIds = new Set<string>();

            function resolveDocId(m: ManthraNode): { docId: string | undefined; strapiTitle?: string } | undefined {
              const resolved = resolvePortalMantraToStrapiDoc(m, resolveOpts);
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
              if (resolved.docId) {
                matchedDocIds.add(resolved.docId);
                markStrapiDocsMatchedByLeaf(m.title, strapiMantrasForKhanda, matchedDocIds);
              }
              return resolved;
            }

            const enrichedManthras = k.manthras.reduce<ManthraNode[]>((acc, m) => {
              const resolved = resolveDocId(m);
              if (!resolved) return acc; // dropped: Strapi record was deleted, no order remap
              const { docId } = resolved;
              acc.push({
                ...m,
                strapiDocumentId: docId,
              });
              return acc;
            }, []);
            // Enrich existing padas (3-level granthas: khanda → pada → manthra).
            // Prefer docId-based lookup for the pada's own section to avoid title collisions.
            // FALLBACK: if draft khanda has no stored documentId, look it up from Strapi by title
            // under the parent adhyaya — needed so the L3 supplement can find missing Adhikaranas.
            const khandaDocId: string | undefined =
              (k as any).documentId
              ?? (adhyaDocId
                ? (strapiChildSectionsByParentDocId.get(adhyaDocId) ?? []).find(
                    (s: any) => s.title === k.title
                  )?.documentId
                : undefined);
            const enrichedPadas = (k.padas ?? []).map((p) => {
              // FALLBACK: if draft pada has no stored documentId, look it up from Strapi by title
              // under the parent khanda (Pada-level section) — needed for manthra supplement.
              const padaDocId: string | undefined =
                (p as any).documentId
                ?? (khandaDocId
                  ? (strapiChildSectionsByParentDocId.get(khandaDocId) ?? []).find(
                      (s: any) => s.title === p.title
                    )?.documentId
                  : undefined);
              const padaStrapi = padaDocId
                ? (strapiMantrasBySecDocId.get(padaDocId) ?? [])
                : (strapiMantrasBySecTitle.get(p.title) ?? []);
              const { byOrder: padaByOrder, ambiguousOrders: padaAmbiguousOrders } =
                buildUniqueStrapiOrderMap(padaStrapi);
              const padaResolveOpts = {
                configuredLeaf: leafLabel,
                byExactTitle: strapiManthraByShloka,
                sectionMantras: padaStrapi,
                byOrder: padaByOrder,
                ambiguousOrders: padaAmbiguousOrders,
              };
              const padaMatchedDocIds = new Set<string>();
              const enrichedPadaManthras = p.manthras.map((m) => {
                const resolved = resolvePortalMantraToStrapiDoc(m, padaResolveOpts);
                if (!resolved?.docId) return m;
                padaMatchedDocIds.add(resolved.docId);
                const row = {
                  ...m,
                  strapiDocumentId: resolved.docId,
                };
                markStrapiDocsMatchedByLeaf(m.title, padaStrapi, padaMatchedDocIds);
                return row;
              });
              // Supplement: Strapi manthras on this pada not yet in the local list.
              const usedPadaOrders = new Set(enrichedPadaManthras.map((m) => m.order).filter((o): o is number => o != null));
              const newPadaManthras: ManthraNode[] = [];
              for (const sm of padaStrapi) {
                if (
                  !padaMatchedDocIds.has(sm.docId) &&
                  !knownShlokas.has(sm.title) &&
                  !strapiVerseTakenForConfiguredLeaf(sm.title, knownSuffixes, leafLabel) &&
                  !deletedManthraDocIdsSet.has(sm.docId)
                ) {
                  if (sm.order != null && usedPadaOrders.has(sm.order)) continue;
                  newPadaManthras.push({ id: uid(), title: sm.title, order: sm.order, strapiDocumentId: sm.docId });
                  knownShlokas.add(sm.title);
                  const suf = mantraNumberSuffix(sm.title);
                  if (suf) knownSuffixes.add(suf);
                }
              }
              const finalPadaManthras = dedupeManthrasForEditor(
                [...enrichedPadaManthras, ...newPadaManthras],
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
                  : (strapiMantrasBySecTitle.get(padaSec.title) ?? []);
                const padaManthras = padaList.sort((x: any, y: any) => (x.order ?? 0) - (y.order ?? 0)).map((sm: any) => ({
                  id: uid(), title: sm.title, order: sm.order, strapiDocumentId: sm.docId,
                } as ManthraNode));
                supplementPadas.push({ id: uid(), title: padaSec.title, order: padaSec.order ?? 0, expanded: true, documentId: padaSec.documentId || undefined, manthras: padaManthras });
              }
            }
            const finalPadas = [...enrichedPadas, ...supplementPadas].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

            // Supplement: add Strapi mantras that aren't already covered by a local node.
            // Also skip any whose order is already taken by an enriched local node —
            // this collapses actual Strapi duplicates (e.g. "Mantra 1.1.1" + "Manthra 1.1.1"
            // both at order=1 in the same section) without showing phantom entries.
            const usedOrders = new Set(
              enrichedManthras.map((m) => m.order).filter((o): o is number => o != null)
            );
            const newManthras: ManthraNode[] = [];
            for (const sm of strapiMantrasForKhanda) {
              if (
                !matchedDocIds.has(sm.docId) &&
                !knownShlokas.has(sm.title) &&
                !strapiVerseTakenForConfiguredLeaf(sm.title, knownSuffixes, leafLabel) &&
                !deletedManthraDocIdsSet.has(sm.docId)
              ) {
                if (sm.order != null && usedOrders.has(sm.order)) continue;
                newManthras.push({ id: uid(), title: sm.title, order: sm.order, strapiDocumentId: sm.docId });
                knownShlokas.add(sm.title);
                const suf = mantraNumberSuffix(sm.title);
                if (suf) knownSuffixes.add(suf);
              }
            }

            const finalManthras = dedupeManthrasForEditor(
              [...enrichedManthras, ...newManthras],
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
          if (strapiAdhyaya?.documentId) {
            const strapiChildren = (strapiChildSectionsByParentDocId.get(strapiAdhyaya.documentId) ?? [])
              .sort((x: any, y: any) => (x.order ?? 0) - (y.order ?? 0));
            for (const sec of strapiChildren) {
              if (!sec.title || existingKhandaTitles.has(sec.title)) continue;
              // Also skip if already matched by documentId (handles title renames in Strapi)
              if (sec.documentId && existingKhandaDocIds.has(sec.documentId)) continue;
              // Skip explicitly deleted sections — do not re-add them from Strapi
              if (sec.documentId && deletedDocIdsSet.has(sec.documentId)) continue;
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
                  manthras: (gc.documentId
                    ? (strapiMantrasBySecDocId.get(gc.documentId) ?? strapiMantrasBySecTitle.get(gc.title) ?? [])
                    : (strapiMantrasBySecTitle.get(gc.title) ?? []))
                    .sort((x: any, y: any) => (x.order ?? 0) - (y.order ?? 0))
                    .filter((sm: any) => !deletedManthraDocIdsSet.has(sm.docId))
                    .map((sm: any) => ({
                      id: uid(),
                      title: sm.title,
                      order: sm.order,
                      strapiDocumentId: sm.docId,
                    } as ManthraNode)),
                } as PadaNode));
              } else {
                // Level-2: manthras live directly on this khanda section.
                const secList = sec.documentId
                  ? (strapiMantrasBySecDocId.get(sec.documentId) ?? [])
                  : (strapiMantrasBySecTitle.get(sec.title) ?? []);
                supplementManthras = secList
                  .sort((x, y) => (x.order ?? 0) - (y.order ?? 0))
                  .filter((sm) => !deletedManthraDocIdsSet.has(sm.docId))
                  .map((sm) => ({
                    id: uid(),
                    title: sm.title,
                    order: sm.order,
                    strapiDocumentId: sm.docId,
                  } as ManthraNode));
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
      let hierInputForEnrich = hierToUse2;
      const configuredLeaf = (effectiveStructureConfig.leafName || "Mantra").trim() || "Mantra";
      if (rawCfg2?.leafName === "Khanda") {
        hierInputForEnrich = migrateHierarchyLeafName(hierInputForEnrich, "Khanda", "Mantra");
      }
      for (const oldPrefix of ["Mantra", "Manthra", "Khanda"] as const) {
        if (oldPrefix !== configuredLeaf) {
          hierInputForEnrich = migrateHierarchyLeafName(hierInputForEnrich, oldPrefix, configuredLeaf);
        }
      }
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
                manthras: (gc.documentId
                  ? (strapiMantrasBySecDocId.get(gc.documentId) ?? strapiMantrasBySecTitle.get(gc.title) ?? [])
                  : (strapiMantrasBySecTitle.get(gc.title) ?? []))
                  .sort((x: any, y: any) => (x.order ?? 0) - (y.order ?? 0))
                  .filter((sm: any) => !topLevelDeletedManthraDocIdsSet.has(sm.docId))
                  .map((sm: any, mi: number) => ({
                    id: uid(),
                    title: sm.title,
                    order: sm.order ?? mi + 1,
                    strapiDocumentId: sm.docId,
                  } as ManthraNode)),
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
              manthras: (child.documentId
                ? (strapiMantrasBySecDocId.get(child.documentId) ?? strapiMantrasBySecTitle.get(child.title) ?? [])
                : (strapiMantrasBySecTitle.get(child.title) ?? []))
                .sort((x: any, y: any) => (x.order ?? 0) - (y.order ?? 0))
                .filter((sm: any) => !topLevelDeletedManthraDocIdsSet.has(sm.docId))
                .map((sm: any, mi: number) => ({
                  id: uid(),
                  title: sm.title,
                  order: sm.order ?? mi + 1,
                  strapiDocumentId: sm.docId,
                } as ManthraNode)),
            } as KhandaNode;
          });
        } else {
          // Flat section — create a synthetic "_default" khanda with this section's manthras
          const manthrasForSec = (sec.documentId
            ? (strapiMantrasBySecDocId.get(sec.documentId) ?? strapiMantrasBySecTitle.get(sec.title) ?? [])
            : (strapiMantrasBySecTitle.get(sec.title) ?? []))
            .sort((x: any, y: any) => (x.order ?? 0) - (y.order ?? 0))
            .filter((sm: any) => !topLevelDeletedManthraDocIdsSet.has(sm.docId))
            .map((sm: any, mi: number) => ({
              id: uid(),
              title: sm.title,
              order: sm.order ?? mi + 1,
              strapiDocumentId: sm.docId,
            } as ManthraNode));
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

      const prep = prepareHierarchyForContentStep(finalHier2, effectiveStructureConfig);
      if (prep.sectionDocIdsToMarkDeleted.length > 0) {
        setDeletedStrapiSectionDocIds((prev) => Array.from(new Set([...prev, ...prep.sectionDocIdsToMarkDeleted])));
      }
      setStructureConfig(effectiveStructureConfig);
      const normalizedOpen = withNormalizedHierarchy(prep.hierarchy as AdhyayaNode[], effectiveStructureConfig);
      setAdhyayas(normalizedOpen);
      if (isPublishedStrapiDocId(granthaDocId)) {
        flushStrapiFullHierarchySectionOrderSyncNow(normalizedOpen, effectiveStructureConfig, true);
      }
      setStep(1);
      setView("form");

    // ── Bulk teeka pre-populate ──
    // After the hierarchy is in state, fetch ALL manthras' teeka data from
    // Strapi in one request and merge it into the hierarchy. This guarantees
    // that teeka content (especially OtherTranslations) is ALWAYS present in
    // state from the moment the grantha opens — not just after each dialog
    // is individually opened. Without this, any "Save" before opening every
    // dialog would clear teeka content in the draft.
    if (granthaDocId) {
      fetch(`/api/strapi/manthras/teekas-by-grantha/${granthaDocId}`, { credentials: "include" })
        .then((r) => r.ok ? r.json() : null)
        .then((payload) => {
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
    setAdhyayas(adhyayas.map((a) => (a.id === id ? { ...a, title } : a)));
    queueStrapiFullHierarchySectionOrderSync();
  }

  function removeAdhyaya(id: string) {
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
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        return { ...a, khandas: a.khandas.map((k) => (k.id === khandaId ? { ...k, title } : k)) };
      })
    );
    queueStrapiFullHierarchySectionOrderSync();
  }

  function removeKhanda(adhyayaId: string, khandaId: string) {
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

  /**
   * Debounced + serialized Strapi mantra sync. Coalesces rapid inserts/deletes into one pass:
   * deletes removed rows first, then insert-between + batch order for the remaining snapshot.
   */
  function scheduleStrapiMantraSectionIdentitySync(
    snapshot: AdhyayaNode[],
    ctx: { adhyayaId: string; khandaId: string; padaId?: string },
  ) {
    const granthaDoc =
      editingItem && !editingItem._isDraft
        ? editingItem.documentId
        : editingItem?._strapiDocId;
    if (!isPublishedStrapiDocId(granthaDoc)) return;

    adhyayasRef.current = snapshot;

    if (mantraSyncTimerRef.current) clearTimeout(mantraSyncTimerRef.current);
    mantraSyncTimerRef.current = setTimeout(() => {
      mantraSyncTimerRef.current = null;
      const snap = adhyayasRef.current as SnapshotAdhyaya[];
      const cfg = structureConfigRef.current;
      const toDelete = [...pendingMantraDeletesRef.current];
      pendingMantraDeletesRef.current.clear();

      mantraSyncChainRef.current = mantraSyncChainRef.current
        .then(() =>
          syncMantraSectionAfterStructuralEdits(
            snap,
            ctx.adhyayaId,
            ctx.khandaId,
            ctx.padaId,
            cfg,
            toDelete,
          ),
        )
        .then(({ patches, failedDeleteIds }) => {
          if (failedDeleteIds.length > 0) {
            setDeletedStrapiManthraDocIds((prev) =>
              Array.from(new Set([...prev, ...failedDeleteIds])),
            );
          }
          if (patches.length > 0) {
            setAdhyayas((prev) => {
              const merged = mergeMantraStrapiDocumentIds(
                prev as SnapshotAdhyaya[],
                ctx.adhyayaId,
                ctx.khandaId,
                ctx.padaId,
                patches,
              ) as AdhyayaNode[];
              adhyayasRef.current = merged;
              return merged;
            });
          }
          invalidateGranthaCmsCaches(queryClient);
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          toast({ variant: "destructive", title: "Strapi mantra sync failed", description: msg });
        });
    }, 450);
  }

  /**
   * Debounced full-grantha pass: every section's mantras get portal titles + order written to Strapi,
   * and docId links are reconciled so Granthas / Mantras / Sections tabs stay aligned.
   */
  function queueFullMantraIdentityAlignToStrapi(
    snapshot: AdhyayaNode[],
    cfg?: GranthaStructureConfig,
    delayMs = 800,
  ) {
    if (!editingGranthaStrapiDocumentId()) return;
    adhyayasRef.current = snapshot;
    if (fullMantraAlignTimerRef.current) clearTimeout(fullMantraAlignTimerRef.current);
    fullMantraAlignTimerRef.current = setTimeout(() => {
      fullMantraAlignTimerRef.current = null;
      void flushFullMantraIdentityAlignToStrapiNow(
        adhyayasRef.current,
        cfg ?? structureConfigRef.current,
      );
    }, delayMs);
  }

  function flushFullMantraIdentityAlignToStrapiNow(
    snapshot: AdhyayaNode[],
    cfg: GranthaStructureConfig = structureConfigRef.current,
  ): Promise<void> {
    if (!editingGranthaStrapiDocumentId()) return Promise.resolve();
    const snap = snapshot as SnapshotAdhyaya[];
    fullMantraAlignChainRef.current = fullMantraAlignChainRef.current
      .then(() => syncAllMantraSectionsInGrantha(snap, cfg, { allowCreate: false }))
      .then((patches) => {
        if (patches.length > 0) {
          setAdhyayas((prev) => {
            const merged = applyMantraDocIdPatches(prev as SnapshotAdhyaya[], patches) as AdhyayaNode[];
            adhyayasRef.current = merged;
            return merged;
          });
        }
        invalidateGranthaCmsCaches(queryClient);
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[granthas] full mantra align failed:", msg);
      });
    return fullMantraAlignChainRef.current;
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
    await syncStrapiSectionOrderAndTitles(
      collectAllSectionOrderSyncRowsFromHierarchy(snapshot, cfg),
    );
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

  function addManthra(adhyayaId: string, khandaId: string, padaId?: string) {
    const adhyayaTitle = adhyayas.find((a) => a.id === adhyayaId)?.title || "";
    track("manthra_added", { grantha_name: formData.GranthaName, adhyaya: adhyayaTitle });
    setAdhyayas((prev) => {
      const cfg = structureConfigRef.current;
      const next = withNormalizedHierarchy(
        prev.map((a) => {
          if (a.id !== adhyayaId) return a;
          return {
            ...a,
            khandas: a.khandas.map((k) => {
              if (k.id !== khandaId) return k;
              const newManthra: ManthraNode = {
                id: uid(),
                title: "",
                order: 0,
                Teekas: teekas.map((t) => ({ TeekaName: t.TeekaName, TeekaAuthor: t.TeekaAuthor })),
              };
              if (cfg.levelThreeEnabled && padaId) {
                return {
                  ...k,
                  padas: (k.padas ?? []).map((p) => {
                    if (p.id !== padaId) return p;
                    const merged = assignContiguousMantraOrders([
                      ...sortNodesByOrder(p.manthras),
                      newManthra,
                    ]);
                    return { ...p, manthras: merged };
                  }),
                };
              }
              const merged = assignContiguousMantraOrders([
                ...sortNodesByOrder(k.manthras),
                newManthra,
              ]);
              return { ...k, manthras: merged };
            }),
          };
        }),
        cfg,
      );
      scheduleStrapiMantraSectionIdentitySync(next, { adhyayaId, khandaId, padaId });
      return next;
    });
  }

  /**
   * Insert a single blank manthra immediately after `afterManthraId`.
   * Full-tree normalization runs so every sibling `order` and mantra label stays consistent.
   */
  function insertManthraAfter(
    adhyayaId: string,
    khandaId: string,
    afterManthraId: string,
    padaId?: string,
  ) {
    setAdhyayas((prev) => {
      const cfg = structureConfigRef.current;
      const next = withNormalizedHierarchy(
        prev.map((a) => {
          if (a.id !== adhyayaId) return a;
          return {
            ...a,
            khandas: a.khandas.map((k) => {
              if (k.id !== khandaId) return k;

              if (cfg.levelThreeEnabled && padaId) {
                return {
                  ...k,
                  padas: (k.padas ?? []).map((p) => {
                    if (p.id !== padaId) return p;
                    const sorted = sortNodesByOrder(p.manthras);
                    const j = sorted.findIndex((m) => m.id === afterManthraId);
                    if (j < 0) return p;
                    const newManthra: ManthraNode = {
                      id: uid(),
                      title: "",
                      order: 0,
                      Teekas: teekas.map((t) => ({ TeekaName: t.TeekaName, TeekaAuthor: t.TeekaAuthor })),
                    };
                    const merged = assignContiguousMantraOrders([
                      ...sorted.slice(0, j + 1),
                      newManthra,
                      ...sorted.slice(j + 1),
                    ]);
                    return { ...p, manthras: merged };
                  }),
                };
              }

              const sorted = sortNodesByOrder(k.manthras);
              const j = sorted.findIndex((m) => m.id === afterManthraId);
              if (j < 0) return k;
              const newManthra: ManthraNode = {
                id: uid(),
                title: "",
                order: 0,
                Teekas: teekas.map((t) => ({ TeekaName: t.TeekaName, TeekaAuthor: t.TeekaAuthor })),
              };
              const merged = assignContiguousMantraOrders([
                ...sorted.slice(0, j + 1),
                newManthra,
                ...sorted.slice(j + 1),
              ]);
              return { ...k, manthras: merged };
            }),
          };
        }),
        cfg,
      );
      scheduleStrapiMantraSectionIdentitySync(next, { adhyayaId, khandaId, padaId });
      return next;
    });
  }

  function confirmRemoveManthra(renumber: boolean) {
    if (!pendingRemove) return;
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

      scheduleStrapiMantraSectionIdentitySync(finalTree, { adhyayaId, khandaId, padaId });
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
    if (options?.markDirty !== false) setManthraDialogDirty(true);
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
    if (editingManthra.padaId) {
      const p = k?.padas?.find((x) => x.id === editingManthra.padaId);
      return p?.manthras.find((x) => x.id === editingManthra.manthraId) ?? null;
    }
    return k?.manthras.find((x) => x.id === editingManthra.manthraId) ?? null;
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

    nodes.forEach((a, ai) => {
      if (!a.title?.trim()) {
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

  function buildSavePayload(): Record<string, any> {
    const payload: Record<string, any> = {
      GranthaName: formData.GranthaName,
      GranthaType: formData.GranthaType || undefined,
      BhashyamName: formData.BhashyamName || undefined,
      BhashyamAuthor: formData.BhashyamAuthor || undefined,
      teekas,
      otherTranslations,
      granthaNameTranslations,
      structureConfig,
      hierarchy: adhyayas,
      deletedStrapiSectionDocIds: deletedStrapiSectionDocIds.length > 0 ? deletedStrapiSectionDocIds : undefined,
      deletedStrapiManthraDocIds: deletedStrapiManthraDocIds.length > 0 ? deletedStrapiManthraDocIds : undefined,
      deletedStrapiTeekaDocIds: deletedStrapiTeekaDocIds.length > 0 ? deletedStrapiTeekaDocIds : undefined,
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

  // "Save" — persist draft and stay on the content entry page
  function handleSave() {
    if (!formData.GranthaName.trim()) {
      toast({ variant: "destructive", title: "Grantha Name is required" });
      return;
    }
    const payload = buildSavePayload();
    const strapiDocId =
      editingItem && !editingItem._isDraft
        ? editingItem.documentId
        : editingItem?._strapiDocId || undefined;

    saveDraft.mutate(
      {
        title: formData.GranthaName,
        data: payload,
        strapiDocumentId: strapiDocId,
        draftId: editingDraftId ?? undefined,
      },
      {
        onSuccess: (saved: any) => {
          track("draft_saved", {
            grantha_name: formData.GranthaName,
            grantha_type: formData.GranthaType,
            has_strapi_link: !!strapiDocId,
            teeka_count: teekas.length,
          });
          // Capture the new draft ID so subsequent saves do PUT not POST
          if (!editingDraftId && saved?.id) {
            setEditingDraftId(saved.id);
          }
        },
      }
    );
  }

  // "Save & Publish" — persist draft then publish to Strapi, stay on page
  function handleSaveAndPublish() {
    if (!formData.GranthaName.trim()) {
      toast({ variant: "destructive", title: "Grantha Name is required" });
      return;
    }
    const payload = buildSavePayload();
    const strapiDocId =
      editingItem && !editingItem._isDraft
        ? editingItem.documentId
        : editingItem?._strapiDocId || undefined;

    saveDraft.mutate(
      {
        title: formData.GranthaName,
        data: payload,
        strapiDocumentId: strapiDocId,
        draftId: editingDraftId ?? undefined,
      },
      {
        onSuccess: (saved: any) => {
          const resolvedDraftId = editingDraftId ?? saved?.id;
          if (!editingDraftId && saved?.id) {
            setEditingDraftId(saved.id);
          }
          if (resolvedDraftId) {
            publishDraft.mutate(resolvedDraftId, {
              onSuccess: (result: any) => {
                track("grantha_published", {
                  grantha_name: formData.GranthaName,
                  grantha_type: formData.GranthaType,
                  teeka_count: teekas.length,
                });
                // ── Post-publish sync ──────────────────────────────────────────────
                // The server enriches the draft hierarchy with Strapi documentIds
                // during publish (manthras & sections get their IDs back-filled).
                // Sync those IDs into memory so the next "Save & Publish" does
                // direct PUT updates instead of re-creating records in Strapi.
                const updatedHierarchy = result?.draft?.data?.hierarchy;
                const newStrapiDocId = result?.draft?.strapiDocumentId;
                const granthaSidForFlush =
                  newStrapiDocId ||
                  (editingItem && !editingItem._isDraft ? editingItem.documentId : editingItem?._strapiDocId);
                if (Array.isArray(updatedHierarchy)) {
                  const nh = withNormalizedHierarchy(updatedHierarchy as AdhyayaNode[], structureConfig);
                  setAdhyayas(nh);
                  if (isPublishedStrapiDocId(granthaSidForFlush)) {
                    flushStrapiFullHierarchySectionOrderSyncNow(nh, structureConfig, true);
                    void flushFullMantraIdentityAlignToStrapiNow(nh, structureConfig).then(() => {
                      invalidateGranthaCmsCaches(queryClient);
                    });
                  } else {
                    invalidateGranthaCmsCaches(queryClient);
                  }
                }

                // If this was a brand-new grantha (no prior Strapi link), the publish
                // created a Strapi record. Capture its docId so subsequent saves
                // correctly store the strapiDocumentId on the draft.
                if (newStrapiDocId && editingItem) {
                  setEditingItem({ ...editingItem, documentId: newStrapiDocId, _strapiDocId: newStrapiDocId });
                }

                // Sections that were deleted are now gone from Strapi — clear the list
                // so a re-publish doesn't attempt to DELETE already-removed sections.
                setDeletedStrapiSectionDocIds([]);
                setDeletedStrapiTeekaDocIds([]);
                setDeletedStrapiManthraDocIds([]);
              },
              onError: (err: any) => {
                track("publish_failed", {
                  grantha_name: formData.GranthaName,
                  error: err?.message || "unknown",
                });
              },
            });
          } else {
            toast({ variant: "destructive", title: "Could not resolve draft ID for publish" });
          }
        },
      }
    );
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
  }

  // Save the draft then publish just the currently open manthra to Strapi
  function handleSaveAndPublishManthra() {
    if (!editingManthra) return;
    if (!formData.GranthaName.trim()) {
      toast({ variant: "destructive", title: "Grantha Name is required" });
      return;
    }
    const runPublish = (draftId: number) => {
      publishMantraMutation.mutate({
        draftId,
        adhyayaId: editingManthra.adhyayaId,
        khandaId: editingManthra.khandaId,
        padaId: editingManthra.padaId,
        manthraId: editingManthra.manthraId,
      });
    };

    // Fast path: patch only edited mantra, then publish that mantra.
    if (editingDraftId && currentManthra) {
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
          onSuccess: () => runPublish(editingDraftId),
          onError: () => {
            const payload = buildSavePayload();
            const strapiDocId =
              editingItem && !editingItem._isDraft
                ? editingItem.documentId
                : editingItem?._strapiDocId || undefined;
            saveDraft.mutate(
              { title: formData.GranthaName, data: payload, strapiDocumentId: strapiDocId, draftId: editingDraftId },
              {
                onSuccess: () => runPublish(editingDraftId),
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
          const resolvedDraftId = editingDraftId ?? saved?.id;
          if (!editingDraftId && saved?.id) setEditingDraftId(saved.id);
          if (!resolvedDraftId) {
            toast({ variant: "destructive", title: "Could not determine draft ID" });
            return;
          }
          runPublish(resolvedDraftId);
        },
      }
    );
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
    if (item._draftId) publishDraft.mutate(item._draftId);
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
            <h1 className="text-2xl font-bold tracking-tight">All Granthas</h1>
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
                    isPublishing={
                      publishDraft.isPending &&
                      (publishDraft.variables as number) === item._draftId
                    }
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
                  {bhashyamAuthors.map((a) => (
                    <SelectItem key={a} value={a}>{a}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                            {teekaAuthors.map((a) => (
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
                  {["Kanda", "Skandha", "Adhyaya", "Valli", "Prapathaka", "Mundaka", "Prashna"].map((name) => (
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
                  {["Valli", "Anuvaka", "Khanda", "Brahmana", "Adhyaya", "Adhikarana", "Varnaka", "Pada"].map((name) => (
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
                    {["Pada", "Varga", "Anuvaka", "Khanda", "Section", "Part", "Sukta", "Adhikaranam"].map((name) => (
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
              {["Mantra", "Manthra", "Shloka", "Sutra", "Anuvaka", "Pada", "Tirtha", "Utsava", "Vivarana"].map((name) => (
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
                const { hierarchy: prepared, sectionDocIdsToMarkDeleted } = prepareHierarchyForContentStep(
                  adhyayas,
                  structureConfig,
                );
                const errs = validateSectionTitles(prepared, structureConfig);
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
                const normalizedStep = withNormalizedHierarchy(prepared, structureConfig);
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
              {" to enter its text content"}
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
              const flatLeafCount = !structureConfig.levelTwoEnabled
                ? (flatFirstKhanda?.manthras.length ?? 0)
                : structureConfig.levelThreeEnabled
                  ? adhyaya.khandas.reduce((s, k) => s + (k.padas ?? []).reduce((ps, p) => ps + p.manthras.length, 0), 0)
                  : adhyaya.khandas.reduce((s, k) => s + k.manthras.length, 0);
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
                      {sortNodesByOrder(flatFirstKhanda.manthras).map((manthra, mIdx) => {
                        const hasContent = hasManthraContent(manthra);
                        return (
                          <div key={manthra.id} className="flex items-center gap-2 group py-0.5">
                            <Hash className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                            <span className="text-sm flex-1">{manthra.title}</span>
                            {hasContent && <FileText className="w-3.5 h-3.5 text-primary" />}
                            {!viewOnly && (
                              <>
                                <Button
                                  size="icon" variant="ghost"
                                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                                  onClick={() => setEditingManthra({ adhyayaId: adhyaya.id, khandaId: flatFirstKhanda.id, manthraId: manthra.id, strapiDocumentId: manthra.strapiDocumentId })}
                                  data-testid={`button-edit-manthra-${aIdx}-0-${mIdx}`}
                                >
                                  <Pencil className="w-3 h-3" />
                                </Button>
                                <Button
                                  size="icon" variant="ghost"
                                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-blue-500 hover:text-blue-700"
                                  onClick={() => { insertManthraAfter(adhyaya.id, flatFirstKhanda.id, manthra.id); toast({ title: `${leaf} inserted`, description: `A new blank ${leaf} was added after "${manthra.title}".` }); }}
                                  title={`Insert blank ${leaf} after this one`}
                                  data-testid={`button-insert-after-manthra-${aIdx}-0-${mIdx}`}
                                >
                                  <Plus className="w-3 h-3" />
                                </Button>
                                <Button
                                  size="icon" variant="ghost"
                                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive"
                                  onClick={() => setPendingRemove({ adhyayaId: adhyaya.id, khandaId: flatFirstKhanda.id, manthraId: manthra.id, title: manthra.title })}
                                  data-testid={`button-remove-manthra-${aIdx}-0-${mIdx}`}
                                >
                                  <X className="w-3 h-3" />
                                </Button>
                              </>
                            )}
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
                              {structureConfig.levelThreeEnabled
                                ? `${(khanda.padas ?? []).length} ${L3.toLowerCase()}${(khanda.padas ?? []).length !== 1 ? "s" : ""}`
                                : `${khanda.manthras.length} ${leaf.toLowerCase()}${khanda.manthras.length !== 1 ? "s" : ""}`
                              }
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
                                    const totalManthras = structureConfig.levelThreeEnabled
                                      ? (khanda.padas ?? []).reduce((s, p) => s + p.manthras.length, 0)
                                      : khanda.manthras.length;
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
                                      {sortNodesByOrder(pada.manthras).map((manthra, mIdx) => {
                                        const hasContent = hasManthraContent(manthra);
                                        return (
                                          <div key={manthra.id} className="flex items-center gap-2 group py-0.5">
                                            <Hash className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                            <span className="text-sm flex-1">{manthra.title}</span>
                                            {hasContent && <FileText className="w-3.5 h-3.5 text-primary" />}
                                            {!viewOnly && (
                                              <>
                                                <Button
                                                  size="icon" variant="ghost"
                                                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                                                  onClick={() => setEditingManthra({ adhyayaId: adhyaya.id, khandaId: khanda.id, padaId: pada.id, manthraId: manthra.id, strapiDocumentId: manthra.strapiDocumentId })}
                                                  data-testid={`button-edit-manthra-${aIdx}-${kIdx}-${pIdx}-${mIdx}`}
                                                >
                                                  <Pencil className="w-3 h-3" />
                                                </Button>
                                                <Button
                                                  size="icon" variant="ghost"
                                                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-blue-500 hover:text-blue-700"
                                                  onClick={() => { insertManthraAfter(adhyaya.id, khanda.id, manthra.id, pada.id); toast({ title: `${leaf} inserted`, description: `A new blank ${leaf} was added after "${manthra.title}".` }); }}
                                                  title={`Insert blank ${leaf} after this one`}
                                                  data-testid={`button-insert-after-manthra-${aIdx}-${kIdx}-${pIdx}-${mIdx}`}
                                                >
                                                  <Plus className="w-3 h-3" />
                                                </Button>
                                                <Button
                                                  size="icon" variant="ghost"
                                                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive"
                                                  onClick={() => setPendingRemove({ adhyayaId: adhyaya.id, khandaId: khanda.id, manthraId: manthra.id, padaId: pada.id, title: manthra.title })}
                                                  data-testid={`button-remove-manthra-${aIdx}-${kIdx}-${pIdx}-${mIdx}`}
                                                >
                                                  <X className="w-3 h-3" />
                                                </Button>
                                              </>
                                            )}
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
                              {sortNodesByOrder(khanda.manthras).map((manthra, mIdx) => {
                                const hasContent = hasManthraContent(manthra);
                                return (
                                  <div key={manthra.id} className="flex items-center gap-2 group py-0.5">
                                    <Hash className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                    <span className="text-sm flex-1">{manthra.title}</span>
                                    {hasContent && (
                                      <span className="text-xs text-primary font-medium" title="Has content">
                                        <FileText className="w-3.5 h-3.5" />
                                      </span>
                                    )}
                                    {!viewOnly && (
                                      <>
                                        <Button
                                          size="icon" variant="ghost"
                                          className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                                          onClick={() => setEditingManthra({ adhyayaId: adhyaya.id, khandaId: khanda.id, manthraId: manthra.id, strapiDocumentId: manthra.strapiDocumentId })}
                                          data-testid={`button-edit-manthra-${aIdx}-${kIdx}-${mIdx}`}
                                          title="Enter text content"
                                        >
                                          <Pencil className="w-3 h-3" />
                                        </Button>
                                        <Button
                                          size="icon" variant="ghost"
                                          className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-blue-500 hover:text-blue-700"
                                          onClick={() => { insertManthraAfter(adhyaya.id, khanda.id, manthra.id); toast({ title: `${leaf} inserted`, description: `A new blank ${leaf} was added after "${manthra.title}".` }); }}
                                          title={`Insert blank ${leaf} after this one`}
                                          data-testid={`button-insert-after-manthra-${aIdx}-${kIdx}-${mIdx}`}
                                        >
                                          <Plus className="w-3 h-3" />
                                        </Button>
                                        <Button
                                          size="icon" variant="ghost"
                                          className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive"
                                          onClick={() => setPendingRemove({ adhyayaId: adhyaya.id, khandaId: khanda.id, manthraId: manthra.id, title: manthra.title })}
                                          data-testid={`button-remove-manthra-${aIdx}-${kIdx}-${mIdx}`}
                                        >
                                          <X className="w-3 h-3" />
                                        </Button>
                                      </>
                                    )}
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
                <Button
                  variant="outline"
                  onClick={handleSave}
                  disabled={saveDraft.isPending || publishDraft.isPending}
                  data-testid="button-save-draft"
                >
                  {saveDraft.isPending && !publishDraft.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Save
                </Button>
                <Button
                  onClick={handleSaveAndPublish}
                  disabled={saveDraft.isPending || publishDraft.isPending}
                  data-testid="button-save-and-publish"
                >
                  {(saveDraft.isPending || publishDraft.isPending) && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  {publishDraft.isPending ? "Publishing…" : "Save & Publish"}
                </Button>
                {isAdmin && editingDraftId && (
                  <Button
                    variant="secondary"
                    onClick={() => recoverDraft.mutate(editingDraftId)}
                    disabled={recoverDraft.isPending || saveDraft.isPending || publishDraft.isPending}
                    data-testid="button-recover-latest-snapshot"
                  >
                    {recoverDraft.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    Recover Snapshot
                  </Button>
                )}
                {publishDraft.isPending && publishProgress && publishProgress.total > 0 && (
                  <div className="absolute bottom-full mb-2 right-0 bg-popover border rounded-md shadow-md p-3 min-w-[260px] text-sm z-50" data-testid="publish-progress-box">
                    <div className="flex items-center gap-2 mb-1 text-muted-foreground">
                      <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
                      <span className="font-medium">Publishing to Strapi</span>
                    </div>
                    <div className="w-full bg-muted rounded-full h-1.5 mb-1">
                      <div
                        className="bg-primary rounded-full h-1.5 transition-all"
                        style={{ width: `${Math.round((publishProgress.done / publishProgress.total) * 100)}%` }}
                      />
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {publishProgress.done}/{publishProgress.total} — {publishProgress.current}
                    </div>
                  </div>
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
        onOpenChange={(open) => { if (!open) closeMantraDialog(); }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {currentManthra?.title ?? "Manthra"}
              {manthraLoading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
            </DialogTitle>
            <DialogDescription>
              {manthraLoading
                ? "Loading latest content from the CMS…"
                : editingManthra?.strapiDocumentId
                  ? "Showing live content from the CMS. Edit here and click Done to update."
                  : "Enter the Sanskrit text and translations. These fields map directly to the CMS chapter record."}
            </DialogDescription>
          </DialogHeader>

          {currentManthra && editingManthra && (
            <div className="space-y-5 pt-1">
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
                  <div className="flex items-center justify-between mb-2 mt-3">
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
                  <div className="flex items-center justify-between mb-2 mt-3">
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
                          <div className="flex items-center justify-between mb-2 mt-3">
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
                <Button
                  variant="outline"
                  onClick={() => closeMantraDialog()}
                  data-testid="button-manthra-close"
                  disabled={saveDraft.isPending || saveManthraPatchMutation.isPending || publishMantraMutation.isPending}
                >
                  Close
                </Button>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => handleSaveManthra()}
                    disabled={saveDraft.isPending || saveManthraPatchMutation.isPending || publishMantraMutation.isPending}
                    data-testid="button-manthra-save"
                  >
                    {(saveDraft.isPending || saveManthraPatchMutation.isPending) && !publishMantraMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    Save
                  </Button>
                  <Button
                    onClick={handleSaveAndPublishManthra}
                    disabled={saveDraft.isPending || saveManthraPatchMutation.isPending || publishMantraMutation.isPending}
                    data-testid="button-manthra-save-publish"
                  >
                    {publishMantraMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    <Send className="w-4 h-4 mr-2" />
                    Save & Publish
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

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
    </div>
  );
}
