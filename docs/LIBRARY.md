# Ekatmadham Library — General Guide and Checklists

A plain-language overview of the library, this portal, and what to do day to day. Use the checklists as you work. For APIs and architecture, see [DATA-FEEDER-CMS.md](./DATA-FEEDER-CMS.md).

---

## What the library is

The **Ekatmadham Library** is a digital collection of Sanskrit sacred texts (granthas), their divisions (adhyaya, khanda, valli, and similar), verses (mantras / shlokas), commentaries (bhashyam and teekas), and related articles about teachers and the tradition.

There are two surfaces:

| Surface | URL | Who uses it |
|---------|-----|-------------|
| **Public library** | [dev.ekatmdhamlibrary.xoidlabs.com](https://dev.ekatmdhamlibrary.xoidlabs.com) | Readers |
| **Data Feeder CMS** (this app) | [admincms.xoidlabs.com](https://admincms.xoidlabs.com) | Editors and admins |

You do **not** type verses into the public site. You enter them here as a **draft**, then **publish**. Published content appears in Strapi and then on the public library.

```
Draft in this portal  →  Save  →  Save & Publish  →  Strapi CMS  →  public library
```

---

## What you can manage here

| Area | In the sidebar | What it is |
|------|----------------|------------|
| Granthas | `/granthas` | Full sacred texts: name, structure, verses, translations |
| Sections | `/sections` | Chapter-style divisions (adhyaya, khanda, …) |
| Manthras | `/manthras` | Verses across texts |
| Teekas | `/teekas` | Commentary works linked to a grantha |
| Articles | `/articles` | Blog / library articles (SEO required) |
| Authors | `/authors` | Article authors |
| Acharyas | `/acharyas` | Guru-parampara profiles |
| Categories | `/categories` | Article categories |
| About | `/about` | About-the-library page for the public site |
| Global | `/global` | Site name, favicon, default SEO |

Admins also see **Snapshots**, **User Management**, and **Shared Lists** (structure labels, teeka authors, and similar).

---

## Roles

- **Editor** — create drafts, edit content, publish, view backups.
- **Admin** — everything an editor can do, plus users, shared lists, grantha locks, and restore from snapshots.

New accounts from the Register tab start as **editor**.

---

## How a grantha is organized

A grantha is a tree. You pick the **names** of each level in Book Structure; the tree is always:

1. **Top-level division** (often Adhyaya, sometimes Parichchedha, Mundaka, …)
2. **Optional sub-section** (Khanda, Vishaya, …)
3. **Optional third level** (Pada, …)
4. **Leaf entries** (Mantra, Shloka, Vyakhyaya, …)

Example: *Parichchedha → Vishaya → Vyakhyaya* is the same kind of tree as *Adhyaya → Khanda → Mantra*; only the labels change.

Each leaf can hold Sanskrit, IAST, English, other-language translations, bhashyam, teekas, and word meanings.

---

## Checklists

Tick these as you go. Copy a list into an issue or note if you are tracking a specific text.

### A. First-time setup (once per person)

- [ ] Open the CMS and **Register** or **Login**
- [ ] Confirm you can see **Dashboard** and **Granthas**
- [ ] Know whether you are an **editor** or **admin**
- [ ] Bookmark the **public library** so you can check published pages
- [ ] (Admins) Confirm Strapi, database, and session env are set on the server
- [ ] (Admins / translators) If using Gemini: Hermex install + login — see [HERMEX.md](./HERMEX.md)

### B. New grantha (from empty)

- [ ] **Configuration** — Grantha name (required), type, bhashyam metadata, intro, video IDs if any
- [ ] **Book Structure** — pick top-level name, sub-sections on/off, leaf name (Mantra / Shloka / …)
- [ ] **Next: Build Content** — first chapter should get a title (e.g. Prathama Adhyaya)
- [ ] Add remaining chapters / sub-sections
- [ ] Add verses (or import CSV if you have a file)
- [ ] Fill Sanskrit + English at least for the verses you intend to publish
- [ ] Add teeka definitions if this text has commentaries
- [ ] **Save** (portal draft only)
- [ ] Spot-check verse order and labels
- [ ] **Save & Publish** and wait until the job finishes
- [ ] Open the public library (or Strapi) and confirm the tree and first verses

### C. Edit an existing published grantha

- [ ] Open the grantha from **All the Granthas**
- [ ] If it is **locked**, stop — only an admin can unlock
- [ ] Confirm Book Structure labels match what you intend (Adhyaya vs Parichchedha, etc.)
- [ ] Edit verses in the tree; **Save** often
- [ ] For a verse between two existing ones: use **+ between verses**, then Save
- [ ] After Save, confirm order and Sanskrit did **not** jump to the wrong verse
- [ ] **Save & Publish** only when the draft looks right
- [ ] Do not close the tab until publish progress completes (large texts can take minutes)
- [ ] If the connection banner appears, click **Retry now** — work in the tab is kept

### D. Insert or delete verses

- [ ] Use **+ between verses** (not a random new row at the end) when order matters
- [ ] Let labels renumber in the editor; check neighbours (e.g. 1.1.7 / new / 1.1.8)
- [ ] **Save** first and re-open a few verses to confirm bodies stayed with the right rows
- [ ] Then **Save & Publish** (structural change may need a full / fresh publish)
- [ ] After publish, check CMS labels still match the portal list

### E. Translations (including Hermex)

- [ ] Enter English or Sanskrit source in the verse dialog
- [ ] Translate **missing** languages, or all, via Gemini (Hermex)
- [ ] Confirm `LanguageOfTranslation` rows look complete
- [ ] **Save** draft, then **publish** — never publish a half-filled OtherTranslations array by hand
- [ ] For a whole grantha batch, use the Hermex CLI and a checkpoint file — see [HERMEX.md](./HERMEX.md)

### F. Article for the public site

- [ ] Create article: title, description, slug, cover
- [ ] Assign **author** and **category**
- [ ] Fill body blocks
- [ ] Fill **SEO**: meta title, meta description, share image
- [ ] Save draft, then publish
- [ ] Check the article on the public site

### G. Before you publish (every time)

- [ ] Grantha / article **name** is correct
- [ ] No blank **section titles** (Adhyaya #1 has no title will block Next)
- [ ] Verse **labels** unique in each section
- [ ] Sanskrit (or at least English) present on verses you care about
- [ ] You clicked **Save** so the draft matches the screen
- [ ] Grantha is **not locked**
- [ ] You are ready to wait — large granthas publish in the background

### H. After publish (spot-check)

- [ ] Publish job status is **done** (not failed)
- [ ] Tree on the public site / Strapi matches the portal
- [ ] A few verses: Sanskrit, English, and one other language
- [ ] Book Structure still shows the labels you chose (if not, recover the portal draft — structure is not stored in Strapi)
- [ ] If verses look swapped, **do not** publish again until you recover or fix the draft

### I. Admin: keep the library healthy

- [ ] Take a **snapshot** before risky bulk edits or restores (`/admin/backups`)
- [ ] **Lock** a grantha once it is finalized
- [ ] Add custom structure names in **Shared Lists** (Parichchedha, Vishaya, …) if editors need them
- [ ] Review **users** (role, password reset)
- [ ] After data incidents, restore from snapshot — do not hand-edit Strapi arrays
- [ ] Watch orphan mantras on a grantha if verses vanished from the tree

### J. If something looks wrong

- [ ] **Save failed** — copy the error; retry once; do not publish
- [ ] **Publish blocked** — fix duplicate labels or empty titles shown in the toast
- [ ] **504 / timeout** — wait; poll publish status; the job may still be running
- [ ] **Wrong structure after publish** — recover draft snapshot; do not republish with default Adhyaya/Khanda/Mantra
- [ ] **Wrong verse text after insert** — compare draft vs Strapi; restore mantra from backup if needed
- [ ] **Hermex / Chrome stuck** — stop the Python process and clear Chrome profile locks (see [DATA-FEEDER-CMS.md](./DATA-FEEDER-CMS.md) troubleshooting)

---

## Suggested weekly rhythm

1. Finish in-progress **drafts** on Dashboard (amber draft badges).
2. Publish only texts that passed checklist **G**.
3. Spot-check published pages (checklist **H**).
4. Admins: snapshot if you did large structural work.

---

## Related docs

| Document | When to open it |
|----------|-----------------|
| [GO-LIVE-BACKLOG.md](./GO-LIVE-BACKLOG.md) | Single backlog for going live |
| [DATA-FEEDER-CMS.md](./DATA-FEEDER-CMS.md) | Full app + REST API |
| [PROJECT_OVERVIEW.md](./PROJECT_OVERVIEW.md) | Developer setup |
| [HERMEX.md](./HERMEX.md) | Gemini translations |
| [orphan-manthras-investigation.md](./orphan-manthras-investigation.md) | Verses missing from the tree |
