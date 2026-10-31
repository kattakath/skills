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


def cases() -> list[Path]:
    """Every fixture input, sorted."""
    return sorted(p for p in ADAPTERS.glob("*/fixtures/*") if p.suffix in (".qfx", ".ofx"))


def case_args(inp: Path) -> tuple[list[str], dict]:
    stem = inp.with_suffix("")
    spec = tomllib.loads(stem.with_name(stem.name + ".case.toml").read_text(encoding="utf-8"))
    args = ["extract", str(inp), *spec.get("args", [])]
    acc = stem.with_name(stem.name + ".accounts.toml")
    if acc.exists():
        args += ["--accounts", str(acc)]
    seen = stem.with_name(stem.name + ".seen.txt")
    if seen.exists():
        args += ["--seen", str(seen)]
    return args, spec


def golden_path(inp: Path) -> Path:
    stem = inp.with_suffix("")
    return stem.with_name(stem.name + ".expected.jsonl")
