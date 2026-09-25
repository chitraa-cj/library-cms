/**
 * Acharyas (guru-parampara) — portal-only feature backed entirely by local
 * Postgres. No Strapi content-type change is required.
 *
 *  - Biographies + works live in the `acharya_profiles` table, seeded from
 *    shared/data/acharya-profiles.seed.json (scraped from advaitadhara).
 *  - "Texts under an acharya" come from two places, merged at read time:
 *    granthas picked by hand in the portal (`linkedGranthaDocIds`), and the ones
 *    derived by matching each acharya's `aliases` against a Grantha's
 *    BhashyamAuthor / a Teeka's TeekaAuthor in Strapi — so an acharya typed in
 *    today can be given their texts explicitly, while the existing author-name
 *    links keep working for everything already in the CMS.
 */
import { Router } from "express";
import { readFileSync } from "fs";
import { join } from "path";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { requireAuth, requireAdmin } from "./auth";
import { strapiRequest, absolutizeMediaUrl } from "./strapi";
import {
  acharyaProfiles,
  createAcharyaSchema,
  updateAcharyaSchema,
  type AcharyaGranthaOption,
  type AcharyaProfile,
  type AcharyaLinkedText,
  type InsertAcharyaProfile,
  type User,
} from "@shared/schema";

// Anchor to the repo root via process.cwd(), which is correct under both
// `tsx server/index.ts` (dev) and pm2 `node dist/index.cjs` (prod).
// Deriving the path from the ESM module URL is undefined in the bundled
// CJS output and crashed cms-library at startup.
const SEED_PATH = join(process.cwd(), "shared", "data", "acharya-profiles.seed.json");

// ---------------------------------------------------------------- normalization
/** Collapse a name to a comparison key: strip diacritics, honorifics, punctuation. */
function normName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining marks (IAST diacritics)
    .toLowerCase()
    .replace(/\b(sri|shri|sree|acharya|bhagavatpada|swami)\b/g, "")
    .replace(/[^a-z0-9ऀ-ॿ]+/g, "");
}

/** URL key for a hand-typed acharya: ASCII-ish, lowercase, hyphenated. */
function slugifyName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Devanagari-only names leave nothing usable behind — fall back to a stable stub.
  return base || `acharya-${Date.now().toString(36)}`;
}

/** First free slug of the form `base`, `base-2`, `base-3`… */
async function uniqueSlug(base: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const [taken] = await db
      .select({ id: acharyaProfiles.id })
      .from(acharyaProfiles)
      .where(eq(acharyaProfiles.slug, candidate));
    if (!taken) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

// --------------------------------------------------------------------- storage
export async function listAcharyas(): Promise<AcharyaProfile[]> {
  return db
    .select()
    .from(acharyaProfiles)
    .orderBy(acharyaProfiles.lineageOrder, acharyaProfiles.id);
}

export async function getAcharyaBySlug(slug: string): Promise<AcharyaProfile | undefined> {
  const [row] = await db.select().from(acharyaProfiles).where(eq(acharyaProfiles.slug, slug));
  return row;
}

/** Upsert one acharya keyed by slug. Preserves editor changes to avatar. */
async function upsertAcharya(rec: InsertAcharyaProfile): Promise<void> {
  await db
    .insert(acharyaProfiles)
    .values(rec)
    .onConflictDoUpdate({
      target: acharyaProfiles.slug,
      set: {
        sourceRef: rec.sourceRef,
        sourceUrl: rec.sourceUrl,
        nameDevanagari: rec.nameDevanagari,
        nameIast: rec.nameIast,
        aliases: rec.aliases,
        dates: rec.dates,
        lineageOrder: rec.lineageOrder,
        guruDevanagari: rec.guruDevanagari,
        category: rec.category,
        biography: rec.biography,
        worksList: rec.worksList,
        bioStatus: rec.bioStatus,
        updatedAt: new Date(),
        // NOTE: nameDisplay + avatarUrl are intentionally NOT overwritten so
        // portal edits survive a re-seed.
      },
    });
}

type SeedFile = {
  acharyas: Array<{
    slug: string;
    sourceRef: string | null;
    sourceUrl: string | null;
    nameDevanagari: string;
    nameIast: string;
    nameDisplay: string;
    aliases: string[];
    dates: string | null;
    lineageOrder: number;
    guruDevanagari: string | null;
    category: string | null;
    biography: AcharyaProfile["biography"];
    worksList: AcharyaProfile["worksList"];
    bioStatus: AcharyaProfile["bioStatus"];
  }>;
};

/** Load the seed file and upsert every acharya. Returns the count. */
export async function seedAcharyas(): Promise<number> {
  const seed = JSON.parse(readFileSync(SEED_PATH, "utf-8")) as SeedFile;
  for (const a of seed.acharyas) {
    await upsertAcharya({
      slug: a.slug,
      sourceRef: a.sourceRef ?? null,
      sourceUrl: a.sourceUrl ?? null,
      nameDevanagari: a.nameDevanagari,
      nameIast: a.nameIast ?? null,
      nameDisplay: a.nameDisplay ?? a.nameIast ?? a.nameDevanagari,
      aliases: a.aliases ?? [],
      dates: a.dates ?? null,
      lineageOrder: a.lineageOrder ?? 0,
      guruDevanagari: a.guruDevanagari ?? null,
      category: a.category ?? null,
      biography: a.biography ?? [],
      worksList: a.worksList ?? [],
      bioStatus: a.bioStatus ?? "empty",
    });
  }
  return seed.acharyas.length;
}

/** Seed only if the table is empty (called on boot). */
export async function seedAcharyasIfEmpty(): Promise<void> {
  const [row] = await db.select({ id: acharyaProfiles.id }).from(acharyaProfiles).limit(1);
  if (row) return;
  try {
    const n = await seedAcharyas();
    console.log(`[acharyas] seeded ${n} profiles from ${SEED_PATH}`);
  } catch (err: any) {
    console.error("[acharyas] seed failed:", err?.message ?? err);
  }
}

// ----------------------------------------------------- derive linked Strapi texts
async function fetchAllPages(basePath: string): Promise<any[]> {
  const first = await strapiRequest(`${basePath}&pagination[page]=1`);
  const out: any[] = [...(first?.data ?? [])];
  const pageCount: number = first?.meta?.pagination?.pageCount ?? 1;
  for (let p = 2; p <= pageCount; p++) {
    const page = await strapiRequest(`${basePath}&pagination[page]=${p}`);
    out.push(...(page?.data ?? []));
  }
  return out;
}

/** Cache the (author -> texts) index briefly to avoid hammering Strapi. */
let textIndexCache: { at: number; granthas: any[]; teekas: any[] } | null = null;
const TEXT_INDEX_TTL_MS = 60_000;

async function getTextIndex(): Promise<{ granthas: any[]; teekas: any[] }> {
  if (textIndexCache && Date.now() - textIndexCache.at < TEXT_INDEX_TTL_MS) {
    return textIndexCache;
  }
  const [granthas, teekas] = await Promise.all([
    fetchAllPages(
      "/api/granthas?fields[0]=GranthaName&fields[1]=GranthaType&fields[2]=BhashyamAuthor&fields[3]=slug" +
        "&populate[coverImage][fields][0]=url&pagination[pageSize]=100&sort=GranthaName:asc",
    ),
    fetchAllPages(
      "/api/teekas?fields[0]=TeekaName&fields[1]=TeekaAuthor&pagination[pageSize]=100&sort=TeekaName:asc",
    ),
  ]);
  textIndexCache = { at: Date.now(), granthas, teekas };
  return textIndexCache;
}

export function invalidateAcharyaTextIndex(): void {
  textIndexCache = null;
}

/** Every grantha in the CMS, as the portal's "granthas under this acharya" picker
 *  shows them. Served from the same cached index the author matching uses. */
export async function listGranthaOptions(): Promise<AcharyaGranthaOption[]> {
  const index = await getTextIndex();
  return index.granthas.map((g: any) => ({
    documentId: g.documentId,
    name: g.GranthaName ?? "(untitled)",
    granthaType: g.GranthaType ?? null,
    bhashyamAuthor: g.BhashyamAuthor ?? null,
  }));
}

/**
 * Return the Granthas + Teekas under an acharya: the granthas picked by hand in the
 * portal first (in the order they were picked), then everything matched by author
 * name that isn't already there.
 */
export async function linkedTextsFor(
  acharya: AcharyaProfile,
): Promise<{ granthas: AcharyaLinkedText[]; teekas: AcharyaLinkedText[] }> {
  const keys = new Set(
    [acharya.nameDevanagari, acharya.nameIast ?? "", ...(acharya.aliases ?? [])]
      .map(normName)
      .filter(Boolean),
  );
  const manualDocIds = acharya.linkedGranthaDocIds ?? [];
  if (keys.size === 0 && manualDocIds.length === 0) return { granthas: [], teekas: [] };

  let index: { granthas: any[]; teekas: any[] };
  try {
    index = await getTextIndex();
  } catch {
    return { granthas: [], teekas: [] };
  }

  const granthaByDocId = new Map<string, any>(
    index.granthas.map((g: any) => [g.documentId, g]),
  );
  const toLinkedGrantha = (g: any, linkedBy: "manual" | "author"): AcharyaLinkedText => ({
    documentId: g.documentId,
    name: g.GranthaName,
    kind: "grantha",
    granthaType: g.GranthaType ?? null,
    slug: g.slug ?? null,
    coverImageUrl: absolutizeMediaUrl(g?.coverImage?.url) ?? null,
    linkedBy,
  });

  const granthas: AcharyaLinkedText[] = [];
  const seen = new Set<string>();
  for (const docId of manualDocIds) {
    const g = granthaByDocId.get(docId);
    // A grantha deleted in Strapi since it was picked simply drops out of the list.
    if (!g || seen.has(docId)) continue;
    seen.add(docId);
    granthas.push(toLinkedGrantha(g, "manual"));
  }
  for (const g of index.granthas) {
    if (seen.has(g.documentId)) continue;
    const author = g?.BhashyamAuthor;
    if (author && keys.has(normName(String(author)))) {
      seen.add(g.documentId);
      granthas.push(toLinkedGrantha(g, "author"));
    }
  }

  const teekas: AcharyaLinkedText[] = [];
  for (const t of index.teekas) {
    const author = t?.TeekaAuthor;
    if (author && keys.has(normName(String(author)))) {
      teekas.push({
        documentId: t.documentId,
        name: t.TeekaName,
        kind: "teeka",
        linkedBy: "author",
      });
    }
  }
  return { granthas, teekas };
}

// ----------------------------------------------------------------------- router
export function createAcharyaRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  // List all acharyas (lightweight — no linked texts).
  router.get("/", async (_req, res) => {
    try {
      res.json({ data: await listAcharyas() });
    } catch (error: any) {
      res.status(500).json({ message: error?.message || "Failed to load acharyas" });
    }
  });

  // Granthas offered in the "granthas under this acharya" picker. Registered before
  // "/:slug" so it isn't swallowed as a slug.
  router.get("/granthas", async (_req, res) => {
    try {
      res.json({ data: await listGranthaOptions() });
    } catch (error: any) {
      res.status(500).json({ message: error?.message || "Failed to load granthas" });
    }
  });

  // Add an acharya typed into the portal (name, dates, biography, their granthas).
  router.post("/", requireAdmin, async (req, res) => {
    try {
      const parsed = createAcharyaSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid payload", issues: parsed.error.issues });
      }
      const user = req.user as User;
      const input = parsed.data;
      const biography = input.biography ?? [];
      // The typed name is the display name; Devanagari/IAST fall back to it so the
      // profile header and the author matching both have something to work with.
      const [created] = await db
        .insert(acharyaProfiles)
        .values({
          slug: await uniqueSlug(slugifyName(input.nameIast || input.name)),
          nameDevanagari: input.nameDevanagari?.trim() || input.name,
          nameIast: input.nameIast?.trim() || null,
          nameDisplay: input.name,
          aliases: input.aliases ?? [input.name],
          dates: input.dates ?? null,
          avatarUrl: input.avatarUrl ?? null,
          biography,
          linkedGranthaDocIds: input.linkedGranthaDocIds ?? [],
          bioStatus: biography.some((section) => section.paragraphs.length > 0)
            ? "custom"
            : "empty",
          updatedBy: user.id,
        })
        .returning();
      invalidateAcharyaTextIndex();
      res.status(201).json(created);
    } catch (error: any) {
      res.status(500).json({ message: error?.message || "Failed to create acharya" });
    }
  });

  // One acharya with their derived Granthas + Teekas.
  router.get("/:slug", async (req, res) => {
    try {
      const acharya = await getAcharyaBySlug(req.params.slug);
      if (!acharya) return res.status(404).json({ message: "Acharya not found" });
      const { granthas, teekas } = await linkedTextsFor(acharya);
      res.json({ ...acharya, granthas, teekas });
    } catch (error: any) {
      res.status(500).json({ message: error?.message || "Failed to load acharya" });
    }
  });

  // Edit an acharya (display name, dates, avatar, aliases, biography).
  router.patch("/:slug", requireAdmin, async (req, res) => {
    try {
      const parsed = updateAcharyaSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid payload", issues: parsed.error.issues });
      }
      const user = req.user as User;
      const patch = parsed.data;
      const set: Record<string, unknown> = { updatedAt: new Date(), updatedBy: user.id };
      if (patch.nameDisplay !== undefined) set.nameDisplay = patch.nameDisplay;
      if (patch.nameDevanagari !== undefined) set.nameDevanagari = patch.nameDevanagari;
      if (patch.nameIast !== undefined) set.nameIast = patch.nameIast;
      if (patch.dates !== undefined) set.dates = patch.dates;
      if (patch.avatarUrl !== undefined) set.avatarUrl = patch.avatarUrl;
      if (patch.aliases !== undefined) set.aliases = patch.aliases;
      if (patch.biography !== undefined) {
        set.biography = patch.biography;
        set.bioStatus = patch.biography.some((section) => section.paragraphs.length > 0)
          ? "custom"
          : "empty";
      }
      if (patch.linkedGranthaDocIds !== undefined) {
        set.linkedGranthaDocIds = patch.linkedGranthaDocIds;
      }
      const [updated] = await db
        .update(acharyaProfiles)
        .set(set)
        .where(eq(acharyaProfiles.slug, req.params.slug))
        .returning();
      if (!updated) return res.status(404).json({ message: "Acharya not found" });
      if (patch.aliases !== undefined) invalidateAcharyaTextIndex();
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: error?.message || "Failed to update acharya" });
    }
  });

  // Re-run the seed (admin). Useful after re-scraping.
  router.post("/seed", requireAdmin, async (_req, res) => {
    try {
      const n = await seedAcharyas();
      res.json({ seeded: n });
    } catch (error: any) {
      res.status(500).json({ message: error?.message || "Failed to seed acharyas" });
    }
  });

  return router;
}
