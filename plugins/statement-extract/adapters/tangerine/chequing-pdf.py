"""Tangerine chequing PDF hook. Written 2026-10-31 from `fixture shape` of the two real
statements (May and September 2026)."""
import re
from decimal import Decimal

from statement_extract import pdfkit
from statement_extract.model import Check, Exit, Refusal, StatementDraft, TxnDraft
from statement_extract.reconcile import printed_total

_OPEN, _CLOSE = "Opening Balance", "Closing Balance"


def _sub(g: dict, rx: str) -> str:
    return rx.replace("{AMT}", g["amt"]).replace("{FULL}", g["full_month"])


def _table(lines: list[str], g: dict) -> list[tuple[str, object]]:
    """The transaction table as ('row', dict) and ('desc', text) items, in page order.
    Column offsets are re-read at every page's heading row."""
    header_re, page_re = re.compile(g["header"]), re.compile(g["page"])
    date_re, txn_re = re.compile(g["date_line"]), re.compile(_sub(g, g["txn"]))
    items: list[tuple[str, object]] = []
    cols = None
    for line in lines:
        if header_re.search(line):
            cols = pdfkit.columns(line, g["columns"])
            continue
        if cols is None or not line.strip():
            continue
        if page_re.match(line):
            cols = None  # page furniture until the next heading row
            continue
        if date_re.match(line):
            tm = txn_re.match(line)
            if not tm or tm.group("a2") is None:
                raise Refusal(Exit.REFUSED, "a date line without both an amount and a balance")
            spans = {"amount": tm.span("a1"), "balance": tm.span("a2")}
            for want, span in spans.items():
                if pdfkit.nearest_column(span, cols) != want:
                    raise Refusal(Exit.REFUSED, f"a date line's {want} is not under its heading")
            desc = tm.group("desc").strip()
            items.append(("row", {
                "date": pdfkit.iso(int(tm.group("year")), pdfkit.month(tm.group("mon")),
                                   int(tm.group("day"))),
                "desc": desc, "amt": pdfkit.amount(tm.group("a1")),
                "bal": pdfkit.amount(tm.group("a2"))}))
            if desc == _CLOSE:
                return items
            continue
        indent = len(line) - len(line.lstrip())
        if abs(indent - cols["desc"][0]) > 3:
            raise Refusal(Exit.REFUSED, "a line inside the transaction table is neither a "
                          "dated row nor a description line")
        items.append(("desc", line.strip()))
    raise Refusal(Exit.REFUSED, "no Closing Balance row in the transaction table")


def _split(items: list[tuple[str, object]]) -> list[dict]:
    """pdftotext centres a row's date and amounts on its description cell, so a row whose
    description wraps has as many lines above its date line as below it. The lines between
    two date lines are therefore the first row's lower half then the second row's upper half,
    and the opening row (one line) fixes the count for every row after it."""
    rows: list[dict] = []
    gap: list[str] = []
    below = 0
    for kind, val in items:
        if kind == "desc":
            gap.append(val)
            continue
        above = len(gap) - below
        if above < 0 or (not rows and gap):
            raise Refusal(Exit.REFUSED, "description lines do not split around their date "
                          "lines")
        if rows:
            rows[-1]["parts"] += gap[:below]
        val["parts"] = gap[below:] + ([val["desc"]] if val["desc"] else [])
        rows.append(val)
        gap, below = [], above
    if below:
        raise Refusal(Exit.REFUSED, "the Closing Balance row is not a single line")
    for r in rows:
        r["desc"] = " ".join(r.pop("parts"))
    return rows


def parse_lines(lines: list[str], spec: dict, text: str) -> list[StatementDraft]:
    """Why not TOML: the table prints ONE unsigned Amount column, so a row's direction is
    whichever sign carries the previous balance to the printed one, which depends on the row
    before. A wrapped description straddles its date line (half above, half below), so which
    row a description line belongs to depends on how many lines every earlier row took."""
    g = spec["grammar"]
    mp = re.search(_sub(g, g["period"]), text)
    ms = re.search(_sub(g, g["summary"]), text, re.M)
    details = re.findall(g["details"], text)
    if not (mp and ms and details):
        raise Refusal(Exit.REFUSED, "header not found (period, summary table, Details heading)")
    if len(details) != 1:
        raise Refusal(Exit.REFUSED, f"{len(details)} account sections; this adapter reads a "
                      "statement holding the chequing account alone")
    acctid, summary_balance = ms.group(1), pdfkit.amount(ms.group(2))
    period_start = pdfkit.iso(int(mp.group(3)), pdfkit.month(mp.group(1)), int(mp.group(2)))
    period_end = pdfkit.iso(int(mp.group(6)), pdfkit.month(mp.group(4)), int(mp.group(5)))

    rows = _split(_table(lines, g))
    if len(rows) < 2 or rows[0]["desc"] != _OPEN:
        raise Refusal(Exit.REFUSED, "the table does not start with an Opening Balance row")
    first, last, rows = rows[0], rows[-1], rows[1:-1]
    opening, closing = first["bal"], last["bal"]

    prev = opening
    for r in rows:
        # A break (neither sign chains) keeps the printed magnitude; running_chain names it.
        r["signed"] = -r["amt"] if prev - r["amt"] == r["bal"] else r["amt"]
        prev = r["bal"]
    net = sum((r["signed"] for r in rows), Decimal(0))
    # An account's first statement opens on the opening day, after the period start
    # (measured on the real May 2026 statement): the Opening row may be late, never early.
    outside = [n for n, r in enumerate(rows, 1)
               if not first["date"] <= r["date"] <= period_end]
    checks = [
        pdfkit.running_chain(opening, [{"amount": r["signed"], "balance": r["bal"]}
                                       for r in rows]),
        printed_total("balance_equation", opening + net, closing, "opening + rows = closing"),
        printed_total("last_balance", rows[-1]["bal"] if rows else opening, closing,
                      "last printed balance = closing"),
        printed_total("summary_balance", closing, summary_balance,
                      "summary table Account Balance = closing"),
        Check("account_consistent", details[0][1] == acctid,
              expected="summary table account = Details heading account",
              actual="same" if details[0][1] == acctid else "differ"),
        Check("pseudo_rows_zero", first["amt"] == 0 and last["amt"] == 0,
              expected="Opening/Closing Balance rows carry no amount",
              actual=f"{first['amt']} / {last['amt']}"),
        Check("dates_in_period",
              period_start <= first["date"] and last["date"] == period_end and not outside,
              expected=f"{period_start} .. {period_end}",
              actual=f"rows outside: {outside}" if outside else
              f"{first['date']} .. {last['date']}"),
    ]
    d = StatementDraft(index=0, acctid=acctid, kind="checking", currency="CAD",
                       period_start=period_start, period_end=period_end, closing=closing,
                       closing_as_of=period_end, opening=opening, checks=checks)
    for n, r in enumerate(rows):
        d.transactions.append(TxnDraft(
            locator=f"line{n:05d}", booking_date=r["date"], amount=r["signed"],
            description=r["desc"], memo=None, running_balance=r["bal"],
            source_type="CREDIT" if r["signed"] > 0 else "DEBIT", entry_ref=None))
    d.raw_txn_count = len(rows)
    return [d]
