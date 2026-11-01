"""Group flagged entries by merchant, so one decision covers many rows.

There is no open standard that maps a merchant's name to a category: the global code (the
MCC, ISO 18245) travels in the card network's data, not in bank exports (measured 2026-11-01:
0 of 19 QFX files carry OFX's <SIC> field). So the review unit is the merchant. Each group
carries a suggested rule pattern; the operator gives the group a category once, and the
consumer turns that into a category rule. The journal is never written.

Normalisation: the payee (or, when it is empty, the memo's first ";" segment), upper-cased,
with masked references (••1234, ***abc, T••12), numbers and punctuation removed; the group key
is its first two remaining words of 2+ letters.
"""
import csv
import re
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

from .errors import Exit, Refusal

MASKED = re.compile(r"[A-Z]?••\w*|\*{2,}\w*|#\w+", re.I)
WORD = re.compile(r"[A-Z][A-Z&']+")


def merchant(payee: str, narration: str) -> tuple[str, list[str]]:
    text = (payee or "").strip() or (narration or "").split(";")[0]
    words = WORD.findall(MASKED.sub(" ", text.upper()))
    key = words[:2]
    return (" ".join(key) or "(no text)"), key


def pattern(words: list[str]) -> str:
    """Case-insensitive regex for a category rule: the words, in order, as whole words."""
    return r"\b" + r"\b.*\b".join(re.escape(w) for w in words) + r"\b" if words else ""


def groups(journal: Path) -> list[dict]:
    from beancount import loader
    from beancount.core import data

    entries, errors, _ = loader.load_file(str(journal))
    if errors:
        raise Refusal(Exit.REFUSED, f"journal has {len(errors)} errors; rebuild first")
    acc = defaultdict(lambda: {"count": 0, "totals": defaultdict(Decimal), "first": None,
                               "last": None, "sample": "", "accounts": set(), "words": []})
    for e in entries:
        if not (isinstance(e, data.Transaction) and e.flag == "!" and "key" in e.meta):
            continue
        key, words = merchant(e.payee, e.narration)
        g = acc[key]
        own = e.postings[0]
        g["count"] += 1
        g["totals"][own.units.currency] += own.units.number
        d = e.date.isoformat()
        g["first"] = min(g["first"] or d, d)
        g["last"] = max(g["last"] or d, d)
        g["sample"] = g["sample"] or f"{e.payee or ''} || {e.narration or ''}".strip()
        g["accounts"].add(own.account)
        g["words"] = words
    out = []
    for key, g in acc.items():
        out.append({"group": key, "pattern": pattern(g["words"]), "count": g["count"],
                    "total": " ".join(f"{v} {c}" for c, v in sorted(g["totals"].items())),
                    "first": g["first"], "last": g["last"], "sample": g["sample"][:120],
                    "accounts": "|".join(sorted(g["accounts"]))})
    return sorted(out, key=lambda g: (-g["count"], g["group"]))


FIELDS = ("group", "pattern", "count", "total", "first", "last", "sample", "accounts")


def write(rows: list[dict], out) -> None:
    w = csv.DictWriter(out, fieldnames=FIELDS)
    w.writeheader()
    w.writerows(rows)
