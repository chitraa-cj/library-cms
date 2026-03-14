import type { StrapiBlock } from "@shared/schema";

export function blocksToText(value: StrapiBlock[] | string | undefined): string {
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
