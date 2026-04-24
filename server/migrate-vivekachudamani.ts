/**
 * One-time migration: split combined Vivekachudamani manthras into individual per-verse entries.
 *
 * POST /api/strapi/migrate/split-vivekachudamani
 *
 * Algorithm per section:
 *  1. Fetch every manthra with full ShlokaManthraEntry content.
 *  2. Extract individual verses from each field (Sanskrit, IAST, English) keyed by verse NUMBER
 *     so that Sanskrit ॥5॥ and English ||5|| land in the same final entry even when they come
 *     from different source manthras.
 *  3. Build a global per-section verse map: verseNumber → { skt?, iast?, eng? }.
 *  4. Delete all original combined manthras from Strapi.
 *  5. POST one new manthra per verse number (ordered sequentially), preserving the section link.
 *
 * Endpoint is idempotent w.r.t. already-single-verse entries (they yield exactly 1 verse from
 * the map and are simply recreated with the correct order and title).
 */

import { Router } from "express";
import { requireAuth } from "./auth";
import { strapiRequest } from "./strapi";

const devaToArabic = (s: string): number =>
  parseInt(s.replace(/[\u0966-\u096F]/g, (c) => String(c.charCodeAt(0) - 0x0966)), 10);

type Block = Record<string, any>;
type VerseMap = Map<number, Block[]>;

/**
 * Split a Strapi blocks array into individual verses keyed by their verse-end marker number.
 * Verses without a marker (trailing content) are ignored.
 */
function extractVerses(blocks: Block[] | null | undefined): VerseMap {
  const m: VerseMap = new Map();
  if (!Array.isArray(blocks) || blocks.length === 0) return m;

  let current: Block[] = [];
  for (const block of blocks) {
    const txt = (block.children || []).map((c: any) => c.text || "").join("");
    if (txt.trim() === "" && current.length === 0) continue; // skip leading blanks
    current.push(block);

    // Devanagari marker: ॥ N ॥
    const deva = txt.match(/॥\s*([\d\u0966-\u096F]+)\s*॥/);
    if (deva) {
      m.set(devaToArabic(deva[1]), current);
      current = [];
      continue;
    }
    // ASCII marker: || N ||
    const ascii = txt.match(/\|\|\s*(\d+)\s*\|\|/);
    if (ascii) {
      m.set(parseInt(ascii[1], 10), current);
      current = [];
    }
  }
  // trailing content without a marker — discard (can't assign to a verse number)
  return m;
}

export function createMigrateRouter() {
  const router = Router();
  router.use(requireAuth);

  router.post("/split-vivekachudamani", async (_req, res) => {
    const log: string[] = [];
    const warn: string[] = [];

    try {
      // ── 1. Find the grantha ──────────────────────────────────────────────────
      const gResp = await strapiRequest(
        "/api/granthas?filters[GranthaName][$containsi]=vivekachudamani" +
          "&fields[0]=documentId&fields[1]=GranthaName&pagination[pageSize]=5",
      );
      const g = gResp.data?.[0];
      if (!g) {
        res.status(404).json({ ok: false, error: "Vivekachudamani grantha not found in Strapi", log, warn });
        return;
      }
      const granthaDocId: string = g.documentId;
      log.push(`Grantha: ${g.GranthaName} (${granthaDocId})`);

      // ── 2. Fetch all manthras with full content ──────────────────────────────
      const POPULATE = [
        `filters[Section][grantha][documentId][$eq]=${granthaDocId}`,
        "populate[Section][fields][0]=documentId",
        "populate[Section][fields][1]=title",
        "populate[Section][fields][2]=order",
        "populate[Section][populate][parent][fields][0]=documentId",
        "populate[Section][populate][parent][fields][1]=title",
        "populate[Section][populate][parent][fields][2]=order",
        "populate[ShlokaManthraEntry][populate]=*",
        "fields[0]=documentId",
        "fields[1]=ShlokaManthraNumber",
        "fields[2]=order",
        "pagination[pageSize]=100",
      ].join("&");

      let allManthras: any[] = [];
      let page = 1;
      while (true) {
        const r = await strapiRequest(`/api/manthras?${POPULATE}&pagination[page]=${page}`);
        allManthras.push(...(r.data || []));
        if (page >= (r.meta?.pagination?.pageCount ?? 1)) break;
        page++;
      }
      log.push(`Fetched ${allManthras.length} manthras total`);

      // ── 3. Group by section ──────────────────────────────────────────────────
      const bySec = new Map<string, { section: any; manthras: any[] }>();
      for (const m of allManthras) {
        const sec = m.Section;
        if (!sec?.documentId) { warn.push(`Manthra ${m.documentId} has no Section`); continue; }
        if (!bySec.has(sec.documentId)) bySec.set(sec.documentId, { section: sec, manthras: [] });
        bySec.get(sec.documentId)!.manthras.push(m);
      }
      log.push(`Sections to process: ${bySec.size}`);

      // ── 4. Process each section ──────────────────────────────────────────────
      for (const [secDocId, { section, manthras }] of bySec) {
        manthras.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

        // Merge all verse content across every manthra in this section
        const verseData = new Map<number, { skt?: Block[]; iast?: Block[]; eng?: Block[] }>();
        for (const m of manthras) {
          const entry = m.ShlokaManthraEntry;
          if (!entry) continue;
          for (const [n, blocks] of extractVerses(entry.SanskritTextEntry)) {
            if (!verseData.has(n)) verseData.set(n, {});
            verseData.get(n)!.skt = blocks;
          }
          for (const [n, blocks] of extractVerses(entry.IASTTransliteration)) {
            if (!verseData.has(n)) verseData.set(n, {});
            verseData.get(n)!.iast = blocks;
          }
          for (const [n, blocks] of extractVerses(entry.EnglishTranslationText)) {
            if (!verseData.has(n)) verseData.set(n, {});
            verseData.get(n)!.eng = blocks;
          }
        }

        const sortedNums = [...verseData.keys()].sort((a, b) => a - b);
        if (sortedNums.length === 0) {
          warn.push(`Section ${section.title} (${secDocId}): no verse markers found, skipping`);
          continue;
        }

        // Determine title prefix and section number string from first manthra
        const firstTitle: string = manthras[0]?.ShlokaManthraNumber ?? "";
        const pfxMatch = firstTitle.match(/^(.+?)\s+([\d.]+)\.\d+$/);
        const titlePfx = pfxMatch?.[1] ?? "Shloka";
        const secNums = pfxMatch?.[2] ?? (() => {
          // Reconstruct from section + parent order
          const kOrder = section.order ?? 1;
          const adhOrder = section.parent?.order ?? 1;
          return `${adhOrder}.${kOrder}`;
        })();

        log.push(`Section "${section.title}" (${secDocId}): ${manthras.length} manthras → ${sortedNums.length} verses`);

        // Delete originals
        for (const m of manthras) {
          try {
            await strapiRequest(`/api/manthras/${m.documentId}`, { method: "DELETE" });
          } catch (e: any) {
            warn.push(`Could not delete ${m.documentId}: ${e.message}`);
          }
        }

        // Create one entry per verse
        for (let i = 0; i < sortedNums.length; i++) {
          const verseNum = sortedNums[i];
          const vd = verseData.get(verseNum)!;
          const order = i + 1;
          const title = `${titlePfx} ${secNums}.${order}`;

          const payload = {
            data: {
              ShlokaManthraNumber: title,
              order,
              Section: secDocId,
              ShlokaManthraEntry: {
                SanskritTextEntry: vd.skt ?? null,
                IASTTransliteration: vd.iast ?? null,
                EnglishTranslationText: vd.eng ?? null,
              },
            },
          };

          try {
            const created = await strapiRequest("/api/manthras", {
              method: "POST",
              body: JSON.stringify(payload),
            });
            log.push(`  Created "${title}" (verse ${verseNum}) → ${created.data?.documentId}`);
          } catch (e: any) {
            warn.push(`  Failed to create "${title}": ${e.message}`);
          }
        }
      }

      res.json({ ok: true, log, warn });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message, log, warn });
    }
  });

  return router;
}
