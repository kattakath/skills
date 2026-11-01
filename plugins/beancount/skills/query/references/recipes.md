# bean-query recipes

Each one ran against `tests/golden/scenario.beancount` (beanquery 0.2.0, 2026-11-01).

```bash
bean-query "$BEANCOUNT_JOURNAL" "<query>"
```

## Balances and net worth

```sql
SELECT account, sum(position) AS balance
WHERE account ~ '^(Assets|Liabilities):' GROUP BY account ORDER BY account
```

```sql
SELECT sum(position) AS net_worth WHERE account ~ '^(Assets|Liabilities):'
```

- Net worth comes back **per currency** (`-197905.00 CAD  490.00 USD` on the golden).
- `convert(sum(position), 'CAD')` converts only where the journal holds a price for that
  day. A build adds none yet, so USD stays USD. Say so; never add the two by hand.

## Spending

```sql
SELECT entry_meta('category') AS category, sum(position) AS total
WHERE account ~ '^Expenses:' AND date >= 2026-01-01 AND date < 2026-02-01
GROUP BY category ORDER BY category
```

- A row with a **blank category** is a pad (mortgage interest, an opening balance). A pad has
  no source transaction, so it carries no metadata.
- Transfer fees show under the category of the inflow leg that carries them.

```sql
SELECT year(date) AS year, sum(position) AS fees
WHERE account ~ '^Expenses:Fees:' GROUP BY year
```

## Review and transfers

```sql
SELECT date, payee, entry_meta('key') AS key, position
WHERE flag = '!' AND account = 'Expenses:Uncategorized' ORDER BY date
```

```sql
SELECT date, payee, entry_meta('key') AS key, position
WHERE account = 'Equity:Transfers:External' AND entry_meta('transfer') IS NULL
  AND entry_meta('category') ~ '^TRANSFER_' ORDER BY date
```

- The second query lists legs booked outside the journal: the **transfer residue** (own-account
  legs with no partner) plus rows a rule marks EXT. `Assets:Transfers` itself always nets to
  zero, because only paired legs post there.

## One transaction

```sql
SELECT date, flag, payee, account, position WHERE entry_meta('key') = '<Key>'
```
