# Go-live backlog

**One list** for taking the Ekatmadham Library (CMS + public site) live. Tick items as they ship. Owner can be filled in later.

**Target:** public readers can use the library without draft/publish bugs, missing structure, or empty verses.

Related: [LIBRARY.md](./LIBRARY.md) (day-to-day), [DATA-FEEDER-CMS.md](./DATA-FEEDER-CMS.md) (tech).

---

## Status

| | |
|--|--|
| Environment | Staging: `dev.ekatmdhamlibrary.xoidlabs.com` · CMS: `admincms.xoidlabs.com` |
| Go-live date | _TBD_ |
| Blocker count | Open P0 items below |

---

## P0 — must fix before go-live

These are known or reported issues that can corrupt published texts.

- [ ] **Book structure resets after publish** — custom labels (e.g. Parichchedha → Vishaya → Vyakhyaya) fall back to Adhyaya → Khanda → Mantra when reopening a published grantha. Persist `structureConfig` (published draft fallback and/or Strapi field) so editors never republish with defaults.
- [ ] **Insert-between then Save / Save & Publish shows wrong content** — verse order, numbers, or Sanskrit jump. Verify the save-path fix on a real grantha; if still wrong after publish, fix CMS label/content merge (not only draft save).
- [ ] **“Adhyaya #1 has no title” on Next** — Adhyaya + Shloka (flat) must reach Build Content without a blocking error. Confirm the title-fill / seed-first-chapter fix on a new grantha.
- [ ] **Do not republish a book whose Structure UI is wrong** — until structure persistence ships, document and train: recover draft / set labels, then save, then publish.
- [ ] **Publish job reliability** — no duplicate running jobs; refresh resumes `jobId`; 504 does not start a second full publish. See [p0-acceptance-checklist.md](../tests/p0-acceptance-checklist.md).
- [ ] **OtherTranslations / Teekas never wiped** — publish always merges; spot-check a 43-language verse after a small edit.
- [ ] **Orphan / blank mantras** — scan live Strapi (`audit:grantha-mantras` / orphan cleanup); no “No number” rows on go-live granthas.
- [ ] **Grantha locks** — lock texts that are already finalized so nobody overwrites them during launch.

---

## P1 — should have for launch

- [ ] **Shared Lists** — add all custom structure names used in production (Parichchedha, Vishaya, Vyakhyaya, …).
- [ ] **Editor training** — Save vs Save & Publish; + between verses; never publish until the tree matches the screen.
- [ ] **Snapshot before launch** — full Strapi backup + confirm restore path once.
- [ ] **About + Global** — public About page and site name / default SEO filled.
- [ ] **At least one gold grantha** — one complete text (structure, verses, English, spot-check other langs) verified on the public site.
- [ ] **Articles SEO** — any launch articles have meta title, description, share image.
- [ ] **Users** — production editor accounts; no leftover test users; admins known.
- [ ] **SESSION_SECRET / STRAPI_API_TOKEN** — stable in production; not rotated on every deploy.
- [ ] **Public site vs CMS** — grantha names, covers, intro video, first verse render correctly on the reader site.
- [ ] **Hermex** — either disabled in prod or documented as optional (Chrome/WAF); do not block launch on full 43-lang coverage.

---

## P2 — after go-live (nice)

- [ ] Persist structure labels on Strapi grantha so reload never depends on draft status.
- [ ] Infer structure names from section titles (full vocabulary, not only Khanda/Pada).
- [ ] Publish progress UX that survives tab close without confusion.
- [ ] Periodic orphan-mantra scan in ops calendar.
- [ ] Acharya profiles complete and linked to texts.
- [ ] CSV import documented for remaining granthas.

---

## Content backlog (what must exist on the public site)

Fill names as you commit texts. Tick when published **and** checked on the public URL.

- [ ] _Grantha 1:_ __________________ (structure + verses + English)
- [ ] _Grantha 2:_ __________________
- [ ] _Grantha 3:_ __________________
- [ ] About the library
- [ ] Global SEO / favicon / site name
- [ ] Launch article(s) (if any)

---

## Launch-day checklist (single pass)

- [ ] CMS and public site up; login works
- [ ] Snapshot taken
- [ ] P0 items all ticked or explicitly waived
- [ ] Gold grantha opens on public site
- [ ] Insert-between + save + publish smoke test on a **copy / non-gold** text (or locked gold texts not used)
- [ ] New grantha Adhyaya + Shloka → Next works
- [ ] Reopen published custom-structure book → Structure labels still correct
- [ ] Announce go-live

---

## Waivers

If something ships incomplete, record it here so it is not forgotten.

| Item | Why waived | Follow-up date |
|------|------------|----------------|
| | | |
