"""Scotiabank closed-chequing PDF hook: a port of agentic-ledger pdf_rows_scotia_chequing.py
(2026-10-31)."""
import re
from decimal import Decimal

from statement_extract.model import Check, Exit, Refusal, StatementDraft, TxnDraft
from statement_extract.reconcile import printed_total

_MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}
_FULL = {m: i for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July", "August", "September",
     "October", "November", "December"], 1)}


def _to_dec(s: str) -> Decimal:
    neg = s.startswith("-") or s.endswith("-")
    d = Decimal(s.strip("-").replace("$", "").replace(",", ""))
    return -d if neg else d


def _iso(month: str, day: str, year: str) -> str:
    return f"{int(year):04d}-{_FULL[month]:02d}-{int(day):02d}"


def parse_lines(lines: list[str], spec: dict, text: str) -> list[StatementDraft]:
    """Why not TOML: a row's direction is not printed. It is whichever sign makes the
    previous running balance plus the amount equal the printed balance, so each row depends
    on the one before it. Detail lines belong to a row only by matching its description
    column (within 2), and the year is inferred per row from the period end."""
    g = spec["grammar"]
    sub = lambda rx: rx.replace("{AMT}", g["amt"]).replace("{FULL}", g["full_month"])  # noqa: E731
    txn_re = re.compile(sub(g["txn"]))

    hdr = next((lines[i + 1] for i, ln in enumerate(lines[:-1]) if g["header"] in ln), "")
    hdr_digits = re.sub(r"\D", "", hdr.split("  ")[-1] if hdr else "")
    if len(hdr_digits) < 4:
        raise Refusal(Exit.REFUSED, "no account number under 'Your account number'")

    mo, mc = re.search(sub(g["opening"]), text), re.search(sub(g["closing"]), text)
    mw, md = re.search(sub(g["withdrawals"]), text), re.search(sub(g["deposits"]), text)
    if not (mo and mc and mw and md):
        raise Refusal(Exit.REFUSED, "summary block not found (opening/closing/withdrawals/"
                      "deposits)")
    opening, closing = _to_dec(mo.group(4)), _to_dec(mc.group(4))
    tot_wdr, tot_dep = _to_dec(mw.group(1)), _to_dec(md.group(1))
    period_start, period_end = _iso(*mo.group(1, 2, 3)), _iso(*mc.group(1, 2, 3))
    end_year, end_month = int(mc.group(3)), _FULL[mc.group(1)]

    rows: list[dict] = []
    started = False
    desc_col = None
    for line in lines:
        tm = txn_re.match(line)
        if tm:
            desc = tm.group("desc").strip()
            if desc == "Opening Balance":
                started = True
                continue
            if desc == "Closing Balance":
                break
            if not started:
                continue
            if tm.group("a2") is None:
                raise Refusal(Exit.REFUSED, "a transaction line carries no running balance")
            mon = _MONTHS[tm.group("mon")]
            year = end_year - 1 if mon > end_month else end_year
            rows.append({"date": f"{year:04d}-{mon:02d}-{int(tm.group('day')):02d}",
                         "desc": desc, "amt": _to_dec(tm.group("a1")),
                         "bal": _to_dec(tm.group("a2"))})
            desc_col = tm.start("desc")
            continue
        if not started or not rows or desc_col is None:
            continue
        stripped = re.split(r"\s{3,}", line.strip())[0]
        if not stripped:
            continue
        ind = len(line) - len(line.lstrip())
        if abs(ind - desc_col) <= 2 and not re.match(r"^(Page \d|continued)", stripped):
            rows[-1]["desc"] += " " + stripped
    if not started:
        raise Refusal(Exit.REFUSED, "no Opening Balance line in the transaction list")

    breaks = []
    prev = opening
    for n, r in enumerate(rows, 1):
        if prev + r["amt"] == r["bal"]:
            r["signed"] = r["amt"]
        elif prev - r["amt"] == r["bal"]:
            r["signed"] = -r["amt"]
        else:
            breaks.append(n)
            r["signed"] = Decimal(0)
        prev = r["bal"]
    net = sum((r["signed"] for r in rows), Decimal(0))
    checks = [
        Check("running_chain", not breaks, expected="every row: previous ± amount = balance",
              actual=f"breaks at line(s) {breaks}" if breaks else "all rows chain"),
        printed_total("balance_equation", opening + net, closing, "opening + rows = closing"),
        printed_total("last_balance", rows[-1]["bal"] if rows else opening, closing,
                      "last printed balance = closing"),
        printed_total("summary_withdrawals",
                      -sum((r["signed"] for r in rows if r["signed"] < 0), Decimal(0)),
                      tot_wdr, "Minus total withdrawals"),
        printed_total("summary_deposits",
                      sum((r["signed"] for r in rows if r["signed"] > 0), Decimal(0)),
                      tot_dep, "Plus total deposits"),
    ]
    d = StatementDraft(index=0, acctid=hdr_digits, kind="checking", currency="CAD",
                       period_start=period_start, period_end=period_end, closing=closing,
                       closing_as_of=period_end, opening=opening, checks=checks)
    for n, r in enumerate(rows):
        d.transactions.append(TxnDraft(
            locator=f"line{n:05d}", booking_date=r["date"], amount=r["signed"],
            description=r["desc"], memo=None, running_balance=r["bal"],
            source_type="CREDIT" if r["signed"] > 0 else "DEBIT", entry_ref=None))
    d.raw_txn_count = len(rows)
    return [d]
