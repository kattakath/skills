"""TD chequing PDF hook (Statement of Account): Description | Withdrawals | Deposits | Date |
Balance, a balance printed only on a day's last row.

Shared by three prints of the same table, each a TOML of its own grammar:
- current (chequing-pdf): no closing row, a `Total` line under the list;
- 2021 (chequing-pdf): a `CLOSING BALANCE` row, then the totals as bare amounts, no label;
- 2018 (chequing-2018-pdf): UPPERCASE headings, `BALANCE FORWARD`, bare totals, and a page
  that continues the list opens with its own `BALANCE FORWARD` and closes with its own totals.
"""
import re
from decimal import Decimal

from statement_extract import pdfkit
from statement_extract.model import Check, Exit, Refusal, StatementDraft, TxnDraft
from statement_extract.reconcile import balance_equation, printed_total


def _bal(s: str) -> Decimal:
    """A printed balance: TD marks an overdrawn one with an OD suffix (spaced in 2021)."""
    s = s.strip()
    return -pdfkit.amount(s[:-2]) if s.endswith("OD") else pdfkit.amount(s)


def parse_lines(lines: list[str], spec: dict, text: str) -> list[StatementDraft]:
    """Why not TOML: a row's direction is the column its amount sits under (Withdrawals or
    Deposits), located from the header line of the page it is on. Only a day's last row prints
    a balance, so the chain is checked through day groups. Without a closing row the closing
    balance is the last printed one. The year is inferred per row from the period end. A totals
    line ends a segment; a later opening row starts the next one (2018 pages), whose opening
    must equal the balance carried so far. A row after a totals line with no new opening means
    a layout this hook does not know."""
    g = spec["grammar"]
    sub = lambda rx: rx.replace("{AMT}", g["amt"]).replace("{DATE}", g["date"])  # noqa: E731
    head_re, open_re = re.compile(g["header"]), re.compile(sub(g["opening"]))
    txn_re, total_re = re.compile(sub(g["txn"])), re.compile(sub(g["total"]))
    close_re = re.compile(sub(g["closing"])) if "closing" in g else None
    after_close_re = re.compile(sub(g["total_after_closing"])) if "total_after_closing" in g else None
    amt_re = re.compile(g.get("total_amt", g["amt"]))

    accts = set(re.findall(g["account"], text))
    if not accts:
        raise Refusal(Exit.REFUSED, "no account number under 'Branch No. Account No.'")
    if len(accts) > 1:
        raise Refusal(Exit.REFUSED, f"{len(accts)} different accounts in one file")
    per = re.search(g["period"], text)
    if not per:
        raise Refusal(Exit.REFUSED, "no statement period (MON DD/YY - MON DD/YY)")
    end_month, end_year = pdfkit.month(per.group(4)), 2000 + int(per.group(6))
    start_month = pdfkit.month(per.group(1))
    period_start = pdfkit.iso(2000 + int(per.group(3)), start_month, int(per.group(2)))
    period_end = pdfkit.iso(end_year, end_month, int(per.group(5)))

    cols = None
    segs: list[dict] = []          # {"opening", "rows", "totals"}
    closing_row: Decimal | None = None
    after_total = 0
    for line in lines:
        if head_re.match(line):
            cols = pdfkit.columns(line, {"withdrawal": g["withdrawals"],
                                         "deposit": g["deposits"]})
            continue
        if cols is None:
            continue
        seg = segs[-1] if segs else None
        if seg is not None and seg["totals"] is not None:
            om = open_re.match(line)
            if om:   # a page that continues the list (2018)
                segs.append({"opening": _bal(om.group("bal")), "rows": [], "totals": None})
            else:
                after_total += bool(txn_re.match(line))
            continue
        if seg is None:
            om = open_re.match(line)
            if om:
                segs.append({"opening": _bal(om.group("bal")), "rows": [], "totals": None})
            continue
        cm = close_re.match(line) if close_re else None
        if cm and closing_row is None:
            closing_row = _bal(cm.group("bal"))
            continue
        tm = total_re.match(line) or (closing_row is not None and after_close_re
                                      and after_close_re.match(line))
        if tm:
            totals = {"withdrawal": Decimal(0), "deposit": Decimal(0)}
            off = tm.start("rest")
            for am in amt_re.finditer(tm.group("rest")):
                span = (off + am.start(), off + am.end())
                totals[pdfkit.nearest_column(span, cols)] += pdfkit.amount(am.group(0))
            seg["totals"] = totals
            continue
        xm = txn_re.match(line)
        if xm:
            col = pdfkit.nearest_column(xm.span("amt"), cols)
            amt = pdfkit.amount(xm.group("amt"))
            mon = pdfkit.month(xm.group("mon"))
            year = pdfkit.infer_year(mon, end_month, end_year)
            seg["rows"].append({"date": pdfkit.iso(year, mon, int(xm.group("day"))),
                                "desc": re.sub(r"\s+", " ", xm.group("desc").strip()),
                                "amount": amt if col == "deposit" else -amt,
                                "balance": _bal(xm.group("bal")) if xm.group("bal") else None})
    if not segs:
        raise Refusal(Exit.REFUSED, "no opening '<WORD> BALANCE' row under the column header")
    if any(s["totals"] is None for s in segs):
        raise Refusal(Exit.REFUSED, "no 'Total' line after the transaction list")
    if after_total:
        raise Refusal(Exit.REFUSED, f"{after_total} row(s) after the first 'Total' line: a "
                      "multi-section layout this adapter does not understand")
    opening = segs[0]["opening"]
    rows = [r for s in segs for r in s["rows"]]
    if rows and rows[-1]["balance"] is None and closing_row is None:
        raise Refusal(Exit.REFUSED, "the last row prints no balance, so there is no closing")
    last = next((r["balance"] for r in reversed(rows) if r["balance"] is not None), opening)
    closing = closing_row if closing_row is not None else last

    drafts = [TxnDraft(locator=f"line{n:05d}", booking_date=r["date"], amount=r["amount"],
                       description=r["desc"], memo=None, running_balance=r["balance"],
                       source_type="CREDIT" if r["amount"] > 0 else "DEBIT", entry_ref=None)
              for n, r in enumerate(rows)]

    def col_sum(seg_rows, sign):
        return sign * sum((r["amount"] for r in seg_rows if r["amount"] * sign > 0), Decimal(0))

    def per_segment(name, key, sign, note):
        """One check over every segment: each segment's rows = its own printed totals."""
        if len(segs) == 1:
            return printed_total(name, col_sum(segs[0]["rows"], sign), segs[0]["totals"][key],
                                 note)
        bad = [n for n, s in enumerate(segs, 1) if col_sum(s["rows"], sign) != s["totals"][key]]
        return Check(name, not bad, expected=f"{len(segs)} page totals",
                     actual=f"mismatch on page(s) {bad}" if bad else "all pages agree",
                     note=note + " (per page)")

    checks = [
        pdfkit.running_chain(opening, rows),
        balance_equation(opening, drafts, closing, "opening + rows = CLOSING BALANCE row"
                         if closing_row is not None else "opening + rows = last printed balance"),
        per_segment("summary_withdrawals", "withdrawal", -1, "Withdrawals column = printed Total"),
        per_segment("summary_deposits", "deposit", 1, "Deposits column = printed Total"),
    ]
    if closing_row is not None:
        checks.append(printed_total("closing_row", last, closing_row,
                                    "last printed balance = CLOSING BALANCE row"))
    if len(segs) > 1:
        # Each continuation page opens with the balance carried from the page before it.
        run, bad = opening, []
        for n, s in enumerate(segs, 1):
            if n > 1 and s["opening"] != run:
                bad.append(n)
            run = s["opening"] + sum((r["amount"] for r in s["rows"]), Decimal(0))
        checks.append(Check("page_handover", not bad, expected="opening = balance carried",
                            actual=f"breaks on page(s) {bad}" if bad else
                            f"{len(segs) - 1} handover(s) agree"))
    d = StatementDraft(index=0, acctid=re.sub(r"\D", "", accts.pop()), kind="checking",
                       currency="CAD", period_start=period_start, period_end=period_end,
                       closing=closing, closing_as_of=period_end, opening=opening,
                       checks=checks, transactions=drafts)
    d.raw_txn_count = len(rows)
    return [d]
