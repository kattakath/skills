"""Wise balance-statement PDF hook. Layout measured 2026-10-31 with `fixture shape` only."""
import re
from datetime import datetime
from decimal import Decimal

from statement_extract.model import Check, Exit, Refusal, StatementDraft, TxnDraft
from statement_extract.reconcile import printed_total, running_chain


def _dec(s: str) -> Decimal:
    return Decimal(s.replace(",", ""))


def _iso(s: str) -> str:
    return datetime.strptime(s, "%d %B %Y").date().isoformat()


def parse_lines(lines: list[str], spec: dict, text: str) -> list[StatementDraft]:
    """Why not TOML: one transaction spans several lines. The amount line comes first, any
    continuation lines fold into its description, and the row is only complete at the detail
    line that carries its date and Wise id; a page footer can fall in between. Rows are
    newest first, so the running-balance chain is walked in reverse."""
    g = spec["grammar"]
    sub = lambda rx: rx.replace("{AMT}", g["amt"]).replace("{DATE}", g["date"])  # noqa: E731
    row_re, detail_re = re.compile(sub(g["row"])), re.compile(sub(g["detail"]))
    footer_re, header_re = re.compile(g["footer"]), re.compile(g["header"])

    mc = re.search(g["currency"], text, re.M)
    mp = re.search(sub(g["period"]), text, re.M)
    mb = re.search(sub(g["closing"]), text, re.M)
    if not (mc and mp and mb):
        raise Refusal(Exit.REFUSED, "header not found (currency / period / closing balance)")
    currency = mc.group("cur")
    if mb.group("cur") != currency:
        raise Refusal(Exit.REFUSED, "the closing balance is printed in another currency")
    start, end = _iso(mp.group("start")), _iso(mp.group("end"))
    closing = _dec(mb.group("amt"))

    rows: list[dict] = []
    pending = None
    started = False
    details = 0
    for n, line in enumerate(lines):
        if not started:
            started = bool(header_re.match(line))
            continue
        if not line.strip() or footer_re.match(line):
            continue
        dm = detail_re.match(line)
        if dm:
            details += 1
            if pending is None:
                raise Refusal(Exit.REFUSED, f"line {n + 1}: a detail line with no amount line")
            pending.update(date=_iso(dm.group("date")), id=dm.group("id"))
            rows.append(pending)
            pending = None
            continue
        rm = row_re.match(line)
        if rm and pending is None:
            pending = {"n": n + 1, "desc": rm.group("desc").strip(), "amt": _dec(rm.group("amt")),
                       "bal": _dec(rm.group("bal"))}
        elif rm:
            raise Refusal(Exit.REFUSED, f"line {n + 1}: a new row before the previous one's "
                          "detail line")
        elif pending is not None:
            pending["desc"] += " " + line.strip()
    if not started:
        raise Refusal(Exit.REFUSED, "no Description header: transaction list not found")
    if pending is not None:
        raise Refusal(Exit.REFUSED, f"line {pending['n']}: the last row has no detail line")

    chron = list(reversed(rows))
    txns = [TxnDraft(
        locator=f"line{r['n']:05d}", booking_date=r["date"], amount=r["amt"],
        description=r["desc"], memo=None, source_type=r["id"].split("-", 1)[0],
        entry_ref=r["id"], running_balance=r["bal"]) for r in chron]
    dates = [r["date"] for r in rows]
    out_of_order = sum(1 for a, b in zip(dates, dates[1:]) if a < b)
    chain, opening, newest = running_chain(txns)
    checks = [
        Check("count_reconcile", details == len(rows), expected=f"{details} detail lines",
              actual=f"{len(rows)} rows"),
        Check("order_proof", out_of_order == 0, expected="newest-first, 0 rows out of order",
              actual=f"{out_of_order} out of order", note="by printed date"),
        Check("period_contains_rows", all(start <= d <= end for d in dates),
              expected=f"{start}..{end}", actual=f"{min(dates, default='-')}..{max(dates, default='-')}"),
        chain,
        printed_total("closing_balance", newest if rows else closing, closing,
                      "newest running balance = printed closing"),
    ]
    d = StatementDraft(index=0, acctid=currency, kind=spec.get("account", {}).get("kind", "balance"),
                       currency=currency, period_start=start, period_end=end, closing=closing,
                       closing_as_of=end, opening=opening if rows else closing,
                       transactions=txns, raw_txn_count=len(rows), checks=checks)
    return [d]
