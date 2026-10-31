"""Consumer-owned accounts.toml: last-four overrides and balance assertions.

    [[account]]
    institution = "Scotiabank"
    acctid_last4 = "0001"   # last four of the file's own account id
    last4 = "4321"          # the last four keys and labels use (e.g. the card on screen)
    kind = "card"           # optional label override

    [[account.balance]]     # optional; each one is checked, any match upgrades to "asserted"
    as_of = "2026-10-31"
    amount = "-12.34"       # in the FILE's sign: a card balance owed is negative

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
    acctid_last4: str
    last4: str | None = None
    kind: str | None = None
    balances: list[Balance] = field(default_factory=list)


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
        for k in ("institution", "acctid_last4"):
            if not isinstance(a.get(k), str):
                raise AccountsError(f"{where}: {k} must be a string")
        for k in ("acctid_last4", "last4"):
            if k in a and not re.fullmatch(r"\d{4}", a[k]):
                raise AccountsError(f"{where}: {k} must be exactly four digits")
        bals = []
        for b in a.get("balance", []):
            try:
                bals.append(Balance(str(b["as_of"]), Decimal(str(b["amount"]))))
            except (KeyError, InvalidOperation):
                raise AccountsError(f"{where}: balance needs as_of and a decimal amount") from None
        out.append(Account(a["institution"], a["acctid_last4"], a.get("last4"), a.get("kind"),
                           bals))
    return out


def find(accounts: list[Account], institution: str, acctid: str) -> Account | None:
    tail = acctid.strip()[-4:]
    hits = [a for a in accounts if a.institution == institution and a.acctid_last4 == tail]
    if len(hits) > 1:
        raise AccountsError(f"accounts file: two entries for {institution} ••{tail}")
    return hits[0] if hits else None
