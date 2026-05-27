/**
 * Match Ishavasya mantras / Shankara bhashyam / Anandagiri teeka against the
 * web-scraped Sacred-Script-Hub Postgres DB, then merge missing OtherTranslations
 * into live Strapi (never overwrites existing languages).
 *
 * Source DB: sacred_script_hub.book slug `isha-upanishad-bhashya`
 * Target: Strapi grantha documentId ngjdm2fcgp0ogp16jcey3vo1
 *
 * Usage:
 *   npx tsx script/import-ishavasya-translations-from-scrape.ts
 *   npx tsx script/import-ishavasya-translations-from-scrape.ts --execute
 *   npx tsx script/import-ishavasya-translations-from-scrape.ts --suffix 1.1.1 --execute
 *
 * Env:
 *   SCRAPED_DATABASE_URL — default postgresql://postgres:root@localhost:5432/sacred_script_hub
 *   STRAPI_URL, STRAPI_API_TOKEN (from .env via server/env)
 */
import "../server/env";
import pg from "pg";
import { strapiRequest } from "../server/strapi";
import { translationLanguages } from "../shared/schema";
import {
  blocksToText,
  filledLangs,
  MANTRA_FULL_QUERY,
  stripEntryForPut,
  textToBlocks,
} from "./lib/hermex-grantha-sync";
import { mergeMissingOtFromBackup } from "./lib/restore-other-translations";
import {
  mapScrapedLanguageCode,
  sanskritTextsMatch,
} from "./lib/scraped-language-map";

const ISHAVASYA_STRAPI_DOC = "ngjdm2fcgp0ogp16jcey3vo1";
const SCRAPED_BOOK_SLUG = "isha-upanishad-bhashya";
const SCRAPED_DB =
  process.env.SCRAPED_DATABASE_URL ||
  "postgresql://postgres:root@localhost:5432/sacred_script_hub";

const BHASHYA_AUTHOR = "Adi Shankaracharya";
const TEEKA_AUTHORS: { scraped: string; strapiNameMatch: RegExp }[] = [
  { scraped: "Anandagiri", strapiNameMatch: /anandagiri/i },
  { scraped: "Upanishad Brahmendra", strapiNameMatch: /brahmendra/i },
];

function parseArgs() {
  const args = process.argv.slice(2);
  let execute = false;
  let suffixFilter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--execute") execute = true;
    else if (args[i] === "--suffix" && args[i + 1]) suffixFilter = args[++i];
  }
  return { execute, suffixFilter };
}

function mantraSuffix(label: string | undefined): string | null {
  const m = String(label ?? "")
    .trim()
    .match(/([\d]+(?:\.[\d]+)*)\s*$/);
  return m ? m[1] : null;
}

type OtRow = { LanguageOfTranslation: string; TranslationText: unknown[]; isAiTranslated: boolean };

function scrapedRowsToOt(
  rows: { language_code: string; content: string }[],
): OtRow[] {
  const out: OtRow[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const lang = mapScrapedLanguageCode(r.language_code);
    if (!lang || seen.has(lang) || !(r.content || "").trim()) continue;
    seen.add(lang);
    out.push({
      LanguageOfTranslation: lang,
      TranslationText: textToBlocks(r.content.trim()),
      isAiTranslated: false,
    });
  }
  return out;
}

function backupEntryFromOt(rows: OtRow[]): { OtherTranslations: OtRow[] } {
  return { OtherTranslations: rows };
}

async function listLiveMantras(granthaDocId: string): Promise<any[]> {
  const all: any[] = [];
  let page = 1;
  while (true) {
    const res = await strapiRequest(
      `/api/manthras?filters[Section][grantha][documentId][$eq]=${encodeURIComponent(granthaDocId)}` +
        `&fields[0]=documentId&fields[1]=ShlokaManthraNumber&pagination[pageSize]=100&pagination[page]=${page}&sort=order:asc`,
    );
    all.push(...(res?.data ?? []));
    if (page >= (res?.meta?.pagination?.pageCount ?? 1)) break;
    page++;
  }
  return all;
}

async function fetchLiveMantraFull(docId: string): Promise<any> {
  const res = await strapiRequest(`/api/manthras/${docId}${MANTRA_FULL_QUERY}`);
  return res?.data ?? null;
}

async function putManthraField(
  docId: string,
  field: "ShlokaManthraEntry" | "BhashyamEntry",
  merged: any,
): Promise<void> {
  const payload = stripEntryForPut(merged);
  if (!payload) return;
  await strapiRequest(`/api/manthras/${docId}`, {
    method: "PUT",
    body: JSON.stringify({ data: { [field]: payload } }),
  });
}

async function putTeekas(docId: string, teekas: any[]): Promise<void> {
  const stripped = teekas.map((t) => {
    const te = stripEntryForPut(t.TeekaEntry);
    const row: any = { teeka: t.teeka?.documentId ?? t.teeka };
    if (t.id) row.id = t.id;
    if (te) row.TeekaEntry = te;
    return row;
  });
  await strapiRequest(`/api/manthras/${docId}`, {
    method: "PUT",
    body: JSON.stringify({ data: { Teekas: stripped } }),
  });
}

type ScrapedVerse = {
  verse_number: number;
  verse_id: string;
  shloka_devanagari: string;
  verse_translations: { language_code: string; content: string }[];
  bhashyam_devanagari: string;
  bhashyam_translations: { language_code: string; content: string }[];
  teeka_by_author: Map<
    string,
    { devanagari: string; translations: { language_code: string; content: string }[] }
  >;
};

async function loadScrapedVerses(pool: pg.Pool): Promise<ScrapedVerse[]> {
  const bookRes = await pool.query(
    `SELECT id FROM books WHERE slug = $1 LIMIT 1`,
    [SCRAPED_BOOK_SLUG],
  );
  if (bookRes.rows.length === 0) {
    throw new Error(`No book with slug "${SCRAPED_BOOK_SLUG}" in scraped DB`);
  }
  const bookId = bookRes.rows[0].id as string;

  const versesRes = await pool.query(
    `SELECT id, verse_number FROM verses WHERE book_id = $1 AND verse_number >= 1 ORDER BY verse_number`,
    [bookId],
  );

  const out: ScrapedVerse[] = [];
  for (const v of versesRes.rows) {
    const verseId = v.id as string;
    const verseNumber = v.verse_number as number;

    const vtRes = await pool.query(
      `SELECT language_code, content FROM verse_translations WHERE verse_id = $1`,
      [verseId],
    );
    const shlokaDev = vtRes.rows.find((r) => r.language_code === "devanagari")?.content as
      | string
      | undefined;

    const explRes = await pool.query(
      `SELECT author_name, language_code, content FROM explanations WHERE verse_id = $1`,
      [verseId],
    );

    const bhashyamRows = explRes.rows.filter((r) => r.author_name === BHASHYA_AUTHOR);
    const bhashyamDev = bhashyamRows.find((r) => r.language_code === "devanagari")?.content as
      | string
      | undefined;

    const teeka_by_author = new Map<
      string,
      { devanagari: string; translations: { language_code: string; content: string }[] }
    >();
    for (const cfg of TEEKA_AUTHORS) {
      const rows = explRes.rows.filter((r) => r.author_name === cfg.scraped);
      const dev = rows.find((r) => r.language_code === "devanagari")?.content as string | undefined;
      teeka_by_author.set(cfg.scraped, {
        devanagari: dev || "",
        translations: rows
          .filter((r) => r.language_code !== "devanagari")
          .map((r) => ({
            language_code: r.language_code as string,
            content: r.content as string,
          })),
      });
    }

    out.push({
      verse_number: verseNumber,
      verse_id: verseId,
      shloka_devanagari: shlokaDev || "",
      verse_translations: vtRes.rows
        .filter((r) => r.language_code !== "devanagari")
        .map((r) => ({
          language_code: r.language_code as string,
          content: r.content as string,
        })),
      bhashyam_devanagari: bhashyamDev || "",
      bhashyam_translations: bhashyamRows
        .filter((r) => r.language_code !== "devanagari")
        .map((r) => ({
          language_code: r.language_code as string,
          content: r.content as string,
        })),
      teeka_by_author,
    });
  }
  return out;
}

function findScrapedForSuffix(scraped: ScrapedVerse[], suffix: string): ScrapedVerse | undefined {
  const parts = suffix.split(".").map((x) => parseInt(x, 10));
  const verseNum = parts.length >= 3 ? parts[2] : parts[parts.length - 1];
  return scraped.find((v) => v.verse_number === verseNum);
}

async function main() {
  const { execute, suffixFilter } = parseArgs();
  const pool = new pg.Pool({ connectionString: SCRAPED_DB });

  try {
    const scraped = await loadScrapedVerses(pool);
    console.log(`\n=== Ishavasya translations from scraped DB ===`);
    console.log(`Scraped verses: ${scraped.length} (book: ${SCRAPED_BOOK_SLUG})`);
    console.log(`Strapi grantha: ${ISHAVASYA_STRAPI_DOC}`);
    console.log(`Mode: ${execute ? "EXECUTE" : "DRY RUN"}\n`);

    const liveList = await listLiveMantras(ISHAVASYA_STRAPI_DOC);
    let matched = 0;
    let skippedNoScrape = 0;
    let skippedSkMismatch = 0;
    let planShloka = 0;
    let planBhashyam = 0;
    let planTeeka = 0;
    let applied = 0;

    for (const ref of liveList) {
      const label = ref.ShlokaManthraNumber || ref.documentId;
      const suffix = mantraSuffix(label);
      if (!suffix) continue;
      if (suffixFilter && suffix !== suffixFilter) continue;

      const scrapedRow = findScrapedForSuffix(scraped, suffix);
      if (!scrapedRow) {
        console.log(`[skip] ${label} — no scraped verse for suffix ${suffix}`);
        skippedNoScrape++;
        continue;
      }

      const live = await fetchLiveMantraFull(ref.documentId);
      if (!live) {
        console.log(`[skip] ${label} — could not load live mantra`);
        continue;
      }

      const liveSk = blocksToText(live.ShlokaManthraEntry?.SanskritTextEntry);
      if (!sanskritTextsMatch(scrapedRow.shloka_devanagari, liveSk)) {
        console.log(`[skip] ${label} — shloka Sanskrit mismatch (scraped vs Strapi)`);
        console.log(`       scraped: ${scrapedRow.shloka_devanagari.slice(0, 60)}…`);
        console.log(`       live:    ${liveSk.slice(0, 60)}…`);
        skippedSkMismatch++;
        continue;
      }
      matched++;

      const shlokaOt = scrapedRowsToOt(scrapedRow.verse_translations);
      const bhashyamOt = scrapedRowsToOt(scrapedRow.bhashyam_translations);

      const plans: Array<{
        kind: string;
        field?: "ShlokaManthraEntry" | "BhashyamEntry";
        teekaIndex?: number;
        added: string[];
        apply: () => Promise<void>;
      }> = [];

      if (shlokaOt.length > 0) {
        const { merged, addedLangs } = mergeMissingOtFromBackup(
          live.ShlokaManthraEntry,
          backupEntryFromOt(shlokaOt),
        );
        if (addedLangs.length > 0) {
          planShloka += addedLangs.length;
          plans.push({
            kind: "shloka",
            field: "ShlokaManthraEntry",
            added: addedLangs,
            apply: async () => putManthraField(ref.documentId, "ShlokaManthraEntry", merged),
          });
        }
      }

      const liveBhSk = blocksToText(live.BhashyamEntry?.SanskritTextEntry);
      if (
        scrapedRow.bhashyam_devanagari &&
        liveBhSk &&
        sanskritTextsMatch(scrapedRow.bhashyam_devanagari, liveBhSk) &&
        bhashyamOt.length > 0
      ) {
        const { merged, addedLangs } = mergeMissingOtFromBackup(
          live.BhashyamEntry,
          backupEntryFromOt(bhashyamOt),
        );
        if (addedLangs.length > 0) {
          planBhashyam += addedLangs.length;
          plans.push({
            kind: "bhashyam",
            field: "BhashyamEntry",
            added: addedLangs,
            apply: async () => putManthraField(ref.documentId, "BhashyamEntry", merged),
          });
        }
      } else if (scrapedRow.bhashyam_devanagari && liveBhSk && bhashyamOt.length > 0) {
        console.log(`  ${label} bhashyam: SK mismatch — skip bhashyam OT`);
      }

      const teekasOut = [...(live.Teekas ?? [])];
      const teekaAdds: { kind: string; added: string[] }[] = [];
      for (const cfg of TEEKA_AUTHORS) {
        const scrapedTeeka = scrapedRow.teeka_by_author.get(cfg.scraped);
        if (!scrapedTeeka?.devanagari) continue;
        const idx = teekasOut.findIndex((t) =>
          cfg.strapiNameMatch.test(t.teeka?.TeekaName || t.TeekaName || ""),
        );
        if (idx < 0) {
          console.log(`  ${label} teeka ${cfg.scraped}: not linked in Strapi`);
          continue;
        }
        const liveTeekaSk = blocksToText(teekasOut[idx].TeekaEntry?.SanskritTextEntry);
        if (!sanskritTextsMatch(scrapedTeeka.devanagari, liveTeekaSk)) {
          console.log(`  ${label} teeka ${cfg.scraped}: SK mismatch — skip teeka OT`);
          continue;
        }
        const teekaOt = scrapedRowsToOt(scrapedTeeka.translations);
        const { merged, addedLangs } = mergeMissingOtFromBackup(
          teekasOut[idx].TeekaEntry,
          backupEntryFromOt(teekaOt),
        );
        if (addedLangs.length > 0) {
          planTeeka += addedLangs.length;
          teekasOut[idx] = { ...teekasOut[idx], TeekaEntry: merged };
          teekaAdds.push({ kind: `teeka:${cfg.scraped}`, added: addedLangs });
        }
      }
      if (teekaAdds.length > 0) {
        const allAdded = teekaAdds.flatMap((t) => t.added);
        plans.push({
          kind: teekaAdds.map((t) => t.kind).join("+"),
          added: allAdded,
          apply: async () => putTeekas(ref.documentId, teekasOut),
        });
      }

      if (plans.length === 0) {
        const skHave = filledLangs(live.ShlokaManthraEntry).size;
        console.log(
          `  ${label}: matched SK — no missing OT (shloka has ${skHave} other langs already)`,
        );
        continue;
      }

      for (const p of plans) {
        console.log(`[plan] ${label} ${p.kind}: add ${p.added.join(", ")}`);
        if (execute) {
          await p.apply();
          applied++;
        }
      }
    }

    console.log(`\n--- Summary ---`);
    console.log(`Live mantras scanned: ${liveList.length}`);
    console.log(`Sanskrit-matched: ${matched}`);
    console.log(`Skipped (no scrape row): ${skippedNoScrape}`);
    console.log(`Skipped (shloka SK mismatch): ${skippedSkMismatch}`);
    console.log(`Planned OT rows — shloka: ${planShloka}, bhashyam: ${planBhashyam}, teeka: ${planTeeka}`);
    if (!execute) {
      console.log(`Re-run with --execute to write to Strapi.`);
    } else {
      console.log(`Applied ${applied} field/teeka updates.`);
    }
    console.log(
      `\nStrapi OtherTranslations enum has ${translationLanguages.length - 2} languages (excl. Sanskrit/English).`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
