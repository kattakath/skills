"""TD annual mortgage statement hook: one position snapshot, tied by the printed year totals."""
import re
from decimal import Decimal

from statement_extract import pdfkit
from statement_extract.model import Check, Exit, PositionDraft, Refusal

_UNIT_DAYS = {"week": 7, "weeks": 7, "day": 1, "days": 1}


def _rx(g: dict, name: str) -> re.Pattern:
    return re.compile(g[name].replace("{AMT}", pdfkit.AMOUNT).replace("{RATE}", pdfkit.RATE)
                      .replace("{DATE}", pdfkit.LONG_DATE), re.M)


def _need(m, what: str):
    if m is None:
        raise Refusal(Exit.REFUSED, f"TD mortgage statement: {what} not found")
    return m


def _amt(g, text, name, what) -> Decimal:
    m = _need(_rx(g, name).search(text), what)
    return pdfkit.amount(next(x for x in reversed(m.groups()) if x is not None))


def _amortization(years: str, n: str, unit: str) -> str:
    """'21 Years and 10 Weeks' -> 'P21Y70D' (ISO 8601 has no year+week form); months -> M."""
    u = unit.lower()
    if u.startswith("month"):
        return pdfkit.duration(years, n)
    if u not in _UNIT_DAYS:
        raise ValueError(f"amortization unit {unit!r} not understood")
    days = int(n) * _UNIT_DAYS[u]
    return f"P{int(years)}Y{days}D" if days else f"P{int(years)}Y"


def parse_lines(lines: list[str], spec: dict, text: str) -> list[PositionDraft]:
    """Why not TOML: values sit in two period columns and a vertically centred cell (the P&I
    amount prints on the line above its label), and the snapshot is only trusted when five
    printed relations tie: the principal roll from Beginning to End of Period, the payment
    split, the year's payment summary, the property-tax account roll, and the later page that
    repeats the outstanding principal and rate."""
    g = spec["grammar"]
    acct = _need(_rx(g, "account").search(text), "mortgage loan number")
    per = _need(_rx(g, "period").search(text), "Statement period")
    period_end = pdfkit.long_date(*per.group(4, 5, 6))
    as_at = pdfkit.long_date(*_need(_rx(g, "as_at").search(text), "As at date").group(1, 2, 3))
    rm = _need(_rx(g, "rate").search(text), "Annual Interest rate row")
    om = _need(_rx(g, "outstanding").search(text), "Outstanding principal amount row")
    begin, end = pdfkit.amount(om.group(1)), pdfkit.amount(om.group(2))
    pi = _amt(g, text, "principal_interest", "Principal and interest payment")
    tax = _amt(g, text, "tax", "Property tax payment")
    credit = _amt(g, text, "credit_protection", "Credit protection premium")
    tm = _need(_rx(g, "total_payment").search(text), "Total payment")
    total = pdfkit.amount(tm.group(2))
    paid = {k: _amt(g, text, f"paid_{k}", f"summary {k}")
            for k in ("principal", "interest", "tax", "credit", "total")}

    balances = {"principal_outstanding": end,
                "principal_paid_in_period": paid["principal"],
                "interest_paid_in_period": paid["interest"],
                "total_paid_in_period": paid["total"]}
    terms = {"rate": Decimal(rm.group(4)), "rate_type": rm.group(3).lower(),
             "payment": total, "frequency": tm.group(1).strip().lower(),
             "principal_interest_payment": pi, "tax_payment": tax,
             "credit_protection_premium": credit}
    ar = _rx(g, "arrears").search(text)
    if ar:
        balances["arrears"] = pdfkit.amount(ar.group(4))
    m = _rx(g, "maturity").search(text)
    if m:
        terms["maturity_date"] = pdfkit.long_date(*m.group(1, 2, 3))
    m = _rx(g, "amortization").search(text)
    if m:
        terms["remaining_amortization"] = _amortization(*m.group(1, 2, 3))
    m = _rx(g, "next_payment").search(text)
    if m:
        terms["next_payment_date"] = pdfkit.long_date(*m.group(1, 2, 3))

    checks = [
        Check("as_at_period_end", as_at == period_end, expected=period_end, actual=as_at,
              note="the snapshot's As at date = the statement period's end"),
        pdfkit.sum_check("principal_roll", [begin, -paid["principal"]], end,
                         "Beginning principal - principal paid = End of Period principal"),
        pdfkit.sum_check("payment_split", [pi, tax, credit], total,
                         "P&I + property tax + credit protection = total payment"),
        pdfkit.sum_check("summary_total", [paid[k] for k in ("principal", "interest", "tax",
                                                             "credit")], paid["total"],
                         "principal + interest + tax + protection paid = total payments"),
    ]
    tax_parts = [_rx(g, k).search(text) for k in ("tax_opening", "tax_in", "tax_out",
                                                  "tax_interest", "tax_closing")]
    if all(tax_parts):
        o, i, out, intr, c = (pdfkit.amount(m.groups()[-1]) for m in tax_parts)
        balances["tax_account_balance"] = c
        checks.append(pdfkit.sum_check("tax_account_roll", [o, i, -out, intr], c,
                                       "opening + payments in - taxes paid + interest = "
                                       "property tax account balance"))
    elif any(tax_parts):
        raise ValueError("property tax account summary is incomplete")
    rp, rr = _rx(g, "repeat_principal").search(text), _rx(g, "repeat_rate").search(text)
    if rp:
        checks.append(pdfkit.sum_check("repeated_principal", [pdfkit.amount(rp.group(1))], end,
                                       "later page's outstanding principal = End of Period"))
    if rr:
        checks.append(Check("repeated_rate", Decimal(rr.group(1)) == terms["rate"],
                            expected=format(terms["rate"], "f"), actual=rr.group(1),
                            note="later page's interest rate = End of Period rate"))
    return [PositionDraft(
        acctid=acct.group(1), kind="mortgage", currency="CAD", as_of=period_end,
        as_of_basis="statement_date", balances=balances, terms=terms, checks=checks)]
