"""Consumer-owned accounts.toml: last-four overrides and balance assertions.

    [[account]]
    institution = "Scotiabank"
    acctid_last4 = "0001"   # last four of the file's own account id
    last4 = "4321"          # the last four keys and labels use (e.g. the card on screen)
    kind = "card"           # optional label override

    [[account.balance]]     # optional; each one is checked, any match upgrades to "asserted"
    as_of = "2026-10-31"
    amount = "-12.34"       # in the FILE's sign: a card balance owed is negative

    [[account]]             # an adapter whose account is a currency (account.ref = "currency",
    institution = "Wise"    # e.g. Wise: one balance per currency, no number of its own) is
    currency = "CAD"        # selected by ISO code instead of acctid_last4, and takes no last4

The file lives with the consumer, never in this plugin: it names real accounts.
"""
import re
import tomllib
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import Path


@dataclass
class Balance:
    as_of: str
    amount: Decimal


@dataclass
class Account:
    institution: str
    acctid_last4: str | None
    last4: str | None = None
    kind: str | None = None
    balances: list[Balance] = field(default_factory=list)
    currency: str | None = None


class AccountsError(ValueError):
    pass


def load(path: Path | None) -> list[Account]:
    if path is None:
        return []
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise AccountsError(f"accounts file: {e}") from None
    out = []
    for i, a in enumerate(data.get("account", [])):
        where = f"accounts file, account #{i + 1}"
        if not isinstance(a.get("institution"), str):
            raise AccountsError(f"{where}: institution must be a string")
        if "currency" in a:
            if not re.fullmatch(r"[A-Z]{3}", str(a["currency"])):
                raise AccountsError(f"{where}: currency must be a three-letter ISO code")
            if "acctid_last4" in a or "last4" in a:
                raise AccountsError(f"{where}: a currency entry takes no acctid_last4 or last4 "
                                    "(the currency is the account, and the key)")
        elif not isinstance(a.get("acctid_last4"), str):
            raise AccountsError(f"{where}: acctid_last4 (or currency) must be a string")
        for k in ("acctid_last4", "last4"):
            if k in a and not re.fullmatch(r"\d{4}", a[k]):
                raise AccountsError(f"{where}: {k} must be exactly four digits")
        bals = []
        for b in a.get("balance", []):
            try:
                bals.append(Balance(str(b["as_of"]), Decimal(str(b["amount"]))))
            except (KeyError, InvalidOperation):
                raise AccountsError(f"{where}: balance needs as_of and a decimal amount") from None
        out.append(Account(a["institution"], a.get("acctid_last4"), a.get("last4"), a.get("kind"),
                           bals, a.get("currency")))
    return out


def find(accounts: list[Account], institution: str, acctid: str) -> Account | None:
    """A currency entry matches a statement whose account id IS that currency (account.ref =
    "currency" adapters); any other entry matches the last four of the file's account id."""
    tail = acctid.strip()[-4:]
    hits = [a for a in accounts if a.institution == institution
            and (a.currency == acctid.strip() if a.currency else a.acctid_last4 == tail)]
    if len(hits) > 1:
        label = acctid.strip() if hits[0].currency else f"••{tail}"
        raise AccountsError(f"accounts file: two entries for {institution} {label}")
    return hits[0] if hits else None
