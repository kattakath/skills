"""Read the durable inputs: canonical JSONL, accounts.toml screen balances, decisions CSV."""
import csv
import json
import re
import tomllib
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path

from . import SCHEMA
from .errors import Exit, Refusal

CATEGORY_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")


def ws(s) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


@dataclass
class Row:
    """One transaction in the shape the rules and the pairing read (the Sheet's columns)."""
    key: str
    iso: str
    amount: Decimal
    payee: str          # counterparty, else description, whitespace collapsed
    memo: str
    inst: str
    acct: str           # the account label: ref, or "<CUR> balance" for a balance account
    cur: str
    sha: str
    n: int = 0          # tiebreak: position after sorting by (date, key)
    # set by the rules pass
    cat: str = ""
    rule: dict | None = None
    cps: set = field(default_factory=set)
    pair: "Row | None" = None
    pair_kind: str = ""
    decision: dict | None = None

    @property
    def amt(self) -> float:
        return float(self.amount)

    @property
    def date(self) -> date:
        return date.fromisoformat(self.iso)

    @property
    def text(self) -> str:
        return f"{self.payee} || {self.memo}"


@dataclass
class Assertion:
    inst: str
    acct: str
    as_of: str          # the day the figure is true at its end; asserted on as_of + 1
    amount: Decimal     # holder view: an amount owed is negative
    cur: str
    origin: str         # statement | screen | position


def _dec(s, where: str) -> Decimal:
    try:
        return Decimal(str(s))
    except InvalidOperation:
        raise Refusal(Exit.USAGE, f"{where}: {s!r} is not a decimal") from None


def label_of(ref: str, kind: str) -> str:
    return f"{ref} balance" if kind == "balance" else ref


def read_jsonl(paths: list[Path]):
    """Every record of every file. Rows dedupe by Key across files; two records with one Key
    that disagree on date, amount, currency or account refuse the build."""
    rows: dict[str, Row] = {}
    asserts, positions, conflicts = [], [], []
    for p in paths:
        try:
            lines = p.read_text(encoding="utf-8").splitlines()
        except OSError as e:
            raise Refusal(Exit.USAGE, f"{p.name}: {e}") from None
        recs = []
        for i, line in enumerate(lines, 1):
            if not line.strip():
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError as e:
                raise Refusal(Exit.USAGE, f"{p.name}:{i}: {e}") from None
            if r.get("schema") != SCHEMA:
                raise Refusal(Exit.USAGE, f"{p.name}:{i}: schema {r.get('schema')!r}, "
                                          f"expected {SCHEMA!r}")
            recs.append((i, r))
        stmts = {r["statement_id"]: r for _, r in recs if r.get("record") == "statement"}
        for i, r in recs:
            kind = r.get("record")
            if kind == "statement":
                b = r["balances"]
                if b.get("closing") is not None and b.get("closing_as_of"):
                    a = r["account"]
                    asserts.append(Assertion(r["institution"], label_of(a["ref"], a["kind"]),
                                             b["closing_as_of"], _dec(b["closing"], p.name),
                                             a["currency"], "statement"))
            elif kind == "position":
                a = r["account"]
                principal = _dec(r["balances"]["principal_outstanding"], p.name)
                positions.append(Assertion(r["institution"], label_of(a["ref"], a["kind"]),
                                           r["as_of"], -principal, a["currency"], "position"))
            elif kind == "transaction":
                st = stmts.get(r["statement_id"])
                if st is None:
                    raise Refusal(Exit.USAGE, f"{p.name}:{i}: no statement record for "
                                              "its statement_id")
                row = Row(key=r["key"], iso=r["booking_date"],
                          amount=_dec(r["amount"], f"{p.name}:{i}"),
                          payee=ws(r.get("counterparty") or r.get("description") or ""),
                          memo=ws(r.get("memo")), inst=r["institution"],
                          acct=label_of(r["account"], st["account"]["kind"]),
                          cur=r["currency"], sha=r["source"]["sha256"])
                old = rows.get(row.key)
                if old is None:
                    rows[row.key] = row
                elif (old.iso, old.amount, old.cur, old.inst, old.acct) != \
                        (row.iso, row.amount, row.cur, row.inst, row.acct):
                    conflicts.append(row.key)
    if conflicts:
        raise Refusal(Exit.REFUSED, "one Key, two different transactions", conflicts)
    out = sorted(rows.values(), key=lambda x: (x.iso, x.key))
    for n, x in enumerate(out):
        x.n = n
    return out, asserts, positions


def read_screen_balances(path: Path, default_cur: str) -> list[Assertion]:
    """statement-extract's accounts.toml: each [[account.balance]] is a figure read off the
    lender's screen, in the file's sign. One home for it; the journal asserts it too."""
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise Refusal(Exit.USAGE, f"accounts.toml: {e}") from None
    out = []
    for i, a in enumerate(raw.get("account", [])):
        if a.get("currency"):
            label, cur = f"{a['currency']} balance", a["currency"]
        else:
            last4 = a.get("last4") or a.get("acctid_last4")
            label, cur = "••" + str(last4)[-4:], default_cur
        for b in a.get("balance", []):
            out.append(Assertion(a["institution"], label, str(b["as_of"]),
                                 _dec(b["amount"], f"accounts.toml account[{i}]"), cur,
                                 "screen"))
    return out


DECISION_FIELDS = ("key", "category", "note", "service", "service_ref", "suggestion", "accept")


def read_decisions(path: Path) -> dict[str, dict]:
    """The Review decisions tab exported as CSV: one row per Key."""
    try:
        with path.open(newline="", encoding="utf-8") as fh:
            reader = csv.DictReader(fh)
            rows = list(reader)
    except OSError as e:
        raise Refusal(Exit.USAGE, f"decisions: {e}") from None
    missing = [f for f in ("key", "category") if f not in (reader.fieldnames or [])]
    if missing:
        raise Refusal(Exit.USAGE, f"decisions: header lacks {missing}")
    out, bad = {}, []
    for r in rows:
        k = (r.get("key") or "").strip()
        if not k:
            continue
        d = {f: ws(r.get(f)) for f in DECISION_FIELDS}
        accepted = d["accept"].upper() in ("TRUE", "YES", "Y", "1", "X")
        d["override"] = d["category"] or (d["suggestion"] if accepted else "")
        if d["override"] and not CATEGORY_RE.match(d["override"]):
            bad.append(k)
        if k in out:
            raise Refusal(Exit.REFUSED, "decisions: a Key appears twice", [k])
        out[k] = d
    if bad:
        raise Refusal(Exit.REFUSED, "decisions: category is not a Plaid DETAILED value", bad)
    return out
