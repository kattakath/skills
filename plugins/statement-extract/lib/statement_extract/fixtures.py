"""`fixture lint`: keep real statement data out of this plugin's tree.

Rules:
- every fixture input (*.qfx, *.ofx) sits under adapters/<inst>/fixtures/ with a
  <case>.case.toml saying `synthetic = true` and a <case>.expected.jsonl golden;
- no PDF, XLSX or other binary file anywhere in the plugin (PDF cases are *.layout.txt);
- no stray 7+ digit run in a fixture input or case file, except the reserved synthetic
  pattern (a run starting 0000) and OFX datetime values (<DT...>).
"""
import re
import tomllib
from pathlib import Path

INPUTS = {".qfx", ".ofx"}
ALLOWED_SUFFIXES = (".qfx", ".ofx", ".case.toml", ".expected.jsonl", ".accounts.toml",
                    ".seen.txt", ".layout.txt")
BINARY_EXT = {".pdf", ".xlsx", ".xls", ".docx", ".zip", ".png", ".jpg", ".jpeg"}
RESERVED = re.compile(r"0000\d*")
DT_VALUE = re.compile(r"<DT[A-Z]+>[0-9.\[\]+:A-Z-]*")
RUN = re.compile(r"\d{7,}")


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
        if p.suffix.lower() in INPUTS:
            stem = p.with_suffix("")
            case = stem.with_name(stem.name + ".case.toml")
            golden = stem.with_name(stem.name + ".expected.jsonl")
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
