"""beancount-kit: build a Beancount journal as a derived artifact.

Inputs are durable and live with the consumer: statement-extract canonical JSONL, a ledger.toml
account map, a category-rules CSV and a per-transaction decisions CSV. The journal is
regenerated from them on every build and never edited by hand.
"""
SCHEMA = "statement-extract/1"
