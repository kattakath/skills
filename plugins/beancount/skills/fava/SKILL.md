---
name: fava
description: >
  This skill should be used when the user wants to see their Beancount journal in a browser —
  "open Fava", "show me the ledger", "net worth chart", "balance sheet", "income statement",
  "start/stop Fava", "is Fava running". It starts Fava on demand, read-only, on 127.0.0.1,
  and stops it when the review is done.
---

# Fava, on demand

```bash
KIT="${CLAUDE_PLUGIN_ROOT}/scripts/beancount-kit"
"$KIT" fava start     # uses $BEANCOUNT_JOURNAL, or --journal PATH
"$KIT" fava status    # exit 0 running, 3 not running
"$KIT" fava stop
```

- **Read-only, always.** The journal is derived; an edit made in Fava would vanish at the next
  build. Fava refuses source edits with 401 in this mode (measured 2026-11-01).
- **Loopback only.** Fava has no login. It binds 127.0.0.1 on `$FAVA_PORT` (default 5000);
  never expose it on another interface.
- **`--poll-watcher`.** A journal on a synced folder misses file events; polling sees each
  rebuild.
- State and log: `$XDG_STATE_HOME/beancount-kit/` (`fava.pid`, `fava.log`).
- Stop it when the review is done. Nothing needs it running between reviews.

## Where to look

| Question | Fava page |
|---|---|
| What needs review? | Journal, filter `flag:!` |
| Do transfers clear? | Account `Assets:Transfers` (zero, or the listed residue) |
| Net worth over time | Balance Sheet → chart |
| Spending by category | Income Statement, or Query with a recipe from the `query` skill |
