import type { StrapiBlock } from "@shared/schema";

export function blocksToText(value: StrapiBlock[] | string | undefined | null): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((block) =>
        (block.children || []).map((child) => child.text || "").join("")
      )
      .join("\n");
  }
  return "";
}

export function entryContentCharCount(
  value: StrapiBlock[] | string | undefined | null,
): number {
  return blocksToText(value).trim().length;
}

/** Order / sequence stubs auto-filled in the editor (e.g. "4", "4.", "4..", "4...."). */
export function isStubOrderOrPlaceholderText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^\d{1,4}(\.+)?$/.test(t)) return true;
  return false;
}

/** Remove order-digit stubs from a TextAndTranslation object (draft or CMS). */
export function stripStubTextAndTranslationEntry(
  entry: unknown,
): Record<string, unknown> | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as Record<string, unknown>;
  const out: Record<string, unknown> = { ...e };
  for (const field of ["SanskritTextEntry", "EnglishTranslationText", "IASTTransliteration"] as const) {
    const t = blocksToText(out[field] as any).trim();
    if (!t || isStubOrderOrPlaceholderText(t)) delete out[field];
  }
  const hasRealText = ["SanskritTextEntry", "EnglishTranslationText", "IASTTransliteration"].some(
    (field) => {
      const t = blocksToText(out[field] as any).trim();
      return t.length > 0 && !isStubOrderOrPlaceholderText(t);
    },
  );
  const ot = out.OtherTranslations;
  const hasOt = Array.isArray(ot) && ot.length > 0;
  if (!hasRealText && !hasOt) return undefined;
  return out;
}

/** True when a portal draft field is a stub (e.g. order digit "4") and must not mask CMS text. */
export function isPlaceholderVersusCms(
  draft: StrapiBlock[] | string | undefined | null,
  cms: StrapiBlock[] | string | undefined | null,
): boolean {
  const d = blocksToText(draft).trim();
  const s = blocksToText(cms).trim();
  if (!d) return false;
  if (isStubOrderOrPlaceholderText(d)) return true;
  if (!s || d === s) return false;
  if (/^\d{1,3}$/.test(d)) return true;
  if (d.length <= 8 && s.length > 40) return true;
  if (s.length >= 40 && d.length < s.length * 0.2) {
    // Real editor input (e.g. Devanagari the user typed) — do not replace with a longer wrong CMS row.
    if (d.length >= 20) return false;
    return true;
  }
  return false;
}

export function textToBlocks(text: string): StrapiBlock[] {
  if (!text.trim()) return [];
  return text.split("\n").map((line) => ({
    type: "paragraph",
    children: [{ type: "text", text: line }],
  }));
}

// ── TipTap JSON ↔ Strapi Blocks ──────────────────────────────────────────────

type TipTapMark = { type: string };
type TipTapNode = {
  type: string;
  text?: string;
  marks?: TipTapMark[];
  content?: TipTapNode[];
  attrs?: Record<string, any>;
};
export type TipTapDoc = { type: "doc"; content?: TipTapNode[] };

/** Convert Strapi blocks (or a plain string) → TipTap doc JSON, used to
 *  initialise the editor. */
export function blocksToTipTap(
  value: StrapiBlock[] | string | undefined | null
): TipTapDoc {
  if (!value) return { type: "doc", content: [{ type: "paragraph" }] };

  if (typeof value === "string") {
    const lines = value.split("\n");
    return {
      type: "doc",
      content: lines.map((line) => ({
        type: "paragraph",
        content: line ? [{ type: "text", text: line }] : [],
      })),
    };
  }

  if (!Array.isArray(value) || value.length === 0) {
    return { type: "doc", content: [{ type: "paragraph" }] };
  }

  const content: TipTapNode[] = value.map((block: any) => {
    const children = (block.children || [])
      .filter((c: any) => c.text !== undefined && c.text !== "")
      .map((c: any) => {
        const marks: TipTapMark[] = [];
        if (c.bold) marks.push({ type: "bold" });
        if (c.italic) marks.push({ type: "italic" });
        if (c.underline) marks.push({ type: "underline" });
        if (c.code) marks.push({ type: "code" });
        const node: TipTapNode = { type: "text", text: c.text };
        if (marks.length) node.marks = marks;
        return node;
      });

    if (block.type === "heading") {
      return {
        type: "heading",
        attrs: { level: block.level ?? 2 },
        content: children.length ? children : undefined,
      };
    }

    return {
      type: "paragraph",
      content: children.length ? children : undefined,
    };
  });

  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

/** Recursively extract plain text from any TipTap node tree. */
function extractText(node: TipTapNode): string {
  if (node.type === "hardBreak") return "\n";
  if (node.text !== undefined) return node.text;
  return (node.content ?? []).map(extractText).join("");
}

/** Convert TipTap doc JSON → Strapi blocks array, called on every editor
 *  `onUpdate` event. Handles all TipTap node types so pasted content is
 *  never silently dropped. */
export function tipTapToBlocks(json: TipTapDoc | null | undefined): StrapiBlock[] {
  if (!json?.content) return [];

  const blocks: StrapiBlock[] = [];

  for (const node of json.content) {
    if (node.type === "paragraph") {
      blocks.push({
        type: "paragraph",
        children: inlineToChildren(node.content),
      });
    } else if (node.type === "heading") {
      blocks.push({
        type: "paragraph",
        children: inlineToChildren(node.content),
      } as any);
    } else if (node.type === "bulletList" || node.type === "orderedList") {
      for (const li of node.content ?? []) {
        const paraContent = li.content?.[0]?.content ?? [];
        blocks.push({
          type: "paragraph",
          children: inlineToChildren(paraContent),
        });
      }
    } else if (node.type === "blockquote") {
      for (const inner of node.content ?? []) {
        blocks.push({
          type: "paragraph",
          children: inlineToChildren(inner.content),
        });
      }
    } else if (node.type === "codeBlock") {
      const text = (node.content ?? []).map((c) => c.text ?? "").join("");
      if (text.trim()) {
        for (const line of text.split("\n")) {
          blocks.push({ type: "paragraph", children: [{ type: "text", text: line }] });
        }
      }
    } else if (node.type === "horizontalRule") {
      // Skip — no Strapi equivalent
    } else {
      // Unknown block type — extract all text to avoid losing pasted content
      const text = extractText(node);
      if (text.trim()) {
        blocks.push({ type: "paragraph", children: [{ type: "text", text }] });
      }
    }
  }

  return blocks;
}

function inlineToChildren(
  content: TipTapNode[] | undefined
): { type: string; text: string; bold?: boolean; italic?: boolean; underline?: boolean; code?: boolean }[] {
  if (!content || content.length === 0) {
    return [{ type: "text", text: "" }];
  }
  const children: ReturnType<typeof inlineToChildren> = [];
  for (const c of content) {
    if (c.type === "hardBreak") {
      // Hard breaks (shift+enter or pasted <br>) become a trailing newline
      // appended to the previous child, or a standalone empty node.
      if (children.length > 0) {
        children[children.length - 1].text += "\n";
      }
      continue;
    }
    const marks = c.marks ?? [];
    const child: any = { type: "text", text: c.text ?? "" };
    if (marks.some((m) => m.type === "bold")) child.bold = true;
    if (marks.some((m) => m.type === "italic")) child.italic = true;
    if (marks.some((m) => m.type === "underline")) child.underline = true;
    if (marks.some((m) => m.type === "code")) child.code = true;
    children.push(child);
  }
  return children.length > 0 ? children : [{ type: "text", text: "" }];
}
