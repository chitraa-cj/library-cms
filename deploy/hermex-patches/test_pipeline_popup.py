"""EC2 test: the PRODUCTION pipeline survives Gemini's location prompt.

The companion to `test_popup_fix.py`. That one covers `hermex.Gemini.send_message`;
this one covers `translate_cli._gemini_send_message()`, which the CMS actually
calls and which deliberately reimplements send_message. A synthetic overlay
carrying BOTH buttons makes every rule deterministic instead of waiting for Google
to show the real card.

    A. overlay present before sending  -> dismissed, message goes through
    B. overlay surviving into the click -> click-interception retry recovers
    C. "Use precise location" is never clicked, in either case

Run on the box (nothing else using Chrome):

    scp python/hermex_translate/translate_cli.py \\
        deploy/hermex-patches/test_pipeline_popup.py ubuntu@<box>:/tmp/pipe/
    ssh ubuntu@<box>
    pgrep -x chromedriver >/dev/null && pkill -x chromedriver   # never `pkill -f`
    rm -f /home/ubuntu/hermex-translation/chrome-profile/Singleton*
    cd /tmp/pipe && DISPLAY=:99 \\
      HERMEX_CHROME_PROFILE=/home/ubuntu/hermex-translation/chrome-profile \\
      /home/ubuntu/hermex-translation/.venv/bin/python test_pipeline_popup.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import translate_cli as tc  # noqa: E402

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, ok))
    print(("  ok   " if ok else "  FAIL ") + name + (" — " + str(detail) if detail else ""), flush=True)


# Trusted Types is enforced on gemini.google.com, so the overlay is built with DOM
# APIs; an innerHTML assignment is refused outright.
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
dismiss.textContent = 'Dismiss';
dismiss.addEventListener('click', () => { window.__dismissClicked = true; o.remove(); });
const precise = document.createElement('button');
precise.textContent = 'Use precise location';
precise.addEventListener('click', () => { window.__preciseClicked = true; });
o.appendChild(label);
o.appendChild(dismiss);
o.appendChild(precise);
document.body.appendChild(o);
return true;
"""

gemini = tc._open_gemini_browser(headless=False)
try:
    check("session still logged in", getattr(gemini, "is_logged_in", None) is True)

    # ── A. overlay present before the send ───────────────────────────────────
    print("\n A. overlay present before sending")
    gemini.driver.execute_script(OVERLAY_JS)
    check("overlay injected", bool(gemini.driver.find_elements("id", "__fake_location_prompt")))
    try:
        tc._gemini_send_message(gemini, "Reply with exactly: PIPELINE_POPUP_OK", paste=False)
        check("_gemini_send_message completed", True)
    except Exception as e:
        check("_gemini_send_message completed", False, type(e).__name__ + ": " + str(e)[:90])
    check("Dismiss was clicked", gemini.driver.execute_script("return window.__dismissClicked;") is True)
    check("'Use precise location' NOT clicked",
          gemini.driver.execute_script("return window.__preciseClicked;") is False)

    tc._wait_idle_or_stall(gemini, 240)
    answer = tc._gemini_fetch_response(gemini)
    text = (getattr(answer, "text", "") or "").strip()
    check("the message really reached Gemini", "PIPELINE_POPUP_OK" in text, repr(text[:60]))

    # ── B. overlay surviving into the click ──────────────────────────────────
    # Neutralise the first dismissal pass so the card is still there when
    # input_p.click() runs — that is the interception the retry must absorb.
    print("\n B. overlay survives into the click")
    gemini.driver.refresh()
    tc._wait_generation_started(gemini, timeout=1)
    gemini.sleep(3)
    gemini.driver.execute_script(OVERLAY_JS)

    real_dismiss = tc._dismiss_gemini_overlays
    calls = {"n": 0}

    def skip_first_two(g):
        calls["n"] += 1
        if calls["n"] <= 2:  # the two pre-click passes inside _gemini_send_message
            return
        real_dismiss(g)

    tc._dismiss_gemini_overlays = skip_first_two
    try:
        tc._gemini_send_message(gemini, "Reply with exactly: PIPELINE_RETRY_OK", paste=False)
        check("click interception was recovered from", True)
    except Exception as e:
        check("click interception was recovered from", False, type(e).__name__ + ": " + str(e)[:90])
    finally:
        tc._dismiss_gemini_overlays = real_dismiss

    check("the retry pass clicked Dismiss",
          gemini.driver.execute_script("return window.__dismissClicked;") is True)
    check("'Use precise location' still NOT clicked",
          gemini.driver.execute_script("return window.__preciseClicked;") is False)
    check("the dismissal retry actually ran (>2 calls)", calls["n"] > 2, "calls=%d" % calls["n"])
finally:
    tc._close_gemini_browser(gemini)

failed = [r for r in RESULTS if not r[1]]
print("\n%d passed, %d failed" % (len(RESULTS) - len(failed), len(failed)))
sys.exit(1 if failed else 0)
