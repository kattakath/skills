"""BMO closed-chequing PDF hook, written from `fixture shape` of the real layout
(2026-10-31)."""
import re
from decimal import Decimal

from statement_extract import pdfkit
from statement_extract.model import Exit, Refusal, StatementDraft, TxnDraft
from statement_extract.reconcile import printed_total

_ZERO = Decimal(0)


def _sub(g: dict, rx: str) -> str:
    return rx.replace("{AMT}", g["amt"]).replace("{FULL}", g["full_month"])


def _amounts(line: str, start: int, cols: dict) -> dict[str, Decimal]:
    """Amounts right of `start`, each assigned to the column heading nearest its right edge.
    Two amounts in one column mean the line is not understood."""
    out: dict[str, Decimal] = {}
    for m in pdfkit.AMOUNT_RE.finditer(line, start):
        if m.end() < cols["wd"][0]:
            continue  # left of every amount column: part of the description
        col = pdfkit.nearest_column(m.span(), cols)
        if col in out:
            raise Refusal(Exit.REFUSED, f"two amounts under one column ({col})")
        out[col] = pdfkit.amount(m.group())
    return out


def parse_lines(lines: list[str], spec: dict, text: str) -> list[StatementDraft]:
    """Why not TOML: the amount columns move from page to page, so each amount's direction is
    decided by the column heading nearest it on the CURRENT page, and then proven by the
    running balance, which depends on every row before it. Detail lines belong to a row only
    by matching its description column (within 2), and the year is inferred per row from the
    period end, because a statement can start in the previous December."""
    g = spec["grammar"]
    txn_re = re.compile(_sub(g, g["txn"]))
    header_re = re.compile(g["header"])
    acct_re = re.compile(g["account"])
    colspec = {"wd": g["wd_col"], "dep": g["dep_col"], "bal": g["bal_col"]}

    mp = re.search(_sub(g, g["period"]), text)
    ms = re.search(_sub(g, g["summary"]), text, re.M)
    if not (mp and ms):
        raise Refusal(Exit.REFUSED, "period end or account summary row not found")
    end_month, end_day, end_year = pdfkit.month(mp.group(1)), int(mp.group(2)), int(mp.group(3))
    period_end = pdfkit.iso(end_year, end_month, end_day)
    acctid = ms.group(2) + ms.group(3)
    opening, tot_wdr, tot_dep, closing = (pdfkit.amount(ms.group(i)) for i in (4, 5, 6, 7))
    accounts = set(acct_re.findall(text))
    if accounts != {f"{ms.group(1)} {ms.group(2)}-{ms.group(3)}"}:
        raise Refusal(Exit.REFUSED, f"{len(accounts)} distinct account numbers in the text; "
                      "this adapter reads a single-account statement")

    cols = None
    rows: list[dict] = []
    open_row = None
    totals = None
    desc_col = None
    for line in lines:
        if header_re.search(line):
            cols = pdfkit.columns(line, colspec)
            continue
        tm = txn_re.match(line)
        if tm and cols is not None:
            desc = tm.group("desc").strip()
            amts = _amounts(line, tm.start("tail"), cols)
            mon = pdfkit.month(tm.group("mon"))
            date = pdfkit.iso(pdfkit.infer_year(mon, end_month, end_year), mon,
                              int(tm.group("day")))
            if desc == g["opening_row"]:
                if set(amts) != {"bal"}:
                    raise Refusal(Exit.REFUSED, "the Opening balance row is not a lone balance")
                open_row = (date, amts["bal"])
                continue
            if desc == g["closing_row"]:
                if "bal" in amts:
                    raise Refusal(Exit.REFUSED, "the Closing totals row carries a balance")
                totals = (amts.get("wd", _ZERO), amts.get("dep", _ZERO))
                break
            if open_row is None:
                continue
            moved = [k for k in ("wd", "dep") if k in amts]
            if len(moved) != 1:
                raise Refusal(Exit.REFUSED, f"a transaction line carries {len(moved)} amounts "
                              "outside the Balance column (expected 1)")
            signed = -amts["wd"] if moved == ["wd"] else amts["dep"]
            rows.append({"date": date, "desc": desc, "amount": signed,
                         "balance": amts.get("bal")})
            desc_col = tm.start("desc")
            continue
        if not rows or desc_col is None:
            continue
        stripped = re.split(r"\s{3,}", line.strip())[0]
        ind = len(line) - len(line.lstrip())
        if stripped and abs(ind - desc_col) <= 2 and not acct_re.search(line):
            rows[-1]["desc"] += " " + stripped
    if open_row is None:
        raise Refusal(Exit.REFUSED, "no Opening balance row in the transaction list")
    if totals is None:
        raise Refusal(Exit.REFUSED, "no Closing totals row: the transaction list is incomplete")

    net = sum((r["amount"] for r in rows), _ZERO)
    last = next((r["balance"] for r in reversed(rows) if r["balance"] is not None), open_row[1])
    checks = [
        pdfkit.running_chain(opening, rows),
        printed_total("balance_equation", opening + net, closing, "opening + rows = closing"),
        printed_total("opening_row", open_row[1], opening,
                      "Opening balance row = summary opening"),
        printed_total("last_balance", last, closing, "last printed balance = summary closing"),
        printed_total("summary_withdrawals", -sum((r["amount"] for r in rows
                                                   if r["amount"] < 0), _ZERO),
                      tot_wdr, "summary: total amounts deducted"),
        printed_total("summary_deposits", sum((r["amount"] for r in rows
                                               if r["amount"] > 0), _ZERO),
                      tot_dep, "summary: total amounts added"),
        printed_total("closing_totals_withdrawals", tot_wdr, totals[0],
                      "Closing totals (deducted) = summary"),
        printed_total("closing_totals_deposits", tot_dep, totals[1],
                      "Closing totals (added) = summary"),
    ]
    d = StatementDraft(index=0, acctid=acctid, kind="checking", currency="CAD",
                       period_start=open_row[0], period_end=period_end, closing=closing,
                       closing_as_of=period_end, opening=opening, checks=checks)
    for n, r in enumerate(rows):
        d.transactions.append(TxnDraft(
            locator=f"line{n:05d}", booking_date=r["date"], amount=r["amount"],
            description=r["desc"], memo=None, running_balance=r["balance"],
            source_type="CREDIT" if r["amount"] > 0 else "DEBIT", entry_ref=None))
    d.raw_txn_count = len(rows)
    return [d]
