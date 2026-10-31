"""Decimal handling. Amounts never pass through float."""
from decimal import Decimal, InvalidOperation


def parse_ofx_amount(text: str) -> Decimal:
    """Same acceptance as ofxtools 0.9.5 `Types.Decimal`: plain Decimal, else comma-as-point.

    Matching it matters because a content key formats this value with `.2f`.
    """
    try:
        return Decimal(text)
    except InvalidOperation:
        try:
            return Decimal(text.replace(",", "."))
        except InvalidOperation:
            raise ValueError(f"not an amount: {text!r}") from None


def fmt2(d: Decimal) -> str:
    """`f"{d:.2f}"` on a Decimal: the context rounding (ROUND_HALF_EVEN). Frozen key bytes."""
    return f"{d:.2f}"


def as_str(d: Decimal | None) -> str | None:
    """Canonical decimal string for output: fixed-point, never an exponent."""
    if d is None:
        return None
    return format(d, "f")


def credit_debit(d: Decimal) -> str:
    return "DBIT" if d < 0 else "CRDT"
