"""Adapter discovery. An adapter is adapters/<institution>/<format>.toml (+ fixtures/)."""
import hashlib
import tomllib
from dataclasses import dataclass
from pathlib import Path

from . import ADAPTERS_DIR
from .drivers.ofx_driver import IDENT_FIELDS
from .keys import SCHEMES
from .model import STATUSES
from .repairs.ofx import BY_NAME

FORMATS = ("ofx",)  # csv and pdftext drivers arrive in later releases
KNOWN_TOP = {"institution", "format", "description", "identify", "repairs", "keys", "account",
             "reconcile", "skip", "sign"}


@dataclass
class Adapter:
    id: str
    path: Path
    sha256: str
    spec: dict

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
    bad_ident = set(ident) - set(IDENT_FIELDS)
    if bad_ident:
        raise AdapterError(f"{adapter_id}: unknown identify field(s) {sorted(bad_ident)}; "
                           f"allowed {sorted(IDENT_FIELDS)}")
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


def load(root: Path = ADAPTERS_DIR) -> list[Adapter]:
    out = []
    for p in sorted(root.glob("*/*.toml")):
        raw = p.read_bytes()
        adapter_id = f"{p.parent.name}/{p.stem}"
        try:
            spec = tomllib.loads(raw.decode("utf-8"))
        except tomllib.TOMLDecodeError as e:
            raise AdapterError(f"{adapter_id}: {e}") from None
        check_spec(adapter_id, spec)
        out.append(Adapter(adapter_id, p, hashlib.sha256(raw).hexdigest(), spec))
    return out
