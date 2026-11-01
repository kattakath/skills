"""TD Visa credit card PDF hook: transaction date | posting date | description | amount, the
balance summary in a right-hand column that shares lines with the rows."""
import re
from decimal import Decimal

from statement_extract import pdfkit
from statement_extract.model import Exit, Refusal, StatementDraft, TxnDraft
from statement_extract.reconcile import printed_total

_COL = 2  # columns an amount printed alone may sit from the column it belongs to


def _summary(lines: list[str], text: str, g: dict, sub) -> dict[str, Decimal]:
    """Each summary figure after its label, searched over the whole text. When one is not
    found there, the block is read again line by line, all six figures afresh: a label with
    its amount at the end of its own line, or a bare label whose amount is printed alone on a
    later line, right-aligned to the block's amount column; bare labels pair with those
    amounts in order. Anything left unpaired is refused."""
    labels = g["summary"]
    found: dict[str, Decimal] = {}
    for k, label in labels.items():
        m = re.search(sub(label + g["summary_amount"]), text, re.M)
        if not m:
            break
        found[k] = pdfkit.amount(m.group(1))
    else:
        return found

    on_line = {k: re.compile(sub(v + g["summary_amount"])) for k, v in labels.items()}
    bare = {k: re.compile(sub(v + g["summary_bare"])) for k, v in labels.items()}
    new_rx = re.compile(sub(g["new"]))
    alone = re.compile(sub(g["amount_alone"]))
    first = next((i for i, line in enumerate(lines) if on_line["previous"].search(line)), None)
    if first is None:
        raise Refusal(Exit.REFUSED, "summary line 'previous' not found")
    found = {"previous": pdfkit.amount(on_line["previous"].search(lines[first]).group(1))}
    end_col = on_line["previous"].search(lines[first]).end(1)
    pending: list[str] = []
    for line in lines[first + 1:]:
        if new_rx.search(line):
            break
        todo = [k for k in labels if k not in found and k not in pending]
        k = next((k for k in todo if on_line[k].search(line)), None)
        if k:
            found[k] = pdfkit.amount(on_line[k].search(line).group(1))
            continue
        k = next((k for k in todo if bare[k].search(line)), None)
        if k:
            pending.append(k)
            continue
        am = alone.match(line)
        if am and pending and abs(am.end(1) - end_col) <= _COL:
            found[pending.pop(0)] = pdfkit.amount(am.group(1))
    for k in labels:
        if k not in found:
            raise Refusal(Exit.REFUSED, f"summary line {k!r} not found")
    return found


def parse_lines(lines: list[str], spec: dict, text: str) -> list[StatementDraft]:
    """Why not TOML: a wrapped description continues on the next line only when it starts in
    the description column of the row above, and that column moves from page to page; a
    wrapped row can print its amount alone below the wrap, under AMOUNT($). Both dates take
    their year from the statement date (a January statement holds December rows). The printed
    summary splits the rows by direction across five figures, each tied to a different subset,
    and the right-hand column shares lines with the rows, so each figure is read from the end
    of its own line, or paired with an amount printed alone below its bare label. An
    additional cardholder's rows get their own net amount of activity, tied per section."""
    g = spec["grammar"]
    sub = lambda rx: rx.replace("{AMT}", g["amt"]).replace("{MON}", g["mon"])  # noqa: E731
    txn_re = re.compile(sub(g["txn"]))
    open_re = re.compile(sub(g["row_open"]))
    alone_re = re.compile(sub(g["amount_alone"]))
    head_re = re.compile(g["amount_head"])
    net_re = re.compile(sub(g["net_activity"]))

    def one(rx: str, what: str) -> re.Match:
        m = re.search(sub(rx), text, re.M)
        if not m:
            raise Refusal(Exit.REFUSED, f"{what} not found")
        return m

    sd = one(g["statement_date"], "STATEMENT DATE")
    end_month, end_year = pdfkit.month(sd.group(1)), int(sd.group(3))
    per = one(g["period"], "STATEMENT PERIOD")
    acct = one(g["account"], "card number after 'Account Number:'")
    previous = pdfkit.amount(one(g["previous"], "PREVIOUS STATEMENT BALANCE").group(1))
    new = pdfkit.amount(one(g["new"], "NEW BALANCE").group(1))
    s = _summary(lines, text, g, sub)

    def dated(m: re.Match) -> tuple[str, str]:
        out = []
        for mk, dk in (("tmon", "tday"), ("pmon", "pday")):
            mon = pdfkit.month(m.group(mk))
            out.append(pdfkit.iso(pdfkit.infer_year(mon, end_month, end_year), mon,
                                  int(m.group(dk))))
        return out[0], out[1]

    rows: list[dict] = []
    nets: list[tuple[int, Decimal]] = []  # (rows above it, printed net) per section
    desc_col = None  # description column of the row the next line may continue
    amt_end = None   # right edge of the AMOUNT($) column on this page
    pending = False  # the last row's amount is still to come, alone on a later line
    for line in lines:
        hm = head_re.search(line)
        if hm:
            amt_end = hm.end()
        tm = txn_re.match(line)
        om = None if tm else open_re.match(line)
        if pending and (tm or om):
            raise Refusal(Exit.REFUSED, "a wrapped row's amount not found below it")
        if tm or om:
            m = tm or om
            tdate, pdate = dated(m)
            rows.append({"tdate": tdate, "date": pdate,
                         "desc": re.sub(r"\s+", " ", m.group("desc").strip()),
                         "card": pdfkit.amount(tm.group("amt")) if tm else None})
            if tm:
                amt_end = tm.end("amt")  # card view: owed +
            pending = om is not None
            desc_col = m.start("desc")
            continue
        stripped = line.strip()
        if pending:
            am = alone_re.match(line)
            if am and amt_end is not None and abs(am.end(1) - amt_end) <= _COL:
                rows[-1]["card"] = pdfkit.amount(am.group(1))
                pending, desc_col = False, None
                continue
        nm = net_re.search(line)
        if nm:
            nets.append((len(rows), pdfkit.amount(nm.group(1))))
        ind = len(line) - len(line.lstrip())
        if desc_col is not None and stripped and abs(ind - desc_col) <= 2:
            rows[-1]["desc"] += " " + re.split(r"\s{3,}", stripped)[0]
            continue
        if pending and stripped:
            raise Refusal(Exit.REFUSED, "a wrapped row's amount not found below it")
        desc_col = None
    if pending:
        raise Refusal(Exit.REFUSED, "a wrapped row's amount not found below it")

    card = [r["card"] for r in rows]
    checks = [
        printed_total("summary_previous", previous, s["previous"],
                      "PREVIOUS STATEMENT BALANCE = summary Previous Balance"),
        printed_total("summary_credits", -sum((a for a in card if a < 0), Decimal(0)),
                      s["credits"], "credit rows = Payments & Credits"),
        printed_total("summary_debits", sum((a for a in card if a > 0), Decimal(0)),
                      s["purchases"] + s["cash_advances"] + s["interest"] + s["fees"],
                      "debit rows = Purchases & Other Charges + Cash Advances + Interest "
                      "+ Fees"),
        printed_total("balance_equation", previous + sum(card, Decimal(0)), new,
                      "Previous Balance + rows = NEW BALANCE (card view)"),
    ]
    if len(nets) == 1:
        checks.append(printed_total("net_activity", sum(card, Decimal(0)), nets[0][1],
                                    "rows = printed net amount of activity"))
    elif nets:
        # One section per card: the rows above each net figure and below the one before it.
        # The last section also takes any rows below its figure, so none goes untied.
        for n, (upto, net) in enumerate(nets):
            lo = nets[n - 1][0] if n else 0
            hi = upto if n < len(nets) - 1 else len(card)
            checks.append(printed_total(
                "net_activity", sum(card[lo:hi], Decimal(0)), net,
                f"rows of card section {n + 1} of {len(nets)} = its printed net amount of "
                "activity"))

    # Holder view from here on: + = money in, so a purchase (owed +) becomes negative.
    end = pdfkit.iso(end_year, end_month, int(sd.group(2)))
    start = pdfkit.iso(int(per.group(3)), pdfkit.month(per.group(1)), int(per.group(2)))
    d = StatementDraft(index=0, acctid=acct.group(1), kind="creditcard", currency="CAD",
                       period_start=start, period_end=end, closing=-new, closing_as_of=end,
                       opening=-previous, checks=checks)
    for n, r in enumerate(rows):
        d.transactions.append(TxnDraft(
            locator=f"line{n:05d}", booking_date=r["date"], transaction_date=r["tdate"],
            amount=-r["card"], description=r["desc"], memo=None,
            source_type="CREDIT" if r["card"] < 0 else "DEBIT", entry_ref=None))
    d.raw_txn_count = len(rows)
    return [d]
