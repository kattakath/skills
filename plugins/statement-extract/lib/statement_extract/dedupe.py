"""In-run dedupe by key, and the --seen file.

Same key + same payload  -> kept once, counted dup_in_run (overlapping exports, or one
                            statement delivered twice with different bytes).
Same key, other payload  -> a collision: exit 3 naming both locators. Never pick one.
"""
from pathlib import Path

from .model import Exit, Refusal

# Fields that legitimately differ between two deliveries of the same transaction.
VOLATILE = ("statement_id", "source")


def payload(rec: dict) -> dict:
    return {k: v for k, v in rec.items() if k not in VOLATILE}


def load_seen(path: Path | None) -> set[str]:
    """One key per line. splitlines(), never split(): content keys contain spaces."""
    if path is None:
        return set()
    return {line for line in path.read_text(encoding="utf-8").splitlines() if line}


def append_seen(path: Path, keys: list[str]) -> None:
    with path.open("a", encoding="utf-8") as f:
        for k in keys:
            f.write(k + "\n")


class Deduper:
    def __init__(self, seen: set[str]):
        self.seen = seen
        self.kept: dict[str, dict] = {}

    def offer(self, rec: dict) -> str:
        """-> 'seen' | 'dup' | 'new'. Raises Refusal on a collision."""
        key = rec["key"]
        if key in self.seen:
            return "seen"
        prior = self.kept.get(key)
        if prior is None:
            self.kept[key] = rec
            return "new"
        if payload(prior) == payload(rec):
            return "dup"
        a, b = prior["source"], rec["source"]
        raise Refusal(Exit.REFUSED, "key collision: same key, different payload",
                      first=f"{a['file']}#{a['locator']}", second=f"{b['file']}#{b['locator']}")
