"""Completeness and occurrence over the canonical JSONL: no gaps, no double counting.

Audit language: *completeness* (every transaction is recorded) and *occurrence* (every recorded
transaction happened, once). The usual technique is statement continuity: each statement's
opening equals the previous closing, and the periods join. No off-the-shelf Beancount plugin
checks statement continuity (searched 2026-11-01); `noduplicates` covers exact duplicate
entries only.

Per account (institution + label):
  - periods: distinct (start, end) statement periods, sorted; re-downloads collapse
  - balance breaks: next opening != previous closing, where both are printed  -> FAIL
    (checked even when a statement prints no start date, e.g. Desjardins PDFs: periods are
    ordered by end date; such a statement can't be checked for holes or overlap by period)
  - date holes: more than one day between one period's end and the next's start -> WARN;
    a balance that moves across a hole is BRIDGED (the build pads it from Equity:Gaps), not
    a break: only adjoining statements must chain
    (statement boundaries leave such days; rows dated on them sit in the next statement, and
    an unbroken balance chain or a passing journal assertion proves nothing is missing)
  - coverage: first and last date the files cover; history before it was never fetched
Across files:
  - one Key, different date or amount                                          -> FAIL
  - one Key in several files (overlapping downloads)                           -> counted once
  - look-alikes: same account, date, amount and description, different Keys    -> listed
    (banks do post identical charges; a passing balance assertion means the bank has them)
  - survivorship first (survive.py): a PDF row on a day a bank export already covers is
    dropped by the build, so it is reported as resolved, not doubled
  - doubled sources: AFTER survivorship, two statements of one account both print a row on
    the same date for the same amount under different Keys, inside the dates both cover
    (two sources of the same rank keyed differently)                             -> FAIL
    (a PDF for a period a QFX already covers keys by content, the QFX by FITID: the Key
    dedupe cannot see it. Identical charges inside ONE statement are never counted here.
    Measured 2026-11-01: 29 reference PDFs over QFX periods; the balance chain stayed
    unbroken on two accounts, and only this check names the cause)
"""
import collections
import json
from datetime import date
from decimal import Decimal
from pathlib import Path

from . import SCHEMA
from .errors import Exit, Refusal
from .inputs import label_of


def _records(paths):
    for p in paths:
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            r = json.loads(line)
            if r.get("schema") != SCHEMA:
                raise Refusal(Exit.USAGE, f"{p.name}:{i}: schema {r.get('schema')!r}, "
                                          f"expected {SCHEMA!r}")
            yield p, r


def coverage(paths: list[Path]) -> dict:
    stmts, rows, kind_of = {}, [], {}
    for p, r in _records(paths):
        if r["record"] == "statement":
            stmts[r["statement_id"]] = r
            kind_of[r["statement_id"]] = r["account"]["kind"]
        elif r["record"] == "transaction":
            rows.append(r)

    per = collections.defaultdict(list)
    for s in stmts.values():
        per[(s["institution"], label_of(s["account"]["ref"], s["account"]["kind"]))].append(s)
    from .survive import resolve
    kept, _, resolved = resolve(stmts, rows, lambda s: (
        s["institution"], label_of(s["account"]["ref"], s["account"]["kind"])))
    span, by_stmt = {}, collections.defaultdict(list)
    for r in kept:      # doubled sources are judged after survivorship, as the build sees them
        by_stmt[r["statement_id"]].append(r)
        k = (r["institution"], label_of(r["account"], kind_of.get(r["statement_id"], "")))
        lo, hi = span.get(k, (r["booking_date"], r["booking_date"]))
        span[k] = (min(lo, r["booking_date"]), max(hi, r["booking_date"]))

    accounts = []
    for k in sorted(per):
        seen, chain = set(), []
        for s in sorted(per[k], key=lambda s: (s["period"]["start"] or s["period"]["end"] or "",
                                               s["period"]["end"] or "")):
            key = (s["period"]["start"], s["period"]["end"])
            if key not in seen:
                seen.add(key)
                chain.append(s)
        holes, breaks, bridged = [], [], []
        for a, b in zip(chain, chain[1:]):
            ae, bs = a["period"]["end"], b["period"]["start"]
            gap = (date.fromisoformat(bs) - date.fromisoformat(ae)).days if ae and bs else None
            if gap is not None and gap > 1:
                holes.append({"after": ae, "before": bs, "days": gap - 1})
            ac, bo = a["balances"]["closing"], b["balances"]["opening"]
            if (gap is None or gap > 0) and ac is not None and bo is not None \
                    and Decimal(ac) != Decimal(bo):
                # Across a hole the balance is SUPPOSED to move: the rows there were never
                # fetched, and the build bridges the hole with a labelled Equity:Gaps pad.
                # Between adjoining statements it must not.
                (bridged if gap is not None and gap > 1 else breaks).append(
                    {"at": ae, "closing": ac, "next_opening": bo})
        doubled = _doubled(per[k], by_stmt)
        starts = [s["period"]["start"] for s in chain if s["period"]["start"]]
        ends = [s["period"]["end"] for s in chain if s["period"]["end"]]
        lo, hi = span.get(k, (None, None))
        accounts.append({"institution": k[0], "account": k[1], "files": len(per[k]),
                         "periods": len(chain), "from": min(starts) if starts else lo,
                         "to": max(ends) if ends else hi, "date_holes": holes,
                         "balance_breaks": breaks, "bridged": bridged, "doubled": doubled,
                         "periods_without_start": sum(1 for s in chain
                                                      if not s["period"]["start"])})

    bykey = collections.defaultdict(list)
    for r in kept:      # the rows the build keeps: a dropped PDF twin is no conflict
        bykey[r["key"]].append(r)
    conflicts = sorted(k for k, v in bykey.items()
                       if len({(x["booking_date"], x["amount"]) for x in v}) > 1)
    look = collections.defaultdict(set)
    for k, v in bykey.items():
        x = v[0]
        look[(x["institution"], x["account"], x["booking_date"], x["amount"],
              (x.get("description") or "").strip())].add(k)
    lookalikes = [{"institution": a, "account": b, "date": c, "amount": d, "description": e,
                   "count": len(ks)} for (a, b, c, d, e), ks in sorted(look.items()) if len(ks) > 1]
    return {"accounts": accounts,
            "rows_read": len(rows), "unique_keys": len(bykey),
            "keys_in_several_files": sum(1 for v in bykey.values() if len(v) > 1),
            "key_conflicts": conflicts, "lookalikes": lookalikes,
            "balance_breaks": sum(len(a["balance_breaks"]) for a in accounts),
            "bridged_holes": sum(len(a["bridged"]) for a in accounts),
            "doubled_rows": sum(d["rows"] for a in accounts for d in a["doubled"]),
            "rows_resolved_overlap": sum(d["rows"] for d in resolved),
            "resolved": [dict(d, account=list(d["account"])) for d in resolved],
            "date_holes": sum(len(a["date_holes"]) for a in accounts)}


def _window(s, rows):
    ds = [r["booking_date"] for r in rows]
    lo = s["period"]["start"] or (min(ds) if ds else s["period"]["end"])
    return lo, s["period"]["end"] or (max(ds) if ds else lo)


def _doubled(stmts, by_stmt) -> list[dict]:
    """Rows a second statement adds, inside dates the first also covers, that match one of the
    first's rows on date and amount under a different Key. Each first-statement row matches at
    most once, so two real identical charges printed by BOTH statements are not counted."""
    out = []
    for i, a in enumerate(stmts):
        ra = by_stmt.get(a["statement_id"], [])
        alo, ahi = _window(a, ra)
        if not (alo and ahi):
            continue
        for b in stmts[i + 1:]:
            rb = by_stmt.get(b["statement_id"], [])
            blo, bhi = _window(b, rb)
            lo, hi = max(alo, blo or alo), min(ahi, bhi or ahi)
            if lo > hi:
                continue
            ka, kb = {r["key"] for r in ra}, {r["key"] for r in rb}
            pool = collections.Counter((r["booking_date"], Decimal(r["amount"])) for r in ra
                                       if r["key"] not in kb and lo <= r["booking_date"] <= hi)
            n, first = 0, None
            for r in rb:
                t = (r["booking_date"], Decimal(r["amount"]))
                if r["key"] not in ka and lo <= t[0] <= hi and pool[t] > 0:
                    pool[t] -= 1
                    n += 1
                    first = min(first or t[0], t[0])
            if n:
                out.append({"from": lo, "to": hi, "rows": n, "first": first,
                            "files": sorted({a["source"]["file"], b["source"]["file"]})})
    return out


def report(c: dict, out) -> None:
    w = out.write
    w("COMPLETENESS (no gaps)\n")
    for a in c["accounts"]:
        w(f"  {a['institution']:12s} {a['account']:14s} files {a['files']:3d} periods "
          f"{a['periods']:3d}  {a['from']} -> {a['to']}  date holes {len(a['date_holes'])}  "
          f"balance breaks {len(a['balance_breaks'])}  bridged {len(a['bridged'])}\n")
        for d in a["doubled"]:
            w(f"      DOUBLED {d['rows']} rows {d['from']} -> {d['to']}: two sources, different "
              f"Keys ({', '.join(d['files'])})\n")
        for b in a["balance_breaks"]:
            w(f"      BREAK at {b['at']}: closing {b['closing']} != next opening "
              f"{b['next_opening']}\n")
    w(f"OCCURRENCE (no double counting)\n  rows {c['rows_read']}, unique Keys "
      f"{c['unique_keys']}, Keys in several files {c['keys_in_several_files']} (counted once), "
      f"conflicting Keys {len(c['key_conflicts'])}, look-alike groups {len(c['lookalikes'])}, "
      f"doubled rows {c['doubled_rows']}, rows resolved by survivorship "
      f"{c['rows_resolved_overlap']} (a better source holds those days)\n")
    for k in c["key_conflicts"][:20]:
        w(f"      CONFLICT {k}\n")
