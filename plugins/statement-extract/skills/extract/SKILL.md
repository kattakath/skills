---
name: extract
description: >
  This skill should be used when the user wants transactions out of bank, card, line-of-credit
  or loan statements — "extract my statements", "turn these QFX/PDF/CSV files into
  transactions", "parse my TD/CIBC/Scotiabank/Tangerine/Desjardins/BMO/Wise statements",
  "reconcile these exports", "dedupe against what's already in my ledger", "what do these
  exit codes mean", or before any import of statement data into a sheet or ledger. It runs
  the statement-extract CLI over many files at once and reads its report. Writing the result
  to a sink (a Sheet, a ledger) is the consumer's job, not this skill's.
---

# Extract statements

**One command, many files, the same bytes every run.** The CLI identifies each file, proves it
against the statement's own totals, masks it, keys it, dedupes it, and emits canonical JSONL.
It **fails closed**: when something doesn't reconcile, it stops and says which check failed.

## Run it

```bash
SE="${CLAUDE_PLUGIN_ROOT}/scripts/statement-extract"
"$SE" doctor                                   # python, adapters, pdftotext
"$SE" identify FILES…                          # which adapter claims each file
"$SE" extract FILES… --accounts accounts.toml --seen keys.txt --report run.json > out.jsonl
"$SE" export out.jsonl > out.csv               # transactions only
```

| Flag | Use it when |
|---|---|
| `--accounts F` | an adapter needs a last-four override (Scotiabank QFX, Desjardins), or to assert a balance (upgrades to `asserted`) |
| `--seen F` | the consumer already holds keys: one per line, read with `splitlines()` |
| `--emit-seen` | append what was emitted to `--seen`, so the next run skips it |
| `--manifest F` | many files, re-run often: skip files already extracted (speed only) |
| `--require asserted\|proven` | the consumer only accepts statements proven to that level |
| `--keep-going` | emit what reconciles and refuse the rest (exit 6). Default is all-or-nothing |
| `--report F` | always, for anything you will act on: the full detail lives only here |

## Reading the result

- **stderr carries no figures.** It shows status, counts and check names, so it is safe to show.
  Balances and expected/actual values are in stdout and `--report` only.
- **Status:** `structural` (parsed and internally consistent), `asserted` (an outside balance
  agrees), `proven` (every row tied to printed totals or running balances).
- **Records:** `statement`, then `position` (loan snapshots), then `transaction`. Amounts are
  decimal strings, **+ = money in**.

## On a refusal — never work around it

| Exit | Means | Do |
|---|---|---|
| 3 | a check failed, or one key carried two payloads | Run `explain FILE` and read the failed check. The file, the adapter or the accounts entry is wrong. Report it, or hand it to the `adapter` skill |
| 4 | no adapter, several, or a required override missing | Add the accounts entry the message names, or a new adapter (`adapter` skill) |
| 5 | an output string still looks like an account number | Nothing was emitted. This needs a mask rule; never post-process the output to hide it |
| 6 | partial (`--keep-going`) | The report lists the refused files |

**Never** do any of these to get past a refusal:
- edit a statement;
- strip the failing rows;
- loosen `--require`;
- pass a different `last4` "to make it work". (A **reissued card** is not a workaround: the
  operator confirms the old and new numbers are one card account, then the entry gets
  `reissued = true`; see the README.)

A refusal is the tool telling you the data is not what it claims to be.

## Rules that are easy to break

- **One source per period.** Different statement types for the same account and dates have
  different keys, so `--seen` cannot dedupe across them. Feed one. Inside a single run the
  engine refuses the mix (`one_source_per_period`).
- **`accounts.toml` belongs to the consumer.** It names real accounts, so it never goes into
  this plugin or into a public repo.
- **Never commit a real statement.** The plugin's commit guard blocks it, and it is right to.
- **Never print stdout records of real statements into a conversation.** Summarise counts
  instead.
