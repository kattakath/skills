"""OFX/QFX driver: identify by FI identifiers, repair, parse, and run the structural checks."""
import re
from collections import Counter
from decimal import Decimal

from ..model import Check, Exit, Refusal, StatementDraft, TxnDraft
from ..money import parse_ofx_amount
from ..readers import ofx
from ..repairs import ofx as repairs

IDENT_FIELDS = {"org": "ORG", "fid": "FID", "intu_bid": "INTU.BID"}


def identify(raw: bytes, spec: dict) -> bool:
    """Every field the adapter lists must match one of its values."""
    found = ofx.identifiers(raw)
    if not found:
        return False
    for field, values in spec["identify"].items():
        tag = IDENT_FIELDS.get(field)
        if tag is None or not set(found.get(tag, [])) & set(values):
            return False
    return True


def _skip(spec: dict, amount: Decimal, name: str | None) -> bool:
    for rule in spec.get("skip", []):
        if "amount" in rule and amount != Decimal(rule["amount"]):
            continue
        if "name_prefix" in rule and not (name or "").startswith(rule["name_prefix"]):
            continue
        return True
    return False


def _statements(root: ofx.Node):
    """(kind, STMTRS-or-CCSTMTRS node) in file order."""
    for msgs, trnrs, rs, kind in (("BANKMSGSRSV1", "STMTTRNRS", "STMTRS", "bank"),
                                  ("CREDITCARDMSGSRSV1", "CCSTMTTRNRS", "CCSTMTRS", "card")):
        for m in root.all(msgs):
            for t in m.all(trnrs):
                for s in t.all(rs):
                    yield kind, s


def _dt(text):
    try:
        return ofx.parse_dt(text)
    except ofx.OFXError as e:
        raise Refusal(Exit.REFUSED, str(e)) from None


def extract(raw: bytes, spec: dict) -> tuple[list[StatementDraft], list[str]]:
    fixed, fired = repairs.apply(raw, spec.get("repairs", []))
    try:
        doc = ofx.parse(fixed)
    except ofx.OFXError as e:
        raise Refusal(Exit.REFUSED, f"OFX does not parse: {e}", repairs=fired) from None

    flip = bool(spec.get("sign", {}).get("flip", False))
    drafts: list[StatementDraft] = []
    parsed_total = 0
    for idx, (kind, s) in enumerate(_statements(doc.root)):
        acct = s.get("BANKACCTFROM" if kind == "bank" else "CCACCTFROM")
        acctid = acct.val("ACCTID") if acct is not None else None
        if not acctid:
            raise Refusal(Exit.REFUSED, f"statement {idx}: no ACCTID")
        accttype = acct.val("ACCTTYPE") if kind == "bank" else None
        if kind == "bank" and accttype not in ofx.ACCTTYPES:
            raise Refusal(Exit.REFUSED, f"statement {idx}: ACCTTYPE {accttype!r} is not OFX")
        tranlist = s.get("BANKTRANLIST")
        ledger = s.get("LEDGERBAL")
        avail = s.get("AVAILBAL")
        d = StatementDraft(
            index=idx, acctid=acctid,
            kind=accttype.lower() if accttype else "creditcard",
            currency=s.val("CURDEF") or "",
            period_start=(_dt(tranlist.val("DTSTART")) or (None,))[0] if tranlist else None,
            period_end=(_dt(tranlist.val("DTEND")) or (None,))[0] if tranlist else None,
            closing=parse_ofx_amount(ledger.val("BALAMT")) if ledger and ledger.val("BALAMT")
            else None,
            closing_as_of=(_dt(ledger.val("DTASOF")) or (None,))[0] if ledger else None,
            available=parse_ofx_amount(avail.val("BALAMT")) if avail and avail.val("BALAMT")
            else None,
        )
        rows = tranlist.all("STMTTRN") if tranlist else []
        parsed_total += len(rows)
        d.raw_txn_count = len(rows)
        fitids: Counter = Counter()
        foreign = 0
        for n, t in enumerate(rows):
            where = f"statement {idx} STMTTRN {n}"
            for req in ("TRNTYPE", "DTPOSTED", "TRNAMT", "FITID"):
                if not t.val(req):
                    raise Refusal(Exit.REFUSED, f"{where}: missing {req}")
            if t.val("TRNTYPE") not in ofx.TRNTYPES:
                raise Refusal(Exit.REFUSED, f"{where}: TRNTYPE {t.val('TRNTYPE')!r} is not OFX")
            try:
                amount = parse_ofx_amount(t.val("TRNAMT"))
            except ValueError as e:
                raise Refusal(Exit.REFUSED, f"{where}: {e}") from None
            fitids[t.val("FITID")] += 1
            if t.get("CURRENCY") is not None:
                foreign += 1
            name = t.val("NAME")
            if _skip(spec, amount, name):
                d.skipped += 1
                continue
            written, key_date = _dt(t.val("DTPOSTED"))
            user = _dt(t.val("DTUSER"))
            payee = t.get("PAYEE")
            d.transactions.append(TxnDraft(
                locator=f"stmt{idx}/trn{n:05d}",
                booking_date=written,
                key_date=key_date,
                transaction_date=user[0] if user else None,
                amount=-amount if flip else amount,
                raw_amount_text=t.val("TRNAMT"),
                description=name,
                memo=t.val("MEMO"),
                counterparty=payee.val("NAME") if payee is not None else None,
                source_type=t.val("TRNTYPE"),
                entry_ref=t.val("FITID"),
            ))
        dups = sorted(f for f, c in fitids.items() if c > 1)
        d.checks += [
            Check("fitid_unique", not dups, expected="0 repeated", actual=f"{len(dups)} repeated"),
            Check("ledgerbal_present", d.closing is not None and d.closing_as_of is not None),
            Check("single_currency", foreign == 0, expected="0 rows with <CURRENCY>",
                  actual=f"{foreign}"),
        ]
        drafts.append(d)

    # Every raw <STMTTRN> start tag in the repaired body must have become a parsed row.
    raw_count = len(re.findall(r"<STMTTRN>", doc.body))
    for d in drafts:
        d.checks.insert(0, Check("count_reconcile", raw_count == parsed_total,
                                 expected=f"{raw_count} raw <STMTTRN>",
                                 actual=f"{parsed_total} parsed"))
    if not drafts:
        raise Refusal(Exit.REFUSED, "no statements in file", repairs=fired)
    return drafts, fired
