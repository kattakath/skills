"""Plaid PFC names, read from the `plaid-pfc` plugin's pinned list: one source of truth.

The two plugins share data, not code, as statement-extract and beancount do: this module reads
`plaid-pfc`'s `data/pfc-v2.json` from its install path (Claude Code's installed_plugins.json),
so both ship on the same release rail. `PLAID_PFC_DATA` names the file directly (tests, CI, or
a machine without Claude Code). A missing pin refuses; it never falls back to a guess.
"""
import json
import os
from functools import lru_cache
from pathlib import Path

from .errors import Exit, Refusal

REVIEW_MARKER = "NEEDS_REVIEW"
REGISTRY = Path.home() / ".claude" / "plugins" / "installed_plugins.json"


def locate() -> Path:
    env = os.environ.get("PLAID_PFC_DATA")
    if env:
        return Path(env)
    try:
        plugins = json.loads(REGISTRY.read_text(encoding="utf-8")).get("plugins", {})
    except (OSError, ValueError):
        plugins = {}
    for key, installs in sorted(plugins.items()):
        if key.split("@", 1)[0] == "plaid-pfc" and installs:
            return Path(installs[0]["installPath"]) / "data" / "pfc-v2.json"
    raise Refusal(Exit.USAGE, "plaid-pfc not found: install the plaid-pfc plugin, or set "
                              "PLAID_PFC_DATA to its data/pfc-v2.json")


@lru_cache(maxsize=None)
def pin() -> dict:
    path = locate()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        data["detailed"] and data["primary"]
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise Refusal(Exit.USAGE, f"plaid-pfc pin unreadable at {path}: {e}") from None
    return data


def names() -> frozenset:
    return frozenset(d["name"] for d in pin()["detailed"])


def primaries() -> list[str]:
    """Longest first, so a prefix match picks the most specific group."""
    return sorted(pin()["primary"], key=len, reverse=True)


def unknown(values) -> list[str]:
    """Distinct values that are neither a pinned detailed name nor the review marker."""
    ok, seen, out = names(), set(), []
    for v in values:
        if v and v not in seen:
            seen.add(v)
            if v != REVIEW_MARKER and v not in ok:
                out.append(v)
    return out
