"""Scotiabank line of credit PDF hook: the same statement layout as the Visa card, so it runs
card-pdf.py's parser rather than a second copy of it.

The adapter's sha256 covers only loc-pdf.toml and THIS file, so the parser it borrows is pinned
by hash: editing card-pdf.py fails this adapter's load until the pin below is updated, which in
turn changes this adapter's sha256. Provenance cannot silently go stale.
"""
import hashlib
import importlib.util
from pathlib import Path

_CARD = Path(__file__).with_name("card-pdf.py")
_CARD_SHA256 = "979891c1b8c0f5d91ce9e56258ba55c8de1cd6d0b5d48897e484a85aa8eca351"


def _load_card():
    raw = _CARD.read_bytes()
    if hashlib.sha256(raw).hexdigest() != _CARD_SHA256:
        raise ValueError("scotiabank/loc-pdf: card-pdf.py changed; review it for the line of "
                         "credit and update _CARD_SHA256 in loc-pdf.py")
    spec = importlib.util.spec_from_file_location("statement_extract_hook_scotiabank_loc_card",
                                                  _CARD)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_card = _load_card()


def parse_lines(lines: list[str], spec: dict, text: str) -> list:
    """Why not TOML: see card-pdf.py's parse_lines; the line of credit differs from the card
    only in data (identify markers, summary label), which lives in loc-pdf.toml."""
    return _card.parse_lines(lines, spec, text)
