"""Category rules and transfer pairing.

A port of agentic-ledger's categorize.py, kept behaviour-identical so its pairs are the oracle:
the same rule semantics, the same candidate kinds and windows, the same float tolerances, the
same greedy order. Its Sheet-row tiebreak becomes Row.n, the position after sorting by
(date, key); run the oracle on rows in that order and the two agree pair for pair.

Rules CSV header (the consumer's "Category rules" tab):
  priority, match_field, pattern, institution, account, counterparty, sign, category, note,
  date_from, date_to
  match_field  payee | memo | both          sign  any | in | out (zero matches every sign)
  institution / account  optional "|"-separated exact values
  counterparty  ""   -> not a transfer
                "EXT" -> to/from an own account outside the journal, never paired
                "A|B" -> own account labels to pair against; "OWN" -> any label present
                trailing "!" -> the category holds only if the row pairs, else NEEDS_REVIEW
A row no rule matches is NEEDS_REVIEW.

Decisions (one per Key) apply BEFORE pairing: a decided row takes the decided category and is
never paired. Undoing a pair is therefore a decision, and a decision can never contradict one.
"""
import collections
import csv
import re
from pathlib import Path

from .errors import Exit, Refusal
from .inputs import CATEGORY_RE, Row

NEEDS_REVIEW = "NEEDS_REVIEW"
CONV = re.compile(r"([\d.,]+) ([A-Z]{3}) to ([\d.,]+) ([A-Z]{3})")


def load_rules(path: Path) -> list[dict]:
    try:
        with path.open(newline="", encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh))
    except OSError as e:
        raise Refusal(Exit.USAGE, f"rules: {e}") from None
    rules, bad = [], []
    for ru in rows:
        if not (ru.get("pattern") or "").strip():
            continue
        cat = ru["category"].strip()
        if not CATEGORY_RE.match(cat):
            bad.append(ru.get("priority", "?"))
            continue
        cp = (ru.get("counterparty") or "").strip()
        rules.append(dict(
            prio=float(ru["priority"]), field=(ru.get("match_field") or "both").strip(),
            rx=re.compile(ru["pattern"], re.I), cat=cat,
            inst=set(filter(None, (ru.get("institution") or "").split("|"))),
            acct=set(filter(None, (ru.get("account") or "").split("|"))),
            sign=(ru.get("sign") or "any").strip(),
            df=(ru.get("date_from") or "").strip(), dt=(ru.get("date_to") or "").strip(),
            must_pair=cp.endswith("!"), cp=cp.rstrip("!")))
    if bad:
        raise Refusal(Exit.USAGE, "rules: category is not a Plaid DETAILED value (priority)", bad)
    rules.sort(key=lambda r: r["prio"])
    return rules


def match(x: Row, rules: list[dict]) -> dict | None:
    for ru in rules:
        if ru["inst"] and x.inst not in ru["inst"]:
            continue
        if ru["acct"] and x.acct not in ru["acct"]:
            continue
        if x.amt != 0 and ru["sign"] != "any" and ru["sign"] != ("in" if x.amt > 0 else "out"):
            continue
        if ru["df"] and x.iso < ru["df"] or ru["dt"] and x.iso > ru["dt"]:
            continue
        t = x.payee if ru["field"] == "payee" else x.memo if ru["field"] == "memo" else x.text
        if ru["rx"].search(t):
            return ru
    return None


def categorise(rows: list[Row], rules: list[dict], decisions: dict, tr) -> dict:
    """Set cat / cps / pair on every row. Returns counters for the report."""
    own = {x.acct for x in rows}
    unknown = sorted(set(decisions) - {x.key for x in rows})
    if unknown:
        raise Refusal(Exit.REFUSED, "decisions name Keys no input carries", unknown)

    for x in rows:
        x.decision = decisions.get(x.key)
        if x.decision and x.decision["override"]:
            x.rule, x.cat, x.cps = None, x.decision["override"], set()
            continue
        ru = match(x, rules)
        x.rule, x.cat = ru, (ru["cat"] if ru else NEEDS_REVIEW)
        cp = ru["cp"] if ru else ""
        x.cps = set() if cp in ("", "EXT") else (own if cp == "OWN" else set(cp.split("|")) & own)

    lo, hi = tr.window
    wide = re.compile(tr.wide_pattern, re.I) if tr.wide_pattern else None
    outs = [x for x in rows if x.cps and x.amt < 0]
    by_acct = collections.defaultdict(list)
    for y in rows:
        if y.cps and y.amt > 0:
            by_acct[y.acct].append(y)

    cands = []
    for o in outs:
        for acct in o.cps - {o.acct}:
            for y in by_acct.get(acct, []):
                if o.acct not in y.cps:
                    continue
                dd = (y.date - o.date).days
                a_, b_ = -o.amt, y.amt
                co, cy = CONV.search(o.payee), CONV.search(y.payee)
                if co or cy:
                    if co and cy and co.groups() == cy.groups() and dd == 0:
                        cands.append((0, 0.0, o.n, y.n, o, y, "conversion"))
                    continue
                if y.cur != o.cur:
                    band = tr.fx.get(y.cur)
                    if band and -3 <= dd <= 3 and band[0] <= b_ / a_ <= band[1]:
                        cands.append((abs(dd), 0.5, o.n, y.n, o, y, "cross-currency"))
                    continue
                feeish = o.inst in tr.fee_institutions or y.inst in tr.fee_institutions
                if wide and (wide.search(o.memo) or wide.search(y.memo)):
                    w = (-6, 6)
                elif feeish:
                    w = (-tr.early_days, max(hi, 3))
                else:
                    w = (lo, hi)
                if not (w[0] <= dd <= w[1]):
                    continue
                if abs(a_ - b_) < 0.005:
                    cands.append((abs(dd), 0.0, o.n, y.n, o, y, "exact"))
                elif feeish and 0 < a_ - b_ <= tr.fee_max * b_ + 0.005:
                    cands.append((abs(dd), a_ - b_, o.n, y.n, o, y, "fee"))
    cands.sort(key=lambda c: c[:4])
    kinds = collections.Counter()
    for *_, o, y, kind in cands:
        if o.pair or y.pair:
            continue
        o.pair, y.pair, o.pair_kind, y.pair_kind = y, o, kind, kind
        kinds[kind] += 1

    unpaired_must = 0
    for x in rows:
        if x.rule and x.rule["must_pair"] and not x.pair:
            x.cat, x.cps = NEEDS_REVIEW, set()
            unpaired_must += 1
    return {"pairs": dict(kinds), "unpaired_must_pair": unpaired_must,
            "review": sum(1 for x in rows if x.cat == NEEDS_REVIEW)}
