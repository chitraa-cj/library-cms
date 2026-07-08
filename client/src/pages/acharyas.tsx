import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  BookOpen,
  Library,
  Loader2,
  Pencil,
  Search,
  Upload,
  ExternalLink,
} from "lucide-react";
import type {
  AcharyaProfile,
  AcharyaWithTexts,
  AcharyaBioSection,
  AcharyaWork,
  AcharyaLinkedText,
} from "@shared/schema";

type ListResponse = { data: AcharyaProfile[] };

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
}

export default function AcharyasPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [search, setSearch] = useState("");
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  const { data: listData, isLoading } = useQuery<ListResponse>({
    queryKey: ["/api/acharyas"],
  });

  const acharyas = listData?.data ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return acharyas;
    return acharyas.filter((a) =>
      [a.nameDisplay, a.nameIast, a.nameDevanagari, ...(a.aliases ?? [])]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(q)),
    );
  }, [acharyas, search]);

  const activeSlug = selectedSlug ?? filtered[0]?.slug ?? acharyas[0]?.slug ?? null;

  const { data: detail, isLoading: detailLoading } = useQuery<AcharyaWithTexts>({
    queryKey: ["/api/acharyas", activeSlug],
    enabled: !!activeSlug,
  });

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Acharyas</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Guru-parampara — biographies, works, and the texts (Upanishads &amp; commentaries)
          linked under each acharya.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[320px_1fr] gap-6">
        {/* List */}
        <div>
          <div className="relative mb-3">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search acharyas…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
              data-testid="input-acharya-search"
            />
          </div>
          {isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm p-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : (
            <div className="space-y-1 max-h-[70vh] overflow-y-auto pr-1">
              {filtered.map((a) => (
                <button
                  key={a.slug}
                  onClick={() => setSelectedSlug(a.slug)}
                  data-testid={`acharya-item-${a.slug}`}
                  className={`w-full text-left rounded-lg px-3 py-2 flex items-center gap-3 transition-colors ${
                    a.slug === activeSlug ? "bg-primary/10 border border-primary/30" : "hover:bg-muted"
                  }`}
                >
                  <Avatar className="w-9 h-9 shrink-0">
                    {a.avatarUrl ? <AvatarImage src={a.avatarUrl} alt={a.nameDisplay ?? ""} /> : null}
                    <AvatarFallback className="text-[11px]">
                      {initials(a.nameIast ?? a.nameDisplay ?? "?")}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{a.nameDevanagari}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {a.nameIast}
                      {a.dates ? ` · ${a.dates}` : ""}
                    </div>
                  </div>
                  {a.bioStatus === "empty" ? (
                    <span className="ml-auto text-[10px] text-muted-foreground/70 shrink-0">no bio</span>
                  ) : null}
                </button>
              ))}
              {filtered.length === 0 ? (
                <p className="text-sm text-muted-foreground p-4">No acharyas match “{search}”.</p>
              ) : null}
            </div>
          )}
        </div>

        {/* Detail */}
        <div>
          {detailLoading || !detail ? (
            <Card className="p-8 flex items-center justify-center text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading profile…
            </Card>
          ) : (
            <AcharyaDetail acharya={detail} isAdmin={isAdmin} />
          )}
        </div>
      </div>
    </div>
  );
}

function AcharyaDetail({ acharya, isAdmin }: { acharya: AcharyaWithTexts; isAdmin: boolean }) {
  const [editOpen, setEditOpen] = useState(false);
  const hasBio = acharya.biography?.some((s) => s.paragraphs?.length);

  return (
    <Card className="p-6">
      <div className="flex items-start gap-4">
        <Avatar className="w-16 h-16 shrink-0">
          {acharya.avatarUrl ? (
            <AvatarImage src={acharya.avatarUrl} alt={acharya.nameDisplay ?? ""} />
          ) : null}
          <AvatarFallback>{initials(acharya.nameIast ?? acharya.nameDisplay ?? "?")}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold leading-tight">{acharya.nameDevanagari}</h2>
          <p className="text-muted-foreground">{acharya.nameIast}</p>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            {acharya.dates ? <Badge variant="secondary">{acharya.dates}</Badge> : null}
            {acharya.category ? <Badge variant="outline">{acharya.category}</Badge> : null}
            {acharya.guruDevanagari ? (
              <span className="text-xs text-muted-foreground">guru: {acharya.guruDevanagari}</span>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {acharya.sourceUrl ? (
            <a
              href={acharya.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:text-foreground"
              title="Source"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          ) : null}
          {isAdmin ? (
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)} data-testid="button-edit-acharya">
              <Pencil className="w-3.5 h-3.5 mr-1.5" /> Edit
            </Button>
          ) : null}
        </div>
      </div>

      {/* Linked texts */}
      {(acharya.granthas.length > 0 || acharya.teekas.length > 0) && (
        <>
          <Separator className="my-5" />
          <div className="grid sm:grid-cols-2 gap-5">
            <LinkedTextList
              icon={<BookOpen className="w-4 h-4" />}
              title="Granthas (texts)"
              items={acharya.granthas}
            />
            <LinkedTextList
              icon={<Library className="w-4 h-4" />}
              title="Teekas (commentaries)"
              items={acharya.teekas}
            />
          </div>
        </>
      )}

      {/* Biography */}
      <Separator className="my-5" />
      <section>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          परिचयः · Biography
        </h3>
        {hasBio ? (
          acharya.biography.map((section, i) => (
            <BioSection key={i} section={section} />
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            No biography available from the source yet.
            {isAdmin ? " Use Edit to add one." : ""}
          </p>
        )}
      </section>

      {/* Works */}
      {acharya.worksList?.length > 0 && (
        <>
          <Separator className="my-5" />
          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
              कृतयः · Works ({acharya.worksList.length})
            </h3>
            <Accordion type="multiple" className="w-full">
              {acharya.worksList.map((w, i) => (
                <WorkItem key={i} work={w} index={i} />
              ))}
            </Accordion>
          </section>
        </>
      )}

      {isAdmin ? (
        <EditAcharyaDialog acharya={acharya} open={editOpen} onOpenChange={setEditOpen} />
      ) : null}
    </Card>
  );
}

function BioSection({ section }: { section: AcharyaBioSection }) {
  return (
    <div className="mb-4">
      {section.heading ? (
        <h4 className="font-medium text-sm mb-1.5">{section.heading}</h4>
      ) : null}
      <div className="space-y-2">
        {section.paragraphs.map((p, i) => (
          <p key={i} className="text-sm leading-relaxed text-foreground/90">
            {p}
          </p>
        ))}
      </div>
    </div>
  );
}

function WorkItem({ work, index }: { work: AcharyaWork; index: number }) {
  const hasDetail = work.type || work.source || work.remarks;
  return (
    <AccordionItem value={`work-${index}`}>
      <AccordionTrigger className="text-sm hover:no-underline">
        <span className="text-left">
          {work.title}
          {work.source ? (
            <span className="text-muted-foreground font-normal ml-2 text-xs">{work.source}</span>
          ) : null}
        </span>
      </AccordionTrigger>
      <AccordionContent>
        {work.type ? (
          <p className="text-xs text-muted-foreground mb-1">{work.type}</p>
        ) : null}
        {work.remarks ? (
          <p className="text-sm leading-relaxed text-foreground/90">{work.remarks}</p>
        ) : !hasDetail ? (
          <p className="text-sm text-muted-foreground">No further details.</p>
        ) : null}
      </AccordionContent>
    </AccordionItem>
  );
}

function LinkedTextList({
  icon,
  title,
  items,
}: {
  icon: React.ReactNode;
  title: string;
  items: AcharyaLinkedText[];
}) {
  return (
    <div>
      <div className="flex items-center gap-2 text-sm font-medium mb-2">
        {icon}
        {title}
        <span className="text-muted-foreground">({items.length})</span>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">None linked.</p>
      ) : (
        <ul className="space-y-1">
          {items.map((t) => (
            <li key={t.documentId} className="text-sm flex items-center gap-2">
              <span className="truncate">{t.name}</span>
              {t.granthaType ? (
                <Badge variant="outline" className="text-[10px] shrink-0">
                  {t.granthaType}
                </Badge>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EditAcharyaDialog({
  acharya,
  open,
  onOpenChange,
}: {
  acharya: AcharyaWithTexts;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [nameDisplay, setNameDisplay] = useState(acharya.nameDisplay ?? "");
  const [dates, setDates] = useState(acharya.dates ?? "");
  const [aliases, setAliases] = useState((acharya.aliases ?? []).join(", "));
  const [avatarUrl, setAvatarUrl] = useState(acharya.avatarUrl ?? "");
  const [uploading, setUploading] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        nameDisplay: nameDisplay.trim() || undefined,
        dates: dates.trim() ? dates.trim() : null,
        avatarUrl: avatarUrl.trim() ? avatarUrl.trim() : null,
        aliases: aliases
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
      const res = await apiRequest("PATCH", `/api/acharyas/${acharya.slug}`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/acharyas"] });
      queryClient.invalidateQueries({ queryKey: ["/api/acharyas", acharya.slug] });
      toast({ title: "Acharya updated" });
      onOpenChange(false);
    },
    onError: (err: any) => toast({ variant: "destructive", title: "Error", description: err.message }),
  });

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast({ variant: "destructive", title: "Please choose an image file" });
      return;
    }
    setUploading(true);
    try {
      const dataBase64 = await fileToBase64(file);
      const res = await apiRequest("POST", "/api/strapi/upload", {
        filename: file.name,
        mimeType: file.type,
        dataBase64,
      });
      const media = (await res.json()) as { url?: string };
      if (media.url) setAvatarUrl(media.url);
      toast({ title: "Avatar uploaded", description: "Remember to Save." });
    } catch (err: any) {
      toast({ variant: "destructive", title: "Upload failed", description: err?.message });
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {acharya.nameDevanagari}</DialogTitle>
          <DialogDescription>
            Display name, life-dates, avatar, and the name aliases used to link texts.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <Avatar className="w-14 h-14">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
              <AvatarFallback>{initials(acharya.nameIast ?? "?")}</AvatarFallback>
            </Avatar>
            <div>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleUpload} />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4 mr-2" />
                )}
                Upload avatar
              </Button>
            </div>
          </div>
          <div>
            <Label>Display name</Label>
            <Input value={nameDisplay} onChange={(e) => setNameDisplay(e.target.value)} className="mt-1.5" />
          </div>
          <div>
            <Label>Life dates</Label>
            <Input value={dates} onChange={(e) => setDates(e.target.value)} placeholder="e.g. 788-820 A.D." className="mt-1.5" />
          </div>
          <div>
            <Label>
              Aliases <span className="text-muted-foreground text-xs">(comma-separated — used to link Granthas &amp; Teekas)</span>
            </Label>
            <Textarea value={aliases} onChange={(e) => setAliases(e.target.value)} className="mt-1.5" rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-acharya">
            {save.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}
