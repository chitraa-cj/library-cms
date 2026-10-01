# Patches applied to the Hermex install on EC2

Hermex is **not** vendored in this repo. It lives on the server as its own git
checkout:

```
/home/ubuntu/hermex-translation/hermex        (git, hermex 0.4.4)
/home/ubuntu/hermex-translation/.venv         (installed from that checkout)
/home/ubuntu/hermex-translation/chrome-profile
```

Edits made there are invisible to this repo and are **lost on any reinstall or
re-clone of hermex**. Every change we make to that package therefore gets a patch
file here, so it can be re-applied deliberately instead of rediscovered by a
production failure.

## Applying

```bash
cd /home/ubuntu/hermex-translation/hermex
git status --porcelain                 # expect clean before applying
git apply --check /path/to/0001-dismiss-gemini-location-popup.patch   # dry run
git apply        /path/to/0001-dismiss-gemini-location-popup.patch
/home/ubuntu/hermex-translation/.venv/bin/python -c "from hermex import Gemini; print(hasattr(Gemini, '_dismiss_popups'))"
```

The venv installs the checkout in editable/source form, so no reinstall step is
needed — the next process picks the change up.

## Checking whether a patch is still applied

```bash
/home/ubuntu/hermex-translation/.venv/bin/python - <<'PY'
from hermex import Gemini
print("popup dismissal:", hasattr(Gemini, "_dismiss_popups"))
PY
```

If that prints `False` after a hermex update, re-apply the patch below.

## Two layers, two tests

The CMS does **not** call `hermex.Gemini.send_message()` — `translate_cli.
_gemini_send_message()` reimplements it on purpose. So popup handling exists in
both places and each has its own check:

| Layer | Code | Test |
| --- | --- | --- |
| hermex package (`Gemini.query`, `send_message`) | patch 0001 below | `test_popup_fix.py` (EC2, real browser) |
| CMS pipeline (`translate_cli._gemini_send_message`) | in this repo, `_dismiss_gemini_overlays` + click retry | `test_pipeline_popup.py` (EC2) and `npm run test:hermex-overlay` (anywhere, no browser) |

Both use the same rule: exact, case-folded decline labels, never a substring, so
"Use precise location" can never be clicked.

## Patches

### 0001 — dismiss Gemini's location prompt before clicking the composer

**Problem.** Gemini intermittently shows a card ("Gemini is more relevant with
location" / "Use precise location for Gemini?") that overlaps `rich-textarea`.
`send_message()` located the composer and clicked it unconditionally, so the
click landed on the overlay and raised `ElementClickInterceptedException` —
observed on this box, and reproduced from a clean session.

**Change.** `hermex/gemini.py` only:

- `Gemini.DISMISS_BUTTON_LABELS` — exact, case-folded labels of *declining*
  buttons (`dismiss`, `no thanks`, `not now`, `maybe later`). Exact matching is
  deliberate: a substring search would eventually click the affirmative button
  beside them and grant a permission.
- `Gemini._dismiss_popups()` — clicks any visible, enabled button carrying one of
  those labels (text or `aria-label`). A no-op when nothing matches; swallows
  `WebDriverException` so a vanishing overlay is never an error.
- `Gemini._click_composer()` — performs the real click, and on
  `ElementClickIntercepted` / `StaleElementReference` dismisses, re-locates and
  retries (3 attempts total, reusing the existing 20s wait). This covers an
  overlay that appears *between* locating the composer and clicking it.
- `send_message()` calls `_dismiss_popups()` before the lookup and routes its
  click through `_click_composer()`.

**Not changed:** login detection, timeouts, retry counts elsewhere, the Chrome
profile, state handling, or any other file. No JavaScript click is used on the
composer — the real Selenium click is still what types into Gemini.

**Verified on the box.** hermex ships no test suite, so `test_popup_fix.py` (next
to this README) is the check. It builds a synthetic overlay carrying BOTH buttons
and asserts: the helper is a no-op with no popup, a mid-interaction overlay is
recovered from, the Dismiss button is clicked, "Use precise location" is **not**,
`send_message()` clears a pre-existing overlay, login detection still reports
`is_logged_in=True`, and a live `query()` returns `PROFILE_LOGIN_TEST_OK`.

```bash
scp deploy/hermex-patches/test_popup_fix.py ubuntu@<box>:/tmp/
ssh ubuntu@<box>
pgrep -x chromedriver >/dev/null && pkill -x chromedriver     # never `pkill -f`: it
                                                              # matches your own ssh line
rm -f /home/ubuntu/hermex-translation/chrome-profile/Singleton*
cd /tmp && DISPLAY=:99 /home/ubuntu/hermex-translation/.venv/bin/python test_popup_fix.py
# expect: 10 passed, 0 failed
```

Last run: 10/10 passed. `mypy hermex/` also passes — run locally against a copy,
because the server venv has no dev tooling and none was installed into it.
