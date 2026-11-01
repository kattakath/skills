# plaid-pfc

Plaid's **Personal Finance Category (PFC)** taxonomy, pinned and strictly enforced, for
anything that categorises transactions.

## What it ships

| Piece | What it does |
|---|---|
| `data/pfc-v2.json` | The 127 v2 detailed names in 18 primary groups, with Plaid's description for each, plus the source URL, fetch date and the CSV's sha256 |
| `data/crosswalk-v1-v2.json` | v1 → v2 renames and splits, from Plaid's own CSV columns (identity is implied) |
| `scripts/pfc` | `validate` (exit 3 on any unknown name), `describe`, `list`, `crosswalk`, `schema`, `refresh` |
| `lib/plaid_pfc/models.py` | Standard I/O records (`Txn`, `Evidence`, `Suggestion`) and their JSON Schema; `category` is an enum of the pin |
| `lib/plaid_pfc/merchant.py` + `data/merchant-vectors.json` | The merchant key a decision applies to; the same algorithm as beancount's `groups`, pinned by shared golden vectors |
| `pfc suggest` / `pfc eval` | Suggest from the consumer's own labelled history (exact merchant key); measure coverage and precision on held-out rows, seen vs unseen merchants |
| Skill `plaid-pfc` | When and how to use it, including enum-bound LLM output |

## Facts it exists to carry (measured 2026-11-01)

- **A de facto standard, not an official one.** Plaid publishes it; no standards body owns it.
  - **MCC (ISO 18245) lost:** it classifies the merchant's business, not the spending.
  - **ISO 20022 bank transaction codes lost:** they classify the bank's operation.
- **v2 is not a pure superset of v1**, despite Plaid's note:
  - **renamed:** `INCOME_WAGES` → `INCOME_SALARY`, `INCOME_OTHER_INCOME` → `INCOME_OTHER`,
    `TRANSFER_IN_CASH_ADVANCES_AND_LOANS` → `LOAN_DISBURSEMENTS_OTHER_DISBURSEMENT`;
  - **split:** the two v1 "other transfer" names map to themselves and to `OTHER_OTHER`.
- **Plaid's own SDK does not pin the names.** `plaid-python` types `detailed` as a free string
  with no allowed values, which is why this plugin exists.
- **`OTHER_OTHER` has no description** in Plaid's CSV.

## Measured on a real ledger (2026-11-01, 6,385 rows; counts only)

| Held out | Stratum | n | At confidence ≥ 0.9: coverage / precision |
|---|---|---|---|
| seen | all | 1,203 | 72.7% / 99.5% |
| seen | decision (rows a human chose) | 83 | 24.1% / 90.0% |
| seen | rule | 1,120 | 76.3% / 99.8% |
| unseen | all | 1,690 | 0% / — (exact match cannot know a new merchant) |

- **The "rule" stratum flatters the method:** history re-learns what a pattern rule already
  decides from the same text.
- **The "decision" row is the honest one for hard cases.**
- **Unseen is 0% by construction.** It is the number that justifies fuzzy matching and the
  evidence adapters.

### With `--fuzzy` (trigram fallback, same ledger, same splits)

| Held out | Stratum | n | Conf ≥ 0.5: cov / prec | Conf ≥ 0.8: cov / prec |
|---|---|---|---|---|
| unseen | all | 1,690 | 56.4% / 82.9% | 7.3% / 89.5% |
| unseen | decision | 58 | 8.6% / 60.0% | 0% / — |
| seen | decision | 83 | 48.2% / 82.5% (exact alone: 38.6% / 84.4%) | 32.5% / 77.8% |

- **Fuzzy recovers a lot of new-merchant coverage, but only at review-grade precision**
  (~83% at ≥ 0.5). It is not good enough to auto-accept.
- **The rows a human had to decide stay hard** (8.6% / 60%). That gap is what the evidence
  adapters (mail receipts, context, web, an enum-bound LLM) must close.
- **It is opt-in** (`--fuzzy`), and it runs in about 1 s on 6,385 rows.

## Why stdlib, not Pydantic

- **The one hard constraint is "one of these names"**, and a JSON Schema `enum` states it
  directly.
- **`enum` + `dataclasses` cover the records**, so the plugin needs nothing installed on any
  machine, the same as `statement-extract`.
- **Pydantic is revisited** if the suggestion models grow.

## Requirements

- Python ≥ 3.11. Nothing else.
- Tests: `bash tests/run.sh`. No network; `refresh` is tested against a synthetic CSV.
- Design and later phases: `docs/plaid-pfc-design.md`.
