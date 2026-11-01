"""TD Visa credit card PDF hook: transaction date | posting date | description | amount, the
balance summary in a right-hand column that shares lines with the rows."""
import re
from decimal import Decimal

from statement_extract import pdfkit
from statement_extract.model import Exit, Refusal, StatementDraft, TxnDraft
from statement_extract.reconcile import printed_total


def parse_lines(lines: list[str], spec: dict, text: str) -> list[StatementDraft]:
    """Why not TOML: a wrapped description continues on the next line only when it starts in
    the description column of the row above, and that column moves from page to page. Both
    dates take their year from the statement date (a January statement holds December rows).
    The printed summary splits the rows by direction across five figures, each tied to a
    different subset, and the right-hand column shares lines with the rows, so each figure is
    read from the end of its own line."""
    g = spec["grammar"]
    sub = lambda rx: rx.replace("{AMT}", g["amt"]).replace("{MON}", g["mon"])  # noqa: E731
    txn_re = re.compile(sub(g["txn"]))

    def one(rx: str, what: str) -> re.Match:
        m = re.search(sub(rx), text, re.M)
        if not m:
            raise Refusal(Exit.REFUSED, f"{what} not found")
        return m

    sd = one(g["statement_date"], "STATEMENT DATE")
    end_month, end_year = pdfkit.month(sd.group(1)), int(sd.group(3))
    per = one(g["period"], "STATEMENT PERIOD")
    acct = one(g["account"], "card number after 'Account Number:'")
    previous = pdfkit.amount(one(g["previous"], "PREVIOUS STATEMENT BALANCE").group(1))
    new = pdfkit.amount(one(g["new"], "NEW BALANCE").group(1))
    s = {k: pdfkit.amount(one(v, f"summary line {k!r}").group(1))
         for k, v in g["summary"].items()}
    net = re.search(sub(g["net_activity"]), text, re.M)

    rows: list[dict] = []
    desc_col = None  # description column of the row the next line may continue
    for line in lines:
        tm = txn_re.match(line)
        if tm:
            dates = []
            for mk, dk in (("tmon", "tday"), ("pmon", "pday")):
                mon = pdfkit.month(tm.group(mk))
                dates.append(pdfkit.iso(pdfkit.infer_year(mon, end_month, end_year), mon,
                                        int(tm.group(dk))))
            rows.append({"tdate": dates[0], "date": dates[1],
                         "desc": re.sub(r"\s+", " ", tm.group("desc").strip()),
                         "card": pdfkit.amount(tm.group("amt"))})  # card view: owed +
            desc_col = tm.start("desc")
            continue
        stripped = line.strip()
        ind = len(line) - len(line.lstrip())
        if desc_col is not None and stripped and abs(ind - desc_col) <= 2:
            rows[-1]["desc"] += " " + re.split(r"\s{3,}", stripped)[0]
            continue
        desc_col = None

    card = [r["card"] for r in rows]
    checks = [
        printed_total("summary_previous", previous, s["previous"],
                      "PREVIOUS STATEMENT BALANCE = summary Previous Balance"),
        printed_total("summary_credits", -sum((a for a in card if a < 0), Decimal(0)),
                      s["credits"], "credit rows = Payments & Credits"),
        printed_total("summary_debits", sum((a for a in card if a > 0), Decimal(0)),
                      s["purchases"] + s["cash_advances"] + s["interest"] + s["fees"],
                      "debit rows = Purchases & Other Charges + Cash Advances + Interest "
                      "+ Fees"),
        printed_total("balance_equation", previous + sum(card, Decimal(0)), new,
                      "Previous Balance + rows = NEW BALANCE (card view)"),
    ]
    if net:
        checks.append(printed_total("net_activity", sum(card, Decimal(0)),
                                    pdfkit.amount(net.group(1)),
                                    "rows = printed net amount of activity"))

    # Holder view from here on: + = money in, so a purchase (owed +) becomes negative.
    end = pdfkit.iso(end_year, end_month, int(sd.group(2)))
    start = pdfkit.iso(int(per.group(3)), pdfkit.month(per.group(1)), int(per.group(2)))
    d = StatementDraft(index=0, acctid=acct.group(1), kind="creditcard", currency="CAD",
                       period_start=start, period_end=end, closing=-new, closing_as_of=end,
                       opening=-previous, checks=checks)
    for n, r in enumerate(rows):
        d.transactions.append(TxnDraft(
            locator=f"line{n:05d}", booking_date=r["date"], transaction_date=r["tdate"],
            amount=-r["card"], description=r["desc"], memo=None,
            source_type="CREDIT" if r["card"] < 0 else "DEBIT", entry_ref=None))
    d.raw_txn_count = len(rows)
    return [d]
