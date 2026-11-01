"""Consumer-owned ledger.toml. It names real accounts, so it lives with the consumer's data,
never in this plugin.

    operating_currency = "CAD"
    title = "Household"                       # optional

    [transfers]                               # every key optional; defaults shown
    account = "Assets:Transfers"              # own-account legs clear through here
    external = "Equity:Transfers:External"    # legs to own accounts outside the journal
    fee_account = "Expenses:Fees:Transfers"   # a fee-band pair's shortfall
    window = [-3, 5]                          # inflow days after the outflow
    fee_institutions = []                     # institutions whose pairs may be short by a fee
    fee_max = 0.0035
    early_days = 7                            # fee institutions may post the inflow early
    wide_pattern = "REVERSAL|CORRECTION"      # memos that get +-6 days
    [transfers.fx]
    USD = [0.70, 0.76]                        # inflow/outflow ratio band, by inflow currency

    [categories]                              # Plaid DETAILED -> account, overriding defaults
    LOAN_PAYMENTS_MORTGAGE_PAYMENT = "Liabilities:Mortgage"

    [[account]]
    institution = "Bank"
    label = "••1234"          # the account as the rows show it; "<CUR> balance" for a
                              # per-currency wallet (statement-extract kind "balance")
    name = "Liabilities:Bank:Card-1234"
    open = "2020-01-01"       # optional; default: the earliest date the journal uses it
    close = "2025-06-30"      # optional
    assert = true             # false: emit no balance assertions (say why in `reason`)
    reason = ""
    interest = "Expenses:Interest:Mortgage"   # positions only: what a later pad books to

    [[gap]]                   # an explained hole in the history: pad from Equity:Gaps
    account = "Liabilities:Bank:Card-1234"
    date = "2023-04-01"
    reason = "statement for March 2023 not available"
"""
import re
import tomllib
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from .errors import Exit, Refusal

ACCOUNT_RE = re.compile(r"^(Assets|Liabilities|Equity|Income|Expenses)(:[A-Z0-9][A-Za-z0-9-]*)+$")


@dataclass
class Account:
    institution: str
    label: str
    name: str
    open: str | None = None
    close: str | None = None
    asserts: bool = True
    reason: str = ""
    interest: str | None = None


@dataclass
class Gap:
    account: str
    date: str
    reason: str


@dataclass
class Transfers:
    account: str = "Assets:Transfers"
    external: str = "Equity:Transfers:External"
    fee_account: str = "Expenses:Fees:Transfers"
    window: tuple = (-3, 5)
    fee_institutions: frozenset = frozenset()
    fee_max: float = 0.0035
    early_days: int = 7
    wide_pattern: str = r"REVERSAL|CORRECTION"
    fx: dict = field(default_factory=dict)


@dataclass
class Ledger:
    operating_currency: str
    title: str
    transfers: Transfers
    categories: dict
    accounts: list[Account]
    gaps: list[Gap]

    def account_for(self, institution: str, label: str) -> Account | None:
        for a in self.accounts:
            if a.institution == institution and a.label == label:
                return a
        return None


def _name(value, where: str) -> str:
    if not isinstance(value, str) or not ACCOUNT_RE.match(value):
        raise Refusal(Exit.USAGE, f"{where}: {value!r} is not a Beancount account name")
    return value


def _date(value, where: str) -> str:
    try:
        return date.fromisoformat(str(value)).isoformat()
    except ValueError:
        raise Refusal(Exit.USAGE, f"{where}: {value!r} is not an ISO date") from None


def load(path: Path) -> Ledger:
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise Refusal(Exit.USAGE, f"ledger.toml: {e}") from None

    t = raw.get("transfers", {})
    lo, hi = t.get("window", [-3, 5])
    transfers = Transfers(
        account=_name(t.get("account", "Assets:Transfers"), "transfers.account"),
        external=_name(t.get("external", "Equity:Transfers:External"), "transfers.external"),
        fee_account=_name(t.get("fee_account", "Expenses:Fees:Transfers"), "transfers.fee_account"),
        window=(int(lo), int(hi)),
        fee_institutions=frozenset(t.get("fee_institutions", [])),
        fee_max=float(t.get("fee_max", 0.0035)),
        early_days=int(t.get("early_days", 7)),
        wide_pattern=t.get("wide_pattern", r"REVERSAL|CORRECTION"),
        fx={c: (float(b[0]), float(b[1])) for c, b in t.get("fx", {}).items()},
    )
    categories = {k: _name(v, f"categories.{k}") for k, v in raw.get("categories", {}).items()}

    accounts, seen = [], set()
    for i, a in enumerate(raw.get("account", [])):
        where = f"account[{i}]"
        if not a.get("institution") or not a.get("label"):
            raise Refusal(Exit.USAGE, f"{where}: needs institution and label")
        k = (a["institution"], a["label"])
        if k in seen:
            raise Refusal(Exit.USAGE, f"{where}: {k} is mapped twice")
        seen.add(k)
        accounts.append(Account(
            institution=a["institution"], label=a["label"], name=_name(a.get("name"), where),
            open=_date(a["open"], where) if a.get("open") else None,
            close=_date(a["close"], where) if a.get("close") else None,
            asserts=bool(a.get("assert", True)), reason=a.get("reason", ""),
            interest=_name(a["interest"], where) if a.get("interest") else None))
    gaps = [Gap(_name(g.get("account"), f"gap[{i}]"), _date(g.get("date"), f"gap[{i}]"),
                g.get("reason", "")) for i, g in enumerate(raw.get("gap", []))]
    return Ledger(operating_currency=raw.get("operating_currency", "CAD"),
                  title=raw.get("title", "Ledger"), transfers=transfers, categories=categories,
                  accounts=accounts, gaps=gaps)
