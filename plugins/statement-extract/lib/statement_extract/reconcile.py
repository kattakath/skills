"""Turn a statement's checks into a reconcile status, and apply balance assertions.

structural  every structural check passed (the OFX gate: all raw <STMTTRN> parsed, no unknown
            tags, FITIDs unique, LEDGERBAL present, one currency)
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


def status(checks: list[Check]) -> str:
    """Caller guarantees all checks passed. Asserted needs a real (non-skipped) agreement."""
    for c in checks:
        if c.name in ("external_assertion", "balance_equation") and c.ok \
                and not c.note.startswith("skipped"):
            return "asserted"
    return "structural"
