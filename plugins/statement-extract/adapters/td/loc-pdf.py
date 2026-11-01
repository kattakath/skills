"""TD line of credit PDF hook: an ACTIVITY table framed by OPENING and CLOSING BALANCE rows,
signed amounts, and two direction totals whose amounts sit away from their labels."""
import re
from decimal import Decimal

from statement_extract import pdfkit
from statement_extract.model import Exit, Refusal, StatementDraft, TxnDraft
from statement_extract.reconcile import printed_total

_LOOKAHEAD = 4  # lines below a total's label that may hold its amount (measured: 1-3)


def _total(lines: list[str], label: str, dollar: re.Pattern) -> Decimal:
    """The first $ amount on a line below `label` whose span lies inside the label's own
    segment (the run of text around it, bounded by 3+ spaces), within 2 columns."""
    for i, line in enumerate(lines):
        lm = re.search(label, line)
        if not lm:
            continue
        seg = next((s for s in re.finditer(r"\S+(?: {1,2}\S+)*", line)
                    if s.start() <= lm.start() < s.end()), None)
        if seg is None:
            continue
        for below in lines[i + 1:i + 1 + _LOOKAHEAD]:
            for am in dollar.finditer(below):
                if am.start() >= seg.start() - 2 and am.end() <= seg.end() + 2:
                    return pdfkit.amount(am.group(0))
    raise Refusal(Exit.REFUSED, f"total for {label!r} not found below its label")


def parse_lines(lines: list[str], spec: dict, text: str) -> list[StatementDraft]:
    """Why not TOML: the transaction rows are only those between the OPENING and CLOSING
    BALANCE rows (the interest table below has the same shape). The two printed direction
    totals are matched to their labels by horizontal position, because the amount sits on a
    later line, under the label in one year's layout and in an interleaved two-column block in
    another. Months in the period line arrive split by the text layer and are re-joined, and
    the year is inferred per row from the period end. A row's month can arrive split the same
    way ("M ay" on the OPENING and CLOSING BALANCE rows of March and May statements)."""
    g = spec["grammar"]
    txn_re = re.compile(g["txn"].replace("{AMT}", g["amt"]))
    dollar = re.compile(g["dollar"])

    per = re.search(g["period"], text)
    if not per:
        raise Refusal(Exit.REFUSED, "no statement period line")
    acct = re.search(g["account"], text)
    if not acct:
        raise Refusal(Exit.REFUSED, "no 'Account Number: dddd-ddddddd'")
    join = lambda s: s.replace(" ", "")  # noqa: E731
    end_month, end_year = pdfkit.month(join(per.group(4))), int(per.group(6))
    period_start = pdfkit.iso(int(per.group(3)), pdfkit.month(join(per.group(1))),
                              int(per.group(2)))
    period_end = pdfkit.iso(end_year, end_month, int(per.group(5)))

    opening = closing = None
    rows: list[dict] = []
    for line in lines:
        tm = txn_re.match(line)
        if not tm:
            continue
        desc = re.sub(r"\s+", " ", tm.group("desc").strip())
        amt = pdfkit.amount(tm.group("amt"))  # printed view: owed +
        if desc == g["opening"] and opening is None:
            opening = amt
            continue
        if opening is None or closing is not None:
            continue
        if desc == g["closing"]:
            closing = amt
            continue
        mon = pdfkit.month(join(tm.group("mon")))
        rows.append({"date": pdfkit.iso(pdfkit.infer_year(mon, end_month, end_year), mon,
                                        int(tm.group("day"))), "desc": desc, "owed": amt})
    if opening is None or closing is None:
        raise Refusal(Exit.REFUSED, "ACTIVITY table not framed by OPENING and CLOSING BALANCE")
    paid = _total(lines, g["payments"], dollar)
    advanced = _total(lines, g["advances"], dollar)

    owed = [r["owed"] for r in rows]
    checks = [
        printed_total("balance_equation", opening + sum(owed, Decimal(0)), closing,
                      "OPENING BALANCE + rows = CLOSING BALANCE (balance owed)"),
        printed_total("summary_credits", -sum((a for a in owed if a < 0), Decimal(0)), paid,
                      "credit rows = printed payments / credits total"),
        printed_total("summary_debits", sum((a for a in owed if a > 0), Decimal(0)), advanced,
                      "debit rows = printed new advances, interest and charges total"),
    ]
    # Holder view: + = money in, so an advance or interest (owed +) becomes negative. The kind
    # matches TD's own QFX for this account, which carries it as a credit-card statement.
    d = StatementDraft(index=0, acctid=re.sub(r"\D", "", acct.group(1)), kind="creditcard",
                       currency="CAD", period_start=period_start, period_end=period_end,
                       closing=-closing, closing_as_of=period_end, opening=-opening,
                       checks=checks)
    for n, r in enumerate(rows):
        d.transactions.append(TxnDraft(
            locator=f"line{n:05d}", booking_date=r["date"], amount=-r["owed"],
            description=r["desc"], memo=None,
            source_type="CREDIT" if r["owed"] < 0 else "DEBIT", entry_ref=None))
    d.raw_txn_count = len(rows)
    return [d]
