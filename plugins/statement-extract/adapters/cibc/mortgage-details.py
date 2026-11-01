"""CIBC mortgage "Mortgage Loan - Details" page hook: one position snapshot."""
import re
from decimal import Decimal

from statement_extract import pdfkit
from statement_extract.model import Check, Exit, PositionDraft, Refusal


def _rx(g: dict, name: str, flags=re.M) -> re.Pattern:
    return re.compile(g[name].replace("{AMT}", pdfkit.AMOUNT).replace("{RATE}", pdfkit.RATE)
                      .replace("{DATE}", pdfkit.LONG_DATE), flags)


def _need(m, what: str):
    if m is None:
        raise Refusal(Exit.REFUSED, f"CIBC mortgage details: {what} not found")
    return m


def _amounts(text: str) -> list:
    return [pdfkit.amount(a) for a in re.findall(pdfkit.AMOUNT, text)]


def parse_lines(lines: list[str], spec: dict, text: str) -> list[PositionDraft]:
    """Why not TOML: the top table prints its five headings on one line and their values
    across the next two (the balance drops below its two-line heading), so values are read
    by line position, not by label. The payment history is a table of columns, one per
    payment, each of which must add up to its printed Total Paid; and the page prints no
    as-of date, so as_of is DERIVED from the newest history column."""
    g = spec["grammar"]
    head = _need(_rx(g, "header").search(text), "mortgage number and balance line")
    top = _need(_rx(g, "top_header").search(text), "the balance / payment table")
    rest = text[top.end():]
    tv = _need(_rx(g, "top_values").search(rest), "the payment frequency / amount / rate row")
    tb = _need(_rx(g, "top_balance").search(rest), "the Mortgage Loan Balance value")
    principal = pdfkit.amount(tb.group(1))
    payment = pdfkit.amount(tv.group(2))
    md = _need(_rx(g, "maturity_date").search(text), "Maturity Date")
    pi = pdfkit.amount(_need(_rx(g, "principal_interest").search(text),
                             "Principal and Interest Amount").group(1))
    tax = pdfkit.amount(_need(_rx(g, "tax").search(text), "Tax Payment").group(1))

    terms = {
        "rate": Decimal(tv.group(3)),
        "frequency": tv.group(1).strip().lower(),
        "payment": payment,
        "principal_interest_payment": pi,
        "tax_payment": tax,
        "next_payment_date": pdfkit.long_date(*tb.group(2, 3, 4)),
        "maturity_date": pdfkit.long_date(*md.group(1, 2, 3)),
    }
    if tv.group(4):
        terms["rate_type"] = tv.group(4).strip().lower()
    for key, name in (("maturity_balance", "maturity_balance"),
                      ("prepayment_privilege_remaining", "prepayment")):
        m = _rx(g, name).search(text)
        if m:
            terms[key] = pdfkit.amount(m.group(1))
    am = _rx(g, "amortization").search(text)
    if am:
        terms["remaining_amortization"] = pdfkit.duration(*am.group(1, 2))

    dates_line = _need(_rx(g, "history_dates").search(text), "payment history dates")
    dates = [pdfkit.long_date(*m) for m in re.findall(g["history_date"], dates_line.group(1))]
    cols = {k: _amounts(_need(re.search(rx, text, re.M), f"history row {k}").group(1))
            for k, rx in g["history"].items()}
    if not dates or any(len(v) != len(dates) for v in cols.values()):
        raise ValueError("payment history columns are ragged")
    if dates != sorted(dates, reverse=True):
        raise ValueError("payment history is not newest first")

    checks = [
        pdfkit.sum_check("balance_repeated", [pdfkit.amount(head.group(2))], principal,
                         "the account line's balance = Mortgage Loan Balance"),
        pdfkit.sum_check("payment_split", [pi, tax], payment,
                         "Principal and Interest + Tax Payment = Payment Amount"),
    ]
    bad = [dates[i] for i in range(len(dates))
           if cols["principal"][i] + cols["interest"][i] + cols["taxes"][i] != cols["total"][i]]
    checks.append(Check("history_split", not bad, expected="0 columns off",
                        actual=f"{len(bad)} of {len(dates)} columns off",
                        note="Principal + Interest + Taxes Paid = Total Paid, every payment"))
    checks.append(Check("as_of_basis", True, note=(
        "the page prints no as-of date: as_of = the newest Payment Date in its history, "
        "after which the printed balance stands")))
    return [PositionDraft(
        acctid=re.sub(r"\D", "", head.group(1)), kind="mortgage", currency="CAD",
        as_of=dates[0], as_of_basis="last_payment_date",
        balances={"principal_outstanding": principal}, terms=terms, checks=checks)]
