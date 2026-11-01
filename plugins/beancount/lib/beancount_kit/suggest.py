"""Suggest a category for every flagged entry, learned from the entries already categorised.

Reuses smart_importer's EntryPredictor (MIT) as a library: its pipeline (narration, payee and
day-of-month features into a linear SVC) with the target swapped from a posting account to
the entry's `category` metadata. smart_importer is built to wrap a beangulp importer; this
journal is built, not imported, so the importer hook does not apply, but the predictor does.

Training data: entries flagged "*" that are not paired transfer legs (a pair's category is
structural, not learned). Prediction: entries flagged "!". The output is a suggestion per
Key for the consumer's decisions table; the journal is never written. A suggestion counts
only once the operator accepts it there.

Measured 2026-11-01 on a real 4.8k-entry journal: 92.9% on a 20% holdout of rule-labelled
entries. Rule-labelled rows are easier than the flagged ones, so that is an upper bound.
"""
import csv
import hashlib
import sys
from pathlib import Path

from .errors import Exit, Refusal


def _predictor():
    try:
        from smart_importer.predictor import EntryPredictor
    except ImportError:
        raise Refusal(Exit.USAGE, "smart_importer is not importable from this interpreter "
                                  "(nix-config: local.beancount.smartImporter = true)") from None

    class PredictCategory(EntryPredictor):
        attribute = "category"
        weights = {"narration": 0.8, "payee": 0.5, "date.day": 0.1}

        @property
        def targets(self):
            return [t.meta["category"] for t in self.training_data]

    return PredictCategory()


def _split(journal: Path):
    from beancount import loader
    from beancount.core import data

    entries, errors, _ = loader.load_file(str(journal))
    if errors:
        raise Refusal(Exit.REFUSED, f"journal has {len(errors)} errors; rebuild first")
    txns = [e for e in entries if isinstance(e, data.Transaction) and "key" in e.meta
            and "category" in e.meta]
    labelled = [t for t in txns if t.flag == "*" and "transfer" not in t.meta]
    flagged = [t for t in txns if t.flag == "!"]
    return labelled, flagged


def _fit(labelled):
    p = _predictor()
    p.define_pipeline()
    p.training_data = labelled
    p.train_pipeline()
    if not p.is_fitted:
        raise Refusal(Exit.REFUSED, "nothing to learn from: no categorised entries")
    return p


def _predict(p, txns):
    if len(set(p.targets)) == 1:
        return [p.targets[0]] * len(txns)
    return list(p.pipeline.predict(txns)) if txns else []


def evaluate(journal: Path) -> dict:
    """Deterministic 20% holdout by Key hash: how often the suggestion equals the category."""
    labelled, _ = _split(journal)
    held = lambda t: int(hashlib.sha256(t.meta["key"].encode()).hexdigest(), 16) % 5 == 0
    train = [t for t in labelled if not held(t)]
    test = [t for t in labelled if held(t)]
    if not test:
        raise Refusal(Exit.REFUSED, "too few categorised entries to hold any out")
    pred = _predict(_fit(train), test)
    hits = sum(a == t.meta["category"] for a, t in zip(pred, test))
    return {"labelled": len(labelled), "train": len(train), "holdout": len(test),
            "accuracy": round(hits / len(test), 4)}


def suggest(journal: Path, out) -> dict:
    labelled, flagged = _split(journal)
    pred = _predict(_fit(labelled), flagged)
    w = csv.writer(out)
    w.writerow(["key", "suggestion"])
    for t, c in sorted(zip(flagged, pred), key=lambda x: (x[0].date, x[0].meta["key"])):
        w.writerow([t.meta["key"], c])
    return {"trained_on": len(labelled), "suggested": len(flagged),
            "classes": len(set(t.meta["category"] for t in labelled))}
