/**
 * Unit checks for the YouTube link parser used by the grantha video list.
 * Run: npx tsx script/test-youtube-url.ts
 */
import assert from "node:assert/strict";
import {
  canonicalYouTubeUrl,
  parseYouTubeLink,
  parseYouTubeTimestamp,
} from "../shared/youtube-url";

const ID = "dQw4w9WgXcQ";

// Accepted shapes
for (const input of [
  ID,
  `https://www.youtube.com/watch?v=${ID}`,
  `http://youtube.com/watch?v=${ID}&list=PL123`,
  `https://m.youtube.com/watch?v=${ID}`,
  `youtube.com/watch?v=${ID}`,
  `https://youtu.be/${ID}`,
  `https://youtu.be/${ID}?si=abc`,
  `https://www.youtube.com/embed/${ID}`,
  `https://www.youtube.com/shorts/${ID}`,
  `https://www.youtube.com/live/${ID}`,
  `https://www.youtube-nocookie.com/embed/${ID}`,
]) {
  const parsed = parseYouTubeLink(input);
  assert.ok(parsed, `expected a parse for ${input}`);
  assert.equal(parsed!.videoId, ID, `wrong id for ${input}`);
}

// Rejected shapes
for (const input of ["", "   ", "not a url", "https://vimeo.com/12345", `https://www.youtube.com/watch?v=short`, "https://www.youtube.com/"]) {
  assert.equal(parseYouTubeLink(input), null, `expected null for ${JSON.stringify(input)}`);
}

// Timestamps
assert.equal(parseYouTubeLink(`https://youtu.be/${ID}?t=90`)!.startSeconds, 90);
assert.equal(parseYouTubeLink(`https://youtu.be/${ID}?t=90s`)!.startSeconds, 90);
assert.equal(parseYouTubeLink(`https://www.youtube.com/watch?v=${ID}&t=1m30s`)!.startSeconds, 90);
assert.equal(parseYouTubeLink(`https://www.youtube.com/watch?v=${ID}&t=1h2m3s`)!.startSeconds, 3723);
assert.equal(parseYouTubeLink(`https://www.youtube.com/embed/${ID}?start=45`)!.startSeconds, 45);
assert.equal(parseYouTubeLink(`https://www.youtube.com/watch?v=${ID}#t=30`)!.startSeconds, 30);
assert.equal(parseYouTubeLink(`https://youtu.be/${ID}`)!.startSeconds, 0);
assert.equal(parseYouTubeTimestamp("garbage"), 0);

assert.equal(canonicalYouTubeUrl(ID), `https://www.youtube.com/watch?v=${ID}`);

console.log("test-youtube-url: all ok");
