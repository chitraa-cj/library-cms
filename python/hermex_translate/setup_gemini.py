#!/usr/bin/env python3
"""One-time Gemini login for Hermex (opens Chrome — log in, then finish setup)."""

from __future__ import annotations

import sys
import time
import warnings

try:
    from hermex import Gemini
    from hermex.config import data_dir as hermex_data_dir
except ModuleNotFoundError:
    raise SystemExit(
        "Hermex is not installed for this Python.\n"
        "  npm run hermex:install    # creates .venv-hermex and installs deps\n"
        "  npm run hermex:setup      # uses .venv-hermex automatically\n"
        "Or: .venv-hermex/bin/python3 python/hermex_translate/setup_gemini.py"
    ) from None

from pathlib import Path

from selenium.common.exceptions import WebDriverException


def _chrome_closed(err: BaseException) -> bool:
    msg = str(err).lower()
    return "no such window" in msg or "web view not found" in msg or "target window already closed" in msg


def _driver_alive(gemini: Gemini) -> bool:
    try:
        return bool(gemini.driver and gemini.driver.window_handles)
    except WebDriverException as e:
        return not _chrome_closed(e)
    except Exception:
        return False


def run_setup() -> int:
    marker = Path(hermex_data_dir) / ".setup_gemini"

    print("=" * 60)
    print("Hermex Gemini setup")
    print("=" * 60)
    print("1. Chrome opens https://gemini.google.com/app")
    print("2. Sign in with Google if prompted")
    print("3. Optional: send one short test message in Gemini")
    print("4. Return here and press ENTER to save the session")
    print("   (Setup will close Chrome for you — no need to hunt for the window.)")
    print("=" * 60)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        gemini = Gemini(headless=False)

    try:
        if not gemini.driver:
            gemini._initialize_driver()
        gemini.driver.get("https://gemini.google.com/app")
        try:
            gemini.wait_for_page_load(60)
        except Exception as e:
            if _chrome_closed(e):
                print("\nChrome closed too soon. Run again: npm run hermex:setup")
                return 1
            print(f"[warn] Page load: {e} — continue in Chrome if it opened.")
    except WebDriverException as e:
        if _chrome_closed(e):
            print("\nChrome closed too soon. Run again: npm run hermex:setup")
            return 1
        raise

    print("\n>>> When you are logged in, press ENTER in this terminal to finish setup <<<\n")

    try:
        while True:
            if not _driver_alive(gemini):
                print("[info] Chrome already closed — saving setup.")
                break
            try:
                line = input()
            except EOFError:
                break
            if line.strip() == "":
                break
            print("Press ENTER (empty line) to finish setup.")
    except KeyboardInterrupt:
        print("\n[abort] Ctrl+C — setup was NOT saved.")
        print("Re-run: npm run hermex:setup — then press ENTER when logged in.")
        return 130
    finally:
        try:
            gemini.close()
        except Exception:
            pass

    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.touch()
    print(f"\nSetup complete.")
    print(f"  Browser profile: {gemini.browser_profile_dir}")
    print(f"  Marker file:     {marker}")
    print("You can run translation jobs now (e.g. npm run hermex:grantha).")
    return 0


if __name__ == "__main__":
    sys.exit(run_setup())
