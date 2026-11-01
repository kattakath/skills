"""`fixture lint`: keep real statement data out of this plugin's tree.

Rules:
- every fixture input (*.qfx, *.ofx, *.csv) sits under adapters/<inst>/fixtures/ with a
  <case>.case.toml saying `synthetic = true` and a <case>.expected.jsonl golden;
- no PDF, XLSX or other binary file anywhere in the plugin (PDF cases are *.layout.txt);
- no stray 7+ digit run in a fixture input or case file, except the reserved synthetic
  pattern (a run starting 0000) and OFX datetime values (<DT...>);
- no CSV fixture with a value under a never-read column ("Payee Account Number"): the
  column may be present, as the real header has it, but every cell must be empty.
"""
import csv
import io
import re
import tomllib
from pathlib import Path

from .drivers.csv_driver import NEVER_READ

INPUTS = {".qfx", ".ofx", ".csv"}
LAYOUT = ".layout.txt"  # a PDF fixture: synthetic text-layer, never a PDF


def case_stem(p: Path) -> str | None:
    """The case name of a fixture INPUT, or None if p is not an input."""
    if p.name.endswith(LAYOUT):
        return p.name[: -len(LAYOUT)]
    if p.suffix.lower() in INPUTS:
        return p.stem
    return None
ALLOWED_SUFFIXES = (".qfx", ".ofx", ".csv", ".case.toml", ".expected.jsonl", ".accounts.toml",
                    ".seen.txt", ".layout.txt")
BINARY_EXT = {".pdf", ".xlsx", ".xls", ".docx", ".zip", ".png", ".jpg", ".jpeg"}
RESERVED = re.compile(r"0000\d*")
DT_VALUE = re.compile(r"<DT[A-Z]+>[0-9.\[\]+:A-Z-]*")
RUN = re.compile(r"\d{7,}")


def never_read_values(text: str) -> list[str]:
    """Never-read columns that hold a value in this CSV text (column names only)."""
    rows = list(csv.reader(io.StringIO(text.lstrip("\ufeff"), newline="")))
    if not rows:
        return []
    hits = []
    for col in NEVER_READ:
        if col in rows[0]:
            i = rows[0].index(col)
            if any(i < len(r) and r[i].strip() for r in rows[1:]):
                hits.append(col)
    return hits


def stray_runs(text: str) -> list[str]:
    text = DT_VALUE.sub("<DT>", text)
    return [m.group(0)[:3] + "…" for m in RUN.finditer(text) if not RESERVED.fullmatch(m.group(0))]


def lint(plugin_root: Path) -> list[str]:
    problems = []
    for p in sorted(plugin_root.rglob("*")):
        if not p.is_file() or {".git", "__pycache__"} & set(p.parts):
            continue
        parts = p.relative_to(plugin_root).parts
        rel = "/".join(parts)
        if p.suffix.lower() in BINARY_EXT:
            problems.append(f"{rel}: binary statement-like file in the plugin tree")
            continue
        in_fixtures = len(parts) >= 4 and parts[0] == "adapters" and parts[2] == "fixtures"
        if p.suffix.lower() in INPUTS and not in_fixtures:
            problems.append(f"{rel}: statement file outside adapters/*/fixtures/")
        if not in_fixtures:
            continue
        if not p.name.endswith(ALLOWED_SUFFIXES):
            problems.append(f"{rel}: unexpected file in fixtures/")
            continue
        raw = p.read_bytes()
        if b"\0" in raw:
            problems.append(f"{rel}: binary content")
            continue
        if not p.name.endswith(".expected.jsonl"):
            # Goldens are engine output, already through the leak gate (which exempts digests).
            for run in stray_runs(raw.decode("utf-8", "replace")):
                problems.append(f"{rel}: 7+ digit run {run} outside the reserved 0000… pattern")
        if p.suffix.lower() == ".csv":
            try:
                hits = never_read_values(raw.decode("utf-8", "replace"))
            except csv.Error as e:
                problems.append(f"{rel}: CSV does not parse ({e})")
                hits = []
            for col in hits:
                problems.append(f"{rel}: {col!r} holds a value; a fixture leaves it empty")
        name = case_stem(p)
        if name is not None:
            case = p.with_name(name + ".case.toml")
            golden = p.with_name(name + ".expected.jsonl")
            if not case.exists():
                problems.append(f"{rel}: no {case.name}")
            else:
                try:
                    spec = tomllib.loads(case.read_text(encoding="utf-8"))
                except tomllib.TOMLDecodeError as e:
                    problems.append(f"{case.name}: {e}")
                    spec = {}
                if spec.get("synthetic") is not True:
                    problems.append(f"{case.name}: must say synthetic = true")
                if not spec.get("quirk"):
                    problems.append(f"{case.name}: must name the quirk it covers")
            if not golden.exists():
                problems.append(f"{rel}: no {golden.name}")
    return problems


# --- fixture shape ------------------------------------------------------------------------
# Only the SHAPE of a real statement may enter an agent's context: column positions and the
# generic label words a parser keys on. Digits become 9, every other word becomes x's, so
# names, addresses, merchants and amounts never leave the machine. The lexicon is fixed and
# generic: nothing in it can be personal.
LABELS = {w.lower() for w in """
    account accounts activity amount amounts and annual apr authorized available balance
    balances bank banking branch card cash back cashback charge charges cheque cheques chequing
    closing continued cr credit credits crédit date day days debit debits deposit deposits
    description details detail due earned fee fees financing for from instalment interest
    limit minimum month new next no number of on opening operations page payment payments
    period posting previous purchase purchases rate regular rewards savings statement summary
    the to total totals trans transaction transactions type withdrawal withdrawals year your
    plus minus is at in by per accord advances avances solde précédent achats débits frais
    paiements crédits nouveau régulier détail des opérations au compte remise en argent relevé
    visa mastercard desjardins scotiabank scotia td cibc tangerine wise dollar dollars xrt
    usd cad eur gbp inr aed jan feb mar apr may jun jul aug sep oct nov dec january february
    march april june july august september october november december opos pos atm e-transfer
    interac free transfer mortgage loan line overdraft service
""".split()}
_TOKEN = re.compile(r"\d|[^\W\d_]+(?:-[^\W\d_]+)*")


def shape_line(line: str) -> str:
    def sub(m: re.Match) -> str:
        tok = m.group(0)
        if tok.isdigit():
            return "9"
        return tok if tok.lower() in LABELS else "x" * len(tok)

    return _TOKEN.sub(sub, line)


def shape(text: str) -> str:
    return "\n".join(shape_line(line) for line in text.splitlines())
