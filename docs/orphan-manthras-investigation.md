# “No number” mantras — investigation and fix

## What users saw

In the **Mantras** tab, some rows showed **No number** instead of `Shloka 1.1`, etc. They often shared:

- Empty `ShlokaManthraNumber` in Strapi
- Low `order` values (2000, 3000, …) from fractional sort keys
- Same section as real verses (usually **Prathama Adhyaya**)
- No Sanskrit body

## Affected granthas (cleaned 2026-06)

| Grantha | Orphan rows removed |
|---------|---------------------|
| Hastamalakiyam | 13 |
| शतश्लोकी - Śataślokī | 2 |
| Ishavasya upanishad | 36 |

Scan: `DRY_RUN=1 npx tsx script/scan-and-cleanup-all-orphan-manthras.ts`  
Delete: `DRY_RUN=0 npx tsx script/scan-and-cleanup-all-orphan-manthras.ts`

## How they were created (root cause)

Strapi allows `POST /api/manthras` with **blank** `ShlokaManthraNumber`. The portal had several paths that did that **before** the editor assigned verse titles:

1. **CMS slot sync** (`sync-mantra-slots` / `syncPendingMantraSlotsFromDraft`)  
   After **+ insert** in the Grantha editor, portal-only rows (`_isNewLocal`) were flushed to Strapi during **Save & Publish** prep. If the row had no `title` yet, the server still POSTed `{ ShlokaManthraNumber: "" }`.

2. **`POST /api/strapi/manthras/create-blank-in-section`**  
   Client `syncAllPendingNewMantrasToStrapi` called this for the first verse in a section without a label.

3. **`POST /api/strapi/manthras/insert-between`**  
   Same issue when `ShlokaManthraNumber` was omitted or empty (Mantras page “insert between” or slot sync).

4. **Retries / batch limits**  
   `MAX_SLOT_CREATES_PER_REQUEST = 15` could leave many pending rows; repeated sync attempts created **multiple** empty rows per section.

5. **Publish identity-only path** (minor)  
   `createOrUpdateManthra` could fall through to POST with empty `ShlokaManthraNumber` when label resolution failed.

**Not** caused by: correct publish of labeled verses, or intentional user content.

## Fixes applied

| Layer | Change |
|-------|--------|
| `shared/mantra-cms-guard.ts` | Single validation: no CMS create without label |
| `server/grantha-mantra-slot-sync.ts` | Refuse blank labels; reuse one existing blank row via PUT |
| `server/strapi.ts` | `insert-between` + `create-blank-in-section` return **400** if label blank |
| `server/routes.ts` | `createOrUpdateManthra` refuses POST without label |
| `client/grantha-strapi-mantra-sync.ts` | Skip slot sync when label empty |
| `server/grantha-orphan-manthras.ts` + routes | List/cleanup API + Mantras UI banner |
| `script/scan-and-cleanup-all-orphan-manthras.ts` | Global audit and delete |

## Prevention going forward

- Do **not** run full CMS slot sync on every Save; only on explicit publish prep (already draft-first).
- After **+ insert**, renumber in portal first; labels must exist before CMS slot create.
- Periodically: `DRY_RUN=1 npx tsx script/scan-and-cleanup-all-orphan-manthras.ts`

## Related: `Vaakhyaa 1.1.3` vs `Mantra 1.1.3` publish error

After deleting blank rows, portal drafts can keep a **stale `strapiDocumentId`** (wrong verse). Publish used that id while the section still had `Mantra 1.1.3`, triggering `duplicate_suffix_in_section`.

**Fix:** `resolveManthraDocIdForPublish` now requires the stored row’s verse **suffix** to match the portal title; otherwise it adopts the existing suffix row (leaf relabel `Mantra` → `Vaakhyaa`). Teeka authors are synced on publish via PUT when reusing existing teeka records.

## If orphans reappear

1. Filter grantha in **Mantras** → use **Remove orphan row(s)** banner.  
2. Or: `POST /api/granthas/:docId/cleanup-orphan-manthras` with `{ dryRun: false }`.  
3. Check server logs for `[sync-mantra-slots] Refusing` or `blank_mantra_label` — means the guard blocked a bad create.
