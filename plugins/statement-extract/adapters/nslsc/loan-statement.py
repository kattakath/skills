"""NSLSC student loan statement hook: the dated rows as a statement, plus a position."""
import re
from decimal import Decimal

from statement_extract import pdfkit
from statement_extract.model import (Check, Exit, PositionDraft, Refusal, StatementDraft,
                                     TxnDraft)
from statement_extract.reconcile import balance_equation

# Transaction Amount, Principal, Interest, Principal Balance: four standalone amounts.
_TOKEN = re.compile(r"(?<!\S)(" + pdfkit.AMOUNT + r")(?!\S)")


def _rx(g: dict, name: str) -> re.Pattern:
    return re.compile(g[name].replace("{AMT}", pdfkit.AMOUNT)
                      .replace("{DATE}", pdfkit.LONG_DATE), re.M)


def _need(m, what: str):
    if m is None:
        raise Refusal(Exit.REFUSED, f"NSLSC loan statement: {what} not found")
    return m


def _rows(lines: list[str], g: dict) -> list[dict]:
    """Group the table's lines into rows around their amount line. A row's date and its
    description wrap ABOVE and BELOW the amounts (pdftotext centres the cell vertically):
    a line opening with a month belongs to the next row, one opening with a year to the row
    above, an indented description line to the row above only while that row is still open
    (no blank line, no month line in between)."""
    header, page_header = _rx(g, "header"), _rx(g, "page_header")
    month_day, year = _rx(g, "month_day"), _rx(g, "year")
    rows: list[dict] = []
    pending: list[str] = []
    in_table = attach_prev = False
    for n, line in enumerate(lines):
        if header.match(line):
            in_table, attach_prev = True, False
            continue
        if not in_table:
            continue
        if not line.strip() or page_header.match(line):
            attach_prev = False
            continue
        toks = list(_TOKEN.finditer(line))
        if toks:
            if len(toks) != 4:
                raise ValueError(f"a row needs 4 amounts, found {len(toks)}")
            rows.append({"line": n, "pre": pending, "anchor": line, "toks": toks, "post": []})
            pending, attach_prev = [], True
        elif year.match(line):
            if not rows:
                raise ValueError("a year line before any row")
            rows[-1]["post"].append(line)
            attach_prev = True
        elif month_day.match(line):
            pending.append(line)
            attach_prev = False
        elif attach_prev and rows:
            rows[-1]["post"].append(line)
        else:
            pending.append(line)
    return rows


def _row_fields(r: dict, g: dict) -> tuple[str, str, list[Decimal]]:
    month_day, year = _rx(g, "month_day"), _rx(g, "year")
    anchor_text = r["anchor"][:r["toks"][0].start()]
    texts = r["pre"] + [anchor_text] + r["post"]
    md = next((m for t in r["pre"] + [anchor_text] if (m := month_day.match(t))), None)
    if md is None:
        raise ValueError("a row without a date")
    yr = md.group(3) or next((m.group(1) for t in r["post"] if (m := year.match(t))), None)
    if yr is None:
        raise ValueError("a row without a year")
    desc = []
    for t in texts:
        t = month_day.sub("", t, count=1)
        t = year.sub("", t, count=1)
        if t.strip():
            desc.append(t.strip())
    amounts = [pdfkit.amount(m.group(1)) for m in r["toks"]]
    return pdfkit.long_date(md.group(1), md.group(2), yr), " ".join(desc), amounts


def parse_lines(lines: list[str], spec: dict, text: str) -> list:
    """Why not TOML: each row's date and description wrap above and below its amounts, so
    rows are grouped around their amount line; rows print NEWEST first and are chained oldest
    first; and three rows are anchors, not movements (Opening, Closing, and the interest
    outstanding at the statement end, which becomes the position's interest balance).

    Sign: holder view, like the line-of-credit adapters. The loan's balance owed is negative,
    a disbursement (principal up) is negative and a payment's principal share positive. A row's
    amount is its PRINCIPAL movement, because that is the balance the statement prints and
    proves; a payment's interest share is checked (Transaction Amount = Principal + Interest)
    but is not a separate row."""
    g = spec["grammar"]
    acct = _need(_rx(g, "account").search(text), "Loan Account Number")
    per = _need(_rx(g, "period").search(text), "Statement Period")
    period_start = pdfkit.long_date(*per.group(1, 2, 3))
    period_end = pdfkit.long_date(*per.group(4, 5, 6))
    opening_re, closing_re = _rx(g, "opening_row"), _rx(g, "closing_row")
    interest_re = _rx(g, "interest_row")

    opening = closing = interest = None
    moves: list[dict] = []
    for r in _rows(lines, g):
        day, desc, (txn_amt, principal, interest_amt, bal) = _row_fields(r, g)
        if opening_re.match(desc):
            opening = bal
        elif closing_re.match(desc):
            closing, closing_day = bal, day
        elif interest_re.match(desc):
            interest = interest_amt
        else:
            moves.append({"date": day, "desc": desc, "txn": txn_amt, "principal": principal,
                          "interest": interest_amt, "bal": bal, "line": r["line"]})
    if opening is None or closing is None:
        raise Refusal(Exit.REFUSED, "NSLSC loan statement: Opening / Closing Balance row "
                      "not found")
    moves.reverse()  # printed newest first; the chain runs oldest first
    if [m["date"] for m in moves] != sorted(m["date"] for m in moves):
        raise ValueError("rows are not in date order")

    d = StatementDraft(index=0, acctid=re.sub(r"\D", "", acct.group(1)), kind="loan",
                       currency="CAD", period_start=period_start, period_end=period_end,
                       closing=-closing, closing_as_of=period_end, opening=-opening)
    for n, m in enumerate(moves):
        d.transactions.append(TxnDraft(
            locator=f"line{m['line']:05d}", booking_date=m["date"], amount=-m["principal"],
            description=m["desc"], memo=None, running_balance=-m["bal"],
            source_type="CREDIT" if m["principal"] < 0 else "DEBIT", entry_ref=None))
    d.raw_txn_count = len(moves)
    split_off = [m for m in moves if m["txn"] != 0 and m["txn"] != m["principal"] + m["interest"]]
    d.checks = [
        pdfkit.running_chain(-opening, [{"amount": -m["principal"], "balance": -m["bal"]}
                                        for m in moves]),
        balance_equation(-opening, d.transactions, -closing,
                         "Opening Balance + principal movements = Closing Balance"),
        Check("row_split", not split_off, expected="0 rows off",
              actual=f"{len(split_off)} rows off",
              note="Transaction Amount = Principal + Interest, every row with an amount"),
        Check("closing_on_period_end", closing_day == period_end, expected=period_end,
              actual=closing_day, note="the Closing Balance row is dated the period end"),
    ]
    balances = {"principal_outstanding": closing}
    if interest is not None:
        balances["interest_outstanding"] = interest
    p = PositionDraft(acctid=d.acctid, kind="loan", currency="CAD", as_of=period_end,
                      as_of_basis="statement_date", balances=balances, terms={}, checks=[
                          Check("closing_row", True, note="principal_outstanding is the "
                                "statement's Closing Balance, proven by its row chain")])
    return [d, p]
