"""Data shapes shared by drivers, the engine and the exporters."""
from dataclasses import dataclass, field
from decimal import Decimal
from enum import IntEnum


class Exit(IntEnum):
    OK = 0
    BUG = 1
    USAGE = 2
    REFUSED = 3       # a check failed, or a key collided
    UNIDENTIFIED = 4  # no adapter, several reconcile, or a required override is missing
    LEAK = 5          # an output string still has an account-number shape
    PARTIAL = 6       # --keep-going only: some files refused, the rest emitted


class Refusal(Exception):
    """Fail closed: the run stops with `code` and nothing is emitted for the file."""

    def __init__(self, code: Exit, reason: str, **detail):
        super().__init__(reason)
        self.code = Exit(code)
        self.reason = reason
        self.detail = detail


# Weakest to strongest. `--require` and an adapter's `minimum` compare by this order.
STATUSES = ("structural", "asserted", "proven")


@dataclass
class Check:
    name: str
    ok: bool
    expected: str = ""
    actual: str = ""
    note: str = ""

    def as_dict(self) -> dict:
        d = {"name": self.name, "ok": self.ok}
        for k in ("expected", "actual", "note"):
            if getattr(self, k):
                d[k] = getattr(self, k)
        return d


@dataclass
class TxnDraft:
    """One raw transaction as the statement shows it. Text is UNMASKED until the engine."""
    locator: str
    booking_date: str               # ISO date, as written in the file
    amount: Decimal                 # signed, holder view: + = money in
    description: str | None
    memo: str | None
    source_type: str
    entry_ref: str | None           # the institution's own id (FITID), if any
    transaction_date: str | None = None
    counterparty: str | None = None
    running_balance: Decimal | None = None
    key_date: str | None = None     # the date a frozen content key uses, when it differs
    native_ts: str | None = None    # native-id-ts/1: the row's timestamp exactly as printed
    raw_amount_text: str = ""


@dataclass
class StatementDraft:
    """One account's statement inside one file."""
    index: int
    acctid: str                     # UNMASKED; never leaves the engine
    kind: str
    currency: str
    period_start: str | None
    period_end: str | None
    closing: Decimal | None
    closing_as_of: str | None
    available: Decimal | None = None
    opening: Decimal | None = None
    transactions: list[TxnDraft] = field(default_factory=list)
    raw_txn_count: int = 0
    skipped: int = 0
    checks: list[Check] = field(default_factory=list)
