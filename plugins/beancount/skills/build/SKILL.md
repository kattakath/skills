---
name: build
description: >
  This skill should be used when the user wants their Beancount journal rebuilt or checked —
  "rebuild the ledger", "update the journal", "build the beancount file", "why does the
  journal fail its check", "which transfers did not pair", "apply my review decisions" — or
  right after new statements were extracted with statement-extract. It runs `beancount-kit
  build`, which regenerates the whole journal from durable inputs and writes it only when
  Beancount's own check passes. The journal is never edited by hand.
---

# Build the journal

The journal is a **build artifact**. Every fact in it comes from an input the consumer keeps:

| Input | Holds | Edited by |
|---|---|---|
| canonical JSONL (`statement-extract/1`) | transactions, statement closings, loan snapshots | statement-extract, never by hand |
| `ledger.toml` | account map, transfer settings, category→account overrides, gaps | the operator, rarely |
| rules CSV | pattern rules → Plaid DETAILED category | the operator |
| decisions CSV | one row per Key: category override, note, service link, accepted suggestion | the operator |
| `accounts.toml` (optional) | figures read off the lender's screen | the operator |

The consumer keeps all of these in its data store, never in a repo. The `ledger.toml`
format is documented at the top of `lib/beancount_kit/config.py`; the rules and decisions
columns are documented at the top of `lib/beancount_kit/rules.py` and `inputs.py`.

## Run

```bash
KIT="${CLAUDE_PLUGIN_ROOT}/scripts/beancount-kit"
"$KIT" build <jsonl files or folders>... --ledger ledger.toml --rules rules.csv \
  --decisions decisions.csv [--accounts accounts.toml] --out "$BEANCOUNT_JOURNAL"
```

- `--check-only` builds and checks without writing.
- `--emit-pairs F` writes `[[out_key, in_key, kind], ...]`; `--emit-rows F` writes the
  rows in pairing order (columns A–L) for an oracle comparison.
- The launcher re-execs under `$BEANCOUNT_PYTHON`, the interpreter that has beancount.

## Read the report (stderr, first line JSON)

| Field | Means |
|---|---|
| `pairs` | matched transfer pairs by kind: exact, fee, conversion, cross-currency |
| `review` | entries flagged `!` on `Expenses:Uncategorized` |
| `unpaired_must_pair` | rows whose rule required a partner and found none (now in review) |
| `transfer_residue` | own-account legs with no partner; each Key is listed below the line |
| `check_errors` | Beancount errors; non-zero means **nothing was written** |

## Exit codes

| Code | Meaning | Do |
|---|---|---|
| 0 | written, or unchanged | — |
| 2 | bad input or wrong schema | fix the input named |
| 3 | refused: check errors, unmapped account, one Key with two values, a decision for a Key no input carries | read the listed items; fix the input, never the journal |

## Rules that hold

- **Never hand-edit the journal.** A change belongs in a decision row, a rule or
  `ledger.toml`; the next build would erase a hand edit.
- **A decision wins over rules and pairing.** A decided row is never paired, so unpairing is
  a decision too.
- **The first figure for an account sizes its opening pad.** Every later figure must match
  exactly; a mismatch is a missing or doubled transaction, not something to pad over. Pad a
  known hole with a `[[gap]]` and its reason.
- **Assertions land the day after the figure's date**: Beancount checks at the start of a day.
