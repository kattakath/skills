"""Turn a statement's checks into a reconcile status, and apply balance assertions.

structural  every structural check passed (the OFX gate: all raw <STMTTRN> parsed, no unknown
            tags, FITIDs unique, LEDGERBAL present, one currency; the CSV gate: rows
            proven in order, one currency, native ids unique, the running balance chains)
asserted    structural + an outside balance (accounts.toml) agrees with the file
proven      the statement proves itself from printed totals (PDF adapters, later releases)
"""
from decimal import Decimal

from .accounts import Account
from .model import STATUSES, Check, StatementDraft


def rank(status: str) -> int:
    return STATUSES.index(status)


def assertions(draft: StatementDraft, account: Account | None) -> list[Check]:
    """external_assertion when as_of is the closing date; balance_equation when it is earlier."""
    out = []
    if account is None or draft.closing is None:
        return out
    for b in account.balances:
        if b.as_of == draft.closing_as_of:
            out.append(Check("external_assertion", draft.closing == b.amount,
                             expected=format(b.amount, "f"), actual=format(draft.closing, "f"),
                             note=f"closing balance as of {b.as_of}"))
        elif draft.closing_as_of and b.as_of < draft.closing_as_of:
            if draft.period_start is None or draft.period_start > b.as_of:
                # The window starts after the asserted day: rows in between are not in this
                # file, so the equation cannot be closed. Say so; do not guess.
                out.append(Check("balance_equation", True, note=(
                    f"skipped: statement starts {draft.period_start}, after {b.as_of}")))
                continue
            moved = sum((t.amount for t in draft.transactions
                         if b.as_of < t.booking_date <= draft.closing_as_of), Decimal(0))
            expected = b.amount + moved
            out.append(Check("balance_equation", expected == draft.closing,
                             expected=format(expected, "f"), actual=format(draft.closing, "f"),
                             note=f"balance {b.as_of} + rows after it = closing"))
    return out


def status(checks: list[Check], proves: bool = False) -> str:
    """Caller guarantees all checks passed. Asserted needs a real (non-skipped) agreement;
    proven is for adapters whose own checks tie every row to printed totals."""
    if proves:
        return "proven"
    for c in checks:
        if c.name in ("external_assertion", "balance_equation") and c.ok \
                and not c.note.startswith("skipped"):
            return "asserted"
    return "structural"


# --- helpers for adapters whose statements print their own totals ------------------------

def balance_equation(opening: Decimal, rows, closing: Decimal, note: str = "") -> Check:
    total = opening + sum((t.amount for t in rows), Decimal(0))
    return Check("balance_equation", total == closing, expected=format(closing, "f"),
                 actual=format(total, "f"), note=note or "opening + rows = closing")


def printed_total(name: str, computed: Decimal, printed: Decimal, note: str = "") -> Check:
    return Check(name, computed == printed, expected=format(printed, "f"),
                 actual=format(computed, "f"), note=note)


def running_chain(chron_rows) -> tuple[Check, Decimal | None, Decimal | None]:
    """Every row, oldest first, must satisfy previous running balance + amount = its running
    balance. The oldest row has no predecessor, so the opening is derived from it
    (running balance - amount): a dropped OLDEST row cannot be seen here, a dropped middle row
    always can, and a dropped newest row only by an outside assertion of the closing.
    -> (check, opening, closing); opening and closing are None when there are no rows."""
    rows = list(chron_rows)
    if not rows:
        return Check("running_chain", True, note="no rows"), None, None
    opening = rows[0].running_balance - rows[0].amount
    prev, breaks = opening, 0
    for t in rows:
        if prev + t.amount != t.running_balance:
            breaks += 1
        prev = t.running_balance
    return (Check("running_chain", breaks == 0, expected="0 breaks", actual=f"{breaks} breaks",
                  note="previous running balance + amount = running balance, oldest first"),
            opening, prev)
