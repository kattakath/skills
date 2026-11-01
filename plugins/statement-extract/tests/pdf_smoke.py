"""PDF reader smoke: fixture text -> a PDF generated in-run -> poppler -> the same records.

Proves the real path (pdftotext -layout, the reader, both PDF adapters) without committing a
PDF. Runs the cases whose case.toml says `pdf_smoke = true`: geometry-sensitive quirks such as
Scotiabank's far-left sort code depend on the bank's own page layout, which a generated
Courier page does not reproduce; those stay covered by their text fixtures.
"""
import json
import shutil
import sys
import tempfile
import tomllib
from pathlib import Path

from helpers import case_name, cases, golden_path, run, sibling
from make_pdf import build


def records(text: str) -> list[tuple]:
    """Transactions by key and content; positions (loan snapshots, no rows) by id and figures."""
    out = []
    for r in map(json.loads, text.splitlines()):
        if r["record"] == "transaction":
            out.append((r["key"], r["amount"], r["booking_date"], r["description"]))
        elif r["record"] == "position":
            out.append((r["position_id"], r["as_of"], json.dumps(r["balances"], sort_keys=True),
                        json.dumps(r["terms"], sort_keys=True)))
    return out


def main() -> int:
    if not shutil.which("pdftotext"):
        print("pdf smoke: pdftotext (poppler-utils) is not installed", file=sys.stderr)
        return 1
    tmp = Path(tempfile.mkdtemp(prefix="se-smoke-"))
    picked = [c for c in cases() if tomllib.loads(
        sibling(c, ".case.toml").read_text(encoding="utf-8")).get("pdf_smoke")]
    if len(picked) < 3:  # a renamed key must not turn this into a green no-op
        print(f"pdf smoke: expected >= 3 pdf_smoke cases, found {len(picked)}", file=sys.stderr)
        return 1
    bad = 0
    for inp in picked:
        pdf = tmp / (inp.name.split(".")[0] + ".pdf")
        pdf.write_bytes(build(inp.read_text(encoding="utf-8")))
        args = ["extract", pdf]
        if sibling(inp, ".accounts.toml").exists():
            args += ["--accounts", sibling(inp, ".accounts.toml")]
        p = run(*args)
        want = records(golden_path(inp).read_text(encoding="utf-8"))
        got = records(p.stdout) if p.returncode == 0 else None
        ok = got == want and len(want) > 0
        bad += not ok
        print(f"{'ok  ' if ok else 'FAIL'} {case_name(inp)}: exit {p.returncode}, "
              f"{len(got or [])}/{len(want)} records")
        if not ok and p.stderr:
            print("     " + p.stderr.strip().splitlines()[-1][:200])
    shutil.rmtree(tmp, ignore_errors=True)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
