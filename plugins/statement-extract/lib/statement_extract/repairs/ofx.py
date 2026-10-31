"""Named byte-level repairs for non-spec OFX exports.

Each repair is idempotent and a no-op on clean input; tests/test_repairs.py holds the three
cases per repair (before->after, twice == once, clean unchanged). An adapter lists the repairs
it needs, in this registry's order, and the report names every one that changed a byte.

The regexes are the agentic-ledger qfx_rows.py repairs of 2026-10-31, unchanged.
"""
import re
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class Repair:
    name: str
    provenance: str
    fn: Callable[[bytes], bytes]


def _empty_accttype(raw: bytes) -> bytes:
    return re.sub(rb"<ACCTTYPE>\s*(?=[\r\n<])", b"<ACCTTYPE>CHECKING", raw)


def _cc_stmttrnrs(raw: bytes) -> bytes:
    return re.sub(
        rb"<CREDITCARDMSGSRSV1>.*?</CREDITCARDMSGSRSV1>",
        lambda m: m.group(0).replace(b"<STMTTRNRS>", b"<CCSTMTTRNRS>"),
        raw,
        flags=re.S,
    )


def _charset_1252_utf8(raw: bytes) -> bytes:
    if re.search(rb"^CHARSET:1252", raw[:600], re.M) and re.search(rb"[\x80-\xff]", raw):
        try:
            return raw.decode("utf-8").encode("cp1252")
        except (UnicodeDecodeError, UnicodeEncodeError):
            pass
    return raw


def _ccacctfrom_accttype(raw: bytes) -> bytes:
    return re.sub(rb"<ACCTTYPE>[A-Z]*(?=\s*</CCACCTFROM>)", b"", raw)


# Registry order is application order (the legacy order).
REPAIRS: tuple[Repair, ...] = (
    Repair("empty-accttype",
           "TD EasyWeb (2026-10-31): empty <ACCTTYPE> in BANKACCTFROM; fill the spec default",
           _empty_accttype),
    Repair("cc-stmttrnrs-wrapper",
           "TD EasyWeb (2026-10-31): LOC opens <STMTTRNRS> inside CREDITCARDMSGSRSV1 but "
           "closes </CCSTMTTRNRS>",
           _cc_stmttrnrs),
    Repair("charset-1252-utf8-body",
           "CIBC (2026-10-31): declares CHARSET:1252 over a UTF-8 body ('PRÊT' read as "
           "'PRÃŠT'); transcode only when the body is valid UTF-8",
           _charset_1252_utf8),
    Repair("ccacctfrom-accttype",
           "CIBC (2026-10-31): <ACCTTYPE>CREDITLINE inside CCACCTFROM, which has none",
           _ccacctfrom_accttype),
)
BY_NAME = {r.name: r for r in REPAIRS}


def apply(raw: bytes, names: list[str]) -> tuple[bytes, list[str]]:
    """Apply the named repairs in registry order. -> (bytes, names that changed something)."""
    unknown = [n for n in names if n not in BY_NAME]
    if unknown:
        raise ValueError(f"unknown repair(s): {', '.join(unknown)}")
    fired = []
    for r in REPAIRS:
        if r.name in names:
            new = r.fn(raw)
            if new != raw:
                fired.append(r.name)
                raw = new
    return raw, fired
