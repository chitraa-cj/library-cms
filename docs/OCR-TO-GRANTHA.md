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

### What it costs

Measured with the estimator at Claude Opus 5 list prices ($5/MTok in, $25/MTok out):

| Document | Requests | Tokens (in / out) | Cost |
| --- | --- | --- | --- |
| 100 pages | 10 | 165k / 216k | **~$6** |
| 300 pages | 30 | 617k / 810k | **~$23** |
| 800 pages | 80 | 1.6M / 2.2M | **~$62** |

Output dominates, because every item carries the source text back verbatim — that is the
price of never letting the model paraphrase. The two levers that actually move the figure
are `STRUCTURE_EFFORT` (try `low`/`medium` on cleanly printed, regularly numbered books)
and `STRUCTURE_MODEL` (Sonnet 5 is ~2.5x cheaper per token than Opus). **If you change the
model, change `STRUCTURE_PRICE_*` with it**, or the portal will quote a stale number.

### The gates

| Gate | Default | Env |
| --- | --- | --- |
| **Spend per document** | **$30** | `STRUCTURE_MAX_SPEND_PER_JOB_USD` |
| **Spend per UTC day** | **$60** | `STRUCTURE_MAX_SPEND_PER_DAY_USD` |
| **Spend per UTC month** | **$400** | `STRUCTURE_MAX_SPEND_PER_MONTH_USD` |
| Requests per document | 200 | `STRUCTURE_MAX_REQUESTS_PER_JOB` |
| Requests per rolling minute / UTC day | 20 / 800 | `STRUCTURE_REQUESTS_PER_MINUTE`, `STRUCTURE_REQUESTS_PER_DAY` |
| Model | `claude-opus-5` | `STRUCTURE_MODEL` |
| Thinking depth | `high` | `STRUCTURE_EFFORT` |
| OCR pages per request | 10 (or 60k characters) | `STRUCTURE_PAGES_PER_CHUNK`, `STRUCTURE_MAX_CHARS_PER_CHUNK` |
| Requests in flight (whole server) | 2 | `STRUCTURE_CONCURRENCY` |
| Documents analysed at once | 1 | `STRUCTURE_MAX_ACTIVE_JOBS` |
| Attempts per range | 3 | `STRUCTURE_MAX_ATTEMPTS` |
| Uncertainty threshold | 0.7 | `STRUCTURE_CONFIDENCE_THRESHOLD` |

Any spend gate set to `0` is disabled. The request caps bound the burst rate; **the spend
caps are what bound the bill**, because one request can carry 60k input and 32k output
tokens.

### Where each gate bites

1. **Before the button.** The instructions step shows the estimate for this document, the
   budget left today and this month, and the per-document cap. Over any of them, the
   Analyse button is disabled and says which one and by how much.
2. **At creation.** `POST /jobs` re-checks server-side and refuses with 429 and the gate
   name, so a stale page or a direct API call cannot slip past the UI.
3. **Before every range.** The per-document spend and request caps are re-checked against
   what has *actually* been billed. A document denser than the estimate assumed stops at
   its cap: the job finishes `partial`, the ranges it did analyse are reviewable, and the
   error names the env var to raise and tells you to press **Retry failed ranges**.
4. **Before every request.** The day and month gates sit in `acquireStructureSlot`, so a
   budget that runs out mid-job stops the next request rather than the next job.

Spend is computed from the token counters the API itself returned, summed over
`cms_structure_jobs` in Postgres — so it survives a restart, counts every process, and
cannot be reset by redeploying. Cache reads are billed at 0.1x and cache writes at 1.25x,
and the two are counted separately (`cached_input_tokens`, `cache_write_tokens`) rather
than lumped together, which would under-bill the budget.

The estimate itself is deliberately pessimistic — 2.5 chars/token (Devanagari and IAST
tokenize far worse than English), every range paying the full prompt overhead, output at
1.35x the page text. It is labelled as an estimate everywhere it appears; the real figure
lands on the job row as each range finishes and is shown while the analysis runs.

The rules, the hierarchy and the editor's instructions are one cached prefix
(`cache_control: ephemeral`), so a 300-page book pays for them once instead of thirty
times; `cachedInputTokens` on the job row is the evidence, and the wizard shows it.

A per-day request counter is also seeded from the database on boot. When it runs out,
remaining ranges are marked `skipped` and the job finishes `partial` — press **Retry
failed ranges** after 00:00 UTC.

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
