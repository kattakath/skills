"""Survivorship: when statements of one account overlap, which source owns each day.

Every statement file goes into the cache; the build decides. Rules (MDM "source precedence"):
  - A statement's RANK comes from its format: a bank export with native IDs (QFX/OFX FITIDs,
    a CSV's own transaction IDs) ranks 0; a PDF, whose Keys are built from content, ranks 1.
  - Within one rank, sources are unioned and the Key dedupes them. A re-export from the same
    bank carries the same IDs, and a late-posted row a later download adds is kept.
  - Across ranks, each DAY of an account belongs to the best rank whose statements cover it.
    A lower-rank row on an owned day is dropped; on a day nothing better covers, it is kept.
    So a PDF fills exactly the days the QFX lacks, cut at whole-day boundaries.
  - A dropped row is not forgotten: it is matched (date, amount; each kept row at most once)
    to the kept row it duplicates, and its statement is recorded as printing that row. The
    dropped statement's printed closing therefore stays a strict balance assertion, and a PDF
    and a QFX that disagree about what happened fail the build instead of passing silently.

Why not match rows across sources by a date window and amount (beangulp's
`heuristic_comparator`, beancount-import's matcher)? Banks post identical charges on one day;
a fuzzy matcher merges them. Day ownership never compares two rows of the same source.

Holes: days between an account's covered stretches. No source can invent the rows missing
there; `holes()` lists them so the journal can bridge each one with a labelled pad.
"""
import collections
from datetime import date, timedelta
from decimal import Decimal

def rank(stmt: dict) -> int:
    """statement-extract's formats are ofx, pdftext and csv (registry.FORMATS); any PDF
    driver ranks below a bank export."""
    return 1 if (stmt.get("source") or {}).get("format", "").lower().startswith("pdf") else 0


def window(stmt: dict, rows: list[dict]) -> tuple[str, str] | None:
    """The days a statement covers: its printed period, else the span of its own rows."""
    ds = [r["booking_date"] for r in rows]
    lo = stmt["period"].get("start") or (min(ds) if ds else None)
    hi = stmt["period"].get("end") or (max(ds) if ds else None)
    if not (lo and hi):
        return None
    return (lo, hi) if lo <= hi else (hi, lo)


def _covered(iso: str, spans) -> bool:
    return any(lo <= iso <= hi for lo, hi in spans)


def resolve(stmts: dict, rows: list[dict], acct_of) -> tuple[list[dict], dict, list[dict]]:
    """(kept rows, twins {kept Key: {statement_id of a dropped duplicate}}, dropped summary).
    `acct_of(stmt)` names the account a statement belongs to."""
    by_stmt = collections.defaultdict(list)
    for r in rows:
        by_stmt[r["statement_id"]].append(r)
    by_acct = collections.defaultdict(list)
    for sid, s in stmts.items():
        by_acct[acct_of(s)].append(s)

    kept, twins, dropped = [], collections.defaultdict(set), []
    for acct, ss in by_acct.items():
        owned = []                      # spans claimed by better ranks
        pool = collections.defaultdict(list)   # (date, amount) -> kept rows, for twins
        for rk in sorted({rank(s) for s in ss}):
            tier = [s for s in ss if rank(s) == rk]
            spans = []
            for s in sorted(tier, key=lambda s: s["statement_id"]):
                rs = by_stmt.get(s["statement_id"], [])
                w = window(s, rs)
                if w:
                    spans.append(w)
                lost = []
                for r in rs:
                    if owned and _covered(r["booking_date"], owned):
                        lost.append(r)
                    else:
                        kept.append(r)
                        pool[(r["booking_date"], Decimal(r["amount"]))].append(r["key"])
                if lost:
                    for r in lost:
                        cands = pool.get((r["booking_date"], Decimal(r["amount"])))
                        if cands:
                            twins[cands.pop(0)].add(s["statement_id"])
                    ds = sorted(r["booking_date"] for r in lost)
                    dropped.append({"account": acct, "statement_id": s["statement_id"],
                                    "file": (s.get("source") or {}).get("file", ""),
                                    "rows": len(lost), "from": ds[0], "to": ds[-1]})
            owned += spans
    return kept, dict(twins), dropped


def holes(stmts: dict, rows: list[dict], acct_of) -> list[dict]:
    """Per account, stretches of more than one day that no statement covers, between the
    first and last covered day: [{account, after, before, days}]."""
    by_stmt = collections.defaultdict(list)
    for r in rows:
        by_stmt[r["statement_id"]].append(r)
    spans = collections.defaultdict(list)
    for sid, s in stmts.items():
        w = window(s, by_stmt.get(sid, []))
        if w:
            spans[acct_of(s)].append(w)
    out = []
    for acct, ws in spans.items():
        ws.sort()
        hi = ws[0][1]
        for lo2, hi2 in ws[1:]:
            gap = (date.fromisoformat(lo2) - date.fromisoformat(hi)).days
            if gap > 1:
                out.append({"account": acct, "after": hi, "before": lo2, "days": gap - 1})
            hi = max(hi, hi2)
    return sorted(out, key=lambda h: (h["account"], h["after"]))


def day_after(iso: str) -> str:
    return (date.fromisoformat(iso) + timedelta(days=1)).isoformat()
