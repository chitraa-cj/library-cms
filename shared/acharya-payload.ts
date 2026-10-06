/**
 * The acharya editor's form -> API payload, kept out of the dialog so the shape the
 * browser actually sends can be validated against `createAcharyaSchema` /
 * `updateAcharyaSchema` in a test instead of only at runtime in production.
 *
 * Everything here is pure string handling and must stay Unicode-transparent: names,
 * aliases and biography prose are Devanagari / IAST and are only trimmed, never
 * normalized, transliterated or stripped.
 */
import type { AcharyaBioSection } from "./schema";

/** One biography section while it is being typed: a heading plus free prose where a
 *  blank line starts a new paragraph. */
export interface BioDraft {
  key: string;
  heading: string;
  body: string;
}

let bioKeySeq = 0;
export const nextBioKey = () => `bio-${Date.now().toString(36)}-${bioKeySeq++}`;

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

/** The raw form state of the acharya dialog. */
export interface AcharyaFormState {
  name: string;
  nameDevanagari: string;
  nameIast: string;
  dates: string;
  aliases: string;
  avatarUrl: string;
  bio: BioDraft[];
  selectedDocIds: string[];
}

/**
 * Body for `POST /api/acharyas` (create) or `PATCH /api/acharyas/:slug` (edit).
 *
 * A box left blank is sent as `null`, not omitted — both schemas accept null for
 * every optional field, so "clear this" and "never filled this in" are the same
 * request and an edit can genuinely blank a field out.
 */
export function buildAcharyaPayload(form: AcharyaFormState, mode: "create" | "edit") {
  const base = {
    nameDevanagari: form.nameDevanagari.trim() || form.name.trim(),
    nameIast: form.nameIast.trim() || null,
    dates: form.dates.trim() || null,
    avatarUrl: form.avatarUrl.trim() || null,
    aliases: form.aliases
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    biography: draftsToBioSections(form.bio),
    linkedGranthaDocIds: form.selectedDocIds,
  };
  return mode === "edit"
    ? { ...base, nameDisplay: form.name.trim() }
    : { ...base, name: form.name.trim() };
}
