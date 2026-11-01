"""Completeness and occurrence over the canonical JSONL: no gaps, no double counting.

Audit language: *completeness* (every transaction is recorded) and *occurrence* (every recorded
transaction happened, once). The usual technique is statement continuity: each statement's
opening equals the previous closing, and the periods join. No off-the-shelf Beancount plugin
checks statement continuity (searched 2026-11-01); `noduplicates` covers exact duplicate
entries only.

Per account (institution + label):
  - periods: distinct (start, end) statement periods, sorted; re-downloads collapse
  - balance breaks: next opening != previous closing, where both are printed  -> FAIL
  - date holes: more than one day between one period's end and the next's start -> WARN
    (statement boundaries leave such days; rows dated on them sit in the next statement, and
    an unbroken balance chain or a passing journal assertion proves nothing is missing)
  - coverage: first and last date the files cover; history before it was never fetched
Across files:
  - one Key, different date or amount                                          -> FAIL
  - one Key in several files (overlapping downloads)                           -> counted once
  - look-alikes: same account, date, amount and description, different Keys    -> listed
    (banks do post identical charges; a passing balance assertion means the bank has them)
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
    span = {}
    for r in rows:
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
        holes, breaks = [], []
        for a, b in zip(chain, chain[1:]):
            ae, bs = a["period"]["end"], b["period"]["start"]
            if not (ae and bs):
                continue
            gap = (date.fromisoformat(bs) - date.fromisoformat(ae)).days
            if gap > 1:
                holes.append({"after": ae, "before": bs, "days": gap - 1})
            ac, bo = a["balances"]["closing"], b["balances"]["opening"]
            if gap > 0 and ac is not None and bo is not None and Decimal(ac) != Decimal(bo):
                breaks.append({"at": ae, "closing": ac, "next_opening": bo})
        starts = [s["period"]["start"] for s in chain if s["period"]["start"]]
        ends = [s["period"]["end"] for s in chain if s["period"]["end"]]
        lo, hi = span.get(k, (None, None))
        accounts.append({"institution": k[0], "account": k[1], "files": len(per[k]),
                         "periods": len(chain), "from": min(starts) if starts else lo,
                         "to": max(ends) if ends else hi, "date_holes": holes,
                         "balance_breaks": breaks})

    bykey = collections.defaultdict(list)
    for r in rows:
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
            "date_holes": sum(len(a["date_holes"]) for a in accounts)}


def report(c: dict, out) -> None:
    w = out.write
    w("COMPLETENESS (no gaps)\n")
    for a in c["accounts"]:
        w(f"  {a['institution']:12s} {a['account']:14s} files {a['files']:3d} periods "
          f"{a['periods']:3d}  {a['from']} -> {a['to']}  date holes {len(a['date_holes'])}  "
          f"balance breaks {len(a['balance_breaks'])}\n")
        for b in a["balance_breaks"]:
            w(f"      BREAK at {b['at']}: closing {b['closing']} != next opening "
              f"{b['next_opening']}\n")
    w(f"OCCURRENCE (no double counting)\n  rows {c['rows_read']}, unique Keys "
      f"{c['unique_keys']}, Keys in several files {c['keys_in_several_files']} (counted once), "
      f"conflicting Keys {len(c['key_conflicts'])}, look-alike groups {len(c['lookalikes'])}\n")
    for k in c["key_conflicts"][:20]:
        w(f"      CONFLICT {k}\n")
