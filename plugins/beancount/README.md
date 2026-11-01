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

`beancount-kit suggest` (optional, needs **smart_importer 1.2**, MIT) suggests a category
for each flagged entry, learned from the categorised ones; the operator accepts or not.

## Language server

The marketplace entry declares `beancount-language-server --stdio` for `.beancount` and
`.bean` files (`strict: false` + `lspServers`, the pattern Anthropic's own LSP plugins use).
Install the binary separately (nix-config's `local.beancount` does). Measured 2026-11-01 on
1.9.2: 12 capabilities, and the golden journal's two `!` entries come back as warnings.
The journal is generated, so the server is for reading and querying it, not hand-editing.

## Not here, on purpose

- **No data.** The account map, rules, decisions and the journal live with the consumer.
- **No hand-edit path** and no edit hook: there is nothing to edit.
- **No always-on server.** Fava runs while someone is looking.
