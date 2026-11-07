# beancount

Double-entry accounting where **the journal is a build artifact**. `beancount-kit build`
regenerates a [Beancount](https://github.com/beancount/beancount) journal from durable inputs,
and writes it only when Beancount's own check passes. Nobody edits the journal; a change goes
into the input that owns it, and the next build carries it.

```
statement-extract JSONL ─┐
ledger.toml (accounts) ──┤
rules CSV ───────────────┼─▶ beancount-kit build ─▶ check ─▶ journal ─▶ Fava (read-only)
decisions CSV ───────────┤                                          └─▶ bean-query
accounts.toml (screen) ──┘
```

## What a build does

- One entry per transaction, keyed by statement-extract's frozen Key; inputs dedupe by Key
  across files and **refuse** if one Key carries two different transactions.
- Categories: pattern rules → a Plaid PFCv2 DETAILED value → an account derived by prefix, or
  overridden in `ledger.toml`. Unmatched rows are flagged `!` on `Expenses:Uncategorized`.
- Transfers between own accounts clear through `Assets:Transfers`, paired one-to-one: exact,
  a fee band (the shortfall posts to a fee account), cross-currency (`@@`), or an in-wallet
  conversion. Unpaired legs post to an external-transfers account and are listed, so the
  clearing account always nets to zero.
- Statement closings, screen figures and loan snapshots become `balance` assertions, dated
  the day after the figure. One opening pad per asserted account; later loan snapshots pad
  from an interest account.

## Requirements

- Python ≥ 3.11 with **beancount 3.2.3**, **beanquery 0.2.0** and **fava 1.30.16** in **one**
  interpreter, named by `$BEANCOUNT_PYTHON`. Tested at those versions.
- `$BEANCOUNT_JOURNAL` (the journal path) and `$FAVA_PORT` (default 5000).
- The **`plaid-pfc`** plugin, a declared dependency, so it installs with this one. Category names are checked against its pinned PFC v2
  list (found via Claude Code's `installed_plugins.json`, or `$PLAID_PFC_DATA` naming its
  `data/pfc-v2.json`). An invented name in rules, decisions or `[categories]` refuses the
  build. The two plugins share data, not code, the same way statement-extract and this one do.
- The tests: `bash tests/run.sh` (set `PYTHON` to an interpreter that has beancount).

## Licences

This plugin is MIT. It **imports** Beancount (GPL-2.0) at run time and calls `bean-query`
and `fava` as programs; it ships none of their code. Fava is MIT.

## Skills

| Skill | For |
|---|---|
| `build` | rebuild or check the journal; read the report and exit codes |
| `query` | answer questions with tested bean-query recipes |
| `fava` | start, check and stop Fava, read-only, on 127.0.0.1 |

`beancount-kit build` takes **every** statement file, overlapping or not: per account and per
day, a bank export (QFX/OFX, CSV) outranks a PDF, the PDF fills only the days nothing better
covers, and holes are bridged by labelled `Equity:Gaps` pads (source precedence, see the
`build` skill).

`beancount-kit coverage` checks the statement JSONL for **completeness** (each statement's
opening equals the previous closing; date holes and where history starts per account) and
**occurrence** (a Key in several files counts once; one Key with two values fails;
look-alikes are listed; after survivorship, two same-rank sources printing the same rows under different Keys fail).
Exit 3 on a balance break, a conflicting Key or a doubled source.

`beancount-kit metrics` reports how well the ledger is kept, as **ratios and counts only**: savings
rate, budget used against the month elapsed, budgets over, the freshest and stalest import, the
review backlog and loader errors. No amount and no account name is ever output. `--push` sends
them as OTLP gauges to `$BEANCOUNT_KIT_OTLP_{ENDPOINT,INSTANCE,TOKEN}`. The push is best-effort,
so a failure never fails the command.

`beancount-kit suggest` (optional, needs **smart_importer 1.2**, MIT) suggests a category
for each flagged entry, learned from the categorised ones; the operator accepts or not.

## Language server

`plugin.json` declares `beancount-language-server --stdio` for `.beancount` and `.bean`
files (`lspServers`). It must live there, not in the marketplace entry: once a plugin has
its own `plugin.json`, entry `lspServers` do not apply
([marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference.md)).
Anthropic's LSP plugins declare it in the entry only because they ship no `plugin.json`.
Until 1.1.4 it sat in the entry, and the server never loaded.
Install the binary separately (nix-config's `local.beancount` does). Measured 2026-11-01 on
1.9.2: 12 capabilities, and the golden journal's two `!` entries come back as warnings.
The journal is generated, so the server is for reading and querying it, not hand-editing.

## Not here, on purpose

- **No data.** The account map, rules, decisions and the journal live with the consumer.
- **No hand-edit path** and no edit hook: there is nothing to edit.
- **No always-on server.** Fava runs while someone is looking.
