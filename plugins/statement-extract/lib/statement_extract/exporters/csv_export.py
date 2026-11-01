"""Canonical JSONL -> CSV, transactions only. The plugin's boundary: sinks live in consumers.

Statement and position records are skipped: a position (a loan balance snapshot) is not a
movement of money, and a transactions CSV has no column for it. Read positions from the JSONL.
"""
import csv
import io
import json

COLUMNS = ("key", "key_scheme", "statement_id", "institution", "account", "booking_date",
           "transaction_date", "amount", "currency", "credit_debit", "description", "memo",
           "counterparty", "source_type", "entry_ref", "running_balance", "source_file",
           "source_sha256", "source_locator")


def rows(records):
    for r in records:
        if r.get("record") != "transaction":
            continue
        src = r.get("source", {})
        flat = {**r, "source_file": src.get("file"), "source_sha256": src.get("sha256"),
                "source_locator": src.get("locator")}
        yield ["" if flat.get(c) is None else flat[c] for c in COLUMNS]


def to_csv(records) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(COLUMNS)
    w.writerows(rows(records))
    return buf.getvalue()


def from_jsonl(text: str) -> list[dict]:
    return [json.loads(line) for line in text.splitlines() if line.strip()]
