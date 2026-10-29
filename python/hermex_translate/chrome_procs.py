"""Chrome processes and lock files of ONE user-data directory — found and cleaned safely.

Translation and OCR each drive their own Chrome on their own user-data directory, often
at the same time on one box. Recovery after a failed launch must never touch the other
workflow's browser, an unrelated Chrome, or a live browser's lock files. So, by default
and with no environment switch:

  * a process is "ours" only if its executable is Chrome/Chromium AND one of its
    arguments is exactly `--user-data-dir=<this directory>` (canonical paths). A shell,
    a grep or a monitor whose command line merely mentions the path never matches;
  * a ChromeDriver is "ours" only if it is a child of the calling process — a driver
    whose owner cannot be proven is left alone;
  * the calling process and its ancestors are never candidates;
  * `Singleton*` files are removed only when the owner recorded in `SingletonLock`
    (host-pid) is on this host and verifiably dead, and no browser on this directory is
    alive. Anything uncertain is left in place and reported.
"""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Callable, Iterable

SINGLETON_FILES = ("SingletonLock", "SingletonSocket", "SingletonCookie")


@dataclass(frozen=True)
class Proc:
    pid: int
    ppid: int
    argv: tuple[str, ...]
    # Raw command line when argv could not be split reliably (`ps` fallback).
    raw: str = ""


def _log(msg: str) -> None:
    print(f"[hermex-procs] {msg}", file=sys.stderr, flush=True)


def canonical(path: str) -> str:
    return os.path.realpath(os.path.expanduser(path)).rstrip(os.sep) or os.sep


def list_processes() -> list[Proc]:
    """Every process with its exact argv (Linux /proc), or `ps` output elsewhere."""
    procs: list[Proc] = []
    if os.path.isdir("/proc/self"):
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            pid = int(entry)
            try:
                with open(f"/proc/{pid}/cmdline", "rb") as f:
                    argv = tuple(a.decode("utf-8", "replace") for a in f.read().split(b"\0") if a)
                with open(f"/proc/{pid}/stat", "rb") as f:
                    stat = f.read().decode("utf-8", "replace")
                ppid = int(stat.rsplit(")", 1)[1].split()[1])
            except (OSError, ValueError, IndexError):
                continue
            if argv:
                procs.append(Proc(pid, ppid, argv))
        return procs
    try:
        out = subprocess.run(["ps", "-axo", "pid=,ppid=,args="], capture_output=True, text=True, timeout=10).stdout
    except Exception as e:  # pragma: no cover - environment problem
        _log(f"could not list processes: {e}")
        return []
    return parse_ps(out)


def parse_ps(text: str) -> list[Proc]:
    procs = []
    for line in text.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) < 3:
            continue
        try:
            procs.append(Proc(int(parts[0]), int(parts[1]), (), parts[2]))
        except ValueError:
            continue
    return procs


def _executable(proc: Proc) -> str:
    if proc.argv:
        return proc.argv[0]
    # `ps` joins argv with spaces. A macOS app bundle path can contain spaces
    # ("Google Chrome.app/Contents/MacOS/Google Chrome"): take it up to the first flag.
    # Anything else: the first token.
    head = proc.raw.split(" --", 1)[0].strip()
    if ".app/Contents/" in head:
        return head
    return proc.raw.split(None, 1)[0] if proc.raw.strip() else ""


def is_chrome(proc: Proc) -> bool:
    base = os.path.basename(_executable(proc)).lower()
    if "chromedriver" in base:
        return False
    return "chrome" in base or "chromium" in base


def is_chromedriver(proc: Proc) -> bool:
    return "chromedriver" in os.path.basename(_executable(proc)).lower()


def user_data_dir_of(proc: Proc) -> str | None:
    prefix = "--user-data-dir="
    if proc.argv:
        for arg in proc.argv[1:]:
            if arg.startswith(prefix):
                return arg[len(prefix):]
        return None
    idx = proc.raw.find(" " + prefix)
    if idx < 0:
        return None
    rest = proc.raw[idx + 1 + len(prefix):]
    # A following argument starts with " --"; the path itself may contain spaces.
    return rest.split(" --", 1)[0].strip()


def protected_pids(procs: Iterable[Proc], me: int | None = None) -> set[int]:
    """This process and its ancestors: never a kill candidate."""
    me = os.getpid() if me is None else me
    parent = {p.pid: p.ppid for p in procs}
    seen = {me}
    cur = me
    while cur in parent and parent[cur] not in seen and parent[cur] > 1:
        cur = parent[cur]
        seen.add(cur)
    return seen


def browser_pids(udd: str, procs: list[Proc], me: int | None = None) -> list[int]:
    """Chrome processes launched on exactly this user-data directory."""
    target = canonical(udd)
    skip = protected_pids(procs, me)
    out = []
    for p in procs:
        if p.pid in skip or not is_chrome(p):
            continue
        value = user_data_dir_of(p)
        if value is not None and canonical(value) == target:
            out.append(p.pid)
    return sorted(out)


def owned_driver_pids(procs: list[Proc], me: int | None = None) -> list[int]:
    """ChromeDrivers started by THIS process (undetected_chromedriver runs them as children)."""
    me = os.getpid() if me is None else me
    return sorted(p.pid for p in procs if p.ppid == me and is_chromedriver(p))


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, owned by someone else


def terminate(pids: list[int], grace: float = 5.0, kill: Callable[[int, int], None] = os.kill,
              alive: Callable[[int], bool] = _alive) -> list[int]:
    """SIGTERM, then SIGKILL whatever is left after `grace`. Returns the pids signalled."""
    signalled = []
    for pid in pids:
        try:
            kill(pid, signal.SIGTERM)
            signalled.append(pid)
        except OSError:
            pass
    deadline = time.monotonic() + grace
    remaining = list(signalled)
    while remaining and time.monotonic() < deadline:
        time.sleep(0.2)
        remaining = [p for p in remaining if alive(p)]
    for pid in remaining:
        try:
            kill(pid, signal.SIGKILL)
        except OSError:
            pass
    return signalled


def singleton_owner(udd: str) -> tuple[str, int] | None:
    """(host, pid) recorded in `SingletonLock` — a symlink to "<host>-<pid>"."""
    try:
        target = os.readlink(os.path.join(udd, "SingletonLock"))
    except OSError:
        return None
    host, sep, pid = target.rpartition("-")
    if not sep:
        return None
    try:
        return host, int(pid)
    except ValueError:
        return None


def remove_stale_singletons(udd: str, procs: list[Proc] | None = None,
                            alive: Callable[[int], bool] = _alive,
                            hostname: str | None = None) -> tuple[list[str], str]:
    """Remove Chrome's Singleton* files only when nothing can be using them.

    Returns (removed file names, reason). Kept when: a browser on this directory is
    alive; the lock names another host; or its owner pid is alive."""
    names = [n for n in SINGLETON_FILES if os.path.lexists(os.path.join(udd, n))]
    if not names:
        return [], "no singleton files"
    procs = list_processes() if procs is None else procs
    live = browser_pids(udd, procs)
    if live:
        return [], f"kept: browser still running on this profile (pids {live})"
    owner = singleton_owner(udd)
    host = hostname or socket.gethostname()
    if owner is not None:
        owner_host, owner_pid = owner
        if owner_host != host:
            return [], f"kept: lock belongs to host {owner_host!r}"
        if alive(owner_pid):
            return [], f"kept: lock owner pid {owner_pid} is alive"
    removed = []
    for name in names:
        try:
            os.remove(os.path.join(udd, name))
            removed.append(name)
        except OSError as e:
            _log(f"could not remove {name} from {udd}: {e}")
    return removed, "owner verified dead" if owner else "no recorded owner and no browser alive"


def cleanup_profile(data_dir: str, grace: float = 5.0) -> dict:
    """Recovery after a failed launch, scoped to ONE hermex data dir.

    The caller must hold that profile's single-flight lock: with it held, a Chrome on
    this directory cannot belong to a live session of the same workflow, so it is an
    orphan of a failed launch. Stops those browsers and this process's own drivers,
    then removes stale Singleton* files only once nothing is using them."""
    base = data_dir.rstrip(os.sep)
    udds = [os.path.join(base, "chrome_profile"), base]
    procs = list_processes()
    browsers = sorted({pid for udd in udds for pid in browser_pids(udd, procs)})
    drivers = owned_driver_pids(procs)
    if browsers or drivers:
        _log(f"stopping {len(browsers)} browser process(es) on this profile and {len(drivers)} own driver(s)")
    terminate(browsers + drivers, grace=grace)
    procs = list_processes()
    singletons = {udd: remove_stale_singletons(udd, procs) for udd in udds if os.path.isdir(udd)}
    for udd, (removed, why) in singletons.items():
        if removed:
            _log(f"removed {', '.join(removed)} from {udd} ({why})")
        elif not why.startswith("no singleton"):
            _log(f"left singleton files in {udd}: {why}")
    return {"browsers": browsers, "drivers": drivers, "singletons": {k: v[0] for k, v in singletons.items()}}


def current_page_url(udd: str, procs: list[Proc] | None = None, timeout: float = 2.0) -> str | None:
    """URL of the first tab of the browser running on this user-data dir, read from its
    local DevTools endpoint (`/json/list`, a plain GET: no session, no input). None when
    no such browser is running or it does not answer."""
    import json
    import urllib.request

    procs = list_processes() if procs is None else procs
    target = canonical(udd)
    for p in procs:
        if not is_chrome(p) or (user_data_dir_of(p) is None) or canonical(user_data_dir_of(p) or "") != target:
            continue
        args = p.argv or tuple(p.raw.split(" --"))
        if any(a.lstrip("-").startswith("type=") for a in args):
            continue  # a renderer/helper, not the browser process
        port = next((a.split("=", 1)[1] for a in args if a.lstrip("-").startswith("remote-debugging-port=")), None)
        if not port or not port.strip().isdigit():
            continue
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port.strip()}/json/list", timeout=timeout) as r:
                tabs = json.load(r)
        except Exception:
            return None
        for tab in tabs:
            if tab.get("type") == "page":
                return str(tab.get("url") or "")
        return None
    return None


def main(argv: list[str]) -> int:
    """Operator tool — the replacement for `pkill -f chromedriver`.

      python chrome_procs.py <hermex data dir>                    list only (default)
      python chrome_procs.py <hermex data dir> --stop --lock <f>  stop this profile's leftover
                                                                  Chrome, clear stale locks

    `--stop` first takes the workflow's single-flight lock (`--lock`), so it refuses
    while a worker is using the profile, and never touches another profile's browser."""
    import argparse

    parser = argparse.ArgumentParser(prog="chrome_procs.py")
    parser.add_argument("data_dir")
    parser.add_argument("--stop", action="store_true")
    parser.add_argument("--lock")
    args = parser.parse_args(argv)
    base = args.data_dir.rstrip(os.sep)
    procs = list_processes()
    for udd in (os.path.join(base, "chrome_profile"), base):
        owner = singleton_owner(udd)
        print(f"{udd}: browser pids {browser_pids(udd, procs)}; SingletonLock owner {owner or 'none'}")
    if not args.stop:
        return 0
    if not args.lock:
        print("--stop needs --lock <the workflow's lock file> (translation: <HERMEX_DIR or profile parent>/.hermex.lock; OCR: <profile>.lock)")
        return 2
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import translate_cli

    lock = translate_cli._ProfileLock(args.lock)
    try:
        lock.acquire()
    except translate_cli.HermexBusyError as e:
        print(f"refused: {e}")
        return 3
    try:
        print(cleanup_profile(base))
    finally:
        lock.release()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
