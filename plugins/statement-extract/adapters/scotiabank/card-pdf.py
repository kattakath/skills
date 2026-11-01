"""Scotiabank credit card / line of credit PDF hook (one layout family, two products).

loc-pdf.py delegates here, pinned by this file's sha256, so the two cannot drift apart.
"""
import re
from decimal import Decimal

from statement_extract.model import Check, Exit, Refusal, StatementDraft, TxnDraft
from statement_extract.pdfkit import amount, infer_year, iso, month, nearest_column
from statement_extract.reconcile import balance_equation, printed_total

_ZERO = Decimal(0)


def _summary(g: dict, text: str) -> dict:
    """The account summary figures, card view (owed +). Missing figure -> Refusal."""
    out = {}
    for name, rx in g["summary"].items():
        for one in rx if isinstance(rx, list) else [rx]:
            m = re.search(one.replace("{AMT}", g["amt"]), text)
            if m:
                out[name] = amount(m.group(1))
                break
    missing = [k for k in ("previous", "interest", "credits", "charges", "closing")
               if k not in out]
    if missing:
        raise Refusal(Exit.REFUSED, f"summary figure(s) not found: {missing}")
    return out


def parse_lines(lines: list[str], spec: dict, text: str) -> list[StatementDraft]:
    """Why not TOML: the amount column is located per page from the AMOUNT($) heading, because
    the summary and interest-rate column on the right shares lines with rows; a wrapped
    description line folds into the row above by its indentation; rows are grouped into
    per-cardholder sections, each tied to its own printed CREDITS/DEBITS subtotals; and the
    year is inferred per row from the statement period. Control flow over a line stream."""
    g = spec["grammar"]
    row_re = re.compile(g["row"])
    amt_re = re.compile(g["row_amount"])
    head_re = re.compile(g["amount_heading"])
    sub_re = re.compile(g["subtotal"])
    slack = int(g["amount_slack"])

    p = re.search(g["period"], text)
    if not p:
        raise Refusal(Exit.REFUSED, "no Statement Period in the header")
    smon, sday, syear, emon, eday, eyear = p.groups()
    end_m, end_y = month(emon), int(eyear)
    period_start = iso(int(syear), month(smon), int(sday))
    period_end = iso(end_y, end_m, int(eday))
    acct = re.search(g["account"], text)
    if not acct:
        raise Refusal(Exit.REFUSED, "no account number after 'Account #'")
    s = _summary(g, text)

    rows: list[dict] = []
    sections: list[dict] = []          # closed: {"rows": [...], "CREDITS": d, "DEBITS": d}
    current: dict = {"rows": []}
    heading = None                     # (start, end) of this page's AMOUNT($)
    fold_col = None                    # desc column of the row just read, while it may wrap
    for line in lines:
        h = head_re.search(line)
        if h:
            heading, fold_col = h.span(), None
            continue
        m = row_re.match(line)
        if m:
            if heading is None:
                raise Refusal(Exit.REFUSED, "a transaction row before any AMOUNT($) heading")
            cands = {i: c.span() for i, c in enumerate(amt_re.finditer(line, m.end()))}
            if not cands:
                raise Refusal(Exit.REFUSED, "a transaction row carries no amount")
            best = nearest_column(heading, cands)
            a0, a1 = cands[best]
            if abs(a1 - heading[1]) > slack:
                raise Refusal(Exit.REFUSED, "a row's amount is not under the AMOUNT($) heading")
            if "CREDITS" in current or "DEBITS" in current:
                raise Refusal(Exit.REFUSED, "a row inside a section's subtotal lines")
            pm, tm = month(m.group("pmon")), month(m.group("tmon"))
            r = {"date": iso(infer_year(pm, end_m, end_y), pm, int(m.group("pday"))),
                 "tdate": iso(infer_year(tm, end_m, end_y), tm, int(m.group("tday"))),
                 "desc": line[m.end():a0].strip(),
                 "amt": amount(line[a0:a1])}  # card view: purchase +, "-" credit
            rows.append(r)
            current["rows"].append(r)
            fold_col = m.end()
            continue
        st = sub_re.match(line)
        if st:
            fold_col = None
            current[st.group("dir")] = amount(st.group("amt"))
            if "CREDITS" in current and "DEBITS" in current:
                sections.append(current)
                current = {"rows": []}
            continue
        chunk = re.split(r"\s{3,}", line.strip())[0] if line.strip() else ""
        indent = len(line) - len(line.lstrip())
        if fold_col is not None and chunk and abs(indent - fold_col) <= 2:
            rows[-1]["desc"] += " " + chunk
        fold_col = None

    debits = sum((r["amt"] for r in rows if r["amt"] > 0), _ZERO)
    credits = -sum((r["amt"] for r in rows if r["amt"] < 0), _ZERO)
    loose = len(current["rows"])
    checks = [
        Check("rows_in_sections", loose == 0 and "CREDITS" not in current,
              expected="every row inside a section closed by CREDITS and DEBITS subtotals",
              actual=(f"{loose} row(s) after the last complete subtotal pair" if loose or
                      "CREDITS" in current else f"{len(sections)} section(s)")),
    ]
    for n, sec in enumerate(sections, 1):
        checks.append(printed_total(
            "section_credits", -sum((r["amt"] for r in sec["rows"] if r["amt"] < 0), _ZERO),
            sec["CREDITS"], f"section {n} credit rows = printed CREDITS subtotal"))
        checks.append(printed_total(
            "section_debits", sum((r["amt"] for r in sec["rows"] if r["amt"] > 0), _ZERO),
            sec["DEBITS"], f"section {n} debit rows = printed DEBITS subtotal"))
    checks += [
        printed_total("summary_credits", credits, s["credits"],
                      "all credit rows = Payments/credits"),
        printed_total("summary_debits", debits, s["interest"] + s["charges"],
                      "all debit rows = Interest + Purchases (or Advances)/charges"),
    ]

    # Holder view from here on: + = money in, so a purchase (owed +) becomes negative.
    d = StatementDraft(index=0, acctid=re.sub(r"\D", "", acct.group(1)), kind=g["kind"],
                       currency="CAD", period_start=period_start, period_end=period_end,
                       closing=-s["closing"], closing_as_of=period_end, opening=-s["previous"])
    for n, r in enumerate(rows):
        d.transactions.append(TxnDraft(
            locator=f"line{n:05d}", booking_date=r["date"], transaction_date=r["tdate"],
            amount=-r["amt"], description=re.sub(r"\s+", " ", r["desc"]), memo=None,
            source_type="CREDIT" if r["amt"] < 0 else "DEBIT", entry_ref=None))
    checks.append(balance_equation(d.opening, d.transactions, d.closing,
                                   "-(Previous balance) + rows = -(closing balance), holder view"))
    d.checks = checks
    d.raw_txn_count = len(rows)
    return [d]
