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
from . import pfc
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
    statement_id: str = ""
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
    statement_id: str = ""


def _dec(s, where: str) -> Decimal:
    try:
        return Decimal(str(s))
    except InvalidOperation:
        raise Refusal(Exit.USAGE, f"{where}: {s!r} is not a decimal") from None


def label_of(ref: str, kind: str) -> str:
    return f"{ref} balance" if kind == "balance" else ref


def read_jsonl(paths: list[Path]):
    """Every record of every file. Overlapping statements of one account are resolved by
    survivorship (survive.py): each day belongs to the best-ranked source covering it. Rows
    then dedupe by Key across files; two records with one Key that disagree on date, amount,
    currency or account refuse the build."""
    from . import survive
    rows: dict[str, Row] = {}
    stmts_of: dict[str, set] = {}   # Key -> every statement that prints it (dedupe keeps one row)
    asserts, positions, conflicts = [], [], []
    all_stmts, raw = {}, []
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
        all_stmts.update(stmts)
        for i, r in recs:
            kind = r.get("record")
            if kind == "statement":
                b = r["balances"]
                if b.get("closing") is not None and b.get("closing_as_of"):
                    a = r["account"]
                    asserts.append(Assertion(r["institution"], label_of(a["ref"], a["kind"]),
                                             b["closing_as_of"], _dec(b["closing"], p.name),
                                             a["currency"], "statement", r["statement_id"]))
            elif kind == "position":
                a = r["account"]
                principal = _dec(r["balances"]["principal_outstanding"], p.name)
                positions.append(Assertion(r["institution"], label_of(a["ref"], a["kind"]),
                                           r["as_of"], -principal, a["currency"], "position"))
            elif kind == "transaction":
                if r["statement_id"] not in stmts:
                    raise Refusal(Exit.USAGE, f"{p.name}:{i}: no statement record for "
                                              "its statement_id")
                raw.append((p.name, i, r))

    def acct_of(s):
        return (s["institution"], label_of(s["account"]["ref"], s["account"]["kind"]))

    kept, twins, dropped = survive.resolve(all_stmts, [r for *_, r in raw], acct_of)
    kept_ids = {id(r) for r in kept}
    for name, i, r in raw:
        if id(r) not in kept_ids:
            continue
        st = all_stmts[r["statement_id"]]
        row = Row(key=r["key"], iso=r["booking_date"],
                  amount=_dec(r["amount"], f"{name}:{i}"),
                  payee=ws(r.get("counterparty") or r.get("description") or ""),
                  memo=ws(r.get("memo")), inst=r["institution"],
                  acct=label_of(r["account"], st["account"]["kind"]),
                  cur=r["currency"], sha=r["source"]["sha256"],
                  statement_id=r["statement_id"])
        stmts_of.setdefault(row.key, set()).add(row.statement_id)
        stmts_of[row.key] |= twins.get(row.key, set())
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
    survival = {"dropped": dropped,
                "holes": survive.holes(all_stmts, [r for *_, r in raw], acct_of),
                # every statement, for `document` links: (account, as-of, sha256, file name)
                "statements": sorted(
                    (acct_of(s), s["balances"].get("closing_as_of") or s["period"].get("end"),
                     (s.get("source") or {}).get("sha256", ""), (s.get("source") or {}).get("file", ""))
                    for s in all_stmts.values()
                    if (s["balances"].get("closing_as_of") or s["period"].get("end")))}
    return out, *split_overlaps(asserts, out, stmts_of), positions, survival


def split_overlaps(asserts, rows, stmts_of=None):
    """A statement closing is asserted at the start of the day after its as-of date. When a LATER
    statement of the same account prints a row dated on or before that as-of date (a bank that
    posts next period's fee on this period's last day, measured 2026-11-01), no day boundary
    separates the two statements, so the figure cannot be asserted at day granularity. Those
    assertions are set aside and counted, never adjusted: an adjusted figure is one no
    statement printed. Every other figure stays a strict assertion.

    A row counts as a clash only if THIS statement does not print it and every statement that
    does print it ends after this one. An overlapping re-export (a "last 30 days" download
    repeating rows an earlier statement already holds) is therefore no clash: dedupe keeps one
    copy of each row, but provenance remembers all of them (measured 2026-11-01: without this, a
    top-up export set aside the previous statement's closing for no reason)."""
    end_of = {a.statement_id: a.as_of for a in asserts if a.statement_id}
    stmts_of = stmts_of or {x.key: {x.statement_id} for x in rows}
    by_acct = {}
    for x in rows:
        by_acct.setdefault((x.inst, x.acct), []).append(x)
    keep, skipped = [], []
    for a in asserts:
        if a.origin == "statement":
            clash = any(x.iso <= a.as_of and a.statement_id not in stmts_of[x.key]
                        and all(end_of.get(s, "") > a.as_of for s in stmts_of[x.key])
                        for x in by_acct.get((a.inst, a.acct), ()))
            if clash:
                skipped.append(a)
                continue
        keep.append(a)
    return keep, skipped


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


BUDGET_FIELDS = ("from", "account", "period", "amount")
BUDGET_PERIODS = {"daily", "weekly", "monthly", "quarterly", "yearly"}


def read_budgets(path: Path, default_cur: str) -> list[tuple]:
    """The Budgets tab exported as CSV: from, account, period, amount[, currency]. Rows with
    no amount are skipped (a category listed but not yet budgeted)."""
    try:
        rows = list(csv.DictReader(path.open(encoding="utf-8")))
    except OSError as e:
        raise Refusal(Exit.USAGE, f"budgets: {e}") from None
    if rows and not set(BUDGET_FIELDS) <= set(rows[0]):
        raise Refusal(Exit.USAGE, f"budgets: needs columns {', '.join(BUDGET_FIELDS)}")
    out, bad = [], []
    for i, r in enumerate(rows, 2):
        if not (r.get("amount") or "").strip():
            continue
        acct, period = (r.get("account") or "").strip(), (r.get("period") or "").strip().lower()
        try:
            d = date.fromisoformat((r.get("from") or "").strip()).isoformat()
            amt = Decimal((r["amount"] or "").replace(",", "").strip())
        except (ValueError, InvalidOperation):
            bad.append(f"row {i}: from/amount"); continue
        if not re.match(r"^[A-Z][A-Za-z0-9-]*(:[A-Z0-9][A-Za-z0-9-]*)+$", acct) or period not in BUDGET_PERIODS:
            bad.append(f"row {i}: account/period"); continue
        out.append((d, acct, period, amt, (r.get("currency") or "").strip() or default_cur))
    if bad:
        raise Refusal(Exit.USAGE, "budgets: rows not understood", bad)
    return sorted(out)


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
        if d["override"] and (not CATEGORY_RE.match(d["override"]) or pfc.unknown([d["override"]])):
            bad.append(f"{k}: {d['override']}")
        if k in out:
            raise Refusal(Exit.REFUSED, "decisions: a Key appears twice", [k])
        out[k] = d
    if bad:
        raise Refusal(Exit.REFUSED, "decisions: category is not a pinned Plaid PFC v2 name "
                                    f"(plaid-pfc, fetched {pfc.pin()['fetched']})", bad)
    return out
