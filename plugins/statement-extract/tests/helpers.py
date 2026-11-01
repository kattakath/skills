"""Shared test plumbing. Every test runs the real launcher in a subprocess with a clean env:
no OTLP endpoint (a developer machine usually has one), and the run log in a temp dir."""
import os
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
LAUNCHER = PLUGIN / "scripts" / "statement-extract"
ADAPTERS = PLUGIN / "adapters"
GOLDEN = PLUGIN / "tests" / "golden"
sys.path.insert(0, str(PLUGIN / "lib"))

_TMP = tempfile.mkdtemp(prefix="statement-extract-tests-")


def clean_env(**extra) -> dict:
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("OTEL_", "STATEMENT_EXTRACT_"))}
    env["STATEMENT_EXTRACT_LOG"] = os.path.join(_TMP, "runs.jsonl")
    env.update(extra)
    return env


def run(*args, env=None, cwd=None) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(LAUNCHER), *map(str, args)], capture_output=True,
                          text=True, env=env or clean_env(), cwd=cwd)


from statement_extract.fixtures import case_stem  # noqa: E402


def cases() -> list[Path]:
    """Every fixture input (.qfx/.ofx, .layout.txt), sorted."""
    return sorted(p for p in ADAPTERS.glob("*/fixtures/*") if case_stem(p) is not None)


def case_name(inp: Path) -> str:
    return f"{inp.parent.parent.name}/{case_stem(inp)}"


def sibling(inp: Path, suffix: str) -> Path:
    return inp.with_name(case_stem(inp) + suffix)


def case_args(inp: Path) -> tuple[list[str], dict]:
    spec = tomllib.loads(sibling(inp, ".case.toml").read_text(encoding="utf-8"))
    args = ["extract", str(inp), *spec.get("args", [])]
    acc = sibling(inp, ".accounts.toml")
    if acc.exists():
        args += ["--accounts", str(acc)]
    seen = sibling(inp, ".seen.txt")
    if seen.exists():
        args += ["--seen", str(seen)]
    return args, spec


def golden_path(inp: Path) -> Path:
    return sibling(inp, ".expected.jsonl")
