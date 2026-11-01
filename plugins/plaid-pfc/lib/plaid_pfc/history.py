"""Suggest a category from the consumer's own labelled history: exact merchant-key match.

Each past row votes for its category with a weight by where its label came from:
  decision 2.0 (the operator chose it for that row), rule 1.0 (a pattern rule matched),
  provisional 0.5 (a rule whose note marks it as a guess, e.g. "auto ... not confirmed").
Rows still flagged NEEDS_REVIEW carry no label and do not vote.
Confidence = the top category's share of the weight among rows with the same merchant key.
No fuzzy matching here: a merchant never seen before gets no suggestion, and `eval` measures
how often that happens before anything smarter is built.
"""
import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass

from . import merchant, taxonomy
from .models import Evidence, Suggestion

WEIGHTS = {"decision": 2.0, "rule": 1.0, "none": 0.0}
PROVISIONAL_WEIGHT = 0.5
DEFAULT_PROVISIONAL = r"\bauto\b"


@dataclass
class History:
    """One labelled row, as a consumer exports it (beancount: `beancount-kit history`)."""
    key: str
    payee: str
    memo: str
    category: str
    source: str          # decision | rule | none
    ref: str = ""        # the rule's priority, when source is rule
    note: str = ""       # the rule's or decision's note

    @property
    def merchant(self) -> str:
        return merchant.key(self.payee, self.memo)


def read(path) -> list[History]:
    out = []
    with open(path, encoding="utf-8") as fh:
        for i, line in enumerate(fh, 1):
            if line.strip():
                d = json.loads(line)
                try:
                    out.append(History(**{k: d.get(k, "") for k in History.__dataclass_fields__}))
                except TypeError as e:
                    raise ValueError(f"{path}:{i}: {e}") from None
    return out


def weight(h: History, provisional: re.Pattern | None) -> float:
    if h.category == taxonomy.REVIEW_MARKER or not h.category:
        return 0.0
    w = WEIGHTS.get(h.source, 0.0)
    if w and provisional and provisional.search(h.note or ""):
        return PROVISIONAL_WEIGHT
    return w


class Index:
    def __init__(self, rows: list[History], provisional: str | None = DEFAULT_PROVISIONAL):
        rx = re.compile(provisional) if provisional else None
        self.votes: dict[str, Counter] = defaultdict(Counter)
        self.refs: dict[tuple, list[str]] = defaultdict(list)
        for h in rows:
            w = weight(h, rx)
            if w > 0:
                self.votes[h.merchant][h.category] += w
                self.refs[(h.merchant, h.category)].append(h.key)

    def suggest(self, key: str, payee: str, memo: str = "") -> Suggestion | None:
        m = merchant.key(payee, memo)
        votes = self.votes.get(m)
        if not votes or m == merchant.NO_TEXT:
            return None
        (cat, top), total = votes.most_common(1)[0], sum(votes.values())
        ev = [Evidence("history", r, summary=f"same merchant key {m!r}")
              for r in self.refs[(m, cat)][:3]]
        return Suggestion(key=key, category=cat, confidence=round(top / total, 4),
                          method="history-exact", evidence=ev).validate()
