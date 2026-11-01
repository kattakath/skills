"""How good is a suggester on the consumer's own rows? Two honest numbers, counts only.

- seen:   a deterministic 20% of rows held out by row Key; the merchant may appear in training.
          What recurring spending gets.
- unseen: a deterministic 20% of MERCHANTS held out, every row of each; the merchant is never
          in training. What the long tail gets, and the number the design is about.
Rows whose label is provisional (a guess; see history.DEFAULT_PROVISIONAL) are never scored:
a suggester that agrees with a guess has not been shown right. They may still train.
Results are split by the held-out row's label source (decision / rule), because the big
transfer rules would otherwise swamp the rows that needed a human.
"""
import hashlib
import re

from . import taxonomy
from .history import DEFAULT_PROVISIONAL, History, Index

THRESHOLDS = (0.0, 0.5, 0.8, 0.9, 1.0)
BUCKETS = 5


def _bucket(s: str) -> int:
    return int(hashlib.sha256(s.encode("utf-8")).hexdigest(), 16) % BUCKETS


def _labelled(h: History) -> bool:
    return bool(h.category) and h.category != taxonomy.REVIEW_MARKER and h.source in ("decision", "rule")


def split(rows: list[History], mode: str) -> tuple[list[History], list[History]]:
    if mode == "seen":
        test = [h for h in rows if _bucket("row:" + h.key) == 0]
    elif mode == "unseen":
        test = [h for h in rows if _bucket("merchant:" + h.merchant) == 0]
    else:
        raise ValueError(f"mode {mode!r}: seen or unseen")
    held = {h.key for h in test}
    return [h for h in rows if h.key not in held], test


def score(rows: list[History], provisional: str | None = DEFAULT_PROVISIONAL, show: bool = False) -> dict:
    rx = re.compile(provisional) if provisional else None
    out = {"rows": len(rows), "labelled": sum(_labelled(h) for h in rows),
           "provisional_excluded_from_test": 0, "modes": {}, "misses": []}
    for mode in ("seen", "unseen"):
        train, test = split(rows, mode)
        idx = Index(train, provisional)
        strata = {}
        for h in test:
            if not _labelled(h):
                continue
            if rx and rx.search(h.note or ""):
                if mode == "seen":
                    out["provisional_excluded_from_test"] += 1
                continue
            s = idx.suggest(h.key, h.payee, h.memo)
            for name in ("all", h.source):
                st = strata.setdefault(name, {"n": 0, **{f"{t}": [0, 0] for t in THRESHOLDS}})
                st["n"] += 1
                for t in THRESHOLDS:
                    if s and s.confidence >= t:
                        st[f"{t}"][0] += 1
                        st[f"{t}"][1] += s.category == h.category
            if show and s and s.category != h.category:
                out["misses"].append({"mode": mode, "key": h.key, "merchant": h.merchant,
                                      "truth": h.category, "suggested": s.category,
                                      "confidence": s.confidence})
        out["modes"][mode] = {
            name: {"n": st["n"], **{f">={t}": {"answered": a, "correct": c,
                                               "coverage": round(a / st["n"], 4) if st["n"] else 0,
                                               "precision": round(c / a, 4) if a else None}
                                   for t, (a, c) in ((t, st[f"{t}"]) for t in THRESHOLDS)}}
            for name, st in sorted(strata.items())}
    if not show:
        out.pop("misses")
    return out


def table(result: dict) -> str:
    lines = [f"rows {result['rows']}, labelled {result['labelled']}, provisional (not scored) "
             f"{result['provisional_excluded_from_test']}",
             f"{'mode':7s} {'stratum':9s} {'n':>6s}  " + "  ".join(f"{'>=' + str(t):>15s}" for t in THRESHOLDS),
             f"{'':7s} {'':9s} {'':>6s}  " + "  ".join(f"{'cov / prec':>15s}" for _ in THRESHOLDS)]
    for mode, strata in result["modes"].items():
        for name, st in strata.items():
            cells = []
            for t in THRESHOLDS:
                c = st[f">={t}"]
                p = "—" if c["precision"] is None else f"{c['precision']:.1%}"
                cells.append(f"{c['coverage']:.1%} / {p}".rjust(15))
            lines.append(f"{mode:7s} {name:9s} {st['n']:6d}  " + "  ".join(cells))
    return "\n".join(lines)
