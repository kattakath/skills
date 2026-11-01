"""CIBC Visa credit card PDF hook."""
import re
from decimal import Decimal

from statement_extract import pdfkit
from statement_extract.model import Check, Exit, Refusal, StatementDraft, TxnDraft
from statement_extract.reconcile import balance_equation, printed_total

_LAST_AMOUNT = re.compile(r"(?<!\S)(" + pdfkit.AMOUNT + r")\s*$")
_CHUNK = re.compile(r"\S+(?: \S+)*")
_ZERO = Decimal(0)


def _rx(g: dict, name: str, flags=re.M) -> re.Pattern:
    return re.compile(g[name].replace("{AMT}", pdfkit.AMOUNT).replace("{MONTH}", g["month"])
                      .replace("{MON}", g["mon"]), flags)


def _need(m: re.Match | None, what: str) -> re.Match:
    if m is None:
        raise Refusal(Exit.REFUSED, f"CIBC card: {what} not found")
    return m


def _cut(header: str, amount_rx: str) -> int | None:
    """Start of the first heading between Description and Amount (spend category, interest
    rate), or None when the table has no middle column."""
    chunks = [(m.start(), m.group()) for m in _CHUNK.finditer(header)]
    names = [c[1] for c in chunks]
    i = next(n for n, c in enumerate(names) if c.startswith("Description"))
    for start, name in chunks[i + 1:]:
        if re.match(amount_rx, name):
            return None
        return start
    return None


def parse_lines(lines: list[str], spec: dict, text: str) -> list[StatementDraft]:
    """Why not TOML: a row's direction depends on the section it sits under (payments are
    credits printed positive; charges print their own sign), a spend-category or interest-rate
    column has to be split off the description by the heading's position, every section
    total closes a running subtotal (a further "Card number" line reopens the section for the
    next cardholder), and the year is inferred per row from the period end."""
    g = spec["grammar"]
    s = {k: _need(_rx(g, k).search(text), k) for k in
         ("previous", "payments", "total_credits", "purchases", "cash_advances", "interest",
          "fees", "total_charges", "total_balance")}
    v = {k: pdfkit.amount(m.group(1)) for k, m in s.items()}
    acct = _need(_rx(g, "account").search(text), "Account number")
    per = _need(_rx(g, "period").search(text), "statement period")
    end_year, end_month = int(per.group(6)), pdfkit.month(per.group(4))
    start_month = pdfkit.month(per.group(1))
    start_year = int(per.group(3)) if per.group(3) else pdfkit.infer_year(
        start_month, end_month, end_year)
    period_start = pdfkit.iso(start_year, start_month, int(per.group(2)))
    period_end = pdfkit.iso(end_year, end_month, int(per.group(5)))

    start_re, header_re, row_re = _rx(g, "start"), _rx(g, "header"), _rx(g, "row")
    total_re, icon_re, card_re = (_rx(g, k) for k in ("section_total", "icon", "card_line"))
    sections = {k: re.compile(rx) for k, rx in g["sections"].items()}
    started = False
    section = last = None
    cut = None
    sub = _ZERO
    rows: list[dict] = []
    checks: list[Check] = []
    for line in lines:
        if not started:
            started = bool(start_re.match(line))
            continue
        hit = next((k for k, rx in sections.items() if rx.match(line)), None)
        if hit:
            section, last, cut, sub = hit, None, None, _ZERO
            continue
        if header_re.match(line):
            cut = _cut(line, g["amount_heading"])
            continue
        if card_re.match(line):
            if section is None:
                section = last  # the next cardholder's rows, under the same section
            continue
        rm = row_re.match(line)
        if rm:
            if section is None:
                raise ValueError("a transaction row outside any known section")
            am = _LAST_AMOUNT.search(line)
            if not am:
                raise ValueError("a transaction row carries no amount")
            printed = pdfkit.amount(am.group(1))
            card = -abs(printed) if section == "payments" else printed
            mid_end = am.start()
            if cut is not None and rm.end() < cut < mid_end:
                desc, memo = line[rm.end():cut], line[cut:mid_end].strip() or None
            else:
                desc, memo = line[rm.end():mid_end], None
            desc = icon_re.sub("", desc.strip())
            pmon, tmon = pdfkit.month(rm.group(3)), pdfkit.month(rm.group(1))
            rows.append({
                "section": section, "card": card, "desc": desc, "memo": memo,
                "date": pdfkit.iso(pdfkit.infer_year(pmon, end_month, end_year), pmon,
                                   int(rm.group(4))),
                "tdate": pdfkit.iso(pdfkit.infer_year(tmon, end_month, end_year), tmon,
                                    int(rm.group(2)))})
            sub += -card if section == "payments" else card
            continue
        if section and total_re.match(line):
            am = _LAST_AMOUNT.search(line)
            if am:
                checks.append(printed_total(f"section_total_{section}", sub,
                                            pdfkit.amount(am.group(1)),
                                            "rows since the last total = printed Total"))
                section, last, sub = None, section, _ZERO
    if not started:
        raise Refusal(Exit.REFUSED, "CIBC card: no 'Transactions from' table found")

    def total(pred) -> Decimal:
        return sum((r["card"] for r in rows if pred(r)), _ZERO)

    checks += [
        printed_total("summary_payments", -total(lambda r: r["section"] == "payments"),
                      v["payments"], "payments section = Payments"),
        printed_total("summary_purchases",
                      total(lambda r: r["section"] == "charges" and r["card"] > 0),
                      v["purchases"] + v["cash_advances"],
                      "charges-section debits = Purchases + Cash advances"),
        printed_total("summary_interest", total(lambda r: r["section"] == "interest"),
                      v["interest"], "interest section = Interest"),
        printed_total("summary_fees", total(lambda r: r["section"] == "fees"), v["fees"],
                      "fees section = Fees"),
        printed_total("summary_charges", total(lambda r: r["card"] > 0), v["total_charges"],
                      "all debits = Total charges"),
        printed_total("summary_credits", -total(lambda r: r["card"] < 0), v["total_credits"],
                      "all credits = Total credits"),
        printed_total("summary_arithmetic",
                      v["previous"] - v["total_credits"] + v["total_charges"],
                      v["total_balance"], "Previous - credits + charges = Total balance"),
    ]
    # Holder view from here on: + = money in, so a purchase (owed +) becomes negative.
    opening, closing = -v["previous"], -v["total_balance"]
    d = StatementDraft(index=0, acctid=re.sub(r"\D", "", acct.group(1)), kind="creditcard",
                       currency="CAD", period_start=period_start, period_end=period_end,
                       closing=closing, closing_as_of=period_end, opening=opening)
    for n, r in enumerate(rows):
        d.transactions.append(TxnDraft(
            locator=f"line{n:05d}", booking_date=r["date"], transaction_date=r["tdate"],
            amount=-r["card"], description=r["desc"], memo=r["memo"],
            source_type="CREDIT" if r["card"] < 0 else "DEBIT", entry_ref=None))
    d.raw_txn_count = len(rows)
    d.checks = [balance_equation(opening, d.transactions, closing,
                                 "-(Previous balance) + rows = -(Total balance)")] + checks
    return [d]
