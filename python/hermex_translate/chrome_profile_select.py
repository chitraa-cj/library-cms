"""Which Chrome profile, inside hermex's user-data directory, a dedicated session drives.

hermex launches Chrome with `--user-data-dir=<data_dir>/chrome_profile` and nothing
else. A user-data directory can hold several profiles (`Default`, `Profile 1`, …):
signing in to Chrome during the one-time login creates a second one. With more than one
profile and no `--profile-directory`, Chrome opens chrome://profile-picker/ instead of a
browser window, and ChromeDriver fails with "session not created … unable to discover
open pages". This module:

  * names the profile explicitly (`--profile-directory=<dir>`) for the OCR / OCR →
    Grantha session only — translation never imports it;
  * reads the profile list from `Local State` (directory, display name, whether it is
    signed in to Chrome — never an email, cookie or token);
  * classifies the page the browser landed on (Gemini, the profile picker, a Google
    login page, something else);
  * finds and stops browsers launched on THIS user-data directory only, by exact
    `--user-data-dir=` match — never any other Chrome.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import time
from typing import Any, Callable

ENV_VAR = "HERMEX_SESSION_PROFILE_DIRECTORY"

# Chrome's own names are "Default" and "Profile N"; allow other plain names, never a path.
_VALID_DIRECTORY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$")


def _log(msg: str) -> None:
    print(f"[hermex-profile] {msg}", file=sys.stderr, flush=True)


def validate_directory(value: str) -> str:
    value = value.strip()
    if not _VALID_DIRECTORY.match(value) or value in (".", "..") or "/" in value or "\\" in value:
        raise ValueError(f"{ENV_VAR} must be a Chrome profile directory name such as 'Profile 1', not {value!r}")
    return value


def directory_from_env(env: dict[str, str] | None = None) -> str | None:
    raw = ((env if env is not None else os.environ).get(ENV_VAR) or "").strip()
    return validate_directory(raw) if raw else None


def user_data_dir(data_dir: str) -> str:
    """The directory hermex hands Chrome: always `<data_dir>/chrome_profile`."""
    return os.path.join(data_dir.rstrip(os.sep), "chrome_profile")


def read_profiles(udd: str) -> list[dict[str, Any]]:
    """Profiles listed in `<udd>/Local State`: directory, display name, signed in to Chrome."""
    try:
        with open(os.path.join(udd, "Local State"), encoding="utf-8") as f:
            state = json.load(f)
    except (OSError, ValueError):
        return []
    cache = ((state.get("profile") or {}).get("info_cache") or {}) if isinstance(state, dict) else {}
    out = []
    for directory, info in cache.items():
        info = info if isinstance(info, dict) else {}
        out.append({"directory": directory, "name": info.get("name") or "", "signedIn": bool(info.get("gaia_id"))})
    return sorted(out, key=lambda p: p["directory"])


def describe(profiles: list[dict[str, Any]]) -> str:
    if not profiles:
        return "no profile list (Local State missing — Chrome creates Default on first launch)"
    return ", ".join(
        f'{p["directory"]} "{p["name"]}" ({"signed in" if p["signedIn"] else "not signed in"})' for p in profiles
    )


def install(directory: str, chrome_options_module: Any = None) -> None:
    """Make every Chrome this process launches open `directory` directly.

    hermex builds its own `undetected_chromedriver.ChromeOptions()` with no hook for
    extra arguments, so the class is replaced, for this process only, by one that adds
    `--profile-directory`. Every relaunch in the session (recovery after a crash) is
    covered too. The prompt session is a single-purpose process; translation runs in
    its own processes and never calls this."""
    directory = validate_directory(directory)
    if chrome_options_module is None:
        import undetected_chromedriver as chrome_options_module  # type: ignore[no-redef]
    base = chrome_options_module.ChromeOptions
    if getattr(base, "_hermex_profile_directory", None) is not None:
        base = base.__mro__[1]

    class _ProfileOptions(base):  # type: ignore[misc, valid-type]
        _hermex_profile_directory = directory

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **kwargs)
            self.add_argument(f"--profile-directory={directory}")

    chrome_options_module.ChromeOptions = _ProfileOptions


def classify_url(url: str | None) -> str:
    """'gemini' | 'picker' | 'login' | 'other' for the page the browser is showing."""
    u = (url or "").strip().lower()
    if u.startswith("chrome://profile-picker"):
        return "picker"
    if u.startswith("https://gemini.google.com/"):
        return "gemini"
    if u.startswith("https://accounts.google.com/"):
        return "login"
    return "other"


def wait_for_gemini(get_url: Callable[[], str], timeout: float = 30.0, every: float = 0.5,
                    sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic) -> str:
    """Poll the browser's URL until it is Gemini, or a definite dead end (the profile
    picker, a Google login page), or `timeout`. Returns the last classification."""
    deadline = clock() + timeout
    kind = "other"
    while True:
        try:
            kind = classify_url(get_url())
        except Exception:
            kind = "other"
        if kind in ("gemini", "picker", "login") or clock() >= deadline:
            return kind
        sleep(every)


def picker_hint(udd: str, configured: str | None) -> str:
    profiles = read_profiles(udd)
    signed = [p["directory"] for p in profiles if p["signedIn"]]
    if configured:
        return (
            f"Chrome showed its profile picker although profile directory {configured!r} was requested. "
            f"Profiles in {udd}: {describe(profiles)}."
        )
    return (
        f"Chrome opened its profile picker instead of Gemini: {udd} holds {len(profiles)} profiles "
        f"({describe(profiles)}) and none was selected. Set HERMEX_STRUCTURE_PROFILE_DIRECTORY"
        + (f" (signed in: {', '.join(signed)})" if signed else "")
        + "."
    )


def own_browser_pids(ps_output: str, udd: str) -> list[int]:
    """PIDs from `ps -axo pid=,command=` whose command line names exactly this user-data dir."""
    needle = f"--user-data-dir={udd.rstrip(os.sep)}"
    pids = []
    for line in ps_output.splitlines():
        line = line.strip()
        if not line:
            continue
        pid_text, _, command = line.partition(" ")
        idx = command.find(needle)
        if idx < 0:
            continue
        end = idx + len(needle)
        # `/x/chrome_profile` must not match `/x/chrome_profile2` or `/x/chrome_profile/sub`.
        if end < len(command) and not command[end].isspace():
            continue
        try:
            pids.append(int(pid_text))
        except ValueError:
            continue
    return pids


def stop_own_browsers(udd: str, grace: float = 5.0) -> list[int]:
    """Stop Chrome processes left on this user-data dir by a failed launch (SIGTERM,
    then SIGKILL after `grace`). Touches no file and no other browser."""
    try:
        ps = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True, timeout=10).stdout
    except Exception as e:
        _log(f"could not list processes: {e}")
        return []
    pids = [p for p in own_browser_pids(ps, udd) if p != os.getpid()]
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    deadline = time.monotonic() + grace
    alive = list(pids)
    while alive and time.monotonic() < deadline:
        time.sleep(0.25)
        alive = [p for p in alive if _alive(p)]
    for pid in alive:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    if pids:
        _log(f"stopped {len(pids)} leftover browser process(es) on {udd}")
    return pids


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False
