# Canonical JSONL: `schema: "statement-extract/1"`

- One stream, in this order: `statement` records, then `position` records, then `transaction`
  records.
- **No timestamps** appear on stdout, so output is byte-identical across runs and argument
  orders.
- Changes within `/1` are **additive only**. Consumers should assert the schema string.

## `record: "statement"`
| Field | Notes |
|---|---|
| `statement_id` | sha256(file sha \| ref \| index)[:16] |
| `institution`, `account{ref, kind, currency}` | `ref` is `••1234` (or the currency, for Wise) |
| `period{start, end}` | ISO dates; `start` may be null |
| `balances{opening, closing, closing_as_of, available}` | decimal strings, holder view |
| `source{file, sha256, format, extractor_version, adapter{id, sha256}, repairs, text_backend?}` | `file` is the **masked** basename |
| `reconcile{status, checks[]}` | each check: `name, ok, expected?, actual?, note?` |
| `counts{parsed, skipped, emitted, seen, dup_in_run}` | |

## `record: "position"` (loan and mortgage snapshots, opt-in)
| Field | Notes |
|---|---|
| `position_id` | sha256(institution \| ref \| kind \| as_of)[:16]: the consumer upserts by it |
| `institution`, `account{ref, kind, currency}` | `kind`: mortgage, loan or heloc |
| `as_of`, `as_of_basis` | basis: statement_date, last_payment_date or next_payment_date |
| `balances{…}`, `terms{…}` | decimal strings, ISO dates, ISO 8601 durations; whatever is printed |
| `source{…}`, `reconcile{status, checks}` | status `structural` or `asserted` |

## `record: "transaction"`
| Field | Notes |
|---|---|
| `key`, `key_scheme`, `statement_id` | |
| `institution`, `account` | |
| `booking_date`, `transaction_date` | PDFs key on the posting date; TD's and Scotiabank's QFX `DTPOSTED` is the transaction date |
| `amount`, `currency`, `credit_debit` | decimal string, + = money in; zero = CRDT |
| `description`, `memo`, `counterparty` | masked |
| `source_type`, `entry_ref`, `running_balance` | `entry_ref` = the institution's id |
| `source{file, sha256, locator}` | |

## The leak gate
Every output string is gated by `\d{7,}|\d{4} ?\d{2}\*|\d{4}\*{4,}|\*{2,}\d|•{3,}`, except:
- the digest fields (`statement_id`, `position_id`, `previous_statement_id`, `sha256`, `extractor_version`);
- `entry_ref`;
- the id segment of `fitid` and `native-id-ts/1` keys.
