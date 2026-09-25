import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { BookOpen, Loader2, Plus, Search, Upload, X } from "lucide-react";
import type {
  AcharyaBioSection,
  AcharyaGranthaOption,
  AcharyaWithTexts,
} from "@shared/schema";

/** One biography section while it is being typed: a heading plus free prose where a
 *  blank line starts a new paragraph. */
interface BioDraft {
  key: string;
  heading: string;
  body: string;
}

let bioKeySeq = 0;
const nextBioKey = () => `bio-${Date.now().toString(36)}-${bioKeySeq++}`;

export function bioSectionsToDrafts(sections: AcharyaBioSection[] | undefined): BioDraft[] {
  if (!sections?.length) return [];
  return sections.map((s) => ({
    key: nextBioKey(),
    heading: s.heading ?? "",
    body: (s.paragraphs ?? []).join("\n\n"),
  }));
}

export function draftsToBioSections(drafts: BioDraft[]): AcharyaBioSection[] {
  return drafts
    .map((d) => ({
      heading: d.heading.trim() || null,
      paragraphs: d.body
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean),
    }))
    .filter((s) => s.heading || s.paragraphs.length > 0);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
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

interface AcharyaEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omitted for "add an acharya"; supplied when editing an existing profile. */
  acharya?: AcharyaWithTexts;
  /** Called with the new slug after a create, so the page can select it. */
  onCreated?: (slug: string) => void;
}

/**
 * Add or edit an acharya: the name as it should read, life dates, avatar, the
 * biography, and — the point of the picker below — which granthas from the CMS sit
 * under them. Picked granthas are stored on the profile; granthas whose
 * BhashyamAuthor already matches the acharya's name keep linking themselves and are
 * shown as such, so the two ways of attributing a text never fight.
 */
export default function AcharyaEditorDialog({
  open,
  onOpenChange,
  acharya,
  onCreated,
}: AcharyaEditorDialogProps) {
  const { toast } = useToast();
  const isEdit = !!acharya;
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [nameDevanagari, setNameDevanagari] = useState("");
  const [nameIast, setNameIast] = useState("");
  const [dates, setDates] = useState("");
  const [aliases, setAliases] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [bio, setBio] = useState<BioDraft[]>([]);
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [granthaSearch, setGranthaSearch] = useState("");
  const [uploading, setUploading] = useState(false);

  // Reset the form each time the dialog opens, so a cancelled edit leaves nothing behind.
  useEffect(() => {
    if (!open) return;
    setName(acharya?.nameDisplay ?? acharya?.nameIast ?? acharya?.nameDevanagari ?? "");
    setNameDevanagari(acharya?.nameDevanagari ?? "");
    setNameIast(acharya?.nameIast ?? "");
    setDates(acharya?.dates ?? "");
    setAliases((acharya?.aliases ?? []).join(", "));
    setAvatarUrl(acharya?.avatarUrl ?? "");
    setBio(bioSectionsToDrafts(acharya?.biography));
    setSelectedDocIds(acharya?.linkedGranthaDocIds ?? []);
    setGranthaSearch("");
  }, [open, acharya]);

  const { data: granthaData, isLoading: granthasLoading } = useQuery<{ data: AcharyaGranthaOption[] }>({
    queryKey: ["/api/acharyas/granthas"],
    enabled: open,
    staleTime: 60_000,
  });
  const granthas = granthaData?.data ?? [];

  /** Granthas already attributed to this acharya through their author name. */
  const autoLinkedDocIds = useMemo(
    () =>
      new Set(
        (acharya?.granthas ?? [])
          .filter((g) => g.linkedBy === "author")
          .map((g) => g.documentId),
      ),
    [acharya],
  );

  const filteredGranthas = useMemo(() => {
    const q = granthaSearch.trim().toLowerCase();
    if (!q) return granthas;
    return granthas.filter((g) =>
      [g.name, g.granthaType, g.bhashyamAuthor]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(q)),
    );
  }, [granthas, granthaSearch]);

  const selectedSet = useMemo(() => new Set(selectedDocIds), [selectedDocIds]);

  function toggleGrantha(documentId: string) {
    setSelectedDocIds((prev) =>
      prev.includes(documentId) ? prev.filter((id) => id !== documentId) : [...prev, documentId],
    );
  }

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        nameDevanagari: nameDevanagari.trim() || name.trim(),
        nameIast: nameIast.trim() ? nameIast.trim() : null,
        dates: dates.trim() ? dates.trim() : null,
        avatarUrl: avatarUrl.trim() ? avatarUrl.trim() : null,
        aliases: aliases
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        biography: draftsToBioSections(bio),
        linkedGranthaDocIds: selectedDocIds,
      };
      if (isEdit) {
        const res = await apiRequest("PATCH", `/api/acharyas/${acharya!.slug}`, {
          ...payload,
          nameDisplay: name.trim(),
        });
        return res.json();
      }
      const res = await apiRequest("POST", "/api/acharyas", { ...payload, name: name.trim() });
      return res.json();
    },
    onSuccess: (saved: { slug: string }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/acharyas"] });
      if (isEdit) {
        queryClient.invalidateQueries({ queryKey: ["/api/acharyas", acharya!.slug] });
      } else {
        onCreated?.(saved.slug);
      }
      toast({
        title: isEdit ? "Acharya updated" : "Acharya added",
        description: selectedDocIds.length
          ? `${selectedDocIds.length} grantha${selectedDocIds.length > 1 ? "s" : ""} under them.`
          : undefined,
      });
      onOpenChange(false);
    },
    onError: (err: any) =>
      toast({ variant: "destructive", title: "Could not save", description: err?.message }),
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
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${acharya!.nameDevanagari}` : "Add an acharya"}</DialogTitle>
          <DialogDescription>
            Type the name, write the biography, and tick the granthas that belong under
            this acharya.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Identity */}
          <div className="flex items-start gap-4">
            <Avatar className="w-14 h-14">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
              <AvatarFallback>{initials(name || "?")}</AvatarFallback>
            </Avatar>
            <div>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleUpload} />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                data-testid="button-acharya-avatar"
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

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <Label>Name *</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Ādi Śaṅkarācārya"
                className="mt-1.5"
                data-testid="input-acharya-name"
              />
            </div>
            <div>
              <Label>Name in Devanagari</Label>
              <Input
                value={nameDevanagari}
                onChange={(e) => setNameDevanagari(e.target.value)}
                placeholder="आदिशङ्कराचार्यः"
                className="mt-1.5"
                data-testid="input-acharya-name-devanagari"
              />
            </div>
            <div>
              <Label>Name in IAST</Label>
              <Input
                value={nameIast}
                onChange={(e) => setNameIast(e.target.value)}
                placeholder="Ādi Śaṅkarācārya"
                className="mt-1.5"
                data-testid="input-acharya-name-iast"
              />
            </div>
            <div>
              <Label>Life dates</Label>
              <Input
                value={dates}
                onChange={(e) => setDates(e.target.value)}
                placeholder="e.g. 788-820 A.D."
                className="mt-1.5"
                data-testid="input-acharya-dates"
              />
            </div>
            <div>
              <Label>
                Aliases{" "}
                <span className="text-muted-foreground text-xs">
                  (comma-separated — also auto-links texts by author name)
                </span>
              </Label>
              <Input
                value={aliases}
                onChange={(e) => setAliases(e.target.value)}
                placeholder="Shankara, Sri Shankarayacharya"
                className="mt-1.5"
                data-testid="input-acharya-aliases"
              />
            </div>
          </div>

          <Separator />

          {/* Granthas under this acharya */}
          <div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="flex items-center gap-2">
                  <BookOpen className="w-4 h-4" /> Granthas under this acharya
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Tick any grantha from the CMS. Ticked granthas are filed under this
                  acharya regardless of the author name recorded on them.
                </p>
              </div>
              <Badge variant="secondary" className="shrink-0" data-testid="badge-acharya-grantha-count">
                {selectedDocIds.length} selected
              </Badge>
            </div>

            <div className="relative mt-2">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={granthaSearch}
                onChange={(e) => setGranthaSearch(e.target.value)}
                placeholder="Search granthas…"
                className="pl-9"
                data-testid="input-acharya-grantha-search"
              />
            </div>

            <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border divide-y">
              {granthasLoading ? (
                <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading granthas…
                </div>
              ) : filteredGranthas.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  {granthas.length === 0
                    ? "No granthas found in the CMS."
                    : `No grantha matches “${granthaSearch}”.`}
                </p>
              ) : (
                filteredGranthas.map((g) => {
                  const checked = selectedSet.has(g.documentId);
                  return (
                    <label
                      key={g.documentId}
                      className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/50"
                      data-testid={`row-acharya-grantha-${g.documentId}`}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleGrantha(g.documentId)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{g.name}</span>
                        {g.bhashyamAuthor ? (
                          <span className="block truncate text-xs text-muted-foreground">
                            {g.bhashyamAuthor}
                          </span>
                        ) : null}
                      </span>
                      {autoLinkedDocIds.has(g.documentId) && !checked ? (
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          by author
                        </Badge>
                      ) : null}
                      {g.granthaType ? (
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          {g.granthaType}
                        </Badge>
                      ) : null}
                    </label>
                  );
                })
              )}
            </div>
          </div>

          <Separator />

          {/* Biography */}
          <div>
            <Label>Biography</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              One block per section. Leave a blank line between paragraphs.
            </p>
            <div className="mt-2 space-y-3">
              {bio.map((section, i) => (
                <div key={section.key} className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Input
                      value={section.heading}
                      onChange={(e) =>
                        setBio((prev) =>
                          prev.map((s, j) => (j === i ? { ...s, heading: e.target.value } : s)),
                        )
                      }
                      placeholder="Section heading (optional)"
                      className="h-8 text-sm"
                      data-testid={`input-acharya-bio-heading-${i}`}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                      onClick={() => setBio((prev) => prev.filter((_, j) => j !== i))}
                      data-testid={`button-acharya-bio-remove-${i}`}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                  <Textarea
                    value={section.body}
                    onChange={(e) =>
                      setBio((prev) =>
                        prev.map((s, j) => (j === i ? { ...s, body: e.target.value } : s)),
                      )
                    }
                    rows={5}
                    placeholder="Write the biography here…"
                    className="text-sm"
                    data-testid={`input-acharya-bio-body-${i}`}
                  />
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => setBio((prev) => [...prev, { key: nextBioKey(), heading: "", body: "" }])}
              data-testid="button-acharya-bio-add"
            >
              <Plus className="w-4 h-4 mr-2" />
              {bio.length === 0 ? "Write biography" : "Add section"}
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || !name.trim()}
            data-testid="button-save-acharya"
          >
            {save.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {isEdit ? "Save" : "Add acharya"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
