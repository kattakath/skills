"""TD chequing PDF hook (Statement of Account): Description | Withdrawals | Deposits | Date |
Balance, a balance printed only on a day's last row, no closing row."""
import re
from decimal import Decimal

from statement_extract import pdfkit
from statement_extract.model import Exit, Refusal, StatementDraft, TxnDraft
from statement_extract.reconcile import balance_equation, printed_total


def _bal(s: str) -> Decimal:
    """A printed balance: TD marks an overdrawn one with an OD suffix."""
    return -pdfkit.amount(s[:-2]) if s.endswith("OD") else pdfkit.amount(s)


def parse_lines(lines: list[str], spec: dict, text: str) -> list[StatementDraft]:
    """Why not TOML: a row's direction is the column its amount sits under (Withdrawals or
    Deposits), located from the header line of the page it is on. Only a day's last row prints
    a balance, so the chain is checked through day groups. There is no closing row: the closing
    balance is the last printed one. The year is inferred per row from the period end, and the
    first `Total` line ends the list; a row after it means a layout this hook does not know."""
    g = spec["grammar"]
    sub = lambda rx: rx.replace("{AMT}", g["amt"]).replace("{DATE}", g["date"])  # noqa: E731
    head_re, open_re = re.compile(g["header"]), re.compile(sub(g["opening"]))
    txn_re, total_re = re.compile(sub(g["txn"])), re.compile(g["total"])
    amt_re = re.compile(g["amt"])

    acct = re.search(g["account"], text)
    if not acct:
        raise Refusal(Exit.REFUSED, "no account number under 'Branch No. Account No.'")
    per = re.search(g["period"], text)
    if not per:
        raise Refusal(Exit.REFUSED, "no statement period (MON DD/YY - MON DD/YY)")
    end_month, end_year = pdfkit.month(per.group(4)), 2000 + int(per.group(6))
    start_month = pdfkit.month(per.group(1))
    period_start = pdfkit.iso(2000 + int(per.group(3)), start_month, int(per.group(2)))
    period_end = pdfkit.iso(end_year, end_month, int(per.group(5)))

    cols = None
    opening = None
    rows: list[dict] = []
    totals: dict[str, Decimal] | None = None
    after_total = 0
    for line in lines:
        if head_re.match(line):
            cols = pdfkit.columns(line, {"withdrawal": g["withdrawals"],
                                         "deposit": g["deposits"]})
            continue
        if totals is not None:
            after_total += bool(txn_re.match(line))
            continue
        if cols is None:
            continue
        om = open_re.match(line)
        if om and opening is None and not rows:
            opening = _bal(om.group("bal"))
            continue
        tm = total_re.match(line)
        if tm and opening is not None:
            totals = {"withdrawal": Decimal(0), "deposit": Decimal(0)}
            off = tm.start("rest")
            for am in amt_re.finditer(tm.group("rest")):
                span = (off + am.start(), off + am.end())
                totals[pdfkit.nearest_column(span, cols)] += pdfkit.amount(am.group(0))
            continue
        xm = txn_re.match(line)
        if xm and opening is not None:
            col = pdfkit.nearest_column(xm.span("amt"), cols)
            amt = pdfkit.amount(xm.group("amt"))
            mon = pdfkit.month(xm.group("mon"))
            year = pdfkit.infer_year(mon, end_month, end_year)
            rows.append({"date": pdfkit.iso(year, mon, int(xm.group("day"))),
                         "desc": re.sub(r"\s+", " ", xm.group("desc").strip()),
                         "amount": amt if col == "deposit" else -amt,
                         "balance": _bal(xm.group("bal")) if xm.group("bal") else None})
    if opening is None:
        raise Refusal(Exit.REFUSED, "no opening '<WORD> BALANCE' row under the column header")
    if totals is None:
        raise Refusal(Exit.REFUSED, "no 'Total' line after the transaction list")
    if after_total:
        raise Refusal(Exit.REFUSED, f"{after_total} row(s) after the first 'Total' line: a "
                      "multi-section layout this adapter does not understand")
    if rows and rows[-1]["balance"] is None:
        raise Refusal(Exit.REFUSED, "the last row prints no balance, so there is no closing")
    closing = rows[-1]["balance"] if rows else opening

    drafts = [TxnDraft(locator=f"line{n:05d}", booking_date=r["date"], amount=r["amount"],
                       description=r["desc"], memo=None, running_balance=r["balance"],
                       source_type="CREDIT" if r["amount"] > 0 else "DEBIT", entry_ref=None)
              for n, r in enumerate(rows)]
    checks = [
        pdfkit.running_chain(opening, rows),
        balance_equation(opening, drafts, closing, "opening + rows = last printed balance"),
        printed_total("summary_withdrawals",
                      -sum((r["amount"] for r in rows if r["amount"] < 0), Decimal(0)),
                      totals["withdrawal"], "Withdrawals column = printed Total"),
        printed_total("summary_deposits",
                      sum((r["amount"] for r in rows if r["amount"] > 0), Decimal(0)),
                      totals["deposit"], "Deposits column = printed Total"),
    ]
    d = StatementDraft(index=0, acctid=re.sub(r"\D", "", acct.group(1)), kind="checking",
                       currency="CAD", period_start=period_start, period_end=period_end,
                       closing=closing, closing_as_of=period_end, opening=opening,
                       checks=checks, transactions=drafts)
    d.raw_txn_count = len(rows)
    return [d]
