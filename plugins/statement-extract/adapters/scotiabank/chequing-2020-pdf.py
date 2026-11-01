"""Scotiabank business chequing, 2020 print: Date | Description | Withdrawals/Debits |
Deposits/Credits | Balance, a balance on every row, an Account Summary of counts and totals."""
import re
from decimal import Decimal

from statement_extract import pdfkit
from statement_extract.model import Check, Exit, Refusal, StatementDraft, TxnDraft
from statement_extract.reconcile import balance_equation, printed_total


def parse_lines(lines: list[str], spec: dict, text: str) -> list[StatementDraft]:
    """Why not TOML: a row's direction is the column its amount sits under, located from the
    header line of the page it is on. The list opens with a BALANCE FORWARD row and the closing
    is the last printed balance; every row must chain on it. The summary block prints twice
    (above and below the list) and both copies must agree, and its COUNTS of debits and of
    credits are tied as well as its totals. Rows end at the second summary block."""
    g = spec["grammar"]
    sub = lambda rx: rx.replace("{AMT}", g["amt"]).replace("{DATE}", g["date"])  # noqa: E731
    head_re, open_re, txn_re = (re.compile(sub(g[k])) for k in ("header", "opening", "txn"))

    accts = set(re.findall(g["account"], text))
    if len(accts) != 1:
        raise Refusal(Exit.REFUSED, f"expected one account number under 'Account Number:', "
                      f"found {len(accts)}")
    per = re.search(g["period"], text)
    if not per:
        raise Refusal(Exit.REFUSED, "no statement period under 'From: To:'")
    period_start = pdfkit.iso(int(per.group(3)), pdfkit.month(per.group(1)), int(per.group(2)))
    period_end = pdfkit.iso(int(per.group(6)), pdfkit.month(per.group(4)), int(per.group(5)))
    sums = [m.groupdict() for m in re.finditer(sub(g["summary"]), text)]
    if not sums:
        raise Refusal(Exit.REFUSED, "no Account Summary (No. of Debits / Total Amount)")
    summ = sums[0]

    cols, opening, rows, done = None, None, [], False
    for line in lines:
        if done:
            break
        if head_re.match(line):
            cols = pdfkit.columns(line, {"withdrawal": g["withdrawals"],
                                         "deposit": g["deposits"]})
            continue
        if cols is None:
            continue
        if "No. of Debits" in line:   # the summary printed again under the list
            done = opening is not None
            continue
        om = open_re.match(line)
        if om and opening is None and not rows:
            opening = pdfkit.amount(om.group("bal"))
            continue
        xm = txn_re.match(line)
        if xm and opening is not None:
            col = pdfkit.nearest_column(xm.span("amt"), cols)
            amt = pdfkit.amount(xm.group("amt"))
            rows.append({"date": pdfkit.iso(int(xm.group("year")), int(xm.group("mon")),
                                            int(xm.group("day"))),
                         "desc": re.sub(r"\s+", " ", xm.group("desc").strip()),
                         "amount": amt if col == "deposit" else -amt,
                         "balance": pdfkit.amount(xm.group("bal"))})
    if opening is None:
        raise Refusal(Exit.REFUSED, "no BALANCE FORWARD row under the column header")
    closing = rows[-1]["balance"] if rows else opening

    drafts = [TxnDraft(locator=f"line{n:05d}", booking_date=r["date"], amount=r["amount"],
                       description=r["desc"], memo=None, running_balance=r["balance"],
                       source_type="CREDIT" if r["amount"] > 0 else "DEBIT", entry_ref=None)
              for n, r in enumerate(rows)]
    debits = [-r["amount"] for r in rows if r["amount"] < 0]
    credits = [r["amount"] for r in rows if r["amount"] > 0]
    checks = [
        pdfkit.running_chain(opening, rows),
        balance_equation(opening, drafts, closing, "BALANCE FORWARD + rows = last balance"),
        printed_total("summary_debits", sum(debits, Decimal(0)), pdfkit.amount(summ["td"]),
                      "Withdrawals/Debits column = Total Amount - Debits"),
        printed_total("summary_credits", sum(credits, Decimal(0)), pdfkit.amount(summ["tc"]),
                      "Deposits/Credits column = Total Amount - Credits"),
        Check("summary_counts", (len(debits), len(credits)) == (int(summ["nd"]), int(summ["nc"])),
              expected=f"{summ['nd']} debits, {summ['nc']} credits",
              actual=f"{len(debits)} debits, {len(credits)} credits",
              note="rows per column = No. of Debits / No. of Credits"),
        Check("summary_repeated", all(s == summ for s in sums),
              expected="every copy of the Account Summary agrees",
              actual=f"{len(sums)} copies, {'agree' if all(s == summ for s in sums) else 'differ'}"),
    ]
    d = StatementDraft(index=0, acctid=re.sub(r"\D", "", accts.pop()), kind="checking",
                       currency="CAD", period_start=period_start, period_end=period_end,
                       closing=closing, closing_as_of=period_end, opening=opening,
                       checks=checks, transactions=drafts)
    d.raw_txn_count = len(rows)
    return [d]
