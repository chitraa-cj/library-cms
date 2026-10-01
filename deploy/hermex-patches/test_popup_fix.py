"""Deterministic test of the Gemini popup-dismissal fix.

Simulates the real overlay (a card with "Dismiss" and "Use precise location")
rather than waiting for Google to show it, so every requirement is checked:
  1. a pre-existing overlay is cleared before the composer is clicked
  2. an overlay that appears AFTER the element lookup is recovered from
  3. the affirmative button is never clicked
  4. the helper is harmless when nothing is on screen
  5. a real query still works end to end
"""
import sys

from selenium.webdriver.common.by import By

from hermex import Gemini

PROFILE = "/home/ubuntu/hermex-translation/chrome-profile"
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(("  ok   " if ok else "  FAIL ") + name + (" — " + str(detail) if detail else ""), flush=True)


# Gemini's page enforces Trusted Types, so the overlay is built with DOM APIs
# (innerHTML assignment is refused outright).
OVERLAY_JS = """
window.__dismissClicked = false;
window.__preciseClicked = false;
const ta = document.querySelector('rich-textarea');
const box = ta.getBoundingClientRect();
const o = document.createElement('div');
o.id = '__fake_location_prompt';
o.style.cssText = 'position:fixed;left:0;top:' + Math.max(0, box.top - 60) +
  'px;width:100vw;height:' + (box.height + 160) + 'px;z-index:2147483647;' +
  'background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;gap:12px;';
const label = document.createElement('p');
label.textContent = 'Use precise location for Gemini?';
const dismiss = document.createElement('button');
dismiss.id = '__d';
dismiss.textContent = 'Dismiss';
dismiss.addEventListener('click', () => { window.__dismissClicked = true; o.remove(); });
const precise = document.createElement('button');
precise.id = '__p';
precise.textContent = 'Use precise location';
precise.addEventListener('click', () => { window.__preciseClicked = true; });
o.appendChild(label);
o.appendChild(dismiss);
o.appendChild(precise);
document.body.appendChild(o);
return true;
"""

g = Gemini(headless=False, disable_web_security=False, data_dir=PROFILE)
try:
    g.open_url(timeout=90)
    check("session still logged in (login detection untouched)", getattr(g, "is_logged_in", None) is True,
          "is_logged_in=%r" % getattr(g, "is_logged_in", None))

    # ── 4. harmless with no popup present ────────────────────────────────────
    before = len(g.driver.find_elements(By.TAG_NAME, "rich-textarea"))
    g._dismiss_popups()
    g._dismiss_popups()
    after = len(g.driver.find_elements(By.TAG_NAME, "rich-textarea"))
    check("no-op when no popup exists", before == after == 1, "textareas %d -> %d" % (before, after))

    # ── 2. overlay appearing BETWEEN lookup and click ────────────────────────
    input_box = g.driver.find_element(By.TAG_NAME, "rich-textarea")
    g.driver.execute_script(OVERLAY_JS)
    check("overlay is present", bool(g.driver.find_elements(By.ID, "__fake_location_prompt")))
    try:
        g._click_composer(input_box)
        check("recovers from a mid-interaction overlay", True)
    except Exception as e:
        check("recovers from a mid-interaction overlay", False, type(e).__name__ + ": " + str(e)[:80])
    check("the Dismiss button was clicked", g.driver.execute_script("return window.__dismissClicked;") is True)
    check("'Use precise location' was NOT clicked",
          g.driver.execute_script("return window.__preciseClicked;") is False)
    check("overlay is gone", not g.driver.find_elements(By.ID, "__fake_location_prompt"))

    # ── 1. overlay present BEFORE send_message ───────────────────────────────
    g.driver.execute_script(OVERLAY_JS)
    try:
        g.send_message("Reply with exactly: PROFILE_LOGIN_TEST_OK", submit=False)
        check("send_message clears a pre-existing overlay", True)
    except Exception as e:
        check("send_message clears a pre-existing overlay", False, type(e).__name__ + ": " + str(e)[:80])
    check("affirmative button still untouched",
          g.driver.execute_script("return window.__preciseClicked;") is False)

    # ── 5. a real query, the user's manual test, with no manual dismiss ──────
    g.driver.refresh()
    g.wait_for_page_load(timeout=60)
    answer = g.query("Reply with exactly: PROFILE_LOGIN_TEST_OK", timeout=240)
    text = (getattr(answer, "text", "") or "").strip()
    check("live Gemini query works", "PROFILE_LOGIN_TEST_OK" in text, repr(text[:80]))
finally:
    try:
        g.close()
    except Exception:
        pass

failed = [r for r in RESULTS if not r[1]]
print("\n%d passed, %d failed" % (len(RESULTS) - len(failed), len(failed)))
sys.exit(1 if failed else 0)
