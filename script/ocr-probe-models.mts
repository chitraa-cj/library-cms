#!/usr/bin/env node --import tsx
/**
 * Check that every model OCR might call is actually reachable with this key.
 *
 * Gemini retires models ("no longer available to new users" → 404) and meters
 * capacity per model (503 "high demand"), so a fallback list can rot silently:
 * a dead entry costs one wasted request per page range. Run this after
 * changing OCR_MODEL_FAST / OCR_MODEL_ACCURATE / OCR_FALLBACK_MODELS.
 *
 *   node --import tsx --env-file=.env script/ocr-probe-models.mts
 *
 * Spends one tiny request per model. Exits non-zero only for a model that can
 * never work as configured (404 retired, 400 bad request, auth). A 503 (busy)
 * or 429 (quota) is reported but not a failure: those are exactly the
 * transient conditions the fallback chain exists to absorb.
 */
import { ocrConfig, isOcrConfigured } from "../server/ocr/config.ts";

if (!isOcrConfigured()) {
  console.error("GEMINI_API_KEY is not set — nothing to probe.");
  process.exit(1);
}

const models = [
  { name: ocrConfig.models.fast, role: "fast" },
  ...(ocrConfig.models.accurate !== ocrConfig.models.fast
    ? [{ name: ocrConfig.models.accurate, role: "accurate" }]
    : []),
  ...ocrConfig.fallbackModels.map((name) => ({ name, role: "fallback" })),
];

let broken = 0;
let transient = 0;

for (const { name, role } of models) {
  const started = Date.now();
  let verdict: string;
  try {
    const res = await fetch(`${ocrConfig.apiBase}/models/${encodeURIComponent(name)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": ocrConfig.apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Reply with the single word OK" }] }],
        generationConfig: { maxOutputTokens: 8, temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (res.ok) {
      verdict = "reachable";
    } else if (res.status === 503) {
      transient++;
      verdict = "busy (503) — transient, the fallback chain covers this";
    } else if (res.status === 429) {
      transient++;
      const daily = /PerDay/i.test(JSON.stringify(json));
      verdict = `quota spent (429${daily ? ", per-day" : ", per-minute"}) — reachable, just rate limited`;
    } else {
      broken++;
      verdict = `UNUSABLE (${res.status}) ${String(json?.error?.message ?? "").slice(0, 80)}`;
    }
  } catch (err: any) {
    broken++;
    verdict = `UNREACHABLE ${err?.message}`;
  }
  console.log(`${name.padEnd(28)} ${role.padEnd(9)} ${verdict}  ${Date.now() - started}ms`);
}

console.log(`\n${models.length} model(s) probed — ${broken} unusable, ${transient} busy or rate limited.`);
if (broken > 0) {
  console.error("Remove or replace the unusable model(s); each one wastes a request per page range.");
  process.exit(1);
}
