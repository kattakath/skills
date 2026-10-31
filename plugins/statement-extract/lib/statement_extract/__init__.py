"""statement-extract: deterministic, reconcile-gated statement extraction.

Stdlib only, Python >= 3.11. Every record on stdout carries SCHEMA; changes within /1 are
additive only, because every merge to the marketplace's main is a release.
"""
import hashlib
from pathlib import Path

SCHEMA = "statement-extract/1"
PACKAGE_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = PACKAGE_DIR.parent.parent
ADAPTERS_DIR = PLUGIN_ROOT / "adapters"


def engine_version() -> str:
    """sha256 over the engine's own sources, so a record names the exact code that made it.

    Content-derived rather than a hand-bumped string: this plugin has no `version` field and
    every commit on main ships, so a manual number would drift silently.
    """
    h = hashlib.sha256()
    for p in sorted(PACKAGE_DIR.rglob("*.py")):
        h.update(p.relative_to(PACKAGE_DIR).as_posix().encode())
        h.update(b"\0")
        h.update(p.read_bytes())
        h.update(b"\0")
    return "sha256:" + h.hexdigest()[:16]
