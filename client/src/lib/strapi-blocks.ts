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
      .filter((c: any) => c.text !== undefined)
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

/** Convert TipTap doc JSON → Strapi blocks array, called on every editor
 *  `onUpdate` event. */
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
      const inner = node.content?.[0]?.content ?? [];
      blocks.push({
        type: "paragraph",
        children: inlineToChildren(inner),
      });
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
  return content.map((c) => {
    const marks = c.marks ?? [];
    const child: any = { type: "text", text: c.text ?? "" };
    if (marks.some((m) => m.type === "bold")) child.bold = true;
    if (marks.some((m) => m.type === "italic")) child.italic = true;
    if (marks.some((m) => m.type === "underline")) child.underline = true;
    if (marks.some((m) => m.type === "code")) child.code = true;
    return child;
  });
}
