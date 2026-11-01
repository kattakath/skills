"""statement-extract command line. See README.md for the contract; exit codes are model.Exit."""
import argparse
import json
import os
import shutil
import sys
import traceback
from pathlib import Path

from . import PLUGIN_ROOT, SCHEMA, accounts, engine, engine_version, fixtures, manifest, mask
from . import registry
from .dedupe import append_seen, load_seen
from .exporters import csv_export
from .model import STATUSES, Exit, Refusal
from .readers import ofx, pdftext
from .telemetry import RunLog, default_log_path, otlp_url


def _err(msg: str) -> None:
    print(f"statement-extract: {msg}", file=sys.stderr)


def _dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True)


def _read_inputs(files: list[str]) -> list[tuple[Path, bytes, str]]:
    out = []
    for f in files:
        p = Path(f)
        if not p.is_file():
            raise Refusal(Exit.USAGE, f"not a file: {mask.mask(p.name)}")
        raw, sha = engine.sha256_file(p)
        out.append((p, raw, sha))
    # Processing order is content order, never argv order.
    return sorted(out, key=lambda x: (x[2], x[0].name))


def _refusal_line(e: Refusal) -> str:
    """stderr is often read by an agent working on REAL statements, so it carries check NAMES
    and locators only, never expected/actual figures. The full detail goes to --report."""
    safe = {}
    for k, v in e.detail.items():
        if k == "checks":
            safe[k] = [c["name"] for c in v]
        elif k == "check":
            safe[k] = v["name"]
        elif k in ("first", "second", "repairs"):
            safe[k] = v
    detail = f" {_dump(safe)}" if safe else ""
    return f"refused (exit {int(e.code)}): {e.reason}{detail}"


# --- extract ----------------------------------------------------------------------------

def cmd_extract(a, log: RunLog) -> int:
    adapters = registry.load()
    accts = accounts.load(Path(a.accounts) if a.accounts else None)
    seen_path = Path(a.seen) if a.seen else None
    if a.emit_seen and seen_path is None:
        raise Refusal(Exit.USAGE, "--emit-seen needs --seen FILE")
    seen = load_seen(seen_path) if seen_path and seen_path.exists() else set()
    man_path = Path(a.manifest) if a.manifest else None
    done = manifest.load(man_path)
    inputs = _read_inputs(a.files)

    results, refused, report_files = [], [], []
    for path, raw, sha in inputs:
        entry = {"file": mask.mask(path.name), "sha256": sha}
        if sha in done and not a.force:
            entry["skipped"] = "unchanged (manifest)"
            report_files.append(entry)
            log.emit("file.skipped", reason="manifest", **{"file.sha256": sha})
            continue
        try:
            res = engine.run_file(path, raw, sha, adapters, accts, a.require)
        except Refusal as e:
            log.emit("refusal", "ERROR", **{"file.sha256": sha, "exit.code": int(e.code),
                                            "reason": e.reason})
            entry["refusal"] = {"exit": int(e.code), "reason": e.reason, **e.detail}
            report_files.append(entry)
            _err(f"{mask.mask(path.name)}: {_refusal_line(e)}")
            if not a.keep_going:
                _write_report(a, report_files, int(e.code))
                return int(e.code)
            refused.append(e)
            continue
        log.emit("adapter.matched", **{"file.sha256": sha, "adapter.id": res.adapter.id})
        for r in res.repairs:
            log.emit("repair.fired", **{"file.sha256": sha, "repair.name": r})
        for s in res.statements:
            for c in s["reconcile"]["checks"]:
                log.emit("check.result", "INFO" if c["ok"] else "ERROR",
                         **{"statement.id": s["statement_id"], "check.name": c["name"],
                            "check.ok": c["ok"], "check.expected": c.get("expected"),
                            "check.actual": c.get("actual")})
        entry.update(adapter=res.adapter.id, repairs=res.repairs, statements=res.statements)
        report_files.append(entry)
        results.append(res)

    try:
        engine.chain(results)
        kept = engine.dedupe(results, seen)
    except Refusal as e:
        log.emit("refusal", "ERROR", **{"exit.code": int(e.code), "reason": e.reason})
        _err(_refusal_line(e))
        _write_report(a, report_files, int(e.code))
        return int(e.code)

    records = engine.order([s for r in results for s in r.statements], kept)
    hits = engine.leak_scan(records)
    if hits:
        log.emit("refusal", "ERROR", **{"exit.code": int(Exit.LEAK), "reason": "leak gate",
                                        "leak.fields": hits[:20]})
        _err(f"refused (exit 5): {len(hits)} output string(s) still carry an account-number "
             f"shape after masking; nothing emitted. First: {', '.join(hits[:5])}")
        _write_report(a, report_files, int(Exit.LEAK))
        return int(Exit.LEAK)

    for s in records:
        if s["record"] != "statement":
            break
        c = s["counts"]
        log.emit("dedupe.counts", **{"statement.id": s["statement_id"],
                                     **{f"count.{k}": v for k, v in c.items()}})
        # Counts and status only: balances stay in the stdout records and the --report file,
        # so an agent verifying real statements can read stderr without seeing a figure.
        _err(f"{s['institution']} {s['account']['ref']} {s['period']['end'] or ''} | "
             f"{s['reconcile']['status']} | {c['emitted']} new, {c['seen']} seen, "
             f"{c['dup_in_run']} dup, {c['skipped']} skipped")

    out = sys.stdout
    if a.format == "csv":
        out.write(csv_export.to_csv(records))
    else:
        for r in records:
            out.write(_dump(r) + "\n")
    out.flush()

    if a.emit_seen:
        append_seen(seen_path, [r["key"] for r in records if r["record"] == "transaction"])
    manifest.append(man_path, [{"sha256": r.sha256, "adapter": r.adapter.id,
                                "statements": len(r.statements)} for r in results])
    code = Exit.PARTIAL if refused else Exit.OK
    if refused and not results:
        code = refused[0].code
    _write_report(a, report_files, int(code))
    return int(code)


def _write_report(a, files: list[dict], code: int) -> None:
    if not getattr(a, "report", None):
        return
    rep = {"schema": SCHEMA, "record": "report", "extractor_version": engine_version(),
           "exit": code, "files": files}
    Path(a.report).write_text(json.dumps(rep, ensure_ascii=False, sort_keys=True, indent=1)
                              + "\n", encoding="utf-8")


# --- identify / explain / adapters / doctor / export ------------------------------------

def cmd_identify(a, log) -> int:
    adapters = registry.load()
    code = Exit.OK
    for path, raw, sha in _read_inputs(a.files):
        name = mask.mask(path.name)
        if a.print_identifiers:
            ids = ofx.identifiers(raw)
            print(_dump({"file": name, **{k: ids.get(k, []) for k in
                                         ("ORG", "FID", "INTU.BID", "CURDEF")}}))
            continue
        hits = [x.id for x in engine.candidates(raw, adapters, path)]
        print(f"{name}\t{','.join(hits) or '-'}")
        if len(hits) != 1:
            code = Exit.UNIDENTIFIED
    return int(code)


def cmd_explain(a, log) -> int:
    adapters = registry.load()
    accts = accounts.load(Path(a.accounts) if a.accounts else None)
    path, raw, sha = _read_inputs([a.file])[0]
    out = {"file": mask.mask(path.name), "sha256": sha,
           "identifiers": {k: v for k, v in ofx.identifiers(raw).items() if k != "CURDEF"},
           "candidates": []}
    for ad in engine.candidates(raw, adapters, path):
        c = {"adapter": ad.id}
        try:
            res = engine.build(path, raw, sha, ad, accts, None)
            c.update(repairs=res.repairs, statements=[
                {k: s[k] for k in ("statement_id", "account", "period", "balances", "reconcile",
                                   "counts")} for s in res.statements])
        except Refusal as e:
            c["refusal"] = {"exit": int(e.code), "reason": e.reason, **e.detail}
        out["candidates"].append(c)
    print(json.dumps(out, ensure_ascii=False, sort_keys=True, indent=1))
    return int(Exit.OK if len(out["candidates"]) == 1 else Exit.UNIDENTIFIED)


def cmd_adapters(a, log) -> int:
    for ad in registry.load():
        s = ad.spec
        print(_dump({"id": ad.id, "institution": ad.institution, "format": ad.format,
                     "key_scheme": s["keys"]["scheme"],
                     "fallback": [f["scheme"] for f in s["keys"].get("fallback", [])],
                     "minimum": ad.minimum, "repairs": s.get("repairs", []),
                     "requires_override": ad.requires_override, "identify": s["identify"],
                     "sha256": ad.sha256}))
    return 0


def cmd_doctor(a, log) -> int:
    ok = True
    print(f"python      {sys.version.split()[0]} ({'ok' if sys.version_info >= (3, 11) else 'TOO OLD, need >= 3.11'})")
    try:
        n = len(registry.load())
        print(f"adapters    {n} loaded")
    except registry.AdapterError as e:
        ok = False
        print(f"adapters    FAILED: {e}")
    print(f"engine      {engine_version()}")
    print(f"run log     {a.log or default_log_path()}")
    print(f"otlp push   {otlp_url() or 'off (OTEL_EXPORTER_OTLP_ENDPOINT unset or not http)'}")
    print(f"pdftotext   {shutil.which('pdftotext') or 'absent (only PDF adapters need it)'}")
    print(f"isolated    {'yes (-I)' if sys.flags.isolated else 'no'}")
    return 0 if ok else int(Exit.BUG)


def cmd_export(a, log) -> int:
    text = Path(a.input).read_text(encoding="utf-8") if a.input != "-" else sys.stdin.read()
    sys.stdout.write(csv_export.to_csv(csv_export.from_jsonl(text)))
    return 0


def cmd_fixture(a, log) -> int:
    root = Path(a.root) if a.root else PLUGIN_ROOT
    problems = fixtures.lint(root)
    for p in problems:
        print(p)
    print(f"fixture lint: {len(problems)} problem(s)", file=sys.stderr)
    return int(Exit.REFUSED) if problems else 0


def cmd_shape(a, log) -> int:
    path = Path(a.file)
    raw = path.read_bytes()
    print(fixtures.shape(pdftext.text_of(path, raw)))
    return 0


def cmd_corpus(a, log) -> int:
    """Hashes + counts only, so the lock is safe to keep next to a private corpus."""
    adapters = registry.load()
    accts = accounts.load(Path(a.accounts) if a.accounts else None)
    files = sorted(p for p in Path(a.dir).rglob("*")
                   if p.is_file() and p.suffix.lower() in fixtures.INPUTS)
    now = {}
    for p in files:
        raw, sha = engine.sha256_file(p)
        try:
            res = engine.run_file(p, raw, sha, adapters, accts, None)
            now[sha] = {"adapter": res.adapter.id, "statements": len(res.statements),
                        "transactions": len(res.transactions),
                        "status": sorted({s["reconcile"]["status"] for s in res.statements})}
        except Refusal as e:
            now[sha] = {"refused": int(e.code)}
    lock = Path(a.lock)
    if not lock.exists():
        lock.write_text(json.dumps(now, sort_keys=True, indent=1) + "\n", encoding="utf-8")
        print(f"corpus: locked {len(now)} file(s)")
        return 0
    old = json.loads(lock.read_text(encoding="utf-8"))
    drift = sorted(set(old) ^ set(now)) + sorted(k for k in set(old) & set(now)
                                                 if old[k] != now[k])
    for k in drift:
        print(f"drift {k[:12]}: {old.get(k)} -> {now.get(k)}")
    print(f"corpus: {len(now)} file(s), {len(drift)} drifted")
    return int(Exit.REFUSED) if drift else 0


# --- entry ------------------------------------------------------------------------------

def parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="statement-extract", description=(
        "Deterministic, reconcile-gated extraction of bank/card statements to canonical JSONL."))
    ap.add_argument("--log", help="run log path (default $STATEMENT_EXTRACT_LOG or "
                    "$XDG_STATE_HOME/statement-extract/runs.jsonl)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    x = sub.add_parser("extract", help="extract statements to JSONL (or CSV)")
    x.add_argument("files", nargs="+")
    x.add_argument("--seen", help="file of keys already stored downstream, one per line")
    x.add_argument("--emit-seen", action="store_true", help="append emitted keys to --seen")
    x.add_argument("--manifest", help="append-only sha256 manifest; skips unchanged files")
    x.add_argument("--force", action="store_true", help="ignore the manifest's skips")
    x.add_argument("--accounts", help="consumer accounts.toml (overrides, balance assertions)")
    x.add_argument("--format", choices=("jsonl", "csv"), default="jsonl")
    x.add_argument("--require", choices=STATUSES, help="minimum reconcile status")
    x.add_argument("--keep-going", action="store_true",
                   help="emit what reconciles, refuse the rest, exit 6")
    x.add_argument("--report", help="write a JSON run report here")
    x.set_defaults(fn=cmd_extract)

    i = sub.add_parser("identify", help="which adapter claims each file")
    i.add_argument("files", nargs="+")
    i.add_argument("--print-identifiers", action="store_true",
                   help="print ORG/FID/INTU.BID/CURDEF (never the account id)")
    i.set_defaults(fn=cmd_identify)

    e = sub.add_parser("explain", help="masked per-file diagnosis: adapters, repairs, checks")
    e.add_argument("file")
    e.add_argument("--accounts")
    e.set_defaults(fn=cmd_explain)

    sub.add_parser("adapters", help="list adapters").set_defaults(fn=cmd_adapters)
    sub.add_parser("doctor", help="check the runtime").set_defaults(fn=cmd_doctor)

    ex = sub.add_parser("export", help="canonical JSONL -> CSV (transactions)")
    ex.add_argument("input", nargs="?", default="-")
    ex.set_defaults(fn=cmd_export)

    f = sub.add_parser("fixture", help="fixture tooling")
    fsub = f.add_subparsers(dest="fixture_cmd", required=True)
    fl = fsub.add_parser("lint", help="keep real data out of the plugin tree")
    fl.add_argument("root", nargs="?")
    fl.set_defaults(fn=cmd_fixture)
    fs = fsub.add_parser("shape", help="a real statement's layout with every value blanked "
                         "(digits -> 9, non-label words -> x); run locally, share only this")
    fs.add_argument("file")
    fs.set_defaults(fn=cmd_shape)

    c = sub.add_parser("corpus", help="private-corpus drift lock")
    csub = c.add_subparsers(dest="corpus_cmd", required=True)
    cc = csub.add_parser("check")
    cc.add_argument("dir")
    cc.add_argument("--lock", required=True)
    cc.add_argument("--accounts")
    cc.set_defaults(fn=cmd_corpus)
    return ap


def main(argv: list[str] | None = None) -> int:
    if sys.version_info < (3, 11):
        _err("needs Python >= 3.11")
        return int(Exit.USAGE)
    a = parser().parse_args(argv)
    log = RunLog(Path(a.log) if a.log else None, engine_version())
    log.emit("run.start", **{"command": a.cmd, "files.count": len(getattr(a, "files", []) or [])})
    try:
        code = a.fn(a, log)
    except Refusal as e:
        _err(_refusal_line(e))
        log.emit("refusal", "ERROR", **{"exit.code": int(e.code), "reason": e.reason})
        code = int(e.code)
    except (registry.AdapterError, accounts.AccountsError) as e:
        _err(str(e))
        code = int(Exit.USAGE)
    except BrokenPipeError:
        code = int(Exit.OK)
    except Exception:
        _err("bug: unexpected error (exit 1)")
        traceback.print_exc()
        code = int(Exit.BUG)
    log.emit("run.end", **{"exit.code": int(code)})
    log.close()
    return int(code)


if __name__ == "__main__":
    sys.exit(main())
