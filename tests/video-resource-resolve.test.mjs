#!/usr/bin/env node --import tsx
/**
 * Video Resource resolver — pure unit test (no I/O).
 * =================================================
 * Verifies inherit-with-fallback, many-per-node ordering, and the
 * nearest-ancestor rule for resolving YouTube videos onto hierarchy nodes.
 *
 * Run: node --import tsx tests/video-resource-resolve.test.mjs
 */

import {
  indexVideosByTarget,
  resolveVideosForNode,
  resolveVideos,
  fromStrapiVideoResource,
} from "../shared/video-resource-resolve.ts";

let PASS = 0;
let FAIL = 0;
function assert(cond, label) {
  if (cond) {
    PASS++;
    console.log(`  ✓ ${label}`);
  } else {
    FAIL++;
    console.error(`  ✗ ${label}`);
  }
}

// Hierarchy:  grantha G  ->  adhyaya A  ->  khanda K  ->  manthra M
const chainForManthra = [
  { type: "manthra", documentId: "M" },
  { type: "section", documentId: "K" },
  { type: "section", documentId: "A" },
  { type: "grantha", documentId: "G" },
];

const v = (targetDocId, targetType, extra = {}) => ({
  youtubeUrl: `https://youtu.be/${targetDocId}${extra.sortOrder ?? ""}`,
  targetType,
  targetDocId,
  ...extra,
});

console.log("Video resource resolver");

// 1. Node with its own videos shows them, not inherited.
{
  const idx = indexVideosByTarget([v("M", "manthra"), v("G", "grantha")]);
  const r = resolveVideosForNode(chainForManthra, idx);
  assert(r.videos.length === 1 && r.videos[0].targetDocId === "M", "own video wins over ancestor");
  assert(r.inheritedFrom === null, "own video reports inheritedFrom=null");
}

// 2. Fallback to NEAREST ancestor when node has none.
{
  const idx = indexVideosByTarget([v("A", "section"), v("G", "grantha")]);
  const r = resolveVideosForNode(chainForManthra, idx);
  assert(r.videos[0].targetDocId === "A", "falls back to nearest ancestor (adhyaya over grantha)");
  assert(r.inheritedFrom?.documentId === "A", "inheritedFrom points at the adhyaya");
}

// 3. Grantha-level fallback when nothing closer exists.
{
  const idx = indexVideosByTarget([v("G", "grantha")]);
  const r = resolveVideosForNode(chainForManthra, idx);
  assert(r.videos[0].targetDocId === "G" && r.inheritedFrom?.type === "grantha", "falls back to grantha");
}

// 4. Many-per-node, ordered by sortOrder ascending.
{
  const idx = indexVideosByTarget([
    v("M", "manthra", { sortOrder: 2, title: "second" }),
    v("M", "manthra", { sortOrder: 1, title: "first" }),
  ]);
  const r = resolveVideosForNode(chainForManthra, idx);
  assert(r.videos.length === 2 && r.videos[0].title === "first", "multiple videos sorted by sortOrder");
}

// 5. No videos anywhere -> empty, not a throw.
{
  const r = resolveVideosForNode(chainForManthra, indexVideosByTarget([]));
  assert(r.videos.length === 0 && r.inheritedFrom === null, "empty when nothing matches");
}

// 6. Rows missing url/target are ignored by the index.
{
  const idx = indexVideosByTarget([
    { targetType: "manthra", targetDocId: "M" }, // no url
    v("M", "manthra"),
  ]);
  assert((idx.get("M") ?? []).length === 1, "rows without youtubeUrl are dropped");
}

// 7. Strapi attribute mapping (snake_case -> camelCase).
{
  const mapped = fromStrapiVideoResource({
    documentId: "vid1",
    youtube_url: "https://youtu.be/x",
    target_type: "section",
    target_doc_id: "K",
    target_section_type: "khanda",
    start_seconds: 42,
    sort_order: 3,
  });
  assert(
    mapped?.youtubeUrl === "https://youtu.be/x" &&
      mapped?.targetDocId === "K" &&
      mapped?.targetSectionType === "khanda" &&
      mapped?.startSeconds === 42 &&
      mapped?.sortOrder === 3,
    "fromStrapiVideoResource maps snake_case attributes",
  );
}

// 8. resolveVideos convenience wrapper agrees with the indexed path.
{
  const r = resolveVideos(chainForManthra, [v("A", "section")]);
  assert(r.inheritedFrom?.documentId === "A", "resolveVideos wrapper resolves the same");
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
