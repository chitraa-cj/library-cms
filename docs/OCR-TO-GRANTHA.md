# OCR → Grantha (admin-only)

Turn a finished OCR transcription into a grantha: configure the hierarchy once, describe
how the book is laid out, let Claude classify the pages, review the result, then download
a CSV or hand it straight to a grantha through the import dialog the editors already use.

Entry point: **Administration → OCR Docs** → pick a document → **Create Grantha from OCR**.
The button appears as soon as one page range has been transcribed, so a long book can be
structured while its tail is still being read.

## The shape of it

```
OCR job (Gemini, unchanged)                      server/ocr/*
   └─ transcribed pages
        └─ structure job                         cms_structure_jobs
             └─ page-range chunks (in order)     cms_structure_job_chunks
                  └─ ONE Claude request each     server/structure/claude.ts
                       └─ validated StructureItem[]        ← the only stored model output
                            └─ + review edits (overrides)
                                 └─ assembleStructure()    shared/ocr-structure.ts
                                      └─ validate → CSV
                                           ├─ Download CSV
                                           └─ Upload to Grantha
                                                └─ grantha-csv-import-dialog (existing)
                                                     └─ draft Save / Save & Publish (existing)
```

Two properties are worth stating plainly, because everything else follows from them:

**Claude is asked for classification only.** One request per page range returns an ordered
list of passages, each labelled (`section` / `verse` / `bhashyam` / `teeka` / `translation` /
`prose` / `footnote` / `ignored`) and carrying the printed text verbatim. It does not build
the hierarchy, decide which verse a commentary belongs to, renumber anything, or produce
CSV. All of that is deterministic code in `shared/ocr-structure.ts`, which runs identically
on the server, in the review UI and in the tests. A wrong answer can therefore only ever be
a mis-labelled passage that the review shows — never an invented structure.

**Nothing derived is stored.** The chunk rows hold `items`; the job row holds the review's
`overrides`. Sections, verses, open questions, validation and the CSV are recomputed from
those two on every read (`buildStructureResult`). So a correction never needs another Claude
call, and the review, the download and the import can never disagree.

## Hierarchy

The CMS holds three section levels plus the leaf entry, which is what the grantha editor's
structure step already offers (Adhyaya → Khanda → Pada → Mantra, under whatever names a
grantha uses). The wizard asks for a depth of 1–4 and a name per level; `depth` counts the
leaf, so "Kanda → Sarga → Adhyaya → Shloka" is 4 and a text of bare numbered mantras is 1.

The verse number in the generated CSV is the section path plus the entry number —
`1.3.2.17` for Shloka 17 of Adhyaya 2 of Sarga 3 of Kanda 1. That is exactly what
`client/src/lib/grantha-csv-placement.ts` reads to place a row, so no new import contract
exists. A number the page printed as `2.108` keeps one prefix, not two.

## Instructions, typed or dictated

The instruction box takes plain sentences, not rules: which printed markers start each
level, what belongs to what, how to read irregular numbering. Dictation uses the browser's
own speech recognition (Chrome/Edge) and writes into the same box, so the transcription is
reviewed and corrected before it is used; no audio and no new provider credential leaves
the machine. Browsers without it simply show an explanatory toast.

The instructions are sent inside `<editor_instructions>`, the pages inside `<document>`,
and the system prompt says that both are data: text inside them is never an instruction to
the model, whatever it claims. `tests/ocr-structure-claude.test.mjs` asserts that fencing.

## Questions, and when they are asked

A question is raised only where the ambiguity would change the grantha and cannot be
settled from the page:

| Situation | Question |
| --- | --- |
| Commentary before the first numbered entry | its own entry, or front matter? |
| A heading deeper than the configured hierarchy | a level-N heading, ordinary text, or leave it out? |
| An entry with no printed number | number it next in the section, merge into the one above, or leave it out? |

Everything else is decided in code. Each question carries a recommended answer, and every
option is just a shortcut for edits that can also be made by hand in the review — there is
one code path for both (`StructureOverride`), which is why answering a question and editing
a block behave identically.

What is NOT asked: confirmation of a heading, a verse or a section that passes validation.
Low-confidence passages are flagged for review, not queued as questions.

## The review

Source on the right, proposed hierarchy on the left, selecting either highlights the other.
The colouring is the overlay: the OCR engine returns Markdown per page and never
coordinates, so drawing boxes on the scan would mean inventing them. Instead each
classified passage is tinted by its classification, with a legend, uncertain passages in a
warning colour, and passages that will not be imported marked as such.

Per block: change the content type, change the hierarchy level or number, move a block to
another parent (by editing its number), attach or detach commentary, rename a teeka, change
the translation language, edit the text (the transcription is kept and restorable), split at
the cursor, merge up, reorder, exclude, and "apply to N similar" for a repeated layout.
Every edit is marked, so an AI proposal is always distinguishable from a human-approved one.

## Validation

Blocking errors — the conditions that would produce wrong CMS records:

- no entries detected at all;
- two entries sharing one number (the portal would renumber the odd one out onto its
  neighbour, and publish would then have two verses fighting over one CMS row);
- an entry with no number, when the hierarchy needs one to place it.

Warnings the editor can accept: chapter numbers the document skips, passages that are not
part of any entry, entries with no text, low-confidence classifications, page ranges that
were not analysed. The split matches what the CSV dialog already does.

## Export and import

**Download CSV** gives the same bytes the direct upload uses (with a BOM, so a double-click
into Excel keeps Devanagari readable).

**Upload to Grantha** stores a handoff (an id, not the file) and opens the grantha editor on
the destination. The editor then fetches the CSV and a hierarchy-mapping proposal and opens
the existing import dialog with:

- the level mapping shown for confirmation — mapped **by position**, never because two
  names look alike, with "matches" / "different name" / "incompatible" per level;
- the column mapping pre-filled from the generated columns;
- teeka columns matched to the destination grantha's teekas by name, and left unmapped with
  an explanation when the grantha has no such teeka;
- grouping switched on with the right number of section levels, and a blocking note if the
  document is deeper than the grantha.

From there it is the ordinary import: rows become draft updates and creates, and the
grantha's own **Save** / **Save & Publish** commits them, with the same locks, backups,
preflight and publish queue as every other edit. There is one publishing mechanism in this
application and this feature does not add a second.

**Duplicate imports**: a job records what it was imported into. Handing the same analysis to
a grantha again asks for confirmation first, naming the grantha and the date.

## Resumability

| State | Meaning |
| --- | --- |
| `analysis_queued` / `analysis_in_progress` | ranges are being analysed |
| `analysis_failed` | the run failed or was cancelled — Retry failed ranges |
| `clarification_required` | open questions |
| `review_pending` | nothing blocking, awaiting the editor's confirmation |
| `validation_failed` | blocking errors |
| `ready_for_export` | review confirmed; CSV available |
| `import_in_progress` / `import_completed` / `import_failed` | the import leg |

Closing the dialog, refreshing or losing the connection costs nothing: the state is the job
row, and re-opening the wizard resumes on the step it implies. A restart requeues in-flight
ranges (`reconcileStructureJobsOnBoot`) and never re-asks for a range that already answered.
Ranges of one job run **in order**, because each one is given the section path still open at
the end of the previous one plus its last paragraphs as read-only context — that is what
keeps a chapter heading on page 40 governing page 41.

## Cost and limits

| Gate | Default | Env |
| --- | --- | --- |
| Model | `claude-opus-5` | `STRUCTURE_MODEL` |
| Thinking depth | `high` | `STRUCTURE_EFFORT` |
| OCR pages per request | 10 (or 60k characters) | `STRUCTURE_PAGES_PER_CHUNK`, `STRUCTURE_MAX_CHARS_PER_CHUNK` |
| Requests in flight (whole server) | 2 | `STRUCTURE_CONCURRENCY` |
| Documents analysed at once | 1 | `STRUCTURE_MAX_ACTIVE_JOBS` |
| Requests per rolling minute / UTC day | 20 / 800 | `STRUCTURE_REQUESTS_PER_MINUTE`, `STRUCTURE_REQUESTS_PER_DAY` |
| Attempts per range | 3 | `STRUCTURE_MAX_ATTEMPTS` |
| Uncertainty threshold | 0.7 | `STRUCTURE_CONFIDENCE_THRESHOLD` |

The rules, the hierarchy and the editor's instructions are one cached prefix
(`cache_control: ephemeral`), so a 300-page book pays for them once instead of thirty
times; `cachedInputTokens` on the job row is the evidence, and the wizard shows it.

A per-day budget is seeded from the database on boot, so a restart does not hand out a
fresh one. When it runs out, remaining ranges are marked `skipped` and the job finishes
`partial` — press **Retry failed ranges** after 00:00 UTC.

## Accuracy

`npm run accuracy:ocr-structure -- --job <id> --labels labels.json` scores a finished
analysis against a human-labelled expectation of the same document: hierarchy assignment,
text preservation, bhashyam and teeka association, ordering, questions asked, manual edits
applied, and confidence calibration (how often the model was confident and wrong). It exits
non-zero below `--target` (99 by default), so it can gate CI once a labelled set exists.
`--items items.json` scores a saved item list with no database, which is how such a set can
live in the repo.

Model-reported confidence is never treated as a measurement; it only decides what gets
flagged for a human.

## Setup

```
ANTHROPIC_API_KEY=sk-ant-...
```

Then `npm run migrate` (or `npm run migrate:ocr-structure`). The server also installs the
two tables itself on first use, the same way the OCR tables do, so a pull + pm2 restart is
enough. Without the key the wizard reports "not configured" and refuses to start; the
existing Gemini OCR is untouched and keeps working.

## Tests

```
npm run test:ocr-structure         # contract, assembler, validator, mapping, states
npm run test:ocr-structure-csv     # the generated CSV through the REAL importer
npm run test:ocr-structure-claude  # the request shape, retries and redaction (no quota)
```

The CSV suite is the compatibility guarantee: it pushes generated bytes through
`parseCsv → planCsvRows → buildImportPayload → placeCsvCreates → prepareHierarchyForSave`
and asserts the tree the editor ends up holding. If the importer's contract changes, it
fails there instead of in a half-imported grantha.
