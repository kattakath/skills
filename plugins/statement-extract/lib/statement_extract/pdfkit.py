"""Shared helpers for PDF adapter hooks: amounts, dates, columns, running balances.

A hook imports these instead of re-deriving them, so every PDF adapter parses money and
proves balances the same way. Pure functions; no I/O.
"""
import re
from decimal import Decimal

from .model import Check

MONTHS = {m: i for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}
FULL_MONTHS = {m: i for i, m in enumerate(
    ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER",
     "OCTOBER", "NOVEMBER", "DECEMBER"], 1)}

# "1,234.56", "$1,234.56", "-1,234.56", "1,234.56-", "(1,234.56)", optional trailing "CR".
AMOUNT = r"\(?-?\$?\d{1,3}(?:,\d{3})*\.\d{2}-?\)?(?:\s?CR)?"
AMOUNT_RE = re.compile(AMOUNT)


def month(name: str) -> int:
    """'Sep', 'SEP', 'September' -> 9. Raises KeyError on anything else."""
    n = name.strip().upper().rstrip(".")
    return FULL_MONTHS[n] if n in FULL_MONTHS else MONTHS[n[:3]]


def amount(text: str) -> Decimal:
    """Printed amount -> Decimal, negative for a leading/trailing minus, parentheses or CR.

    What the sign MEANS (money in or out) is the hook's call: card statements print a
    purchase positive, bank statements print a withdrawal in its own column.
    """
    t = text.strip()
    neg = t.startswith(("-", "(")) or t.endswith(("-", ")")) or t.upper().endswith("CR")
    digits = re.sub(r"[^\d.]", "", re.sub(r"CR$", "", t, flags=re.I))
    d = Decimal(digits)
    return -d if neg else d


def infer_year(mon: int, end_month: int, end_year: int) -> int:
    """A statement ending in `end_month/end_year` can only hold months up to `end_month`; a
    later month number belongs to the previous year (a January statement's December rows)."""
    return end_year - 1 if mon > end_month else end_year


def iso(year: int, mon: int, day: int) -> str:
    return f"{year:04d}-{mon:02d}-{day:02d}"


def columns(header: str, names: dict[str, str]) -> dict[str, tuple[int, int]]:
    """Locate column headings on a header line: {key: regex} -> {key: (start, end)}.
    Raises KeyError naming the heading that is missing."""
    out = {}
    for key, rx in names.items():
        m = re.search(rx, header)
        if not m:
            raise KeyError(f"column heading {key!r} not found")
        out[key] = (m.start(), m.end())
    return out


def nearest_column(span: tuple[int, int], cols: dict[str, tuple[int, int]]) -> str:
    """The column whose heading's RIGHT edge is nearest the value's right edge: amounts are
    right-aligned under their heading in every layout seen so far."""
    return min(cols, key=lambda k: abs(cols[k][1] - span[1]))


def running_chain(opening: Decimal, rows: list[dict]) -> Check:
    """rows: [{'amount': signed Decimal, 'balance': Decimal | None}] in statement order.
    Where a balance is printed (every row, or only a day's last row), the running total so far
    must equal it. A layout that prints no balances at all cannot pass this check."""
    run = opening
    printed = 0
    breaks = []
    for n, r in enumerate(rows, 1):
        run += r["amount"]
        if r.get("balance") is not None:
            printed += 1
            if run != r["balance"]:
                breaks.append(n)
                run = r["balance"]  # report each break once, not every row after it
    ok = not breaks and (printed > 0 or not rows)
    return Check("running_chain", ok,
                 expected="running total = every printed balance",
                 actual=(f"breaks at row(s) {breaks}" if breaks else
                         f"{printed} printed balance(s) agree" if printed else
                         "no printed balance to check against"))
