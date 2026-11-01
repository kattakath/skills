"""CIBC chequing PDF hook ("CIBC Account Statement", Withdrawals / Deposits / Balance)."""
import re
from decimal import Decimal

from statement_extract import pdfkit
from statement_extract.model import Check, Exit, Refusal, StatementDraft, TxnDraft
from statement_extract.reconcile import balance_equation, printed_total

# An amount token stands alone between spaces: "FEE$12.34" inside a detail line is text.
_TOKEN = re.compile(r"(?<!\S)(" + pdfkit.AMOUNT + r")(?!\S)")


def _rx(g: dict, name: str) -> re.Pattern:
    return re.compile(g[name].replace("{AMT}", pdfkit.AMOUNT).replace("{MON}", g["mon"]), re.M)


def _need(m: re.Match | None, what: str) -> re.Match:
    if m is None:
        raise Refusal(Exit.REFUSED, f"CIBC chequing: {what} not found")
    return m


def _iso(mon: str, day: str, year: str) -> str:
    return pdfkit.iso(int(year), pdfkit.month(mon), int(day))


def _row_check(name: str, printed: Decimal | None, want: Decimal, note: str) -> Check:
    if printed is None:
        return Check(name, False, expected=format(want, "f"), actual="row not found", note=note)
    return printed_total(name, printed, want, note)


def parse_lines(lines: list[str], spec: dict, text: str) -> list[StatementDraft]:
    """Why not TOML: direction is the COLUMN an amount sits under, and the columns move on every
    continuation page, so each heading line re-anchors them. The date is printed only on a
    day's first row, later rows inherit it, and the year is inferred per row from the period
    end. Detail lines belong to the row above by indentation, and the Opening / Balance
    forward / Closing rows are balance anchors, not transactions."""
    g = spec["grammar"]
    mo = _need(_rx(g, "opening").search(text), "Opening balance")
    mc = _need(_rx(g, "closing_date").search(text), "Closing balance date")
    ma = _need(_rx(g, "closing_amount").search(text), "closing balance amount (= line)")
    mw = _need(_rx(g, "withdrawals").search(text), "Withdrawals total")
    md = _need(_rx(g, "deposits").search(text), "Deposits total")
    acct = _need(re.search(g["account"], text), "Account number")
    opening, closing = pdfkit.amount(mo.group(4)), pdfkit.amount(ma.group(1))
    tot_wdr, tot_dep = pdfkit.amount(mw.group(1)), pdfkit.amount(md.group(1))
    period_start, period_end = _iso(*mo.group(1, 2, 3)), _iso(*mc.group(1, 2, 3))
    end_year, end_month = int(mc.group(3)), pdfkit.month(mc.group(1))

    header_re, date_re = _rx(g, "header"), _rx(g, "date")
    end_re = _rx(g, "end_of_page")
    opening_re, forward_re, closing_re = (_rx(g, k) for k in
                                          ("opening_row", "forward_row", "closing_row"))
    cols = None
    desc_col = 0
    day = None
    cur = None
    rows: list[dict] = []
    chain: list[dict] = []
    opening_row = closing_row = None
    for line in lines:
        if header_re.match(line):
            cols = pdfkit.columns(line, g["columns"])
            desc_col = line.index("Description")
            cur = None
            continue
        if cols is None:
            continue
        if end_re.search(line) or not line.strip():
            cur = None
            if end_re.search(line):
                cols = None
            continue
        toks = [m for m in _TOKEN.finditer(line) if m.end() > cols["withdrawals"][0]]
        dm = date_re.match(line)
        if dm:
            day = (pdfkit.month(dm.group(1)), int(dm.group(2)))
        if not toks:
            if dm:
                raise ValueError("a dated line carries no amount")
            ind = len(line) - len(line.lstrip())
            if cur is not None and abs(ind - desc_col) <= 2:
                cur["memo"].append(line.strip())
            continue
        desc = line[dm.end() if dm else 0:toks[0].start()].strip()
        got: dict[str, Decimal] = {}
        for m in toks:
            col = pdfkit.nearest_column((m.start(), m.end()), cols)
            if col in got:
                raise ValueError(f"two amounts under {col!r} on one line")
            got[col] = pdfkit.amount(m.group(1))
        bal = got.get("balance")
        cur = None
        if opening_re.match(desc):
            opening_row = bal
            continue
        if forward_re.match(desc):
            chain.append({"amount": Decimal(0), "balance": bal})
            continue
        if closing_re.match(desc):
            closing_row = bal
            break
        if ("withdrawals" in got) == ("deposits" in got):
            raise ValueError("a row needs exactly one of Withdrawals / Deposits")
        if day is None:
            raise ValueError("a transaction row before any date")
        amt = -got["withdrawals"] if "withdrawals" in got else got["deposits"]
        year = pdfkit.infer_year(day[0], end_month, end_year)
        cur = {"date": pdfkit.iso(year, *day), "desc": desc, "memo": [], "amt": amt, "bal": bal}
        rows.append(cur)
        chain.append({"amount": amt, "balance": bal})
    if opening_row is None and not rows:
        raise Refusal(Exit.REFUSED, "CIBC chequing: no transaction table found")

    d = StatementDraft(index=0, acctid=re.sub(r"\D", "", acct.group(1)), kind="checking",
                       currency="CAD", period_start=period_start, period_end=period_end,
                       closing=closing, closing_as_of=period_end, opening=opening)
    for n, r in enumerate(rows):
        d.transactions.append(TxnDraft(
            locator=f"line{n:05d}", booking_date=r["date"], amount=r["amt"],
            description=r["desc"], memo=" / ".join(r["memo"]) or None,
            running_balance=r["bal"], source_type="CREDIT" if r["amt"] > 0 else "DEBIT",
            entry_ref=None))
    d.raw_txn_count = len(rows)
    d.checks = [
        pdfkit.running_chain(opening, chain),
        balance_equation(opening, d.transactions, closing, "opening + rows = closing"),
        _row_check("opening_row", opening_row, opening, "Opening balance row = summary"),
        _row_check("closing_row", closing_row, closing, "Closing balance row = summary"),
        printed_total("summary_withdrawals",
                      -sum((r["amt"] for r in rows if r["amt"] < 0), Decimal(0)), tot_wdr,
                      "Withdrawals column = summary Withdrawals"),
        printed_total("summary_deposits",
                      sum((r["amt"] for r in rows if r["amt"] > 0), Decimal(0)), tot_dep,
                      "Deposits column = summary Deposits"),
    ]
    return [d]
