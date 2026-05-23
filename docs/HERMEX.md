# Hermex + Gemini translation

This project uses [Hermex](https://github.com/pseudo-usama/hermex) to drive **Gemini in Chrome** for translating Upanishad / grantha text into all **43** `OtherTranslations` languages (everything in `translationLanguages` except Sanskrit and English).

No Gemini API key or billing — translations run through the free Gemini web UI via browser automation.

## Requirements

- **Python 3.11+**
- **Google Chrome 130+**
- macOS / Linux / Windows with a display (avoid headless for login sessions)

## One-time setup

```bash
# From repo root — creates .venv-hermex and installs Hermex
npm run hermex:install

# Log into Gemini once (opens Chrome; uses .venv-hermex)
npm run hermex:setup
```

When Chrome opens: sign in if needed, then **press Enter in the terminal** to save the session (setup closes Chrome for you). Do not use **Ctrl+C** (that aborts setup).

Or without npm:

```bash
python python/hermex_translate/setup_gemini.py
```

## Environment variables

Add to `.env` at the project root:

```env
HERMEX_ENABLED=true
# Optional:
# HERMEX_PYTHON=.venv-hermex/bin/python3
# HERMEX_TRANSLATE_SCRIPT=python/hermex_translate/translate_cli.py
# HERMEX_TRANSLATE_TIMEOUT_MS=2700000
```

## Using in the CMS

1. Start the app: `npm run dev`
2. Open a grantha → edit a mantra → **Shloka**, **Bhashyam**, or **Teeka** section
3. Enter **English** or **Sanskrit** source text
4. Use **Gemini translation (Hermex)**:
   - **Translate missing (N)** — only languages without text yet
   - **Translate all 43 languages** — full batch (slow; may take 15–30+ minutes)

Results are written into `OtherTranslations` with `isAiTranslated: true`. **Save the draft and publish** as usual; existing publish merge logic still protects Strapi rows you did not touch.

## API (authenticated)

- `GET /api/hermex/status` — enabled flag, language list
- `POST /api/hermex/translate` — body:

```json
{
  "sourceText": "...",
  "sourceLanguage": "English",
  "targetLanguages": ["Tamil", "Kannada"],
  "context": "Shloka 1.1.1",
  "chunkSize": 5
}
```

## Full grantha batch (any name, resumable)

Translates **every mantra** in a grantha (Shloka, Bhashyam, Teeka missing languages). Pass the **Grantha name** as shown in Strapi. Checkpoint file allows **resume after crashes**; Strapi merge keeps existing translations.

```bash
HERMEX_PYTHON=.venv-hermex/bin/python3 npm run hermex:grantha -- "Chandogya Upanishad"

# One mantra only:
npm run hermex:grantha -- "Chandogya Upanishad" --mantra "1.1.1"

# Plan only:
npm run hermex:grantha -- "Chandogya Upanishad" --dry-run

# Restart from scratch:
npm run hermex:grantha -- "Chandogya Upanishad" --reset-checkpoint

# Visible Chrome (if headless fails):
npm run hermex:grantha -- "Chandogya Upanishad" --headed
```

Checkpoint: `logs/hermex-checkpoints/<grantha-slug>.json`

Env tuning:

```env
HERMEX_CHUNK_SIZE=3
HERMEX_CHUNK_DELAY_MS=8000
HERMEX_MAX_RETRIES=3
HERMEX_TRANSLATE_TIMEOUT_MS=7200000
```

If you see **`Strapi error 403`** with HTML in the message, the batch hit a WAF/rate limit (not a bad translation). The runner now retries with backoff. If it persists, wait a few minutes and re-run; confirm `STRAPI_API_TOKEN` in `.env`.

Shortcut for all Chandogya mantras:

```bash
npm run hermex:chandogya
```

Log lines:

- `[hermex] OK` / `[hermex] FAIL` — Gemini per language/chunk (stderr)
- `[strapi] OK` — languages saved to Strapi after each chunk
- `[translate] FAIL` — chunk-level failure (continues with next chunk)
- `[summary]` — language count after each job

## CLI (debug)

```bash
echo '{"sourceText":"Lead me from untruth to truth.","sourceLanguage":"English","targetLanguages":["Tamil","Hindi"],"context":"test","headless":true}' \
  | python python/hermex_translate/translate_cli.py
```

## Troubleshooting

| Symptom | Cause | What to do |
|--------|--------|------------|
| Input box filled with **“Some fake text…”** | Hermex `fake_typing` + paste mode | Fixed in `translate_cli.py` (`fake_typing=False`). Re-run the job. |
| Gemini shows Hebrew (etc.) in the browser but logs **FAIL / no rows parsed** | Response was **truncated** or invalid JSON (common on long Teeka) | Parser now salvages partial text and syncs what it can. Re-run for missing langs only (resume). |
| `[translate] partial … saved 1/2` | One language parsed, one missing | Expected — missing langs are retried on the next run. |
| **`Response contained neither text nor image`** | Hermex read the reply before Gemini filled `.markdown`, or Chrome closed mid-run | Fixed: polls up to ~40s after IDLE; retries refresh **same browser** (no flash close/open). Run `npm run hermex:setup` once. Do not close the Chrome window while a job runs. |
| **`element click intercepted`** (Canvas card) | Gemini discovery overlay on `/app` | Fixed: dismiss overlays + JS focus before paste. Use `--headed` if headless still fails. |
| Parse snippet shows **`npm run hermex...`** | Clipboard/`get_markdown` picked up terminal text, not Gemini | Fixed: read plain `.text` only; reject shell-like garbage. |

Long Teeka text (>800 chars) uses **marker blocks** (`===LANGUAGE: Hebrew===`) instead of JSON to avoid quote/Unicode breakage.

## Notes

- Hermex depends on the Gemini web UI; UI changes can break automation.
- Respect [Google’s terms of service](https://policies.google.com/terms) for automated use.
- Review AI translations before publish; do not rely on them without editorial check.
