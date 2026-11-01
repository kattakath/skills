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
| rules CSV | pattern rules → Plaid DETAILED category (checked against `plaid-pfc`'s pin; an invented name refuses) | the operator |
| decisions CSV | one row per Key: category override, note, service link, accepted suggestion | the operator |
| `accounts.toml` (optional) | figures read off the lender's screen | the operator |

The consumer keeps all of these in its data store, never in a repo. The `ledger.toml`
format is documented at the top of `lib/beancount_kit/config.py`; the rules and decisions
columns are documented at the top of `lib/beancount_kit/rules.py` and `inputs.py`.

## Run

```bash
KIT="${CLAUDE_PLUGIN_ROOT}/scripts/beancount-kit"
"$KIT" build <jsonl files or folders>... --ledger ledger.toml --rules rules.csv \
  --decisions decisions.csv [--accounts accounts.toml] [--budgets budgets.csv] \
  [--statements <folder>] --out "$BEANCOUNT_JOURNAL"
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
| `transfer_residue` | own-account legs with no partner. They post to `transfers.external` (so `Assets:Transfers` always nets to zero) and each Key is listed below the line; a partner found by a later build pairs them back |
| `rows_dropped_overlap` | rows a lower-ranked source (a PDF) printed on days a bank export already covers; each file is listed as `overlap:`. Their statement closings are still asserted |
| `bridges` | holes bridged by a labelled `Equity:Gaps` pad, each listed as `gap bridged:` with its date range |
| `assertions_skipped_overlap` | statement closings not asserted because a later statement prints a row dated on or before them (no day boundary separates the two); each is listed. Never padded or adjusted |
| `budgets` / `queries` / `documents` | Fava budgets, saved queries and statement links written (see below) |
| `documents_missing` | statements with no matching file under `--statements` (by name **and** sha256) |
| `check_errors` | Beancount errors; non-zero means **nothing was written** |

## Fava features, derived each build

The journal is rebuilt every time, so nothing is typed into it. Each feature has one home:

| Feature | Home | Written as |
|---|---|---|
| Fava options | `ledger.toml` `[fava]`, e.g. `default-page = "income_statement"` | `custom "fava-option" "<key>" "<value>"` |
| Saved queries (Query tab) | generic ones in `lib/beancount_kit/queries.toml`; personal ones in `ledger.toml` `[[query]]` `name` + `sql`; a personal query of the same name replaces a generic one | `query "<name>" "<sql>"` |
| Budgets | a CSV with `from, account, period, amount[, currency]` (`--budgets`); period is daily, weekly, monthly, quarterly or yearly; a row with no amount is skipped | `custom "budget" <account> "<period>" <amount> <cur>` |
| Statement PDFs | `--statements <folder>`: each statement links to the file its extract recorded, matched by name **and** sha256 | `document <account> "<absolute path>"` at the statement's closing date |

Every categorised entry also carries `rule: "<priority>"`, the Category rules row that decided
it (absent when a decision row did). The generic "Rows by rule" query groups by it.
Measured 2026-11-01 (Fava 1.30): a journal with all four loads with 0 errors, including paths
that contain spaces.

## Drop every statement in: survivorship

Put **every** statement file into the cache: QFX, CSV and PDF, overlapping or not, already
synced or not. The cache is keyed by file sha256, so a file added twice is one file. The build
decides, per account and per day (`lib/beancount_kit/survive.py`):

| Situation | What the build does |
|---|---|
| Two bank exports overlap (re-download, "last 30 days") | Union; the bank's own IDs dedupe them, and a late-posted row is kept |
| A PDF covers days a bank export covers | The export owns those days; the PDF's rows there are dropped and reported |
| A PDF covers days nothing else covers | Its rows are kept: it fills exactly those days, cut at whole days |
| The PDF and the export disagree about a day | The PDF's printed closing is still asserted, so the build **fails** |
| Days no statement covers, between covered stretches | A pad from `Equity:Gaps` bridges the hole, labelled `gap: "not recorded: <from> to <to>"` |
| A statement for an account `ledger.toml` does not map | The build **refuses**: map the account (a replaced card number is a new ref) |

The name for this is **source precedence** (MDM "survivorship"): when sources overlap, a
ranked rule picks which copy of a fact wins, and the bank's printed balances prove it.
Rejected: matching rows across sources by a date window and amount (beangulp
`heuristic_comparator`, beancount-import's matcher), because banks post identical charges on
one day and a fuzzy matcher merges them; beancount-import also edits the journal, which here is
derived.

## Labelled history for plaid-pfc (`history`)

```bash
"$KIT" history <jsonl...> --ledger L --rules R --decisions D --out "$(dirname "$BEANCOUNT_JOURNAL")/history.jsonl"
```

- **What it writes:** one row per transaction, with its category and where the label came from:
  - `decision` (a Review decisions row);
  - `rule` (`ref` = the rule's priority, `note` = the rule's note);
  - `none`.
- **What reads it:** `plaid-pfc`'s `suggest` and `eval`.
- **It carries row text:** keep it beside the journal, never in a repository.

## No gaps, no double counting (`coverage`)

```bash
"$KIT" coverage <jsonl files or folders>      # exit 3 on a balance break or a conflicting Key
```

- **Completeness:** per account, each statement's opening must equal the previous ADJOINING
  closing (a **balance break** fails); date holes between periods are listed but do not fail.
  A balance that moves across a hole is **bridged** (the build pads it), not a break.
  Coverage per account shows where history starts: earlier history was never fetched.
- **Occurrence:** a Key in several files (overlapping downloads) is counted once; one Key with
  two different date/amount values fails; look-alikes (same account, date, amount, description,
  different Keys) are listed. Banks post identical charges; a passing balance assertion over
  the period means the bank has every one.
- **Survivorship first:** coverage judges the rows the build keeps, so a PDF over a QFX is
  `rows_resolved_overlap`, not a failure.
- **Doubled sources fail:** after survivorship, two statements of the SAME rank (two bank
  exports keyed differently) that print the same date and amount under different Keys.
- **No start date** (some PDFs print only the end): breaks are still checked in end-date
  order; holes and overlap fall back to the statement's own row dates.
- Run it beside every build. No off-the-shelf Beancount plugin checks statement continuity
  (searched 2026-11-01); the core `noduplicates` plugin catches exact duplicates only.

## Reviewing flagged entries: merchant groups first

```bash
"$KIT" groups --out groups.csv     # group, pattern, count, total, first, last, sample, accounts
```

- One row per merchant (masked references, numbers and punctuation stripped; first two
  words), busiest first, with a suggested case-insensitive rule `pattern`.
- Give a group a category once; turn it into a category rule; rebuild. Rules are exact and
  reviewable, which a model is not.
- Groups whose counterparty is masked (e-transfers) cannot become a rule: decide those per row.
- **Why not a standard?** The global merchant code (MCC, ISO 18245) is not in bank exports
  (0 of 19 real QFX files carried OFX `<SIC>`), and no open merchant-name dataset exists.

## Suggestions for flagged entries (optional, weak)

```bash
"$KIT" suggest --evaluate                 # holdout accuracy on entries already categorised
"$KIT" suggest --out suggestions.csv      # key,suggestion for every entry flagged "!"
```

- Learns from the entries flagged `*` (paired transfers excluded) with smart_importer's
  predictor, and predicts the `category` of each flagged entry. **It never writes the
  journal.**
- Put each suggestion into the decisions table's `suggestion` column with `accept` unticked.
  It counts only once the operator ticks `accept`; then rebuild.
- `--evaluate` is an upper bound: rule-labelled entries are easier than the flagged ones.
  Measured 2026-11-01: 92.9% on the holdout, about 3 in 15 right on a spot check of flagged
  entries. Prefer groups.
- Needs `smart_importer` in `$BEANCOUNT_PYTHON`; `doctor` reports whether it is there.

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
- **Assertions are exact to the cent** (`~ 0.00`). Beancount's default would pass a figure one
  cent off. A cent that no statement explains, e.g. interest rounded between two statements
  the bank never issued, is a `[[gap]]` with its reason, never a looser tolerance.
