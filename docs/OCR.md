# OCR Docs (admin-only)

Transcribe PDFs and scans **on this server**, with no external AI service. Admins see
**Administration → OCR Docs** (`/admin/ocr`); editors do not see the nav entry and every
API route returns 403 for them.

Until 2026-10 this feature sent page ranges to the Gemini API. It now runs a local
engine; jobs transcribed the old way keep their text and still display (as Markdown).

## How a page is read

```
upload (stored once, never modified)            .ocr-store/<jobId>/source.pdf
   └─ page count (pdf-lib) + one chunk row per page        cms_ocr_job_chunks
        └─ pool of OCR lanes (OCR_CONCURRENCY), nice'd     server/ocr/jobs.ts
             └─ per page                                    server/ocr/engine.ts
                  ├─ PDF text layer usable?  → pdftotext    (no OCR at all)
                  └─ otherwise: pdftoppm → Tesseract OSD (script) →
                       Tesseract with that script's language set; below
                       OCR_ACCEPT_CONFIDENCE, try the other sets, keep the best
                  └─ normalize (engine artefacts only) → review flags
             └─ fenced write: raw text + normalized text + per-page metadata
```

What is kept, per page, and never mixed up:

| Stage | Where | What |
| --- | --- | --- |
| Original | `.ocr-store/<job>/source.*` | the upload, byte for byte |
| Raw | `cms_ocr_job_chunks.raw_text` | exactly what pdftotext / Tesseract produced (`Raw` download) |
| Normalized | `cms_ocr_job_chunks.markdown` | raw minus meaningless artefacts — what the viewer shows and OCR → Grantha reads |
| Metadata | `cms_ocr_job_chunks.pages_meta` | source (text layer / OCR), engine + language set, OSD script, confidence, low-confidence words, review flags |
| Approved | the grantha | whatever an editor commits through the grantha editor |

**Nothing rewrites source text.** There is no AI "correction" stage: uncertain pages are
*flagged*, never fixed. Normalization (`shared/ocr-quality.ts`) only removes CR/LF
differences, trailing spaces, form feeds, blank-line runs and Tesseract's ZERO WIDTH
NON-JOINER after a word-final virama (`त्‌` → `त्`; a ZWNJ between consonants, which
changes the conjunct, is kept). No Unicode normalization form is applied.

### Review flags

`empty`, `short`, `low_confidence` (page mean below `OCR_LOW_PAGE_CONFIDENCE`),
`low_confidence_words` (words below `OCR_LOW_WORD_CONFIDENCE`, listed on the page),
`invalid_unicode`, `repeated_lines` (a recognition loop), and
`embedded_text_rejected` (the PDF had a text layer that looked unusable, so the page was
OCR'd). The viewer shows them on each page and counts flagged pages in the header.

### When to choose "Always OCR"

The text-layer check rejects layers that are nearly empty or full of unmapped/replacement
characters. It **cannot** detect a layer that is plausible-looking but wrong — notably PDFs
typeset with legacy 8-bit Devanagari fonts (Kruti Dev and similar), whose "text" is Latin
gibberish, and PDFs whose font map silently drops a sign. Observed on the test fixture: the
Chrome-produced PDF's text layer drops the Vedic **ꣳ** (U+A8F3), splits "कुर्वन्नेवेह" into
"कु र्वन्नेवेह" and loses one danda — with no flag, because a text layer carries no
confidence. When the editor knows the source, **Always OCR** is the safe choice.

## Accuracy (measured, not assumed)

On the 3-page Īśāvāsya fixture in `tests/fixtures/ocr/` (rendered from Unicode text, then
rasterised at 200 dpi and OCR'd at 300 dpi), character error rate against the exact source
text:

| Page | Script | Language set chosen | CER |
| --- | --- | --- | --- |
| 1 | Devanagari | `san` | 3.1% |
| 2 | Devanagari | `san` | 4.3% |
| 3 | IAST | `script/Latin` | 10.1% |

What the language comparison on the same pages showed (and why the defaults are what they
are): `san+hin+eng` contaminates Devanagari with Latin look-alikes (6.2% CER); `hin` is
worse than `san` on Sanskrit (3.6–5.4%); `eng` strips every IAST diacritic **while
reporting ~87 confidence**; `script/Latin` keeps most of them. Known misreads on the
fixture: the verse number **१ read as ९** (not flagged — confidence does not catch every
error), **ꣳ** read as "ाबि" (flagged at confidence 12), and IAST `ṃ ṛ ḥ ś` dropped.

These are synthetic, clean pages. Real scans (skew, noise, old type) will do worse;
re-measure on a labelled sample of the actual corpus before trusting any threshold.
Confidence thresholds are review hints, calibrated only on this fixture.

## Speed

Measured on an Apple M1, one lane: text-layer PDF, 3 pages: ~60 ms (no OCR). Scanned PDF,
3 pages at 300 dpi: ~4.8 s (OSD + one or two recognitions per page). Throughput scales
with `OCR_CONCURRENCY` up to the core count; the EC2 box has not been measured — its
first jobs set the ETA's "historical" basis.

Each Tesseract process runs single-threaded (`OMP_THREAD_LIMIT=1`) at `nice 10`;
parallelism comes from page lanes, so one book cannot starve the web app or the
translation worker of CPU.

## Reliability

- **Unit of work = one page** (`OCR_CHUNK_SIZE=1`): a failure costs only that page;
  **Retry** re-runs only failed/unfinished pages (verified: finished pages' rows are not
  rewritten).
- **Transient** failures (a process killed by the OS, a timeout) retry with exponential
  backoff + jitter, `OCR_MAX_ATTEMPTS` per page. **Bad input** (corrupt page) fails the page
  without retrying. A **missing engine** (binary or language data) stops the job and leaves
  its pages queued — Retry after installing.
- **Ownership** (`server/lib/job-lease.ts`): jobs are claimed with
  `FOR UPDATE SKIP LOCKED`; every write of a run is fenced on its run token; a heartbeat
  proves liveness. A run whose heartbeat is older than `OCR_STALE_AFTER_MS` is requeued by a
  periodic sweep (so after a crash, recovery starts within ~2 minutes). A run that lost its
  job — cancelled, requeued — writes nothing. Cancel works across processes.
- **Idempotent upload**: the same bytes with the same settings return the existing job
  (`reused: true`) as long as its stored upload still exists. `force=1` makes a new one.
- A job whose stored upload has gone (purged) fails once with that reason instead of every
  page failing on a poppler exit code.

## Install (Ubuntu / EC2)

```bash
sudo apt install poppler-utils tesseract-ocr tesseract-ocr-osd \
                 tesseract-ocr-san tesseract-ocr-script-latn
curl -s localhost:<port>/api/admin/ocr/health        # 200 + versions when ready
```

`GET /api/admin/ocr/health` (admin) reports the Tesseract version, installed languages and
anything missing with the package to install. Until it is green, uploads are refused with
that message and queued jobs wait.

On macOS (dev): `brew install tesseract tesseract-lang poppler`. Homebrew splits language
files across two directories, so point `OCR_TESSDATA_DIR` at one holding `san`,
`script/Latin` and `osd` (symlinks are fine) and `OCR_TESSERACT_BIN` at
`/opt/homebrew/bin/tesseract` if another tesseract comes first on `PATH`.

## Configuration

See `.env.example` (OCR section) for every variable and default. No API key is needed or
read. The variables `GEMINI_API_KEY`, `OCR_MODEL_*`, `OCR_FALLBACK_MODELS`,
`OCR_REQUESTS_PER_*` are no longer used by OCR (translation never used them).

## API

All routes are `requireAuth + requireAdmin`, mounted at `/api/admin/ocr`.

| Route | Purpose |
| --- | --- |
| `GET /config` | engine, languages, limits, lane usage |
| `GET /health` | local engine readiness (200/503) — never contacts any service |
| `GET /jobs` | recent jobs |
| `POST /jobs` | upload (raw body; `fileName`, `mimeType`, `quality` = `fast`/`accurate` (200/300 dpi), `textMode` = `auto`/`ocr`, `force=1`) → 201 new / 200 `reused` |
| `GET /jobs/:id` | job + per-page status, live state, progress/ETA |
| `GET /jobs/:id/document` | merged pages, each with `meta` (source, engine, confidence, flags) |
| `GET /jobs/:id/download?format=md\|txt\|raw` | normalized Markdown/text, or the raw engine output |
| `GET /jobs/:id/source` | the original upload |
| `POST /jobs/:id/retry` | requeue failed/unfinished pages (409 while queued/running) |
| `POST /jobs/:id/cancel` | cancel (any process); finished pages are kept |
| `DELETE /jobs/:id` | cancel, delete rows + stored upload |

## Testing

```bash
npm run test:ocr-local-engine     # quality rules, TSV/OSD parsing, page decision and
                                  # range retries with fake engines, rendering, ETA, and
                                  # the REAL engine on tests/fixtures/ocr (skips loudly
                                  # when Tesseract is missing)
node --import tsx tests/ocr-pipeline.test.mjs   # planning, page markers, rendering, ETA
npm run test:provider-audit       # no provider SDK/endpoint/key/HTTP call reachable
TEST_DATABASE_URL=postgresql://test@127.0.0.1:55433/cmstest npm run test:ocr-structure-db
                                  # real Postgres + real engine through the router:
                                  # leases, resume, cancel, idempotency (throwaway DB only)
```
