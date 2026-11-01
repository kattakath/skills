"""beancount-kit CLI.

  build   JSONL... --ledger L --rules R [--decisions D] [--accounts A] [--out J | --check-only]
          [--emit-rows F] [--emit-pairs F]
  coverage JSONL... [--json]          no gaps, no double counting (exit 3: break/conflict/doubled)
  history JSONL... --ledger L --rules R [--decisions D] --out F
                                     one labelled row per line, with where the label came from
                                     (decision | rule | none): the input plaid-pfc's suggest/eval read
  groups  [--journal J] [--out F]   flagged entries grouped by merchant, with a rule pattern
  suggest [--journal J] [--out F | --evaluate]   category suggestions for flagged entries
  fava    start | stop | status   [--journal J]
  doctor

Exit codes: 0 ok · 1 bug · 2 usage (bad input, wrong schema) · 3 refused (a check failed;
nothing written).
"""
import argparse
import json
import os
import sys
from pathlib import Path

from . import fava
from .config import load as load_ledger
from .errors import Exit, Refusal
from .inputs import read_decisions, read_jsonl, read_screen_balances
from .journal import render
from .rules import NEEDS_REVIEW, categorise, load_rules


def _jsonl_paths(items: list[str]) -> list[Path]:
    out = []
    for s in items:
        p = Path(s)
        out += sorted(p.glob("*.jsonl")) if p.is_dir() else [p]
    return out


def build(a) -> int:
    ledger = load_ledger(Path(a.ledger))
    from . import pfc
    bad = pfc.unknown(ledger.categories)
    if bad:
        raise Refusal(Exit.USAGE, "ledger.toml [categories]: not a pinned Plaid PFC v2 name", bad)
    rows, asserts, overlapped, positions, survival = read_jsonl(_jsonl_paths(a.jsonl))
    if a.accounts:
        asserts += read_screen_balances(Path(a.accounts), ledger.operating_currency)
    rules = load_rules(Path(a.rules))
    decisions = read_decisions(Path(a.decisions)) if a.decisions else {}
    stats = categorise(rows, rules, decisions, ledger.transfers)

    if a.emit_rows:   # the oracle's input: Sheet columns A-L, in Row.n order
        Path(a.emit_rows).write_text(json.dumps(
            [[x.iso, x.amt, x.payee, x.memo, x.inst, x.acct, "", "", x.key, "", "", x.cur]
             for x in rows], ensure_ascii=False), encoding="utf-8")
    if a.emit_pairs:
        Path(a.emit_pairs).write_text(json.dumps(
            [[x.key, x.pair.key, x.pair_kind] for x in rows if x.pair and x.amt < 0],
            ensure_ascii=False), encoding="utf-8")

    # An opening or interest pad whose difference is zero is "unused" to Beancount. Which ones
    # are zero is Beancount's arithmetic, not ours: render, drop exactly the pads it reports
    # unused, render once more. Any error left after that is real.
    from .check import check
    text, rstats = render(rows, asserts, positions, ledger, bridges=survival["holes"])
    errs, unused = check(text)
    if unused:
        text, rstats = render(rows, asserts, positions, ledger, skip_pads=unused,
                              bridges=survival["holes"])
        errs, _ = check(text)
    report = {"rows": len(rows), **stats, **{k: v for k, v in rstats.items()
                                             if k not in ("transfer_residue", "bridges")},
              "transfer_residue": len(rstats["transfer_residue"]),
              "bridges": len(rstats["bridges"]),
              "assertions_skipped_overlap": len(overlapped),
              "rows_dropped_overlap": sum(d["rows"] for d in survival["dropped"]),
              "check_errors": len(errs)}
    print(json.dumps(report), file=sys.stderr)
    for k in rstats["transfer_residue"]:
        print(f"  unpaired transfer leg: {k}", file=sys.stderr)
    for d in survival["dropped"]:
        print(f"  overlap: {d['rows']} rows {d['from']} -> {d['to']} of {d['file']} "
              f"({d['account'][0]} {d['account'][1]}) already held by a better source",
              file=sys.stderr)
    for g in rstats["bridges"]:
        print(f"  gap bridged: {g}", file=sys.stderr)
    for s in overlapped:
        print(f"  not asserted (a later statement has rows dated <= {s.as_of}): "
              f"{s.inst} {s.acct}", file=sys.stderr)
    if errs:
        for e in errs[:50]:
            print(f"  {e}", file=sys.stderr)
        raise Refusal(Exit.REFUSED, f"journal fails its check ({len(errs)} errors); "
                                    "nothing written")
    if a.check_only:
        return 0
    if a.out == "-":
        sys.stdout.write(text)
        return 0
    out = Path(a.out)
    if out.exists() and out.read_text(encoding="utf-8") == text:
        print("journal unchanged", file=sys.stderr)
        return 0
    # Write in place (truncate, same file): a synced folder keeps one file and its history,
    # where a rename would make a new file each build.
    with out.open("w", encoding="utf-8") as fh:
        fh.write(text)
    print(f"journal written: {len(text)} bytes", file=sys.stderr)
    return 0


def history_cmd(a) -> int:
    """Labels and their provenance, for plaid-pfc. Carries row text: write it next to the
    journal (the consumer's data folder), never into a repository."""
    ledger = load_ledger(Path(a.ledger))
    rows, *_ = read_jsonl(_jsonl_paths(a.jsonl))
    decisions = read_decisions(Path(a.decisions)) if a.decisions else {}
    categorise(rows, load_rules(Path(a.rules)), decisions, ledger.transfers)
    n = {"decision": 0, "rule": 0, "none": 0}
    with open(a.out, "w", encoding="utf-8") as fh:
        for x in rows:
            if x.decision and x.decision.get("override"):
                src, ref, note = "decision", "", x.decision.get("note", "")
            elif x.rule and x.cat != NEEDS_REVIEW:
                src, ref, note = "rule", f"{x.rule['prio']:g}", x.rule.get("note", "")
            else:
                src, ref, note = "none", "", ""
            n[src] += 1
            fh.write(json.dumps({"key": x.key, "payee": x.payee, "memo": x.memo, "category": x.cat,
                                 "source": src, "ref": ref, "note": note}, ensure_ascii=False) + "\n")
    print(json.dumps({"rows": len(rows), **n}), file=sys.stderr)
    return 0


def coverage_cmd(a) -> int:
    from . import coverage as cv
    c = cv.coverage(_jsonl_paths(a.jsonl))
    if a.json:
        print(json.dumps(c, ensure_ascii=False))
    else:
        cv.report(c, sys.stdout)
    return int(Exit.REFUSED) if c["balance_breaks"] or c["key_conflicts"] or c["doubled_rows"] \
        else 0


def groups_cmd(a) -> int:
    from . import groups as gr
    if not a.journal:
        raise Refusal(Exit.USAGE, "no --journal and BEANCOUNT_JOURNAL is unset")
    rows = gr.groups(Path(a.journal))
    if a.out and a.out != "-":
        with open(a.out, "w", newline="", encoding="utf-8") as fh:
            gr.write(rows, fh)
    else:
        gr.write(rows, sys.stdout)
    print(json.dumps({"groups": len(rows), "entries": sum(r["count"] for r in rows),
                      "singletons": sum(r["count"] == 1 for r in rows)}), file=sys.stderr)
    return 0


def suggest_cmd(a) -> int:
    from . import suggest as sg
    if not a.journal:
        raise Refusal(Exit.USAGE, "no --journal and BEANCOUNT_JOURNAL is unset")
    if a.evaluate:
        print(json.dumps(sg.evaluate(Path(a.journal))))
        return 0
    if a.out and a.out != "-":
        with open(a.out, "w", newline="", encoding="utf-8") as fh:
            rep = sg.suggest(Path(a.journal), fh)
    else:
        rep = sg.suggest(Path(a.journal), sys.stdout)
    print(json.dumps(rep), file=sys.stderr)
    return 0


def doctor(_a) -> int:
    ok = True

    def line(good: bool, what: str):
        nonlocal ok
        ok &= good
        print(f"{'ok  ' if good else 'FAIL'} {what}")

    line(sys.version_info >= (3, 11), f"python {sys.version.split()[0]} at {sys.executable}")
    try:
        import smart_importer  # noqa: F401  optional: only `suggest` needs it
        print("ok   import smart_importer (suggest available)")
    except ImportError:
        print("--   smart_importer not importable (suggest unavailable; optional)")
    for mod in ("beancount", "beanquery", "fava"):
        try:
            m = __import__(mod)
            line(True, f"import {mod} {getattr(m, '__version__', '')}".rstrip())
        except ImportError:
            line(False, f"import {mod}")
    j = os.environ.get("BEANCOUNT_JOURNAL")
    line(bool(j), f"BEANCOUNT_JOURNAL={'set' if j else 'unset'}")
    if j:
        line(Path(j).parent.exists(), f"journal folder reachable: {Path(j).parent}")
    line(bool(fava.fava_bin()), f"fava binary: {fava.fava_bin()}")
    try:
        from . import pfc
        p = pfc.pin()
        line(True, f"plaid-pfc pin: {len(p['detailed'])} names, fetched {p['fetched']} ({pfc.locate()})")
    except Refusal as e:
        line(False, e.reason)
    return 0 if ok else 3


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="beancount-kit", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("jsonl", nargs="+", help="canonical JSONL files, or folders of *.jsonl")
    b.add_argument("--ledger", required=True)
    b.add_argument("--rules", required=True)
    b.add_argument("--decisions")
    b.add_argument("--accounts", help="statement-extract accounts.toml: screen balances")
    g = b.add_mutually_exclusive_group(required=True)
    g.add_argument("--out", help="journal path, or - for stdout")
    g.add_argument("--check-only", action="store_true")
    b.add_argument("--emit-rows")
    b.add_argument("--emit-pairs")
    hp = sub.add_parser("history")
    hp.add_argument("jsonl", nargs="+", help="canonical JSONL files, or folders of *.jsonl")
    hp.add_argument("--ledger", required=True)
    hp.add_argument("--rules", required=True)
    hp.add_argument("--decisions")
    hp.add_argument("--out", required=True)
    cp = sub.add_parser("coverage")
    cp.add_argument("jsonl", nargs="+", help="canonical JSONL files, or folders of *.jsonl")
    cp.add_argument("--json", action="store_true")
    gp = sub.add_parser("groups")
    gp.add_argument("--journal", default=os.environ.get("BEANCOUNT_JOURNAL"))
    gp.add_argument("--out", help="CSV (default stdout)")
    s = sub.add_parser("suggest")
    s.add_argument("--journal", default=os.environ.get("BEANCOUNT_JOURNAL"))
    g2 = s.add_mutually_exclusive_group()
    g2.add_argument("--out", help="CSV key,suggestion (default stdout)")
    g2.add_argument("--evaluate", action="store_true",
                    help="report holdout accuracy on categorised entries instead")
    f = sub.add_parser("fava")
    f.add_argument("action", choices=("start", "stop", "status"))
    f.add_argument("--journal", default=os.environ.get("BEANCOUNT_JOURNAL"))
    sub.add_parser("doctor")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "build":
            return build(a)
        if a.cmd == "doctor":
            return doctor(a)
        if a.cmd == "history":
            return history_cmd(a)
        if a.cmd == "coverage":
            return coverage_cmd(a)
        if a.cmd == "groups":
            return groups_cmd(a)
        if a.cmd == "suggest":
            return suggest_cmd(a)
        if a.action == "start":
            if not a.journal:
                raise Refusal(Exit.USAGE, "no --journal and BEANCOUNT_JOURNAL is unset")
            return fava.start(a.journal)
        return fava.stop() if a.action == "stop" else fava.status()
    except Refusal as e:
        print(f"beancount-kit: {e.reason}", file=sys.stderr)
        for item in e.items[:50]:
            print(f"  {item}", file=sys.stderr)
        return int(e.code)
