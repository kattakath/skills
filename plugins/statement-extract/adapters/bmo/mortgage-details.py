"""BMO mortgage "Mortgage Details" page hook: one position snapshot."""
import re
from decimal import Decimal

from statement_extract import pdfkit
from statement_extract.model import Check, Exit, PositionDraft, Refusal

_RATE_TYPE_LOOKAHEAD = 3  # lines below the rate that may hold its type (measured: 2)


def _rx(g: dict, name: str) -> re.Pattern:
    return re.compile(g[name].replace("{AMT}", pdfkit.AMOUNT).replace("{RATE}", pdfkit.RATE)
                      .replace("{DATE}", pdfkit.LONG_DATE), re.M)


def _need(m, what: str):
    if m is None:
        raise Refusal(Exit.REFUSED, f"BMO mortgage details: {what} not found")
    return m


def _rate_type(text: str, m: re.Match) -> str | None:
    """The word printed alone in the rate's own column a line or two below it."""
    line_start = text.rfind("\n", 0, m.start(1)) + 1
    col = m.start(1) - line_start
    below = text[m.end():].split("\n")[1:1 + _RATE_TYPE_LOOKAHEAD]
    for line in below:
        w = re.match(r"\s*([A-Za-z][A-Za-z-]*)\s*$", line[col - 4:col + 24])
        if w and len(line) - len(line.lstrip()) >= col - 4:
            return w.group(1).lower()
    return None


def parse_lines(lines: list[str], spec: dict, text: str) -> list[PositionDraft]:
    """Why not TOML: the page is two columns sharing lines with the property address, so the
    prime rate wraps below its label and the rate type sits alone in the rate's column two
    lines down; both are found by COLUMN, not by label. Two printed sums tie: P&I + Property
    Tax = Total Mortgage Payment, and prime + the printed spread = Current Interest Rate."""
    g = spec["grammar"]
    acct = _need(_rx(g, "account").search(text), "mortgage number")
    principal = pdfkit.amount(_need(_rx(g, "balance").search(text), "Current Balance").group(1))
    payment = pdfkit.amount(_need(_rx(g, "payment").search(text),
                                  "Total Mortgage Payment").group(1))
    pi = pdfkit.amount(_need(_rx(g, "principal_interest").search(text),
                             "Principal & Interest").group(1))
    tax = pdfkit.amount(_need(_rx(g, "tax").search(text), "Property Tax").group(1))
    nxt = _need(_rx(g, "next_payment").search(text), "Next Payment Date")
    rm = _need(_rx(g, "rate").search(text), "Current Interest Rate")
    rate = Decimal(rm.group(1))

    terms = {"rate": rate, "payment": payment, "principal_interest_payment": pi,
             "tax_payment": tax, "next_payment_date": pdfkit.long_date(*nxt.group(1, 2, 3))}
    checks = [pdfkit.sum_check("payment_split", [pi, tax], payment,
                               "Principal & Interest + Property Tax = Total Mortgage Payment")]
    rt = _rate_type(text, rm)
    if rt:
        terms["rate_type"] = rt
    pm, sm = _rx(g, "prime").search(text), _rx(g, "spread").search(text)
    if pm and sm:
        prime, spread = Decimal(pm.group(1)), Decimal(sm.group(2))
        terms["prime_rate"], terms["rate_spread"] = prime, spread
        checks.append(pdfkit.sum_check("rate_split", [prime, spread], rate,
                                       f"BMO Prime + {sm.group(1)} = Current Interest Rate"))
    elif pm or sm:
        raise ValueError("prime rate and its spread must both parse, or neither")
    for key, name in (("original_amount", "original"), ("lump_sum_ytd", "lump_sum_ytd")):
        m = _rx(g, name).search(text)
        if m:
            terms[key] = pdfkit.amount(m.group(1))
    m = _rx(g, "frequency").search(text)
    if m:
        terms["frequency"] = m.group(1).lower()
    m = _rx(g, "term").search(text)
    if m:
        terms["term"] = pdfkit.duration(0, m.group(1))
    m = _rx(g, "renewal").search(text)
    if m:
        terms["maturity_date"] = pdfkit.long_date(*m.group(1, 2, 3))
    m = _rx(g, "amortization_end").search(text)
    if m:
        terms["amortization_end"] = f"{int(m.group(2)):04d}-{pdfkit.month(m.group(1)):02d}"
    checks.append(Check("as_of_basis", True, note=(
        "the page prints no as-of date (its figures are for the previous business day): "
        "as_of = the Next Payment Date, before which the printed balance stands")))
    return [PositionDraft(
        acctid=acct.group(1), kind="mortgage", currency="CAD",
        as_of=terms["next_payment_date"], as_of_basis="next_payment_date",
        balances={"principal_outstanding": principal}, terms=terms, checks=checks)]
