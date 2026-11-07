---
name: query
description: >
  This skill should be used when the user asks a question their Beancount journal can answer —
  "what did I spend on groceries last month", "net worth today", "balance of my card",
  "which transactions need review", "spending by category this year", "show the transfer
  residue", "find transaction {key}". It answers with bean-query (BQL) against the journal,
  using tested recipes, and never edits the journal.
---

# Ask the journal

```bash
bean-query "$BEANCOUNT_JOURNAL" "<BQL>"
```

Recipes, each run against the plugin's golden journal: `references/recipes.md`.

- **Figures are derived.** A total from the journal is the sum of what the statements said.
  Say which period it covers, and that it is derived.
- **Amounts carry their own currency.** Group by `currency` or convert explicitly with
  `convert(..., 'CAD')`, which uses the journal's prices; never add CAD and USD.
- **`category` metadata** holds the Plaid DETAILED value on every entry; group by it to
  survive account renames.
- A question the journal cannot answer (a balance today, a limit, a rate) is for the
  lender's own screen, not a query.
