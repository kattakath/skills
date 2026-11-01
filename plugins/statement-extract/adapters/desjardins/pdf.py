"""Desjardins Visa PDF hook: a port of agentic-ledger pdf_rows_desjardins.py (2026-10-31)."""
import re
from decimal import Decimal

from statement_extract.model import Check, Exit, Refusal, StatementDraft, TxnDraft
from statement_extract.reconcile import printed_total


def _to_dec(num: str, credit: str | None) -> Decimal:
    """Printed amount -> signed Decimal in CARD view: owed/charged +, a CR credit -."""
    n = re.sub(r"[ ,  ](?=\d{3}\b)", "", num)  # thousands separators
    d = Decimal(n.replace(",", "."))
    return -d if credit else d


def parse_lines(lines: list[str], spec: dict, text: str) -> list[StatementDraft]:
    """Why not TOML: rows are classified by which section they fall under (regular /
    operations / the rewards table, which must be excluded), a foreign-currency detail line
    folds into the row above it, the year is inferred per row (a January statement carries
    December postings), and the five printed summary figures are each tied to a different
    subset of rows. That is control flow over a line stream, not a grammar."""
    g = spec["grammar"]
    amt = g["amt"]
    txn_re = re.compile(g["txn"].replace("{AMT}", amt))
    fx_re = re.compile(g["fx"])
    total_re = re.compile(g["total"].replace("{AMT}", amt))

    m = re.search(g["stmt_date"], text)
    if not m:
        raise Refusal(Exit.REFUSED, "no STATEMENT DATE found")
    sd, sm, sy = int(m.group(1)), int(m.group(2)), int(m.group(3))
    stmt_date = f"{sy:04d}-{sm:02d}-{sd:02d}"
    acct = re.search(g["account"], text)
    if not acct:
        raise Refusal(Exit.REFUSED, "no account number in the statement header")

    def summary(label: str) -> Decimal | None:
        s = re.search(rf"(?:{label})\s*[+=\-]?\s*({amt})\s*(CR|-)?", text, re.I)
        return _to_dec(s.group(1), s.group(2)) if s else None

    s = {k: summary(v) for k, v in g["summary"].items()}
    missing = [k for k in ("previous", "purchases", "charges", "credits", "new") if s[k] is None]
    if missing:
        raise Refusal(Exit.REFUSED, f"summary fields not found: {missing}")

    section, rows, printed = "regular", [], None
    for line in lines:
        if re.search(g["section_regular"], line, re.I):
            section = "regular"
        elif re.search(g["section_operations"], line, re.I):
            section = "operations"
        elif re.search(g["section_done"], line, re.I):
            section = "done"
        if section == "done":
            continue
        t = total_re.match(line)
        if t and section == "regular":
            printed = _to_dec(t.group(1), t.group(2))
            continue
        tm = txn_re.match(line)
        if tm:
            pd, pm = int(tm.group(3)), int(tm.group(4))
            td, tmon = int(tm.group(1)), int(tm.group(2))
            year = sy - 1 if pm > sm else sy
            tyear = sy - 1 if tmon > sm else sy
            rows.append({"section": section, "date": f"{year:04d}-{pm:02d}-{pd:02d}",
                         "tdate": f"{tyear:04d}-{tmon:02d}-{td:02d}",
                         "desc": tm.group("desc"),
                         "amt": _to_dec(tm.group("amt"), tm.group("cr"))})
            continue
        fx = fx_re.match(line)
        if fx and rows:
            rows[-1]["desc"] += " — " + fx.group(1)

    reg = [r["amt"] for r in rows if r["section"] == "regular"]
    ops = [r["amt"] for r in rows if r["section"] == "operations"]
    credits = -sum((r["amt"] for r in rows if r["amt"] < 0), Decimal(0))
    other = (s["cash_advances"] or 0) + (s["instalment"] or 0)
    printed_credits = -s["credits"] if s["credits"] < 0 else s["credits"]
    checks = [
        printed_total("summary_purchases", sum((a for a in reg if a > 0), Decimal(0)),
                      s["purchases"], "regular-section debits = Purchases / Debits"),
        printed_total("summary_charges", sum((a for a in ops if a > 0), Decimal(0)),
                      s["charges"] + other,
                      "operations debits = Credit Charges + Cash Advances + Instalment"),
        printed_total("summary_credits", credits, printed_credits,
                      "all credits = Payments / Credits"),
        printed_total("balance_equation", s["previous"] + sum((r["amt"] for r in rows),
                                                              Decimal(0)), s["new"],
                      "Previous Balance + rows = New Regular Balance (card view)"),
    ]
    if printed is not None:
        checks.append(printed_total("section_total", sum(reg, Decimal(0)), printed,
                                    "regular rows = printed Total"))

    # Holder view from here on: + = money in, so a purchase (owed +) becomes negative.
    d = StatementDraft(index=0, acctid=acct.group(1), kind="creditcard", currency="CAD",
                       period_start=None, period_end=stmt_date, closing=-s["new"],
                       closing_as_of=stmt_date, opening=-s["previous"], checks=checks)
    for n, r in enumerate(rows):
        d.transactions.append(TxnDraft(
            locator=f"line{n:05d}", booking_date=r["date"], transaction_date=r["tdate"],
            amount=-r["amt"], description=r["desc"], memo=None,
            source_type="CREDIT" if r["amt"] < 0 else "DEBIT", entry_ref=None))
    d.raw_txn_count = len(rows)
    return [d]
