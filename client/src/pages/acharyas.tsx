import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import AcharyaEditorDialog from "@/components/acharya-editor-dialog";
import {
  BookOpen,
  Library,
  Loader2,
  Pencil,
  Plus,
  Search,
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
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [search, setSearch] = useState("");
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

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
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Acharyas</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Guru-parampara — biographies, works, and the texts (Upanishads &amp; commentaries)
            linked under each acharya.
          </p>
        </div>
        {isAdmin ? (
          <Button onClick={() => setAddOpen(true)} data-testid="button-add-acharya">
            <Plus className="w-4 h-4 mr-2" />
            Add acharya
          </Button>
        ) : null}
      </div>
      {isAdmin ? (
        <AcharyaEditorDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          onCreated={(slug) => setSelectedSlug(slug)}
        />
      ) : null}

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

      {/* Texts under this acharya */}
      {(acharya.granthas.length > 0 || acharya.teekas.length > 0 || isAdmin) && (
        <>
          <Separator className="my-5" />
          <div className="grid sm:grid-cols-2 gap-5">
            <LinkedTextList
              icon={<BookOpen className="w-4 h-4" />}
              title="Granthas (texts)"
              items={acharya.granthas}
              emptyHint={isAdmin ? "Use Edit to pick the granthas under this acharya." : undefined}
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
        <AcharyaEditorDialog acharya={acharya} open={editOpen} onOpenChange={setEditOpen} />
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
  emptyHint,
}: {
  icon: React.ReactNode;
  title: string;
  items: AcharyaLinkedText[];
  emptyHint?: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 text-sm font-medium mb-2">
        {icon}
        {title}
        <span className="text-muted-foreground">({items.length})</span>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyHint ?? "None linked."}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((t) => (
            <li key={t.documentId} className="text-sm flex items-center gap-2">
              <span className="truncate">{t.name}</span>
              {t.linkedBy === "author" ? (
                <Badge variant="secondary" className="text-[10px] shrink-0" title="Matched by author name">
                  by author
                </Badge>
              ) : null}
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
