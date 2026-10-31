"""Append-only sha256 manifest: skip files already extracted. Speed only.

Dedupe never depends on it (that is always by key), so a lost or stale manifest costs time,
never correctness. One JSON object per line; the last line for a sha256 wins.
"""
import json
from pathlib import Path


def load(path: Path | None) -> dict[str, dict]:
    seen: dict[str, dict] = {}
    if path is None or not path.exists():
        return seen
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rec = json.loads(line)
            seen[rec["sha256"]] = rec
    return seen


def append(path: Path | None, entries: list[dict]) -> None:
    if path is None or not entries:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, sort_keys=True, ensure_ascii=False) + "\n")
