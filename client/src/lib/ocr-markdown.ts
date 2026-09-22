/**
 * A small, dependency-free Markdown renderer for OCR output.
 *
 * The OCR prompt constrains Gemini to a narrow Markdown subset (headings,
 * paragraphs, lists, block quotes, tables, rules, emphasis), so a focused
 * renderer covers it without pulling a parser into the bundle. Everything is
 * HTML-escaped *before* any markup is generated, so transcribed text can never
 * inject markup — the model's output is untrusted text, not HTML.
 */

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inline spans: `code`, **bold**, *italic*, ~~strike~~, and hard line breaks. */
function renderInline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code class="rounded bg-muted px-1 py-0.5 text-[0.9em]">$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return out;
}

function renderTable(rows: string[]): string {
  const cells = (row: string) =>
    row
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  const isDivider = (row: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(row) && row.includes("-");
  const head = cells(rows[0]);
  const bodyRows = rows.slice(isDivider(rows[1] ?? "") ? 2 : 1).map(cells);

  const thead = `<thead><tr>${head.map((c) => `<th class="border border-border px-2 py-1 text-left font-medium">${renderInline(c)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${bodyRows
    .map((row) => `<tr>${row.map((c) => `<td class="border border-border px-2 py-1 align-top">${renderInline(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody>`;
  return `<table class="my-3 w-full border-collapse text-sm">${thead}${tbody}</table>`;
}

/** Render one page of OCR Markdown to safe HTML. */
export function renderOcrMarkdown(markdown: string): string {
  const lines = (markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p class="my-2 leading-relaxed">${paragraph.map(renderInline).join("<br />")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = null;
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    html.push(
      `<blockquote class="my-3 border-l-2 border-primary/40 pl-3 italic text-muted-foreground">${quote
        .map(renderInline)
        .join("<br />")}</blockquote>`,
    );
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      flushAll();
      continue;
    }

    // Table: a pipe row followed by a divider row.
    if (trimmed.startsWith("|") && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]?.trim() ?? "")) {
      flushAll();
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(lines[i++]);
      i--;
      html.push(renderTable(rows));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      const size = ["text-2xl", "text-xl", "text-lg", "text-base", "text-sm", "text-sm"][level - 1];
      html.push(`<h${level} class="mt-4 mb-2 font-semibold ${size}">${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushAll();
      html.push('<hr class="my-4 border-border" />');
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph();
      flushList();
      quote.push(trimmed.replace(/^>\s?/, ""));
      continue;
    }

    const unordered = /^[-*+]\s+(.*)$/.exec(trimmed);
    const ordered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (unordered || ordered) {
      flushParagraph();
      flushQuote();
      const wanted: "ul" | "ol" = unordered ? "ul" : "ol";
      if (listType !== wanted) {
        flushList();
        listType = wanted;
        html.push(`<${wanted} class="my-2 ml-5 space-y-1 ${wanted === "ul" ? "list-disc" : "list-decimal"}">`);
      }
      html.push(`<li>${renderInline((unordered ? unordered[1] : ordered![2]) ?? "")}</li>`);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line.replace(/\s+$/, ""));
  }

  flushAll();
  return html.join("\n");
}

/** Highlight every occurrence of `needle` in already-rendered HTML (text nodes only). */
export function highlightHtml(html: string, needle: string): string {
  const query = needle.trim();
  if (query.length < 2) return html;
  const escaped = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(${escaped})(?![^<]*>)`, "gi");
  return html.replace(re, '<mark class="rounded bg-amber-200 px-0.5 dark:bg-amber-500/40">$1</mark>');
}
