"""pfc — the pinned Plaid PFC taxonomy as a command line.

  pfc validate [NAME ...] [--csv FILE --column N|HEADER] [--allow X]   exit 3 on any unknown name
  pfc validate --suggestions FILE                                       exit 3 on any invalid Suggestion
  pfc describe NAME                                                     primary + Plaid's description
  pfc list [--primary P]                                                the pinned detailed names
  pfc crosswalk V1_NAME [...]                                           identical | renamed | split
  pfc schema [category|txn|evidence|suggestion]                         JSON Schema (draft 2020-12)
  pfc refresh [--from CSV] [--write] [--accept-removals]                re-pin from Plaid's CSV
  pfc merchant PAYEE [MEMO]                                             the merchant key a decision applies to
  pfc suggest --history H.jsonl (--input T.jsonl | --flagged) [--fuzzy] [--min-confidence C] [--rest F]
                                                                        Suggestion JSONL from own history
  pfc eval --history H.jsonl [--fuzzy] [--json] [--show]                accuracy on held-out rows (counts)

Exit codes: 0 ok · 2 usage · 3 refused (an unknown name, or a refresh that removes names).
"""
import argparse
import csv
import json
import sys
from pathlib import Path

from . import evaluate, history, merchant, models, refresh as rf, taxonomy

OK, USAGE, REFUSED = 0, 2, 3


def _csv_values(path: str, column: str) -> list[str]:
    with open(path, newline="", encoding="utf-8") as fh:
        rows = list(csv.reader(fh))
    if not rows:
        return []
    if column.isdigit():
        i = int(column)
        return [r[i] for r in rows if len(r) > i]
    head = rows[0]
    if column not in head:
        raise SystemExit(f"pfc: column {column!r} not in header {head}")
    i = head.index(column)
    return [r[i] for r in rows[1:] if len(r) > i]


def _validate_suggestions(path: str) -> int:
    bad, n = [], 0
    with open(path, encoding="utf-8") as fh:
        for i, line in enumerate(fh, 1):
            if not line.strip():
                continue
            n += 1
            try:
                models.Suggestion.from_dict(json.loads(line))
            except (models.Invalid, ValueError) as e:
                bad.append(f"line {i}: {e}")
    if bad:
        print(f"pfc: {len(bad)} of {n} suggestions invalid:", file=sys.stderr)
        for b in bad[:50]:
            print(f"  {b}", file=sys.stderr)
        return REFUSED
    print(f"pfc: {n} suggestions, all valid", file=sys.stderr)
    return OK


def cmd_validate(a) -> int:
    if a.suggestions:
        return _validate_suggestions(a.suggestions)
    values = list(a.names)
    if a.csv:
        values += _csv_values(a.csv, a.column)
    if not values and not sys.stdin.isatty():
        values = [l.strip() for l in sys.stdin]
    bad = taxonomy.unknown(values, allow=(taxonomy.REVIEW_MARKER, *a.allow))
    distinct = len({v.strip() for v in values if v and v.strip()})
    if bad:
        print(f"pfc: {len(bad)} of {distinct} distinct names are not PFC v2 (pinned "
              f"{taxonomy.pinned()['fetched']}):", file=sys.stderr)
        for b in bad:
            hint = taxonomy.crosswalk(b)
            tip = f"  (v1 name; v2: {', '.join(hint['v2'])})" if hint["kind"] in ("renamed", "split") else ""
            print(f"  {b}{tip}", file=sys.stderr)
        return REFUSED
    print(f"pfc: {distinct} distinct names, all PFC v2", file=sys.stderr)
    return OK


def cmd_describe(a) -> int:
    d = taxonomy.by_name().get(a.name)
    if not d:
        print(f"pfc: {a.name!r} is not a PFC v2 name", file=sys.stderr)
        return REFUSED
    print(json.dumps(d, ensure_ascii=False, indent=2))
    return OK


def cmd_list(a) -> int:
    for d in taxonomy.pinned()["detailed"]:
        if not a.primary or d["primary"] == a.primary:
            print(d["name"])
    return OK


def cmd_crosswalk(a) -> int:
    out = {n: taxonomy.crosswalk(n) for n in a.names}
    print(json.dumps(out, indent=2))
    return REFUSED if any(v["kind"] == "unknown" for v in out.values()) else OK


def cmd_schema(a) -> int:
    print(json.dumps(models.schema(a.model), indent=2))
    return OK


def cmd_refresh(a) -> int:
    raw = Path(a.src).read_bytes() if a.src else rf.fetch()
    pinned, cross = rf.parse(raw, fetched=a.fetched)
    d = rf.diff(taxonomy.pinned(), pinned)
    same = pinned["sha256"] == taxonomy.pinned()["sha256"]
    print(json.dumps({"sha256_unchanged": same, **d,
                      "detailed": len(pinned["detailed"]), "primary": len(pinned["primary"])}, indent=2))
    if d["removed"] and not a.accept_removals:
        print("pfc: the new list REMOVES names; add their crosswalk and rerun with "
              "--accept-removals", file=sys.stderr)
        return REFUSED
    if a.write:
        for name, obj in (("pfc-v2.json", pinned), ("crosswalk-v1-v2.json", cross)):
            (taxonomy.DATA / name).write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n",
                                              encoding="utf-8")
        print("pfc: pin written", file=sys.stderr)
    return OK


def cmd_merchant(a) -> int:
    print(merchant.key(a.payee, a.memo))
    return OK


def _provisional(a):
    return None if a.no_provisional else a.provisional


def _targets(a, rows):
    """(key, payee, memo) to suggest for: the flagged history rows, or an --input JSONL."""
    if a.flagged:
        return [(h.key, h.payee, h.memo) for h in rows if h.category == taxonomy.REVIEW_MARKER]
    out = []
    with open(a.input, encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                t = json.loads(line)
                out.append((t["key"], t.get("payee") or t.get("description", ""), t.get("memo", "")))
    return out


def cmd_suggest(a) -> int:
    if not (a.flagged or a.input):
        print("pfc: suggest needs --input FILE or --flagged", file=sys.stderr)
        return USAGE
    rows = history.read(a.history)
    idx = history.Index(rows, _provisional(a), fuzzy=a.fuzzy)
    targets = _targets(a, rows)
    hit, rest = 0, []
    for key, payee, memo in targets:
        s = idx.suggest(key, payee, memo)
        if s and s.confidence >= a.min_confidence:
            hit += 1
            print(json.dumps(s.to_dict(), ensure_ascii=False))
        else:
            rest.append({"key": key, "payee": payee, "memo": memo})
    if a.rest:
        with open(a.rest, "w", encoding="utf-8") as fh:
            fh.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in rest)
    print(f"pfc: {hit} of {len(targets)} rows have a suggestion; {len(rest)} left"
          + (f" in {a.rest}" if a.rest else ""), file=sys.stderr)
    return OK


def cmd_eval(a) -> int:
    r = evaluate.score(history.read(a.history), _provisional(a), show=a.show, fuzzy=a.fuzzy)
    print(json.dumps(r, indent=2) if a.json else evaluate.table(r))
    return OK


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="pfc", description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate"); v.add_argument("names", nargs="*")
    v.add_argument("--csv"); v.add_argument("--column", default="category")
    v.add_argument("--allow", action="append", default=[])
    v.add_argument("--suggestions", help="JSONL of Suggestion records to schema-check instead")
    d = sub.add_parser("describe"); d.add_argument("name")
    l = sub.add_parser("list"); l.add_argument("--primary")
    c = sub.add_parser("crosswalk"); c.add_argument("names", nargs="+")
    s = sub.add_parser("schema"); s.add_argument("model", nargs="?", default="suggestion",
                                                 choices=["category", *models.MODELS])
    r = sub.add_parser("refresh"); r.add_argument("--from", dest="src")
    r.add_argument("--write", action="store_true"); r.add_argument("--accept-removals", action="store_true")
    r.add_argument("--fetched", help="override the fetch date (tests, reproducible pins)")
    m = sub.add_parser("merchant"); m.add_argument("payee"); m.add_argument("memo", nargs="?", default="")
    for name in ("suggest", "eval"):
        x = sub.add_parser(name); x.add_argument("--history", required=True)
        x.add_argument("--provisional", default=history.DEFAULT_PROVISIONAL,
                       help="regex on a label's note marking it a guess (weight 0.5, never scored)")
        x.add_argument("--no-provisional", action="store_true")
        x.add_argument("--fuzzy", action="store_true",
                       help="fall back to trigram similarity when the merchant has no exact history")
        if name == "suggest":
            x.add_argument("--input", help="JSONL rows to suggest for: key, payee, memo")
            x.add_argument("--flagged", action="store_true",
                           help="suggest for the history rows still flagged NEEDS_REVIEW")
            x.add_argument("--min-confidence", type=float, default=0.0)
            x.add_argument("--rest", help="write rows left without a suggestion here (row text: keep it "
                                          "in the consumer's data folder)")
        else:
            x.add_argument("--json", action="store_true")
            x.add_argument("--show", action="store_true", help="list misses (contains row text)")
    try:
        a = p.parse_args(argv)
    except SystemExit as e:
        return USAGE if e.code else OK
    return {"validate": cmd_validate, "describe": cmd_describe, "list": cmd_list,
            "crosswalk": cmd_crosswalk, "schema": cmd_schema, "refresh": cmd_refresh,
            "merchant": cmd_merchant, "suggest": cmd_suggest, "eval": cmd_eval}[a.cmd](a)
