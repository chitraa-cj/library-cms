/**
 * The page-marker format chunk rows store their text in. Every chunk's `markdown`
 * (and `raw_text`) is a sequence of `<<<PAGE:n>>>` lines, each followed by that
 * page's text. Jobs transcribed before the local engine used the same markers, so
 * old and new rows are read by one function.
 */

const PAGE_MARKER_RE = /^\s*<<<PAGE:\s*(\d+)\s*>>>\s*$/gm;

export function formatPageMarker(page: number): string {
  return `<<<PAGE:${page}>>>`;
}

/**
 * Split a chunk's text into pages on the marker lines. Falls back to a single
 * block for the whole range if there are no markers, so a missing marker degrades
 * pagination instead of losing text. A declared page outside the chunk's range is
 * replaced by its position (only ever possible in rows written by the old model).
 */
export function splitChunkPages(
  text: string,
  startPage: number,
  endPage: number,
): Array<{ page: number; markdown: string }> {
  const matches = [...text.matchAll(PAGE_MARKER_RE)];
  if (matches.length === 0) {
    return [{ page: startPage, markdown: text.trim() }];
  }

  const pages: Array<{ page: number; markdown: string }> = [];
  matches.forEach((match, i) => {
    const from = (match.index ?? 0) + match[0].length;
    const to = i + 1 < matches.length ? matches[i + 1].index ?? text.length : text.length;
    const declared = Number(match[1]);
    const page = declared >= startPage && declared <= endPage ? declared : startPage + i;
    pages.push({ page, markdown: text.slice(from, to).trim() });
  });
  return pages;
}
