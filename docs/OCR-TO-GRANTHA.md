# OCR → Grantha (admin-only)

Turn a finished OCR transcription into a grantha: configure the hierarchy once, describe
how the book is laid out, let the assistant classify the pages, review the result, then
download a CSV or hand it straight to a grantha through the import dialog the editors
already use.

The assistant is **Hermex driving Gemini's web UI on a dedicated Google account**: the
same Hermex the translation workflow uses, but never its account, Chrome profile, lock or
quota (see *Setup*). No API key and no SDK are involved. Until 2026-10 this step called
the Claude API.

Entry point: **Administration → OCR Docs** → pick a document → **Create Grantha from OCR**.
The button appears as soon as one page range has been transcribed, so a long book can be
structured while its tail is still being read.

## The shape of it

```
OCR job (local engine)                           server/ocr/*
   └─ transcribed pages
        └─ structure job                         cms_structure_jobs
             └─ page-range chunks (in order)     cms_structure_job_chunks
                  └─ numbered lines → ONE prompt each       server/structure/prompt.ts
                       └─ Hermex session (dedicated profile) server/structure/hermex-analyzer.ts
                            └─ line spans → resolveLineAnswer  shared/ocr-structure-lines.ts
                                 └─ validated StructureItem[]   ← the only stored model output
                            └─ + review edits (overrides)
                                 └─ assembleStructure()    shared/ocr-structure.ts
                                      └─ validate → CSV
                                           ├─ Download CSV
                                           └─ Upload to Grantha
                                                └─ grantha-csv-import-dialog (existing)
                                                     └─ draft Save / Save & Publish (existing)
```

Two properties are worth stating plainly, because everything else follows from them:

**The model labels line spans; it never writes text.** The pages are shown as numbered
lines (`L12| …`). One request per page range returns an ordered list of spans, each
labelled (`section` / `verse` / `bhashyam` / `teeka` / `translation` / `prose` /
`footnote` / `ignored`), e.g. "lines 4–5 are verse 1". `resolveLineAnswer` then **cuts the
text from the OCR transcription itself**, so every word in the review and the CSV is
byte-identical to the OCR output. The model cannot paraphrase, "correct", transliterate or
drop it, not even through the chat UI's rendering. Coverage is checked in code:
overlapping, backwards or out-of-range spans reject the answer (it is retried), and lines
the model skipped come back as **unclassified** prose at confidence 0, so no text is ever
silently lost.

**Printed, inferred, supplied and uncertain are kept apart** on each item:
`numberSource` is `printed` only when the number appears in the item's own lines
(Devanagari digits are matched as digits); otherwise it is `inferred`, with confidence
capped at 0.5 so it gets flagged. `teekaNameSource` is `printed` (on these pages), `known`
(used earlier in the document), `instructions` (named by the editor) or `inferred` (capped
and flagged). Editor changes are marked `edited`. Every item records its `sourceLines` and
its page.

The model still does not build the hierarchy, decide which verse a commentary belongs to,
renumber anything or produce CSV. That is deterministic code in `shared/ocr-structure.ts`,
which runs identically on the server, in the review UI and in the tests.

**Nothing derived is stored.** The chunk rows hold `items`; the job row holds the review's
`overrides`. Sections, verses, open questions, validation and the CSV are recomputed from
those two on every read (`buildStructureResult`). So a correction never needs another model
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

## Which pages (the page window)

The instructions step asks **Which pages?** — two boxes, `from` and `to`, 1-based and
inclusive. Leave them empty for the whole transcription; fill them to analyse a slice.

The window is a *scope* decision, applied before anything else happens: only those pages
are planned into ranges, only they are sent to the model. So a
900-page scan can be done a hundred pages at a time, each part reviewed and imported on
its own, and re-running one part costs only that part. The request count beside the boxes updates
itself as they change (debounced, because the estimate assembles the transcription
server-side), and it states the resolved window in words before the Analyse button.

Tolerances, all in `selectPageWindow` (`shared/ocr-structure.ts`, unit-tested):

- either bound may be omitted — "from 41" means 41 to the end;
- bounds the wrong way round are read as a range, not as nothing;
- a window is **clamped to the pages that actually have a transcription**, so `1–100` on a
  document whose OCR reached page 60 analyses 60 pages instead of failing;
- a window that happens to cover everything is recorded as no window at all, so the review
  never claims a scope the editor did not choose;
- a window with no transcribed pages in it is refused at creation, with the document's
  real page span in the message.

The applied window is stored on the job (`cms_structure_jobs.page_from` / `page_to`, null =
the whole document) and shown on the analysis, review and export steps — the CSV covers
those pages only, and the export step says so, because the rest of the book is a separate
analysis and a separate import.

Each range is also *told* the window, so a passage cut off at its edge is understood as a
boundary rather than as page damage. That sentence sits in the per-request user message,
never in the cached prefix.

## Instructions, typed or dictated

The instruction box takes plain sentences, not rules: which printed markers start each
level, what belongs to what, how to read irregular numbering. Dictation uses the browser's
own speech recognition (Chrome/Edge) and writes into the same box, so the transcription is
reviewed and corrected before it is used; no audio and no new provider credential leaves
the machine. Browsers without it simply show an explanatory toast.

The instructions are sent inside `<editor_instructions>`, the pages inside `<document>`,
and the rules say that both are data: text inside them is never an instruction to the
model, whatever it claims. Data cannot close its own fence (a literal `</document>` in a
scan is neutralised in the prompt copy). Even a successful injection could only mislabel
spans: the model has no tools here, cannot write text, and its answer is validated and
then reviewed. `tests/ocr-structure-lines.test.mjs` asserts the fencing.

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
row, and re-opening the wizard resumes on the step it implies. Ranges of one job run **in
order** (each is given the section path still open at the end of the previous one, plus its
last lines as read-only context) through **one browser session per job**, so Chrome is
launched once per analysis, not once per range.

Ownership works as it does for OCR (`server/lib/job-lease.ts`): an atomic claim, a fencing
token on every write, and a heartbeat. A run that stays silent for
`STRUCTURE_STALE_AFTER_MS` is requeued, and only its unfinished ranges run again. A setup
failure (profile not logged in, no display, lock held) **stops the job and leaves its
ranges queued**, so Retry works once it is fixed. A range whose answer stays unusable
after `STRUCTURE_MAX_ATTEMPTS` fails on its own and stores no partial items. Starting the
same analysis twice while it is queued or running returns the first one.

**Concurrent review edits**: the review appends edits and saves the whole list. The server
accepts a save only if the stored list is a prefix of it (compared key-order-insensitively,
under a row lock). A save that would erase another reviewer's edits gets a 409 asking the
editor to reload.

## Requests and limits

There is no per-token bill: the cost is the dedicated account's web quota and browser time.
The instructions step shows how many requests the chosen pages need and how many remain
today. Over a hard limit, the Analyse button is disabled and says why.

| Gate | Default | Env |
| --- | --- | --- |
| OCR pages / characters per request | 3 / 5,000 | `STRUCTURE_PAGES_PER_CHUNK`, `STRUCTURE_MAX_CHARS_PER_CHUNK` |
| Requests per rolling minute / UTC day (dedicated account) | 4 / 300 | `STRUCTURE_REQUESTS_PER_MINUTE`, `STRUCTURE_REQUESTS_PER_DAY` |
| Requests per document | 600 | `STRUCTURE_MAX_REQUESTS_PER_JOB` |
| Attempts per range | 3 | `STRUCTURE_MAX_ATTEMPTS` |
| Cool-down after Gemini's canned error reply | 60 s | `STRUCTURE_TRANSIENT_COOLDOWN_MS` (do not lower; see docs/HERMEX.md) |
| One request / browser launch | 15 min / 6 min | `STRUCTURE_REQUEST_TIMEOUT_MS`, `STRUCTURE_LAUNCH_TIMEOUT_MS` |
| Documents analysed at once | 1 (one browser per profile) | — |
| Uncertainty threshold | 0.7 | `STRUCTURE_CONFIDENCE_THRESHOLD` |
| Pages per analysis | 1500 | `STRUCTURE_MAX_PAGES` |

Ranges are small on purpose. Gemini's web UI has refused ~6K-character prompts from the EC2
box while accepting larger ones from a Mac (docs/HERMEX.md). The answer is only a short
list of spans, so small ranges cost little. When the day cap is reached, the remaining
ranges are `skipped` and the job finishes `partial`; press Retry failed ranges after
00:00 UTC.

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

1. **A dedicated Google account** for document analysis, not the one translation uses.
   Translation's Chrome profile holds an exclusive lock for its whole run, and the web
   quota is per account; sharing either would make translation items fail or run out of
   quota. Prefer an account with **no Gmail/Drive data, with Gemini extensions and saved
   info/activity memory turned off**: scanned text is untrusted input, and an empty
   account gives a prompt injection nothing to reach.
2. Configure the profile (a new directory) in the CMS `.env`:
   ```
   HERMEX_STRUCTURE_CHROME_PROFILE=/home/ubuntu/hermex-structure/chrome-profile
   ```
   The server refuses a profile that is translation's, sits inside it, or is hermex's
   default profile, and it refuses translation's lock file.
3. Log it in once (this needs a display; on EC2 use the same Xvfb/VNC route as for
   translation): `npm run hermex:setup-structure` opens Chrome; sign in, then press Enter.
4. `GET /api/admin/ocr/structure/health` must return 200 (filesystem checks only; it
   never opens a browser).
5. `npm run migrate` (or let the server add the two lease columns itself on first use).

The structure browser runs beside translation's, as its own Chrome under its own lock and
with its own cleanup scope (`HERMEX_CLEANUP_SCOPE=profile`), so it never kills
translation's driver. Translation's cleanup is unchanged: if *translation* has to reap
orphans after a launch failure, it may kill the structure browser, which then fails that
range with a retryable `chrome` error. That asymmetry is deliberate, so translation keeps
priority.

### Verifying on a server

```
npm run hermex:check                     # translation's setup: must stay green
curl …/api/admin/ocr/structure/health    # the structure profile
```
Then run one small analysis (one or two pages) and check that the range shows
`hermex/gemini-web`, that items carry `sourceLines`, and that translation jobs keep
completing.

## Tests

```
npm run test:ocr-structure          # contract, assembler, validator, mapping, states
npm run test:ocr-structure-csv      # the generated CSV through the REAL importer
npm run test:ocr-structure-lines    # line spans → verbatim text, coverage, printed vs
                                    # inferred, prompt fencing
npm run test:hermex-structure       # profile isolation, child env (no translation profile,
                                    # no credentials), session protocol, retries, no fallback
npm run test:hermex-isolation       # Python: scoped cleanup, prompt_session.py protocol
npm run test:provider-audit         # nothing reachable from either workflow can call a
                                    # provider API or write the CMS
TEST_DATABASE_URL=… npm run test:ocr-structure-db   # real Postgres, scripted analyzer
```

None of these opens a browser or sends a prompt. The real Gemini leg is verified by hand
(see *Verifying on a server*).

