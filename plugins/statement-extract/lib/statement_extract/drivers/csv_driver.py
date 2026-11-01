"""CSV driver: declarative. The adapter's TOML says everything about the file; there is no
per-institution code on this path.

    [identify]
    header   = ["Id", "Date", ...]          # columns that must ALL be in the header row
    filename = ['^bank-(?P<currency>[A-Z]{3})-(?P<start>\\d{4}-\\d{2}-\\d{2})-to-...\\.csv$']
                                            # any one must match the basename; the named
                                            # groups currency / start / end are read below
    [csv]
    encoding = "utf-8-sig"                  # utf-8-sig accepts and strips a UTF-8 BOM
    drop     = ["Some Column"]              # never read: removed by NAME as each row is split
    currency = "Currency"                   # column; absent or every row empty -> file name
    order    = "newest-first"               # or "oldest-first"; proven, never assumed

    [csv.columns]
    id = "Id"                    # the institution's own id (entry_ref; native-id-ts/1 keys)
    datetime = "Date Time"       # printed timestamp: order proof and native-id-ts/1 keys
    date = "Date"                # booking date
    amount = "Amount"            # signed, + = money in, unless [sign] flip = true
    running_balance = "Balance"  # optional: every row must chain (running_chain)
    description = ["Description"]           # text fields: first non-empty column wins
    counterparty = ["Merchant", "Payee"]
    memo = ["Reference"]
    source_type = ["Type"]

    [csv.formats]
    date = "%d-%m-%Y"
    datetime = "%d-%m-%Y %H:%M:%S.%f"

Checks: row_width (every record has the header's width), order_proof, single_currency (one
currency, and the file name's when it carries one), running_chain (when a running balance
is mapped). The engine adds native_id_unique for native-id-ts/1 keys.

A header-only file is a statement with zero rows: its currency and period come from the
file name, and its balances are unknown (null), because an export with no movements says
nothing about the balance that sat idle through it.
"""
import csv
import io
import re
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .. import reconcile
from ..model import Check, Exit, Refusal, StatementDraft, TxnDraft

IDENT_FIELDS = {"header": "columns that must all be in the header row",
                "filename": "regexes; one must match the file's basename"}
# Columns no CSV adapter may ever read, whatever its TOML says: they hold third parties'
# full account numbers (Wise, measured 2026-10-31).
NEVER_READ = ("Payee Account Number",)
CSV_KEYS = {"encoding", "drop", "currency", "order", "columns", "formats"}
SINGLE = ("id", "datetime", "date", "amount", "running_balance")
TEXT = ("description", "counterparty", "memo", "source_type")
ORDERS = ("newest-first", "oldest-first")
FILENAME_GROUPS = ("currency", "start", "end")


def _texts(v) -> list[str]:
    return [v] if isinstance(v, str) else list(v or [])


def check_spec(spec: dict) -> list[str]:
    """Problems with a csv adapter's TOML, so a typo fails at load, not on a statement."""
    out = []
    c = spec.get("csv")
    if not isinstance(c, dict):
        return ["a csv adapter needs a [csv] table"]
    out += [f"unknown [csv] key {k!r}" for k in sorted(set(c) - CSV_KEYS)]
    cols = c.get("columns", {})
    out += [f"unknown [csv.columns] field {k!r}" for k in sorted(set(cols) - set(SINGLE + TEXT))]
    out += [f"[csv.formats] unknown {k!r}" for k in sorted(set(c.get("formats", {}))
                                                        - {"date", "datetime"})]
    for req in ("date", "amount"):
        if req not in cols:
            out.append(f"[csv.columns] needs {req!r}")
    header = set(spec["identify"].get("header", []))
    dropped = set(NEVER_READ) | set(c.get("drop", []))
    named = [cols[k] for k in SINGLE if k in cols]
    if c.get("currency"):
        named.append(c["currency"])
    for col in named:
        if col not in header:
            out.append(f"column {col!r} is read but not in identify.header")
    for col in named + [x for k in TEXT for x in _texts(cols.get(k))]:
        if col in dropped:
            out.append(f"column {col!r} is both read and dropped")
    if c.get("order") is not None and c["order"] not in ORDERS:
        out.append(f"[csv] order must be one of {ORDERS}")
    if "running_balance" in cols and c.get("order") is None:
        out.append("a running balance can only chain in a proven order: set [csv] order")
    if c.get("order") is not None and not ({"datetime", "date"} & set(cols)):
        out.append("[csv] order needs a datetime or date column to prove it")
    if spec["keys"].get("scheme") == "native-id-ts/1" and not {"id", "datetime"} <= set(cols):
        out.append("native-id-ts/1 keys need [csv.columns] id and datetime")
    for rx in spec["identify"].get("filename", []):
        try:
            groups = set(re.compile(rx).groupindex)
        except re.error as e:
            out.append(f"identify.filename {rx!r}: {e}")
            continue
        out += [f"identify.filename group {g!r} is not one of {FILENAME_GROUPS}"
                for g in sorted(groups - set(FILENAME_GROUPS))]
    if not c.get("currency") and not any("(?P<currency>" in rx
                                         for rx in spec["identify"].get("filename", [])):
        out.append("no currency source: set [csv] currency or a (?P<currency>) file-name group")
    return out


def _name_match(adapter, path: Path | None) -> re.Match | None:
    if path is None:
        return None
    rxs = adapter.spec["identify"].get("filename")
    if not rxs:
        return re.match("", "")  # no file-name rule: any name
    for rx in rxs:
        m = re.search(rx, path.name)
        if m:
            return m
    return None


def _decode(raw: bytes, adapter) -> str:
    return raw.decode(adapter.spec["csv"].get("encoding", "utf-8-sig"))


def identify(raw: bytes, adapter, path: Path | None = None) -> bool:
    if _name_match(adapter, path) is None:
        return False
    try:
        first = next(csv.reader(io.StringIO(_decode(raw, adapter), newline="")), None)
    except (UnicodeDecodeError, csv.Error):
        return False
    return bool(first) and set(adapter.spec["identify"].get("header", [])) <= set(first)


def _rows(text: str, dropped: set[str]):
    """-> (header, [(n, row dict)], ragged). A dropped column's cell is discarded as each
    record is split, before the row exists, so nothing downstream can read it."""
    reader = csv.reader(io.StringIO(text, newline=""))
    header = next(reader, None)
    if not header:
        raise Refusal(Exit.REFUSED, "no header row")
    if len(set(header)) != len(header):
        raise Refusal(Exit.REFUSED, "the header repeats a column name")
    keep = [(i, h) for i, h in enumerate(header) if h not in dropped]
    out, ragged = [], 0
    for n, rec in enumerate(reader, 1):
        if not rec:
            continue  # a blank line
        if len(rec) != len(header):
            ragged += 1
        out.append((n, {h: rec[i] if i < len(rec) else "" for i, h in keep}))
    return header, out, ragged


def _first(row: dict, cols) -> str | None:
    for c in _texts(cols):
        v = (row.get(c) or "").strip()
        if v:
            return v
    return None


def _parse(kind: str, text: str, fmt: str | None, where: str):
    try:
        if kind == "amount":
            return Decimal(text.strip())
        dt = datetime.strptime(text.strip(), fmt) if fmt else datetime.fromisoformat(text.strip())
        return dt
    except (InvalidOperation, ValueError):
        # Name the row and the column, never the value: it is real data.
        raise Refusal(Exit.REFUSED, f"{where}: {kind} does not parse"
                      + (f" as {fmt!r}" if fmt else "")) from None


def extract(raw: bytes, adapter, path: Path | None = None
            ) -> tuple[list[StatementDraft], list[str]]:
    spec = adapter.spec
    c = spec["csv"]
    cols = c.get("columns", {})
    fmts = c.get("formats", {})
    try:
        text = _decode(raw, adapter)
    except UnicodeDecodeError as e:
        raise Refusal(Exit.REFUSED, f"not {c.get('encoding', 'utf-8-sig')}: byte {e.start}"
                      ) from None
    try:
        _, rows, ragged = _rows(text, set(NEVER_READ) | set(c.get("drop", [])))
    except csv.Error as e:
        raise Refusal(Exit.REFUSED, f"CSV does not parse: {e}") from None
    name = _name_match(adapter, path)
    groups = name.groupdict() if name else {}
    flip = bool(spec.get("sign", {}).get("flip", False))

    txns, stamps, currencies = [], [], set()
    for n, row in rows:
        where = f"row {n}"
        for k in SINGLE:
            if k in cols and k != "running_balance" and not (row.get(cols[k]) or "").strip():
                raise Refusal(Exit.REFUSED, f"{where}: empty {k} ({cols[k]!r})")
        amount = _parse("amount", row[cols["amount"]], None, where)
        booked = _parse("date", row[cols["date"]], fmts.get("date"), where).date().isoformat()
        ts_text = row[cols["datetime"]].strip() if "datetime" in cols else None
        if ts_text is not None:
            stamps.append(_parse("datetime", ts_text, fmts.get("datetime"), where))
        else:
            stamps.append(datetime.fromisoformat(booked))
        rb = None
        if "running_balance" in cols:
            rb_text = (row.get(cols["running_balance"]) or "").strip()
            if not rb_text:
                raise Refusal(Exit.REFUSED, f"{where}: empty running_balance")
            rb = _parse("amount", rb_text, None, where)
        if c.get("currency"):
            cur = (row.get(c["currency"]) or "").strip()
            if cur:
                currencies.add(cur)
        txns.append(TxnDraft(
            locator=f"row{n:05d}",
            booking_date=booked,
            amount=-amount if flip else amount,
            raw_amount_text=row[cols["amount"]].strip(),
            description=_first(row, cols.get("description")),
            memo=_first(row, cols.get("memo")),
            counterparty=_first(row, cols.get("counterparty")),
            source_type=_first(row, cols.get("source_type")) or "CSV",
            entry_ref=row[cols["id"]].strip() if "id" in cols else None,
            running_balance=rb,
            native_ts=ts_text,
        ))

    checks = [Check("row_width", ragged == 0, expected="0 records off the header's width",
                    actual=f"{ragged}")]

    order = c.get("order")
    chron = txns
    if order:
        pairs = list(zip(stamps, stamps[1:]))
        ok = all(a >= b for a, b in pairs) if order == "newest-first" else \
            all(a <= b for a, b in pairs)
        bad = sum(1 for a, b in pairs if (a < b if order == "newest-first" else a > b))
        checks.append(Check("order_proof", ok, expected=f"{order}, 0 rows out of order",
                            actual=f"{bad} out of order",
                            note="by " + ("datetime" if "datetime" in cols else "date")))
        if order == "newest-first":
            chron = list(reversed(txns))

    named = groups.get("currency")
    found = sorted(currencies)
    want = {named} if named else set(found[:1])
    checks.append(Check("single_currency", len(found) <= 1 and set(found) <= want,
                        expected="one currency" + (f", {named} (file name)" if named else ""),
                        actual=", ".join(found) or "no rows"))
    currency = found[0] if len(found) == 1 else named
    if not currency:
        raise Refusal(Exit.REFUSED, "no currency: no rows carry one and the file name has none")

    opening = closing = None
    if "running_balance" in cols:
        chk, opening, closing = reconcile.running_chain(chron)
        checks.append(chk)

    dates = sorted(t.booking_date for t in txns)
    start = groups.get("start") or (dates[0] if dates else None)
    end = groups.get("end") or (dates[-1] if dates else None)
    for label, v in (("start", start), ("end", end)):
        try:
            v is None or datetime.strptime(v, "%Y-%m-%d")
        except ValueError:
            raise Refusal(Exit.REFUSED, f"file-name period {label} is not YYYY-MM-DD") from None
    acct = spec.get("account", {})
    d = StatementDraft(
        index=0, acctid=currency, kind=acct.get("kind", "account"), currency=currency,
        period_start=start, period_end=end, closing=closing,
        closing_as_of=end if closing is not None else None, opening=opening,
        transactions=chron, raw_txn_count=len(rows), checks=checks)
    return [d], []
