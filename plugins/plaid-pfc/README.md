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
