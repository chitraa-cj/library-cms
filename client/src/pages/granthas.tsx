import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
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
  type StrapiResponse,
  type StrapiBlock,
  type TextAndTranslation,
} from "@shared/schema";
import StrapiSyncBar from "@/components/strapi-sync-bar";
import { STRAPI_POLL_INTERVAL } from "@/hooks/use-strapi-sync";
import { blocksToText } from "@/lib/strapi-blocks";
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
}

interface KhandaNode {
  id: string;
  title: string;
  order: number;
  padas: PadaNode[];   // used when levelThreeEnabled
  manthras: ManthraNode[];  // used when levelThreeEnabled is false
  expanded: boolean;
}

interface AdhyayaNode {
  id: string;
  title: string;
  order: number;
  khandas: KhandaNode[];
  expanded: boolean;
}

// ---------- Helpers ----------

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

const ORDINALS = [
  "Prathama", "Dvitiya", "Tritiya", "Chaturtha", "Panchama",
  "Shashthi", "Saptama", "Ashtama", "Navama", "Dashama",
];

function ordinal(n: number) {
  return ORDINALS[n - 1] ?? `${n}`;
}

function hasBlocks(v: StrapiBlock[] | string | null | undefined): boolean {
  if (!v) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.some((b) => b.children?.some((c) => (c.text ?? "").trim().length > 0));
  return false;
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
// "Mantra 1.1.1" and a portal-published "Manthra 1.1.1" both at order=1), keep only
// the one with the HIGHER numeric Strapi id (most recently created = portal-published).
// This is more reliable than relying on array position since Strapi's secondary sort
// for populated relations is not guaranteed.
function deduplicateManthrasByOrder(manthras: any[]): any[] {
  // Build a map from order → best manthra (highest numeric id wins)
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
  return [...best.values(), ...noOrder];
}

function reconstructHierarchyFromStrapi(sections: any[]): AdhyayaNode[] {
  if (!sections || sections.length === 0) return [];

  // Separate top-level sections (no parent) from child sections
  const topLevel = sections.filter((s) => !s.parent?.documentId);
  const children = sections.filter((s) => !!s.parent?.documentId);

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
        khandas: sorted.map((s, i) => ({
          id: uid(),
          title: s.title || `Section ${i + 1}`,
          order: s.order ?? i + 1,
          expanded: true,
          padas: [],
          manthras: deduplicateManthrasByOrder(
            [...(s.manthras || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          ).map((m: any, mi: number) => ({
            id: uid(),
            title: m.ShlokaManthraNumber || `Mantra ${mi + 1}`,
            order: m.order ?? mi + 1,
            strapiDocumentId: m.documentId || undefined,
          })),
        })),
      },
    ];
  }

  return topLevel
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((adhyaya, ai) => {
      const khandas = children
        .filter((c) => c.parent?.documentId === adhyaya.documentId)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

      // If no children found, treat the adhyaya's own manthras as its content
      const khandaNodes: KhandaNode[] =
        khandas.length > 0
          ? khandas.map((k, ki) => ({
              id: uid(),
              title: k.title || `Section ${ki + 1}`,
              order: k.order ?? ki + 1,
              expanded: true,
              padas: [],
              manthras: deduplicateManthrasByOrder(
                [...(k.manthras || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
              ).map((m: any, mi: number) => ({
                id: uid(),
                title: m.ShlokaManthraNumber || `Mantra ${mi + 1}`,
                order: m.order ?? mi + 1,
                strapiDocumentId: m.documentId || undefined,
              })),
            }))
          : [
              {
                id: uid(),
                title: "_default",
                order: 1,
                expanded: true,
                padas: [],
                manthras: deduplicateManthrasByOrder(
                  [...(adhyaya.manthras || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
                ).map((m: any, mi: number) => ({
                  id: uid(),
                  title: m.ShlokaManthraNumber || `Mantra ${mi + 1}`,
                  order: m.order ?? mi + 1,
                  strapiDocumentId: m.documentId || undefined,
                })),
              },
            ];

      return {
        id: uid(),
        title: adhyaya.title || `Adhyaya ${ai + 1}`,
        order: adhyaya.order ?? ai + 1,
        expanded: true,
        khandas: khandaNodes,
      };
    });
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
}: {
  item: any;
  onEdit: () => void;
  onView?: (item: any) => void;
  onDelete: () => void;
  onPublish: () => void;
  isPublishing: boolean;
  currentUserId?: string | null;
  isDuplicate?: boolean;
}) {
  const isDraft = item._isDraft;
  const canDelete = !currentUserId || item._createdBy === currentUserId;

  return (
    <div
      className="group relative border rounded-xl bg-card p-5 cursor-pointer hover:border-primary/50 hover:shadow-sm transition-all"
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
            data-testid={`button-edit-${item.documentId || item._draftId}`}
          >
            <Pencil className="w-3.5 h-3.5" />
          </Button>
          {isDraft && (
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
          {canDelete && (
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
            const displaySections = leafSections.length > 0 ? leafSections : item.sections;
            return (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">
                  Sections ({displaySections.length}){totalManthras > 0 ? ` · ${totalManthras} mantra${totalManthras !== 1 ? "s" : ""}` : ""}
                </p>
                <div className="flex flex-wrap gap-1">
                  {displaySections.map((s: any) => (
                    <span
                      key={s.documentId || s.id}
                      className="inline-flex items-center text-xs bg-muted rounded px-1.5 py-0.5 text-foreground"
                    >
                      {s.title || "Untitled"}
                      {s.type && <span className="ml-1 text-muted-foreground">· {s.type}</span>}
                    </span>
                  ))}
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

  // Manthra content dialog
  const [editingManthra, setEditingManthra] = useState<{
    adhyayaId: string;
    khandaId: string;
    padaId?: string;  // only set when levelThreeEnabled
    manthraId: string;
    strapiDocumentId?: string; // set if this mantra is already published to Strapi
  } | null>(null);
  const [manthraLoading, setManthraLoading] = useState(false);
  const [editingGranthaSectionsLoading, setEditingGranthaSectionsLoading] = useState(false);

  // When the mantra dialog opens for a published mantra (has strapiDocumentId),
  // fetch the live Strapi content and populate the form fields so users always
  // see the current CMS version rather than potentially stale local draft data.
  useEffect(() => {
    const docId = editingManthra?.strapiDocumentId;
    if (!docId || !editingManthra) return;
    let cancelled = false;
    setManthraLoading(true);
    fetch(`/api/strapi/manthras/${docId}`, { credentials: "include" })
      .then((r) => r.json())
      .then((res) => {
        if (cancelled) return;
        const m = res.data;
        if (!m) return;
        const { adhyayaId, khandaId, manthraId, padaId } = editingManthra;
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
                            ShlokaManthraEntry: m.ShlokaManthraEntry || undefined,
                            BhashyamForShlokaManthra: m.BhashyamEntry || undefined,
                            Teekas: Array.isArray(m.Teekas) && m.Teekas.length > 0
                              ? m.Teekas.map((t: any) => ({
                                  TeekaName: t.teeka?.TeekaName || t.TeekaName || "",
                                  TeekaAuthor: t.teeka?.TeekaAuthor || t.TeekaAuthor || "",
                                  teekaDocId: t.teeka?.documentId || undefined,
                                  TeekaEntry: t.TeekaEntry || undefined,
                                }))
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
                      ShlokaManthraEntry: m.ShlokaManthraEntry || undefined,
                      BhashyamForShlokaManthra: m.BhashyamEntry || undefined,
                      Teekas: Array.isArray(m.Teekas) && m.Teekas.length > 0
                        ? m.Teekas.map((t: any) => ({
                            TeekaName: t.teeka?.TeekaName || t.TeekaName || "",
                            TeekaAuthor: t.teeka?.TeekaAuthor || t.TeekaAuthor || "",
                            teekaDocId: t.teeka?.documentId || undefined,
                            TeekaEntry: t.TeekaEntry || undefined,
                          }))
                        : mn.Teekas,
                    }
                  ),
                };
              }),
            };
          })
        );
      })
      .catch(console.error)
      .finally(() => { if (!cancelled) setManthraLoading(false); });
    return () => { cancelled = true; };
  }, [editingManthra?.manthraId, editingManthra?.strapiDocumentId]); // eslint-disable-line react-hooks/exhaustive-deps

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
    deleteDraft,
  } = useDrafts("granthas");

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
  }

  function openAdd() {
    resetForm();
    setStep(1);
    setView("form");
  }

  async function openEdit(item: any) {
    setEditingItem(item);
    if (item._isDraft) {
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
      const rawCfg1 = d.structureConfig;
      const migratedCfg1 = migrateStructureConfig(rawCfg1);
      setStructureConfig(migratedCfg1);
      const rawHier1 = d.hierarchy || [];
      setAdhyayas(rawCfg1?.leafName === "Khanda"
        ? migrateHierarchyLeafName(rawHier1, "Khanda", "Mantra")
        : rawHier1);
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

      // OtherTranslations (Bhashyakara): prefer draft (portal format) if non-empty
      if (hasDraft && Array.isArray(savedData.otherTranslations) && savedData.otherTranslations.length > 0) {
        setOtherTranslations(savedData.otherTranslations.map((t: any) => ({
          id: t.id || uid(),
          language: t.language || "",
          text: t.text || [],
        })));
      } else {
        setOtherTranslations(
          Array.isArray(item.BhashyakaraIntroduction?.OtherTranslations)
            ? item.BhashyakaraIntroduction.OtherTranslations.map((t: any) => ({
                id: uid(),
                language: t.LanguageOfTranslation || "",
                text: t.TranslationText ?? t.OtherLanguagesTranslation ?? [],
              }))
            : []
        );
      }

      // GranthaNameTranslations: prefer draft (portal format) if non-empty
      if (hasDraft && Array.isArray(savedData.granthaNameTranslations) && savedData.granthaNameTranslations.length > 0) {
        setGranthaNameTranslations(savedData.granthaNameTranslations.map((t: any) => ({
          id: t.id || uid(),
          language: t.language || "",
          name: t.name || "",
        })));
      } else {
        setGranthaNameTranslations(
          Array.isArray(item.GranthaNameTranslations)
            ? item.GranthaNameTranslations.map((t: any) => ({
                id: uid(),
                language: t.LanguageOfTranslation || "",
                name: (Array.isArray(t.TranslationText) ? blocksToText(t.TranslationText) : null) || t.GranthaNameTranslation || t.name || "",
              }))
            : []
        );
      }

      // Structure config (synchronous)
      const rawCfg2 = savedData?.structureConfig;
      const migratedCfg2 = migrateStructureConfig(rawCfg2);
      setStructureConfig(migratedCfg2);

      // Fetch sections + teekas in parallel.
      // Teekas: prefer saved draft, then inline item.teekas, then fetch from Strapi.
      const hasSavedTeekas = Array.isArray(savedData?.teekas) && savedData.teekas.length > 0;
      const hasInlineTeekas = Array.isArray(item.teekas) && item.teekas.length > 0;

      setEditingGranthaSectionsLoading(true);
      let fetchedSections: any[] = [];
      try {
        const sectionsFetch = fetch(`/api/strapi/sections/by-grantha/${item.documentId}`, { credentials: "include" });
        const teekasFetch = (!hasSavedTeekas && !hasInlineTeekas)
          ? fetch(`/api/strapi/teekas/by-grantha/${item.documentId}`, { credentials: "include" })
          : Promise.resolve(null as unknown as Response);

        const [sectionsRes, teekasRes] = await Promise.all([sectionsFetch, teekasFetch]);

        if (sectionsRes.ok) {
          const sectionsData = await sectionsRes.json();
          fetchedSections = sectionsData?.data || [];
        }

        if (hasSavedTeekas) {
          setTeekas(savedData.teekas);
        } else if (hasInlineTeekas) {
          setTeekas(
            item.teekas.map((t: any) => ({
              id: t.documentId || uid(),
              TeekaName: t.TeekaName || "",
              TeekaAuthor: t.TeekaAuthor || "",
            }))
          );
        } else if (teekasRes?.ok) {
          const teekasData = await teekasRes.json();
          const strapiTeekas: any[] = teekasData?.data || [];
          setTeekas(
            strapiTeekas.map((t: any) => ({
              id: t.documentId || uid(),
              TeekaName: t.TeekaName || "",
              TeekaAuthor: t.TeekaAuthor || "",
            }))
          );
        } else {
          setTeekas([]);
        }
      } catch { setTeekas([]); /* use empty teekas on error */ }
      setEditingGranthaSectionsLoading(false);

      // Hierarchy: prefer portal draft; fall back to reconstructing from Strapi sections.
      const rawHier2 = savedData?.hierarchy || [];
      const hierToUse2 =
        rawHier2.length > 0
          ? rawHier2
          : reconstructHierarchyFromStrapi(fetchedSections);

      // Auto-detect flat granthas (no real khanda level).
      // When every adhyaya has exactly one "_default" synthetic khanda, this grantha
      // has no actual sub-section tier — disable levelTwo so manthras render directly
      // under their adhyaya. This covers both fresh loads (no draft) and old drafts
      // that were saved before this auto-detection was added.
      if (hierToUse2.length > 0) {
        const isFlat = hierToUse2.every(
          (a) => a.khandas.length === 1 && a.khandas[0]?.title === "_default"
        );
        if (isFlat && migratedCfg2.levelTwoEnabled) {
          setStructureConfig((prev) => ({ ...prev, levelTwoEnabled: false }));
        }
      }

      // Build lookup maps from fetched sections so we can enrich hierarchy nodes
      // with strapiDocumentIds and supplement any Strapi mantras/sections missing from the draft.
      const strapiManthraByShloka = new Map<string, string>(); // shlokaNr → documentId
      const strapiMantrasBySecTitle = new Map<string, { title: string; docId: string; order: number }[]>();
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

      function enrichHierarchy(hier: AdhyayaNode[]): AdhyayaNode[] {
        const knownShlokas = collectKnownShlokas(hier);
        return hier.map((a) => {
          // ── Enrich existing khandas ──────────────────────────────────────────────────
          const enrichedKhandas = a.khandas.map((k) => {
            // For flat granthas the synthetic "_default" khanda owns the adhyaya's own
            // manthras — look them up by the adhyaya title (which IS the Strapi section title).
            const lookupTitle = k.title === "_default" ? a.title : k.title;
            const strapiMantrasForKhanda = strapiMantrasBySecTitle.get(lookupTitle) ?? [];

            // Build an order→strapi lookup for this section (order-based fallback matching).
            const strapiByOrder = new Map<number, { title: string; docId: string; order: number }>();
            for (const sm of strapiMantrasForKhanda) {
              if (sm.order != null) strapiByOrder.set(sm.order, sm);
            }
            // Track which Strapi records were matched so we don't add them again as "new".
            const matchedDocIds = new Set<string>();

            // Helper: resolve strapiDocumentId (and canonical Strapi title) for a manthra node.
            // Returns { docId, strapiTitle } where strapiTitle is set only when the match
            // came from Strapi (title may differ from the draft node's title — e.g. a stale
            // draft says "Mantra 1.1.1" but Strapi only knows it as "Manthra 1.1.1").
            function resolveDocId(m: ManthraNode): { docId: string; strapiTitle?: string } | undefined {
              if (m.strapiDocumentId) {
                // If the draft already has a strapiDocumentId, check it still exists in Strapi.
                const stillExists = strapiMantrasForKhanda.some((sm) => sm.docId === m.strapiDocumentId);
                if (!stillExists) {
                  // The Strapi record was deleted. Try to remap by order so the correct
                  // Strapi manthra is shown instead of a ghost entry.
                  if (m.order != null && strapiByOrder.has(m.order)) {
                    const sm = strapiByOrder.get(m.order)!;
                    matchedDocIds.add(sm.docId);
                    return { docId: sm.docId, strapiTitle: sm.title };
                  }
                  // Truly deleted with no order match — drop this node (return undefined).
                  return undefined;
                }
                matchedDocIds.add(m.strapiDocumentId);
                return { docId: m.strapiDocumentId };
              }
              if (strapiManthraByShloka.has(m.title)) {
                const id = strapiManthraByShloka.get(m.title)!;
                matchedDocIds.add(id);
                return { docId: id };
              }
              // Fallback: match by order when the title spelling differs (e.g. "Manthra" vs "Mantra").
              // Also handles stale draft nodes whose title no longer exists in Strapi.
              if (m.order != null && strapiByOrder.has(m.order)) {
                const sm = strapiByOrder.get(m.order)!;
                matchedDocIds.add(sm.docId);
                return { docId: sm.docId, strapiTitle: sm.title };
              }
              return undefined;
            }

            const enrichedManthras = k.manthras.reduce<ManthraNode[]>((acc, m) => {
              const resolved = resolveDocId(m);
              if (!resolved) return acc; // dropped: Strapi record was deleted, no order remap
              const { docId, strapiTitle } = resolved;
              acc.push({
                ...m,
                strapiDocumentId: docId,
                // Adopt the Strapi title when the match was via order (draft title is stale/wrong)
                ...(strapiTitle ? { title: strapiTitle } : {}),
              });
              return acc;
            }, []);
            const enrichedPadas = (k.padas ?? []).map((p) => {
              const padaStrapi = strapiMantrasBySecTitle.get(p.title) ?? [];
              const padaByOrder = new Map<number, { title: string; docId: string; order: number }>();
              for (const sm of padaStrapi) { if (sm.order != null) padaByOrder.set(sm.order, sm); }
              return {
                ...p,
                manthras: p.manthras.map((m) => {
                  if (m.strapiDocumentId) return m;
                  if (strapiManthraByShloka.has(m.title)) return { ...m, strapiDocumentId: strapiManthraByShloka.get(m.title) };
                  if (m.order != null && padaByOrder.has(m.order)) return { ...m, strapiDocumentId: padaByOrder.get(m.order)!.docId };
                  return m;
                }),
              };
            });

            // Supplement: add Strapi mantras that aren't already covered by a local node.
            // Also skip any whose order is already taken by an enriched local node —
            // this collapses actual Strapi duplicates (e.g. "Mantra 1.1.1" + "Manthra 1.1.1"
            // both at order=1 in the same section) without showing phantom entries.
            const usedOrders = new Set(
              enrichedManthras.map((m) => m.order).filter((o): o is number => o != null)
            );
            const newManthras: ManthraNode[] = [];
            for (const sm of strapiMantrasForKhanda) {
              if (!matchedDocIds.has(sm.docId) && !knownShlokas.has(sm.title)) {
                if (sm.order != null && usedOrders.has(sm.order)) continue;
                newManthras.push({ id: uid(), title: sm.title, order: sm.order, strapiDocumentId: sm.docId });
                knownShlokas.add(sm.title);
              }
            }

            const finalManthras = [...enrichedManthras, ...newManthras].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            return {
              ...k,
              manthras: finalManthras,
              padas: enrichedPadas,
            };
          }); // end of enrichedKhandas.map

          // ── Supplement: add Strapi khandas completely absent from the draft ─────────
          // Match this draft adhyaya to its Strapi counterpart by title, then find
          // Strapi child sections (khandas/brahmanas) that were never saved in the draft.
          const existingKhandaTitles = new Set(enrichedKhandas.map((k) => k.title));
          const strapiAdhyaya = strapiSectionByTitle.get(a.title);
          const supplementKhandas: KhandaNode[] = [];
          if (strapiAdhyaya?.documentId) {
            const strapiChildren = (strapiChildSectionsByParentDocId.get(strapiAdhyaya.documentId) ?? [])
              .sort((x: any, y: any) => (x.order ?? 0) - (y.order ?? 0));
            for (const sec of strapiChildren) {
              if (!sec.title || existingKhandaTitles.has(sec.title)) continue;
              // This Strapi khanda is missing from the draft — add it with its manthras
              const secManthras = (strapiMantrasBySecTitle.get(sec.title) ?? [])
                .sort((x, y) => (x.order ?? 0) - (y.order ?? 0))
                .map((sm) => ({
                  id: uid(),
                  title: sm.title,
                  order: sm.order,
                  strapiDocumentId: sm.docId,
                } as ManthraNode));
              supplementKhandas.push({
                id: uid(),
                title: sec.title,
                order: sec.order ?? 0,
                expanded: true,
                padas: [],
                manthras: secManthras,
              });
            }
          }

          return {
            ...a,
            khandas: [...enrichedKhandas, ...supplementKhandas].sort((x, y) => (x.order ?? 0) - (y.order ?? 0)),
          };
        }); // end of hier.map
      }
      const enrichedHier2 = enrichHierarchy(
        rawCfg2?.leafName === "Khanda"
          ? migrateHierarchyLeafName(hierToUse2, "Khanda", "Mantra")
          : hierToUse2
      );

      // ── Supplement: add top-level Strapi sections absent from the draft ──────────
      // The enrichHierarchy above only supplements missing *khandas within existing
      // adhyayas*. If the draft itself is missing entire top-level adhyayas (e.g. the
      // user published 3 more khandas in Strapi after saving a portal draft that only
      // had 1), those adhyayas are never shown. Fix: append them here.
      const existingAdhyayaTitles = new Set(enrichedHier2.map((a) => a.title));
      const topLevelStrapiSections = fetchedSections
        .filter((s: any) => !s.parent?.documentId)
        .sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
      const missingAdhyayas: AdhyayaNode[] = [];
      for (const sec of topLevelStrapiSections) {
        if (!sec.title || existingAdhyayaTitles.has(sec.title)) continue;
        // Child sections of this Strapi section → become khandas
        const strapiChildren = (strapiChildSectionsByParentDocId.get(sec.documentId) ?? [])
          .sort((x: any, y: any) => (x.order ?? 0) - (y.order ?? 0));
        let khandas: KhandaNode[];
        if (strapiChildren.length > 0) {
          khandas = strapiChildren.map((child: any) => ({
            id: uid(),
            title: child.title,
            order: child.order ?? 0,
            expanded: true,
            padas: [],
            manthras: (strapiMantrasBySecTitle.get(child.title) ?? [])
              .sort((x: any, y: any) => (x.order ?? 0) - (y.order ?? 0))
              .map((sm: any, mi: number) => ({
                id: uid(),
                title: sm.title,
                order: sm.order ?? mi + 1,
                strapiDocumentId: sm.docId,
              } as ManthraNode)),
          } as KhandaNode));
        } else {
          // Flat section — create a synthetic "_default" khanda with this section's manthras
          const manthrasForSec = (strapiMantrasBySecTitle.get(sec.title) ?? [])
            .sort((x: any, y: any) => (x.order ?? 0) - (y.order ?? 0))
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
          khandas,
        } as AdhyayaNode);
      }
      const finalHier2 = missingAdhyayas.length > 0
        ? [...enrichedHier2, ...missingAdhyayas].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        : enrichedHier2;

      setAdhyayas(finalHier2);
    }
    setStep(1);
    setView("form");
  }

  async function openView(item: any) {
    setViewOnly(true);
    await openEdit(item);
    setStep(3);
  }

  // ---------- Teeka handlers ----------

  function addTeeka() {
    setTeekas([...teekas, { id: uid(), TeekaName: "", TeekaAuthor: "" }]);
  }

  function updateTeeka(id: string, field: keyof Omit<TeekaDefinition, "id">, value: string) {
    setTeekas(teekas.map((t) => (t.id === id ? { ...t, [field]: value } : t)));
  }

  function removeTeeka(id: string) {
    setTeekas(teekas.filter((t) => t.id !== id));
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
    const n = adhyayas.length + 1;
    const L1 = structureConfig.levelOneName;
    const defaultKhanda = !structureConfig.levelTwoEnabled
      ? [{ id: uid(), title: "_default", order: 1, padas: [], manthras: [], expanded: true }]
      : [];
    setAdhyayas([
      ...adhyayas,
      { id: uid(), title: `${ordinal(n)} ${L1}`, order: n, khandas: defaultKhanda, expanded: true },
    ]);
  }

  function updateAdhyaya(id: string, title: string) {
    setAdhyayas(adhyayas.map((a) => (a.id === id ? { ...a, title } : a)));
  }

  function removeAdhyaya(id: string) {
    setAdhyayas(adhyayas.filter((a) => a.id !== id));
  }

  function toggleAdhyaya(id: string) {
    setAdhyayas(adhyayas.map((a) => (a.id === id ? { ...a, expanded: !a.expanded } : a)));
  }

  function addKhanda(adhyayaId: string) {
    const L2 = structureConfig.levelTwoName;
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        const n = a.khandas.length + 1;
        return {
          ...a,
          khandas: [
            ...a.khandas,
            { id: uid(), title: `${ordinal(n)} ${L2}`, order: n, padas: [], manthras: [], expanded: true },
          ],
        };
      })
    );
  }

  function updateKhanda(adhyayaId: string, khandaId: string, title: string) {
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        return { ...a, khandas: a.khandas.map((k) => (k.id === khandaId ? { ...k, title } : k)) };
      })
    );
  }

  function removeKhanda(adhyayaId: string, khandaId: string) {
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        return { ...a, khandas: a.khandas.filter((k) => k.id !== khandaId) };
      })
    );
  }

  function toggleKhanda(adhyayaId: string, khandaId: string) {
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        return {
          ...a,
          khandas: a.khandas.map((k) =>
            k.id === khandaId ? { ...k, expanded: !k.expanded } : k
          ),
        };
      })
    );
  }

  // ── Level 3 (Pada) functions ──
  function addPada(adhyayaId: string, khandaId: string) {
    const L3 = structureConfig.levelThreeName;
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        return {
          ...a,
          khandas: a.khandas.map((k) => {
            if (k.id !== khandaId) return k;
            const n = (k.padas ?? []).length + 1;
            return {
              ...k,
              padas: [
                ...(k.padas ?? []),
                { id: uid(), title: `${ordinal(n)} ${L3}`, order: n, manthras: [], expanded: true },
              ],
            };
          }),
        };
      })
    );
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
  }

  function removePada(adhyayaId: string, khandaId: string, padaId: string) {
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        return {
          ...a,
          khandas: a.khandas.map((k) => {
            if (k.id !== khandaId) return k;
            return { ...k, padas: (k.padas ?? []).filter((p) => p.id !== padaId) };
          }),
        };
      })
    );
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
  function addManthra(adhyayaId: string, khandaId: string, padaId?: string) {
    // Use the adhyaya's 1-indexed position in the sorted array as its section number.
    const aIdx = adhyayas.findIndex((x) => x.id === adhyayaId) + 1;
    const leaf = structureConfig.leafName;
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        // kIdx: position of this khanda within its adhyaya (1-indexed).
        // For a synthetic "_default" khanda (flat section — no real child sections in
        // Strapi), skip the khanda index so the number stays 2-part (aIdx.mIdx)
        // instead of 3-part (aIdx.1.mIdx), keeping it consistent with the existing
        // ShlokaManthraNumbers already stored in Strapi for that section.
        const targetKhanda = a.khandas.find((x) => x.id === khandaId);
        const isDefaultKhanda = targetKhanda?.title === "_default";
        const kIdx = structureConfig.levelTwoEnabled && !isDefaultKhanda
          ? a.khandas.findIndex((x) => x.id === khandaId) + 1
          : aIdx;
        return {
          ...a,
          khandas: a.khandas.map((k) => {
            if (k.id !== khandaId) return k;
            if (structureConfig.levelThreeEnabled && padaId) {
              // Add manthra inside a Pada
              return {
                ...k,
                padas: (k.padas ?? []).map((p) => {
                  if (p.id !== padaId) return p;
                  const pIdx = (k.padas ?? []).findIndex((x) => x.id === padaId) + 1;
                  const maxMIdx = p.manthras.reduce((mx, m) => {
                    const n = parseInt((m.title?.split(".") ?? []).slice(-1)[0] ?? "0", 10);
                    return isNaN(n) ? mx : Math.max(mx, n);
                  }, 0);
                  const mIdx = Math.max(maxMIdx, p.manthras.length) + 1;
                  const newManthra: ManthraNode = {
                    id: uid(),
                    // For _default khanda, keep 2-part numbering in the pada path too
                    title: isDefaultKhanda
                      ? `${leaf} ${aIdx}.${pIdx}.${mIdx}`
                      : `${leaf} ${aIdx}.${kIdx}.${pIdx}.${mIdx}`,
                    order: mIdx,
                    Teekas: teekas.map((t) => ({ TeekaName: t.TeekaName, TeekaAuthor: t.TeekaAuthor })),
                  };
                  return { ...p, manthras: [...p.manthras, newManthra] };
                }),
              };
            }
            // Add manthra directly inside Khanda (L3 disabled)
            const maxMIdx2 = k.manthras.reduce((mx, m) => {
              const n = parseInt((m.title?.split(".") ?? []).slice(-1)[0] ?? "0", 10);
              return isNaN(n) ? mx : Math.max(mx, n);
            }, 0);
            const mIdx = Math.max(maxMIdx2, k.manthras.length) + 1;
            const newManthra: ManthraNode = {
              id: uid(),
              // _default khanda → flat section → use 2-part number (aIdx.mIdx)
              // Real khanda with levelTwoEnabled → 3-part (aIdx.kIdx.mIdx)
              // levelTwoEnabled=false → 2-part (aIdx.mIdx)
              title: structureConfig.levelTwoEnabled && !isDefaultKhanda
                ? `${leaf} ${aIdx}.${kIdx}.${mIdx}`
                : `${leaf} ${aIdx}.${mIdx}`,
              order: mIdx,
              Teekas: teekas.map((t) => ({ TeekaName: t.TeekaName, TeekaAuthor: t.TeekaAuthor })),
            };
            return { ...k, manthras: [...k.manthras, newManthra] };
          }),
        };
      })
    );
  }

  function removeManthra(adhyayaId: string, khandaId: string, manthraId: string, padaId?: string) {
    setAdhyayas(
      adhyayas.map((a) => {
        if (a.id !== adhyayaId) return a;
        return {
          ...a,
          khandas: a.khandas.map((k) => {
            if (k.id !== khandaId) return k;
            if (padaId) {
              return {
                ...k,
                padas: (k.padas ?? []).map((p) =>
                  p.id === padaId
                    ? { ...p, manthras: p.manthras.filter((m) => m.id !== manthraId) }
                    : p
                ),
              };
            }
            return { ...k, manthras: k.manthras.filter((m) => m.id !== manthraId) };
          }),
        };
      })
    );
  }

  function updateManthraContent(
    adhyayaId: string,
    khandaId: string,
    manthraId: string,
    updates: Partial<ManthraNode>,
    padaId?: string
  ) {
    setAdhyayas(
      adhyayas.map((a) => {
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

  function validateSectionTitles(): string[] {
    const errors: string[] = [];
    const L1name = structureConfig?.levelOneName || "Adhyaya";
    const L2name = structureConfig?.levelTwoName || "Khanda";
    const L3name = structureConfig?.levelThreeName || "Pada";
    const levelTwoEnabled = structureConfig?.levelTwoEnabled !== false;
    const levelThreeEnabled = !!structureConfig?.levelThreeEnabled;

    adhyayas.forEach((a, ai) => {
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

  function handleSaveAndExit() {
    if (!formData.GranthaName.trim()) {
      toast({ variant: "destructive", title: "Grantha Name is required" });
      return;
    }

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
        onSuccess: () => {
          setView("list");
          resetForm();
          toast({ title: "Saved as draft" });
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
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
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
            <h1 className="text-2xl font-bold tracking-tight">Granthas</h1>
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
      {viewOnly && (
        <div className="flex items-center justify-between gap-3 mb-6 px-4 py-3 rounded-lg bg-muted/60 border border-border">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Eye className="w-4 h-4 shrink-0" />
            <span>You are viewing <strong>{formData.GranthaName}</strong> in read-only mode. No changes can be made.</span>
          </div>
          <Button size="sm" variant="outline" onClick={() => { setView("list"); resetForm(); }} data-testid="button-close-view">
            Close
          </Button>
        </div>
      )}

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
              <Button size="sm" variant="outline" onClick={addTeeka} data-testid="button-add-teeka">
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                Add Teeka
              </Button>
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
                  onClick={() => setStructureConfig({ ...structureConfig, leafName: name })}
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
                const errs = validateSectionTitles();
                if (errs.length > 0) {
                  toast({
                    variant: "destructive",
                    title: "Some sections are missing titles",
                    description: errs.slice(0, 3).join(" • ") + (errs.length > 3 ? ` (+${errs.length - 3} more)` : ""),
                  });
                  return;
                }
                setStep(3);
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
            {adhyayas.map((adhyaya, aIdx) => {
              const L1 = structureConfig.levelOneName;
              const L2 = structureConfig.levelTwoName;
              const leaf = structureConfig.leafName;
              const hideL1Row = !structureConfig.levelOneEnabled;
              const flatLeafCount = !structureConfig.levelTwoEnabled
                ? (adhyaya.khandas[0]?.manthras.length ?? 0)
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
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={(e) => { e.stopPropagation(); removeAdhyaya(adhyaya.id); }}
                        data-testid={`button-remove-adhyaya-${aIdx}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                    {adhyaya.expanded
                      ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
                      : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                  </div>
                </div>
                )}

                {/* Flat mode: show leaves directly under L1 */}
                {!structureConfig.levelTwoEnabled && adhyaya.expanded && adhyaya.khandas[0] && (
                  <div className="px-4 pt-2 pb-3 border-t bg-muted/10">
                    <p className="text-xs font-medium text-muted-foreground mb-2">
                      {leaf}s in this {L1}
                    </p>
                    <div className="space-y-1">
                      {adhyaya.khandas[0].manthras.map((manthra, mIdx) => {
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
                                  onClick={() => setEditingManthra({ adhyayaId: adhyaya.id, khandaId: adhyaya.khandas[0].id, manthraId: manthra.id, strapiDocumentId: manthra.strapiDocumentId })}
                                  data-testid={`button-edit-manthra-${aIdx}-0-${mIdx}`}
                                >
                                  <Pencil className="w-3 h-3" />
                                </Button>
                                <Button
                                  size="icon" variant="ghost"
                                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive"
                                  onClick={() => removeManthra(adhyaya.id, adhyaya.khandas[0].id, manthra.id)}
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
                          onClick={() => addManthra(adhyaya.id, adhyaya.khandas[0].id)}
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
                    {adhyaya.khandas.map((khanda, kIdx) => {
                      const L3 = structureConfig.levelThreeName;
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
                            )}
                            {khanda.expanded
                              ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                              : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
                          </div>
                        </div>

                        {/* L3 enabled: show Padas inside Khanda */}
                        {structureConfig.levelThreeEnabled && khanda.expanded && (
                          <div className="px-4 pt-2 pb-3 border-t bg-muted/10 space-y-2">
                            {(khanda.padas ?? []).map((pada, pIdx) => (
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
                                      <Button
                                        size="icon" variant="ghost"
                                        className="h-5 w-5 text-destructive hover:text-destructive"
                                        onClick={(e) => { e.stopPropagation(); removePada(adhyaya.id, khanda.id, pada.id); }}
                                        data-testid={`button-remove-pada-${aIdx}-${kIdx}-${pIdx}`}
                                      >
                                        <Trash2 className="w-3 h-3" />
                                      </Button>
                                    )}
                                    {pada.expanded
                                      ? <ChevronDown className="w-3 h-3 text-muted-foreground" />
                                      : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
                                  </div>
                                </div>
                                {pada.expanded && (
                                  <div className="px-4 pt-1.5 pb-2.5 border-t bg-muted/5">
                                    <div className="space-y-1">
                                      {pada.manthras.map((manthra, mIdx) => {
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
                                                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive"
                                                  onClick={() => removeManthra(adhyaya.id, khanda.id, manthra.id, pada.id)}
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
                              {khanda.manthras.map((manthra, mIdx) => {
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
                                          className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive"
                                          onClick={() => removeManthra(adhyaya.id, khanda.id, manthra.id)}
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
                <Button onClick={handleSaveAndExit} disabled={saveDraft.isPending} data-testid="button-save-exit">
                  {saveDraft.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Save & Exit
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Manthra content dialog */}
      <Dialog
        open={!!editingManthra}
        onOpenChange={(open) => { if (!open) setEditingManthra(null); }}
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
                  <div className="flex items-center justify-between mb-2">
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
                  <div className="flex items-center justify-between mb-2">
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
                    // Match priority:
                    // 1. Strapi teeka documentId (most reliable — survives name typos / wrong links)
                    // 2. TeekaName equality
                    // 3. Positional fallback — when a manthra has exactly one teeka entry but
                    //    it was linked to the wrong teeka in Strapi admin, the name/id won't
                    //    match the grantha definition; we still surface the content so it's
                    //    visible and editable, and re-publishing will correct the relation.
                    const ts = currentManthra.Teekas ?? [];
                    let existingIdx = ts.findIndex(
                      (t) => t.teekaDocId && granthaTeeka.id && t.teekaDocId === granthaTeeka.id
                    );
                    if (existingIdx < 0) {
                      existingIdx = ts.findIndex((t) => t.TeekaName === granthaTeeka.TeekaName);
                    }
                    if (existingIdx < 0 && tIdx < ts.length) {
                      // Positional fallback: use the tIdx-th manthra teeka when no exact
                      // match exists.  Re-publishing from the wizard will correct the link.
                      existingIdx = tIdx;
                    }
                    // Always stamp the grantha's correct teeka documentId so re-publishing
                    // fixes any wrong teeka relation that was set via the Strapi admin.
                    const teeka: ManthraTeekaEntry =
                      existingIdx >= 0
                        ? { ...ts[existingIdx], teekaDocId: granthaTeeka.id }
                        : { TeekaName: granthaTeeka.TeekaName, TeekaAuthor: granthaTeeka.TeekaAuthor, teekaDocId: granthaTeeka.id };

                    // Rebuild the full Teekas array with the updated entry merged in
                    function buildUpdated(updated: ManthraTeekaEntry): ManthraTeekaEntry[] {
                      const existing = currentManthra.Teekas ?? [];
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
                      </div>
                    );
                  })}
                </section>
              )}

              <div className="flex justify-end pt-2">
                <Button onClick={() => setEditingManthra(null)} data-testid="button-manthra-done">
                  <Check className="w-4 h-4 mr-2" />
                  Done
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
