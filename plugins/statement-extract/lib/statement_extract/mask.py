"""Display masking and the output leak gate.

DISPLAY masking only. Key text is normalised by the frozen functions in keys.py, which never
change in place; these rules may improve over time because nothing is keyed on their output.

Order matters: each rule sees the previous rule's output.
"""
import re
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class Rule:
    name: str
    provenance: str
    apply: Callable[[str], str]


def _last4(digits: str) -> str:
    return "••" + digits[-4:]


_DATE_SHAPES = re.compile(
    r"\d{4}[-/ ]\d{2}[-/ ]\d{2}|\d{2}[-/ ]\d{2}[-/ ]\d{4}|\d{2}[-/ ]\d{2}[-/ ]\d{2}"
)
_GROUPED = re.compile(r"(?<![\d•])\d+(?:[ -]\d+)+(?!\d)")


def _grouped(s: str) -> str:
    def sub(m: re.Match) -> str:
        text = m.group(0)
        digits = re.sub(r"\D", "", text)
        if len(digits) < 7 or _DATE_SHAPES.fullmatch(text):
            return text
        return _last4(digits)

    return _GROUPED.sub(sub, s)


RULES: tuple[Rule, ...] = (
    Rule("collapse-whitespace", "Desjardins PDF text (2026-10-31): layout runs of spaces",
         lambda s: re.sub(r"\s+", " ", s.strip())),
    Rule("desjardins-card", "Desjardins (2026-10-31) prints the card 'dddd dd** **** dddd'",
         lambda s: re.sub(r"\d{4} ?\d{2}\*\* ?\*{4} ?(\d{4})", r"••\1", s)),
    Rule("star-masked", "Scotiabank (2026-10-31) payees '*****12*3456': keep the last four",
         lambda s: re.sub(r"(?<![\d*])\*{2,}[\d*]*(\d{4})\b", r"••\1", s)),
    Rule("first4-stars-last4", "CIBC (2026-10-31) card memos 'CC#dddd********dddd'; Wise cards",
         lambda s: re.sub(r"\d{4}\*{4,}(\d{4})", r"••\1", s)),
    Rule("grouped-digits", "space/dash grouped account numbers (>=7 digits), dates excluded",
         _grouped),
    Rule("long-digit-run", "TD (2026-10-31) transfer payees 'TO:<number>': any 7+ digit run",
         lambda s: re.sub(r"\d{7,}", lambda m: _last4(m.group(0)), s)),
)


def mask(s: str | None) -> str:
    out = s or ""
    for rule in RULES:
        out = rule.apply(out)
    return out


# Every output string passes this, keys included. A trip is exit 5 with nothing emitted.
LEAK = re.compile(r"\d{7,}|\d{4} ?\d{2}\*|\d{4}\*{4,}|\*{2,}\d|•{3,}")


def leaks(s: str) -> bool:
    return bool(LEAK.search(s))
