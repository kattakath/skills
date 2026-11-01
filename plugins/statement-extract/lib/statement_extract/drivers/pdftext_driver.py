"""PDF text-layer driver: get the layout text, identify by text markers, hand lines to the
adapter's parse_lines hook, and refuse anything the hook could not tie to printed totals.

The adapter's TOML declares `identify.text` (regexes that must ALL match) and its `grammar`
(the regexes its hook uses). The hook returns StatementDrafts with their checks.
"""
import re
from pathlib import Path

from ..model import Exit, Refusal, StatementDraft
from ..readers import pdftext

IDENT_FIELDS = {"text": "regexes that must all match the layout text"}


def identify(raw: bytes, adapter, path: Path | None) -> bool:
    text = pdftext.maybe_text(path, raw)
    if text is None:
        return False
    return all(re.search(rx, text, re.M) for rx in adapter.spec["identify"]["text"])


def extract(raw: bytes, adapter, path: Path | None) -> tuple[list[StatementDraft], list[str]]:
    text = pdftext.text_of(path, raw)
    try:
        drafts = adapter.hook.parse_lines(text.splitlines(), adapter.spec, text)
    except Refusal:
        raise
    except (ValueError, KeyError, ArithmeticError) as e:
        raise Refusal(Exit.REFUSED, f"{adapter.id}: layout not understood "
                      f"({type(e).__name__}: {e})") from None
    if not drafts:
        raise Refusal(Exit.REFUSED, f"{adapter.id}: no statement found in the text")
    return drafts, []
