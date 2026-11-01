"""Fava on demand: read-only, loopback only, one instance, tracked by a PID file."""
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path


def state_dir() -> Path:
    base = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    d = Path(base) / "beancount-kit"
    d.mkdir(parents=True, exist_ok=True)
    return d


def fava_bin() -> str | None:
    py = os.environ.get("BEANCOUNT_PYTHON")
    if py:
        sib = Path(py).parent / "fava"
        if sib.exists():
            return str(sib)
    return shutil.which("fava")


def _pid() -> int | None:
    f = state_dir() / "fava.pid"
    try:
        pid = int(f.read_text().strip())
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError):
        f.unlink(missing_ok=True)
        return None


def port() -> int:
    return int(os.environ.get("FAVA_PORT", "5000"))


def status() -> int:
    pid = _pid()
    if pid:
        print(f"fava: running, pid {pid}, http://127.0.0.1:{port()}/")
        return 0
    print("fava: not running")
    return 3


def start(journal: str) -> int:
    if _pid():
        return status()
    exe = fava_bin()
    if not exe:
        print("fava: not installed (no BEANCOUNT_PYTHON sibling, none on PATH)", file=sys.stderr)
        return 2
    if not Path(journal).exists():
        print(f"fava: journal not found: {journal}", file=sys.stderr)
        return 2
    log = (state_dir() / "fava.log").open("ab")
    # --poll-watcher: the journal may sit on a synced (FUSE-like) folder where file events are
    # unreliable. --read-only: the journal is derived; an edit through Fava would be lost.
    p = subprocess.Popen([exe, "--read-only", "--host", "127.0.0.1", "--port", str(port()),
                          "--poll-watcher", journal],
                         stdout=log, stderr=log, stdin=subprocess.DEVNULL,
                         start_new_session=True)
    (state_dir() / "fava.pid").write_text(str(p.pid))
    time.sleep(2)
    if p.poll() is not None:
        print(f"fava: exited at start, see {state_dir() / 'fava.log'}", file=sys.stderr)
        (state_dir() / "fava.pid").unlink(missing_ok=True)
        return 3
    return status()


def stop() -> int:
    pid = _pid()
    if not pid:
        print("fava: not running")
        return 0
    os.killpg(pid, signal.SIGTERM)
    (state_dir() / "fava.pid").unlink(missing_ok=True)
    print(f"fava: stopped pid {pid}")
    return 0
