"""One synthetic household, every value fabricated. Writes the inputs a build reads.

Accounts: a chequing ••0001 and a card ••0002 at "Bank", a mortgage ••0003 at "Bank"
(positions only), a wallet at "Wallet" with CAD and USD balances.
Covers: exact transfer pair, fee-band pair, in-wallet conversion, cross-currency pair, an
unpaired transfer leg, NEEDS_REVIEW, a must-pair rule that does not pair, EXT payments booked to
the mortgage liability, two mortgage snapshots (opening pad, then interest pad), a duplicate Key across two files, a decision override, a note, a quote in a payee.
"""
import json
from pathlib import Path

S = "statement-extract/1"


def stmt(sid, inst, ref, kind, cur, closing, as_of, fmt="ofx"):
    return {"schema": S, "record": "statement", "statement_id": sid, "institution": inst,
            "account": {"ref": ref, "kind": kind, "currency": cur},
            "period": {"start": None, "end": as_of},
            "balances": {"opening": None, "closing": closing, "closing_as_of": as_of,
                         "available": None},
            "source": {"file": f"{sid}.x", "sha256": sid * 8, "format": fmt}}


def txn(sid, inst, ref, cur, key, d, amount, desc, memo="", counterparty=None):
    return {"schema": S, "record": "transaction", "key": key, "statement_id": sid,
            "institution": inst, "account": ref, "booking_date": d, "amount": amount,
            "currency": cur, "description": desc, "memo": memo, "counterparty": counterparty,
            "source_type": "DEBIT" if amount.startswith("-") else "CREDIT",
            "source": {"file": f"{sid}.x", "sha256": sid * 8, "locator": "x"}}


def position(inst, ref, as_of, principal):
    return {"schema": S, "record": "position", "position_id": f"p{as_of}", "institution": inst,
            "account": {"ref": ref, "kind": "mortgage", "currency": "CAD"}, "as_of": as_of,
            "balances": {"principal_outstanding": principal}, "terms": {},
            "source": {"file": "m.pdf", "sha256": "m" * 64}}


CHQ = [
    stmt("aaaa", "Bank", "••0001", "chequing", "CAD", "1255.00", "2026-01-31"),
    txn("aaaa", "Bank", "••0001", "CAD", "Bank|••0001|F1", "2026-01-02", "2000.00", "PAYROLL ACME"),
    txn("aaaa", "Bank", "••0001", "CAD", "Bank|••0001|F2", "2026-01-05", "-300.00",
        "PAYMENT CARD 0002"),
    txn("aaaa", "Bank", "••0001", "CAD", "Bank|••0001|F3", "2026-01-10", "-1000.00",
        "SEND TO WALLET"),
    txn("aaaa", "Bank", "••0001", "CAD", "Bank|••0001|F4", "2026-01-15", "-900.00",
        "MORTGAGE PMT"),
    txn("aaaa", "Bank", "••0001", "CAD", "Bank|••0001|F5", "2026-01-20", "-45.00",
        'CORNER "STORE"'),
    txn("aaaa", "Bank", "••0001", "CAD", "Bank|••0001|F6", "2026-01-25", "-500.00",
        "SEND TO WALLET"),   # unpaired: the wallet side is outside this window
]
CARD_A = [
    stmt("bbbb", "Bank", "••0002", "card", "CAD", "-60.00", "2026-01-31"),
    txn("bbbb", "Bank", "••0002", "CAD", "Bank|••0002|C1", "2026-01-03", "-360.00",
        "GROCER ONE"),
    txn("bbbb", "Bank", "••0002", "CAD", "Bank|••0002|C2", "2026-01-07", "300.00",
        "PAYMENT THANK YOU"),
]
CARD_B = [   # an overlapping re-download: C2 again, identical
    stmt("cccc", "Bank", "••0002", "card", "CAD", "-60.00", "2026-01-31"),
    txn("cccc", "Bank", "••0002", "CAD", "Bank|••0002|C2", "2026-01-07", "300.00",
        "PAYMENT THANK YOU"),
]
WALLET = [
    stmt("dddd", "Wallet", "CAD", "balance", "CAD", "0.00", "2026-01-31", fmt="csv"),
    stmt("eeee", "Wallet", "USD", "balance", "USD", "490.00", "2026-01-31", fmt="csv"),
    txn("dddd", "Wallet", "CAD", "CAD", "Wallet|CAD|1", "2026-01-09", "997.00",
        "TOPUP FROM BANK"),   # fee pair: 3.00 short, a day early
    txn("dddd", "Wallet", "CAD", "CAD", "Wallet|CAD|2", "2026-01-12", "-685.00",
        "Converted 685.00 CAD to 500.00 USD"),
    txn("eeee", "Wallet", "USD", "USD", "Wallet|USD|1", "2026-01-12", "500.00",
        "Converted 685.00 CAD to 500.00 USD"),
    txn("dddd", "Wallet", "CAD", "CAD", "Wallet|CAD|3", "2026-01-14", "-312.00",
        "SEND TO SELF USD"),
    txn("eeee", "Wallet", "USD", "USD", "Wallet|USD|2", "2026-01-15", "228.00",
        "FROM SELF CAD"),
    txn("eeee", "Wallet", "USD", "USD", "Wallet|USD|3", "2026-01-20", "-228.00",
        "MYSTERY MERCHANT"),
    txn("eeee", "Wallet", "USD", "USD", "Wallet|USD|4", "2026-01-28", "-10.00",
        "SEND TO SELF CAD"),   # must-pair rule, no partner: NEEDS_REVIEW
]
MORTGAGE = [position("Bank", "••0003", "2025-12-31", "200000.00"),
            position("Bank", "••0003", "2026-01-31", "199600.00")]

RULES = """priority,match_field,pattern,institution,account,counterparty,sign,category,note,date_from,date_to
10,payee,PAYROLL,,,,in,INCOME_SALARY,,,
20,payee,PAYMENT CARD|PAYMENT THANK YOU,Bank,,••0001|••0002,any,LOAN_PAYMENTS_CREDIT_CARD_PAYMENT,,,
30,payee,SEND TO WALLET,,,OWN,any,TRANSFER_OUT_ACCOUNT_TRANSFER,,,
31,payee,TOPUP,Wallet,,OWN,in,TRANSFER_IN_ACCOUNT_TRANSFER,,,
40,payee,Converted,Wallet,,OWN,any,TRANSFER_OUT_ACCOUNT_TRANSFER,,,
50,payee,SELF,Wallet,,OWN!,any,TRANSFER_OUT_ACCOUNT_TRANSFER,,,
60,payee,MORTGAGE PMT,,,EXT,out,LOAN_PAYMENTS_MORTGAGE_PAYMENT,,,
70,payee,GROCER,,,,out,FOOD_AND_DRINK_GROCERIES,,,
"""
DECISIONS = """key,category,note,service,service_ref,suggestion,accept
Bank|••0001|F5,GENERAL_MERCHANDISE_CONVENIENCE_STORES,checked receipt,,,,
Wallet|USD|3,,ask the bank,Wallet,T-1,ENTERTAINMENT_TV_AND_MOVIES,
"""
LEDGER = """operating_currency = "CAD"
title = "Test household"

[transfers]
fee_institutions = ["Wallet"]
fee_account = "Expenses:Fees:Wallet"
[transfers.fx]
USD = [0.70, 0.76]

[categories]
LOAN_PAYMENTS_MORTGAGE_PAYMENT = "Liabilities:Bank:Mortgage-0003"

[[account]]
institution = "Bank"
label = "••0001"
name = "Assets:Bank:Chequing-0001"
open = "2025-12-01"

[[account]]
institution = "Bank"
label = "••0002"
name = "Liabilities:Bank:Card-0002"

[[account]]
institution = "Bank"
label = "••0003"
name = "Liabilities:Bank:Mortgage-0003"
interest = "Expenses:Interest:Mortgage"

[[account]]
institution = "Wallet"
label = "CAD balance"
name = "Assets:Wallet:CAD"

[[account]]
institution = "Wallet"
label = "USD balance"
name = "Assets:Wallet:USD"
"""


def write(d: Path) -> dict:
    d.mkdir(parents=True, exist_ok=True)
    files = {"chq": CHQ, "card-a": CARD_A, "card-b": CARD_B, "wallet": WALLET,
             "mortgage": MORTGAGE}
    for name, recs in files.items():
        (d / f"{name}.jsonl").write_text(
            "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in recs), encoding="utf-8")
    (d / "rules.csv").write_text(RULES, encoding="utf-8")
    (d / "decisions.csv").write_text(DECISIONS, encoding="utf-8")
    (d / "ledger.toml").write_text(LEDGER, encoding="utf-8")
    return {k: d / f"{k}.jsonl" for k in files}
