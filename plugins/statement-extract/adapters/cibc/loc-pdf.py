"""CIBC line of credit PDF hook (personal and secured LOC share one layout)."""
import re
from decimal import Decimal

from statement_extract import pdfkit
from statement_extract.model import Exit, Refusal, StatementDraft, TxnDraft
from statement_extract.reconcile import balance_equation, printed_total

_ZERO = Decimal(0)
# Detail lines print the source account as "ddddd/****ddd": a star run before a 3-digit tail,
# which no display-mask rule of this release shortens, so the leak gate would refuse the run.
_STARRED = re.compile(r"\*{2,}[\d*]*\d")


def _rx(g: dict, name: str) -> re.Pattern:
    return re.compile(g[name].replace("{AMT}", pdfkit.AMOUNT), re.M)


def _need(m: re.Match | None, what: str) -> re.Match:
    if m is None:
        raise Refusal(Exit.REFUSED, f"CIBC line of credit: {what} not found")
    return m


def _loc(m: re.Match) -> Decimal:
    """LOC view: a balance owed or a debit is +, a CR amount is -."""
    return pdfkit.amount(m.group(1))


def parse_lines(lines: list[str], spec: dict, text: str) -> list[StatementDraft]:
    """Why not TOML: a row's direction is a CR suffix, rows carry no year (inferred per row
    from the period end), a detail line belongs to the row directly above it, a dated line
    with no amount is a rate note that ends the row before it, a footnoted $0.00 credit-limit
    line is not money moving, and the summary, the detail footer and the interest total are each
    tied to a different subset of rows."""
    g = spec["grammar"]
    acct = _need(_rx(g, "account").search(text), "account number")
    per = _need(_rx(g, "period").search(text), "STATEMENT PERIOD")
    v = {k: _loc(_need(_rx(g, k).search(text), k)) for k in
         ("previous", "total_credits", "total_debits", "new", "detail_previous", "detail_new")}
    ti = _rx(g, "total_interest").search(text)
    sm, sy = pdfkit.month(per.group(1)), 2000 + int(per.group(3))
    em, ey = pdfkit.month(per.group(4)), 2000 + int(per.group(6))
    period_start = pdfkit.iso(sy, sm, int(per.group(2)))
    period_end = pdfkit.iso(ey, em, int(per.group(5)))

    row_re, dated_re, end_re = _rx(g, "row"), _rx(g, "dated"), _rx(g, "end")
    limit_re, interest_re = _rx(g, "limit_row"), _rx(g, "interest_row")
    started = False
    cur = None
    rows: list[dict] = []
    for line in lines:
        if not started:
            started = "STATEMENT PERIOD:" in line
            continue
        if end_re.match(line):
            break
        rm = row_re.match(line)
        if rm:
            cur = None
            if limit_re.search(rm.group(3)) and pdfkit.amount(rm.group(4)) == 0:
                continue
            mon = pdfkit.month(rm.group(1))
            cur = {"date": pdfkit.iso(pdfkit.infer_year(mon, em, ey), mon, int(rm.group(2))),
                   "desc": rm.group(3).strip(), "memo": [],
                   "loc": pdfkit.amount(rm.group(4))}
            rows.append(cur)
            continue
        if not line.strip() or dated_re.match(line):
            cur = None
            continue
        if cur is not None:
            cur["memo"].append(_STARRED.sub(
                lambda m: "••" + re.sub(r"\D", "", m.group())[-4:], line.strip()))
    if not started:
        raise Refusal(Exit.REFUSED, "CIBC line of credit: no STATEMENT PERIOD line")

    debits = sum((r["loc"] for r in rows if r["loc"] > 0), _ZERO)
    credits = -sum((r["loc"] for r in rows if r["loc"] < 0), _ZERO)
    # Holder view from here on: + = money in, so a balance owed and a debit are negative.
    opening, closing = -v["previous"], -v["new"]
    d = StatementDraft(index=0, acctid=re.sub(r"\D", "", acct.group(1)), kind="creditline",
                       currency="CAD", period_start=period_start, period_end=period_end,
                       closing=closing, closing_as_of=period_end, opening=opening)
    for n, r in enumerate(rows):
        d.transactions.append(TxnDraft(
            locator=f"line{n:05d}", booking_date=r["date"], amount=-r["loc"],
            description=r["desc"], memo=" / ".join(r["memo"]) or None,
            source_type="CREDIT" if r["loc"] < 0 else "DEBIT", entry_ref=None))
    d.raw_txn_count = len(rows)
    d.checks = [
        balance_equation(opening, d.transactions, closing,
                         "-(Previous balance) + rows = -(New balance)"),
        printed_total("summary_debits", debits, v["total_debits"], "debit rows = Total debits"),
        printed_total("summary_credits", credits, abs(v["total_credits"]),
                      "CR rows = Total credits"),
        printed_total("detail_previous", v["detail_previous"], v["previous"],
                      "PREVIOUS BALANCE (details) = Previous balance (summary)"),
        printed_total("detail_new", v["detail_new"], v["new"],
                      "NEW BALANCE (details) = New balance (summary)"),
    ]
    if ti:
        d.checks.append(printed_total(
            "total_interest",
            sum((r["loc"] for r in rows if interest_re.search(r["desc"]) and r["loc"] > 0),
                _ZERO), _loc(ti), "INTEREST rows = TOTAL INTEREST"))
    return [d]
