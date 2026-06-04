import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useDrafts } from "@/hooks/use-drafts";
import DataTable from "@/components/data-table";
import ArticleEditorialGuide from "@/components/article-editorial-guide";
import ArticleSeoPanel from "@/components/article-seo-panel";
import RichTextEditor from "@/components/rich-text-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  type StrapiArticle,
  type StrapiAuthor,
  type StrapiCategory,
  type StrapiResponse,
  type StrapiBlock,
} from "@shared/schema";
import {
  enrichArticleDraftForSave,
  parseArticleMetaFromBlocks,
  validateArticleDraft,
} from "@shared/article-editorial";
import {
  evaluateArticleSeo,
  slugifyArticleTitle,
  suggestMetaDescription,
  suggestMetaTitle,
} from "@shared/article-seo";
import { Loader2 } from "lucide-react";
import StrapiSyncBar from "@/components/strapi-sync-bar";
import { STRAPI_POLL_INTERVAL } from "@/hooks/use-strapi-sync";

type ArticleFormState = {
  title: string;
  slug: string;
  author: string;
  category: string;
  eventDate: string;
  eventTime: string;
  place: string;
  lead: string;
  body: StrapiBlock[];
  metaTitle: string;
  metaDescription: string;
  focusKeyword: string;
  metaKeywords: string;
  ogTitle: string;
  ogDescription: string;
};

const emptyForm = (): ArticleFormState => ({
  title: "",
  slug: "",
  author: "",
  category: "",
  eventDate: "",
  eventTime: "",
  place: "",
  lead: "",
  body: [],
  metaTitle: "",
  metaDescription: "",
  focusKeyword: "",
  metaKeywords: "",
  ogTitle: "",
  ogDescription: "",
});

function formFromDraftOrItem(item: any): ArticleFormState {
  if (item._isDraft) {
    const d = item._draftData ?? {};
    return {
      title: d.title || "",
      slug: d.slug || "",
      author: d.author || "",
      category: d.category || "",
      eventDate: d.eventDate || "",
      eventTime: d.eventTime || "",
      place: d.place || "",
      lead: d.lead || "",
      body: Array.isArray(d.body) ? d.body : [],
      metaTitle: d.metaTitle || d.title || "",
      metaDescription: d.metaDescription || d.description || "",
      focusKeyword: d.focusKeyword || "",
      metaKeywords: d.metaKeywords || "",
      ogTitle: d.ogTitle || d.metaTitle || "",
      ogDescription: d.ogDescription || d.metaDescription || "",
    };
  }
  const parsed = parseArticleMetaFromBlocks(item.blocks);
  const metaTitle = item.seo?.metaTitle || item.title || "";
  const metaDescription = item.seo?.metaDescription || item.description || "";
  return {
    title: item.title || "",
    slug: item.slug || "",
    author: item.author?.documentId || "",
    category: item.category?.documentId || "",
    eventDate: parsed.eventDate || "",
    eventTime: parsed.eventTime || "",
    place: parsed.place || "",
    lead: parsed.lead || "",
    body: parsed.body ?? [],
    metaTitle,
    metaDescription,
    focusKeyword: "",
    metaKeywords: "",
    ogTitle: metaTitle,
    ogDescription: metaDescription,
  };
}

export default function ArticlesPage() {
  const { toast } = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [editingDraftId, setEditingDraftId] = useState<number | null>(null);
  const [formData, setFormData] = useState<ArticleFormState>(emptyForm);

  const { data, isLoading, error } = useQuery<StrapiResponse<StrapiArticle>>({
    queryKey: ["/api/strapi", "articles"],
    refetchInterval: STRAPI_POLL_INTERVAL,
    refetchOnWindowFocus: true,
  });

  const { data: authorsData } = useQuery<StrapiResponse<StrapiAuthor>>({
    queryKey: ["/api/strapi", "authors"],
    refetchInterval: STRAPI_POLL_INTERVAL,
  });

  const { data: categoriesData } = useQuery<StrapiResponse<StrapiCategory>>({
    queryKey: ["/api/strapi", "categories"],
    refetchInterval: STRAPI_POLL_INTERVAL,
  });

  const { unpublishedDrafts, isLoadingDrafts, saveDraft, publishDraft, deleteDraft } =
    useDrafts("articles");

  const deleteStrapiMutation = useMutation({
    mutationFn: async (documentId: string) => {
      const res = await apiRequest("DELETE", `/api/strapi/articles/${documentId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strapi", "articles"] });
      setDeleteTarget(null);
      toast({ title: "Article deleted" });
    },
    onError: (err: any) => {
      toast({ variant: "destructive", title: "Error", description: err.message });
    },
  });

  function resetForm() {
    setFormData(emptyForm());
    setEditingDraftId(null);
  }

  function openAdd() {
    setEditingItem(null);
    resetForm();
    setFormOpen(true);
  }

  function openEdit(item: any) {
    setEditingItem(item);
    setEditingDraftId(item._isDraft ? item._draftId : null);
    setFormData(formFromDraftOrItem(item));
    setFormOpen(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validationError = validateArticleDraft(formData);
    if (validationError) {
      toast({ variant: "destructive", title: "Cannot save article", description: validationError });
      return;
    }

    const authorName = (authorsData?.data || []).find((a) => a.documentId === formData.author)?.name;
    const categoryName = (categoriesData?.data || []).find((c) => c.documentId === formData.category)?.name;

    const slug =
      formData.slug.trim() || slugifyArticleTitle(formData.title);
    const payload = enrichArticleDraftForSave(
      {
        title: formData.title.trim(),
        slug,
        eventDate: formData.eventDate.trim(),
        eventTime: formData.eventTime.trim(),
        place: formData.place.trim(),
        lead: formData.lead.trim() || undefined,
        body: formData.body,
        metaTitle: formData.metaTitle.trim(),
        metaDescription: formData.metaDescription.trim(),
        focusKeyword: formData.focusKeyword.trim(),
        metaKeywords: formData.metaKeywords.trim() || undefined,
        ogTitle: formData.ogTitle.trim() || formData.metaTitle.trim(),
        ogDescription: formData.ogDescription.trim() || formData.metaDescription.trim(),
        ...(formData.author ? { author: formData.author } : {}),
        ...(formData.category ? { category: formData.category } : {}),
      },
      { authorName, categoryName },
    );

    const strapiDocId =
      editingItem && !editingItem._isDraft
        ? editingItem.documentId
        : editingItem?._strapiDocId || undefined;

    saveDraft.mutate(
      {
        title: formData.title.trim(),
        data: payload,
        strapiDocumentId: strapiDocId,
        draftId: editingDraftId || undefined,
      },
      {
        onSuccess: () => {
          setFormOpen(false);
          resetForm();
          setEditingItem(null);
        },
      },
    );
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    if (deleteTarget._isDraft) {
      deleteDraft.mutate(deleteTarget._draftId, { onSuccess: () => setDeleteTarget(null) });
    } else {
      deleteStrapiMutation.mutate(deleteTarget.documentId);
    }
  }

  function handlePublish(item: any) {
    if (item._draftId) publishDraft.mutate(item._draftId);
  }

  const mergedData = [
    ...unpublishedDrafts.map((d) => ({
      ...(d.data as any),
      _isDraft: true,
      _draftId: d.id,
      _draftStatus: d.status,
      _strapiDocId: d.strapiDocumentId,
      _draftData: d.data,
    })),
    ...(data?.data || []).map((item) => ({
      ...item,
      _isDraft: false,
      _draftStatus: "published",
    })),
  ];

  const isSaving = saveDraft.isPending;

  const columns = [
    { key: "title", label: "Title" },
    {
      key: "eventDate",
      label: "When / Where",
      render: (_: unknown, row: any) => {
        const d = row._isDraft ? row._draftData : row;
        const date = d?.eventDate || parseArticleMetaFromBlocks(row.blocks).eventDate;
        const place = d?.place || parseArticleMetaFromBlocks(row.blocks).place;
        if (!date && !place) return null;
        return (
          <span className="text-sm text-muted-foreground line-clamp-2 max-w-[220px]">
            {date ? `${date}` : ""}
            {date && place ? " · " : ""}
            {place || ""}
          </span>
        );
      },
    },
    {
      key: "metaDescription",
      label: "SEO",
      render: (_: unknown, row: any) => {
        const d = row._isDraft ? row._draftData : row;
        const meta = d?.metaDescription || row.seo?.metaDescription || row.description;
        const { score } = evaluateArticleSeo({
          title: row.title,
          slug: row.slug || d?.slug,
          metaTitle: d?.metaTitle || row.seo?.metaTitle || row.title,
          metaDescription: meta,
          focusKeyword: d?.focusKeyword,
          lead: d?.lead,
          place: d?.place || parseArticleMetaFromBlocks(row.blocks).place,
        });
        return (
          <div className="flex flex-col gap-0.5">
            {meta ? (
              <span className="text-sm text-muted-foreground line-clamp-1 max-w-[180px]">{meta}</span>
            ) : null}
            <Badge variant={score >= 85 ? "default" : score >= 60 ? "secondary" : "outline"}>
              SEO {score}%
            </Badge>
          </div>
        );
      },
    },
    {
      key: "author",
      label: "Author",
      render: (_: any, row: any) =>
        row.author?.name ? <Badge variant="secondary">{row.author.name}</Badge> : null,
    },
    {
      key: "category",
      label: "Category",
      render: (_: any, row: any) =>
        row.category?.name ? <Badge variant="outline">{row.category.name}</Badge> : null,
    },
  ];

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      <DataTable
        title="Articles"
        headerContent={<StrapiSyncBar />}
        description="SEO-optimized articles — date, time, place, meta tags, and structured content for search and social."
        columns={columns}
        data={mergedData}
        isLoading={isLoading || isLoadingDrafts}
        error={error}
        onAdd={openAdd}
        onEdit={openEdit}
        onDelete={(item) => setDeleteTarget(item)}
        onPublish={handlePublish}
        publishingId={publishDraft.isPending ? (publishDraft.variables as number) : null}
        addLabel="Add Article"
        testIdPrefix="article"
        searchKey="title"
        emptyMessage="No articles found."
      />

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingItem ? "Edit Article" : "Add New Article"}</DialogTitle>
            <DialogDescription>
              Build a complete, SEO-ready article. Date, time, place, and meta tags are required.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <ArticleEditorialGuide />

            <div>
              <Label>Title *</Label>
              <p className="text-xs text-muted-foreground mt-1 mb-1.5">
                A clear headline or a curiosity-sparking question (e.g. “Why did the crowd gather at
                dawn?”).
              </p>
              <Input
                value={formData.title}
                onChange={(e) => {
                  const title = e.target.value;
                  setFormData((prev) => ({
                    ...prev,
                    title,
                    slug: prev.slug || slugifyArticleTitle(title),
                    metaTitle: prev.metaTitle || suggestMetaTitle(title, prev.place),
                  }));
                }}
                placeholder="Article title or question"
                className="mt-0"
                data-testid="input-article-title"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <Label>Event date *</Label>
                <Input
                  type="date"
                  value={formData.eventDate}
                  onChange={(e) => setFormData({ ...formData, eventDate: e.target.value })}
                  className="mt-1.5"
                  data-testid="input-article-event-date"
                />
              </div>
              <div>
                <Label>Event time *</Label>
                <Input
                  value={formData.eventTime}
                  onChange={(e) => setFormData({ ...formData, eventTime: e.target.value })}
                  placeholder="e.g. 6:30 AM IST"
                  className="mt-1.5"
                  data-testid="input-article-event-time"
                />
              </div>
              <div>
                <Label>Place *</Label>
                <Input
                  value={formData.place}
                  onChange={(e) => setFormData({ ...formData, place: e.target.value })}
                  placeholder="City, venue, region"
                  className="mt-1.5"
                  data-testid="input-article-place"
                />
              </div>
            </div>

            <ArticleSeoPanel
              value={formData}
              onChange={(patch) => setFormData((prev) => ({ ...prev, ...patch }))}
            />

            <div>
              <Label>Opening lead</Label>
              <p className="text-xs text-muted-foreground mt-1 mb-1.5">
                First paragraph after the dateline — scene, stakes, or key fact. Write in your own
                voice; be specific and human.
              </p>
              <Textarea
                value={formData.lead}
                onChange={(e) => {
                  const lead = e.target.value;
                  setFormData((prev) => ({
                    ...prev,
                    lead,
                    metaDescription:
                      prev.metaDescription ||
                      suggestMetaDescription({
                        title: prev.title,
                        lead,
                        place: prev.place,
                        eventDate: prev.eventDate,
                        focusKeyword: prev.focusKeyword,
                      }),
                  }));
                }}
                placeholder="Set the scene and draw the reader in…"
                rows={4}
                className="mt-0"
                data-testid="input-article-lead"
              />
            </div>

            <div>
              <Label>Article body *</Label>
              <p className="text-xs text-muted-foreground mt-1 mb-1.5">
                Full story with as much detail as you have — names, context, quotes, and what
                happened next. Original wording only.
              </p>
              <RichTextEditor
                value={formData.body}
                onChange={(body) => setFormData({ ...formData, body })}
                placeholder="Write the full article here…"
                minHeight={220}
                data-testid="input-article-body"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Author</Label>
                <Select
                  value={formData.author}
                  onValueChange={(val) => setFormData({ ...formData, author: val })}
                >
                  <SelectTrigger className="mt-1.5" data-testid="select-article-author">
                    <SelectValue placeholder="Select author" />
                  </SelectTrigger>
                  <SelectContent>
                    {(authorsData?.data || []).map((a) => (
                      <SelectItem key={a.documentId} value={a.documentId}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Category</Label>
                <Select
                  value={formData.category}
                  onValueChange={(val) => setFormData({ ...formData, category: val })}
                >
                  <SelectTrigger className="mt-1.5" data-testid="select-article-category">
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent>
                    {(categoriesData?.data || []).map((c) => (
                      <SelectItem key={c.documentId} value={c.documentId}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving} data-testid="button-article-save">
                {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Save as Draft
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?._isDraft ? "Draft" : "Article"}</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{deleteTarget?.title}&quot;?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
