"""Adapter discovery. An adapter is adapters/<institution>/<format>.toml (+ fixtures/)."""
import hashlib
import importlib.util
import tomllib
from dataclasses import dataclass
from pathlib import Path

from . import ADAPTERS_DIR
from .drivers import csv_driver, ofx_driver, pdftext_driver
from .keys import SCHEMES
from .model import STATUSES
from .repairs.ofx import BY_NAME

FORMATS = ("ofx", "pdftext", "csv")
DRIVER_MODULES = {"ofx": ofx_driver, "pdftext": pdftext_driver, "csv": csv_driver}
# The only functions a Python hook may define, each because TOML cannot express it.
HOOKS = ("parse_lines", "post_drafts", "extra_checks")
KNOWN_TOP = {"institution", "format", "description", "identify", "repairs", "keys", "account",
             "reconcile", "skip", "sign", "grammar", "csv", "hook"}
ACCOUNT_REFS = ("last4", "currency")


@dataclass
class Adapter:
    id: str
    path: Path
    sha256: str
    spec: dict
    hook: object = None

    @property
    def institution(self) -> str:
        return self.spec["institution"]

    @property
    def format(self) -> str:
        return self.spec["format"]

    @property
    def minimum(self) -> str:
        return self.spec.get("reconcile", {}).get("minimum", "structural")

    @property
    def requires_override(self) -> bool:
        return bool(self.spec.get("account", {}).get("require_override", False))


class AdapterError(ValueError):
    pass


def check_spec(adapter_id: str, spec: dict) -> None:
    """Reject a malformed adapter at load time, so a typo never reaches a statement."""
    bad = set(spec) - KNOWN_TOP
    if bad:
        raise AdapterError(f"{adapter_id}: unknown key(s) {sorted(bad)}")
    for k in ("institution", "format", "identify", "keys"):
        if k not in spec:
            raise AdapterError(f"{adapter_id}: missing {k!r}")
    if spec["format"] not in FORMATS:
        raise AdapterError(f"{adapter_id}: format {spec['format']!r} not in {FORMATS}")
    ident = spec["identify"]
    if not ident or not all(isinstance(v, list) and v for v in ident.values()):
        raise AdapterError(f"{adapter_id}: identify needs at least one non-empty list")
    # A key written after a [table] header lands INSIDE that table in TOML, so a misplaced
    # `repairs = [...]` would silently become an identify field. Reject anything unknown.
    allowed = DRIVER_MODULES[spec["format"]].IDENT_FIELDS
    bad_ident = set(ident) - set(allowed)
    if bad_ident:
        raise AdapterError(f"{adapter_id}: unknown identify field(s) {sorted(bad_ident)}; "
                           f"allowed {sorted(allowed)}")
    if not isinstance(spec.get("repairs", []), list):
        raise AdapterError(f"{adapter_id}: repairs must be a list")
    unknown = [r for r in spec.get("repairs", []) if r not in BY_NAME]
    if unknown:
        raise AdapterError(f"{adapter_id}: unknown repair(s) {unknown}")
    schemes = [spec["keys"].get("scheme")] + [f.get("scheme") for f in
                                              spec["keys"].get("fallback", [])]
    for s in schemes:
        if s not in SCHEMES:
            raise AdapterError(f"{adapter_id}: key scheme {s!r} not in {SCHEMES}")
    minimum = spec.get("reconcile", {}).get("minimum", "structural")
    if minimum not in STATUSES:
        raise AdapterError(f"{adapter_id}: reconcile.minimum {minimum!r} not in {STATUSES}")
    ref = spec.get("account", {}).get("ref", "last4")
    if ref not in ACCOUNT_REFS:
        raise AdapterError(f"{adapter_id}: account.ref {ref!r} not in {ACCOUNT_REFS}")
    if spec["format"] == "csv":
        problems = csv_driver.check_spec(spec)
        if problems:
            raise AdapterError(f"{adapter_id}: " + "; ".join(problems))
    elif "csv" in spec:
        raise AdapterError(f"{adapter_id}: a [csv] table needs format = \"csv\"")
    if "statement-line/1" in schemes and spec["keys"].get("immutable") is not True:
        raise AdapterError(f"{adapter_id}: statement-line/1 keys need keys.immutable = true "
                           "(a statement that can be reissued would change every key)")


def load_hook(adapter_id: str, path: Path):
    """Import <format>.py beside the TOML. Only HOOKS may be defined, each with a docstring
    that starts 'Why not TOML:' so a reviewer sees the case for code over data."""
    spec = importlib.util.spec_from_file_location(
        "statement_extract_hook_" + adapter_id.replace("/", "_").replace("-", "_"), path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    public = [n for n in vars(mod) if not n.startswith("_") and callable(getattr(mod, n))
              and getattr(getattr(mod, n), "__module__", None) == mod.__name__]
    extra = sorted(set(public) - set(HOOKS))
    if extra:
        raise AdapterError(f"{adapter_id}: hook defines {extra}; only {HOOKS} are allowed "
                           "(prefix helpers with _)")
    for name in HOOKS:
        fn = getattr(mod, name, None)
        if fn is not None and not (fn.__doc__ or "").lstrip().startswith("Why not TOML:"):
            raise AdapterError(f"{adapter_id}: hook {name} needs a docstring starting "
                               "'Why not TOML:'")
    return mod


def load(root: Path = ADAPTERS_DIR) -> list[Adapter]:
    out = []
    # Sort by adapter id (inst, name), not by path: "a-b.toml" sorts before "a.toml" as a path
    # but after "a" as an id, and the CLI promises id order.
    for p in sorted(root.glob("*/*.toml"), key=lambda q: (q.parent.name, q.stem)):
        raw = p.read_bytes()
        adapter_id = f"{p.parent.name}/{p.stem}"
        try:
            spec = tomllib.loads(raw.decode("utf-8"))
        except tomllib.TOMLDecodeError as e:
            raise AdapterError(f"{adapter_id}: {e}") from None
        check_spec(adapter_id, spec)
        h = hashlib.sha256(raw)
        hook = None
        # `hook = "other.py"` shares a sibling adapter's hook (same layout, different data)
        # instead of a copy; its bytes enter THIS adapter's sha256, so an edit to the shared
        # hook changes every adapter that uses it.
        named = spec.get("hook")
        if named is not None and (not isinstance(named, str) or "/" in named
                                  or not named.endswith(".py")):
            raise AdapterError(f"{adapter_id}: hook must be a sibling file name ending .py")
        hook_path = p.with_name(named) if named else p.with_suffix(".py")
        if named and not hook_path.exists():
            raise AdapterError(f"{adapter_id}: hook {named} not found")
        if hook_path.exists():
            h.update(b"\0" + hook_path.read_bytes())
            hook = load_hook(adapter_id, hook_path)
        if spec["format"] == "pdftext" and (hook is None or not hasattr(hook, "parse_lines")):
            raise AdapterError(f"{adapter_id}: a pdftext adapter needs a parse_lines hook")
        out.append(Adapter(adapter_id, p, h.hexdigest(), spec, hook))
    return out
