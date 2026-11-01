# statement-extract

Turn bank and card statements into **reconciled, masked, deduplicated** transaction records,
many files at once, the same bytes every run. It **fails closed**: a statement that does not
reconcile, a key that collides, or a string that still looks like an account number stops the
run with a distinct exit code and emits nothing.

The plugin ends at canonical JSONL (and a CSV exporter). Writing to a Sheet or a ledger stays
with the consumer.

## Status: releases 1, 2 and 3 (QFX/OFX, CSV, PDF)

| Ships now | Later releases |
|---|---|
| Core engine, CLI contract, run log, CSV exporter, fixture lint and shape | |
| R4: the `extract` and `adapter` skills, the `adapter-author` agent, the commit guard | |
| MIT OFX 1.x/2.x reader + 4 named repairs | |
| QFX adapters: **TD, CIBC, Scotiabank, Tangerine** | |
| Declarative CSV driver (R2) + adapter: **Wise** balance statements | |
| PDF text-layer reader (poppler) + adapters: **Desjardins Visa**, **Scotiabank closed chequing**, **Wise** | |
| PDF adapters (R3b): **TD** chequing, Visa, LOC · **CIBC** chequing, Visa, LOC/HELOC · **Scotiabank** Visa, LOC · **Tangerine** chequing · **BMO** chequing (closed) | |
| Older prints: **Desjardins Visa** 2021 · **TD** chequing 2021 and 2018 (`td/chequing-2018-pdf`) · **Scotiabank** business chequing 2020 (`scotiabank/chequing-2020-pdf`) | |
| **Positions** (loan and mortgage balance snapshots, opt-in `record: "position"`): **CIBC** and **BMO** online mortgage details, **TD** annual mortgage statement, **NSLSC** student loan statement (also a proven statement with its rows) | Scanned mortgage statements (they refuse as a scan) |

## Skills, agent and commit guard (R4)

| Piece | Invoke | Does |
|---|---|---|
| `statement-extract:extract` | "extract these statements", "what does exit 3 mean" | runs the CLI over many files, reads the report, handles refusals without working around them |
| `statement-extract:adapter` | "add support for <bank>", "this layout changed" | identify → shape → synthetic fixture → TOML/hook → checks → goldens → run.sh, under the key-freeze rule and the privacy boundary; `references/` holds the contract, the schema, the known layout traps and the fixture rules |
| `adapter-author` agent | delegated adapter work | the same procedure in an isolated worktree, from shapes and failing reports only; it can't touch frozen normalisers, and it reports only when `run.sh` is green |
| commit guard | automatic (PreToolUse on Bash) | blocks a `git commit` that would add OFX content outside `fixtures/` in **any** repo, or a PDF/CSV/XLSX inside this plugin outside `fixtures/` |

**About the commit guard:**
- It checks the index, plus `git commit -a`, plus the paths a `git add` earlier in the same
  command would stage. The hook runs before that add, so the index alone would miss it.
- It exits 2 with the reason on stderr.
- It is deliberately narrow: it returns at once unless the command contains `git … commit`, and
  it never blocks a CSV or PDF outside this plugin.
- It fails **open** on a malformed payload or an internal error, because a guard that denied
  on its own bug would stall every Bash call in every session.
- `tests/guard-cases.sh` asserts both directions and the fail-open path.

## Run it

The launcher is `scripts/statement-extract` inside the installed plugin. Inside a skill it is
`${CLAUDE_PLUGIN_ROOT}/scripts/statement-extract`. From a shell, take the install path Claude Code
records. Do NOT pick the newest cache directory by modification time: after an update the old
version's directory can be newer (measured 2026-11-01, `ls -td` picked the superseded copy).

```bash
SE="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.claude/plugins/installed_plugins.json")))["plugins"]["statement-extract@kattakath"][0]["installPath"])')/scripts/statement-extract"
"$SE" doctor
"$SE" extract statements/*.qfx --accounts accounts.toml --seen keys.txt --report run.json > out.jsonl
"$SE" export out.jsonl > out.csv
```

| Command | Does |
|---|---|
| `extract FILES…` | Extract. Flags: `--seen F` `--emit-seen` `--manifest F` `--force` `--accounts F` `--format jsonl\|csv` `--require structural\|asserted\|proven` `--keep-going` `--report F`; global `--log F` |
| `identify FILES…` | Which adapter claims each file. `--print-identifiers` prints ORG / FID / INTU.BID / CURDEF, **never the account id** |
| `explain FILE` | Masked diagnosis: candidates, repairs fired, every check with expected/actual |
| `adapters`, `doctor` | List adapters; check the runtime |
| `export [F]` | Canonical JSONL → CSV (transactions) |
| `fixture lint` | Keep real data out of this tree |
| `fixture shape FILE` | A real statement's layout with every value blanked, safe to share with an agent |
| `corpus check DIR --lock F` | Drift lock over a private corpus: hashes and counts only |

### Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | OK | |
| 1 | Bug | Report it |
| 2 | Usage | Fix the command or the accounts file |
| 3 | **Refused**: a check failed, or one key carried two payloads | Read `explain`; fix the adapter. Never work around it |
| 4 | **Unidentified**, ambiguous, or a required account override is missing | Add the accounts entry, or an adapter |
| 5 | **Leak**: an output string still has an account-number shape | Add a mask rule; nothing was emitted |
| 6 | Partial (`--keep-going` only) | The report names the refused files |

Default is all-or-nothing.

## Output: `schema: "statement-extract/1"`

One JSONL stream: statements, then positions, then transactions. No timestamps, so two runs,
or one with shuffled arguments, produce identical bytes.

- **`record: "statement"`**: `statement_id`, institution, `account{ref, kind, currency}`, period,
  balances, `source{file, sha256, format, extractor_version, adapter{id, sha256}, repairs}`,
  `reconcile{status, checks[]}`, `counts{parsed, skipped, emitted, seen, dup_in_run}`.
- **`record: "transaction"`**: `key`, `key_scheme`, `statement_id`, institution, `account`,
  `booking_date`, `transaction_date`, `amount` (decimal string, **+ = money in**), `currency`,
  `credit_debit` (zero = CRDT), masked `description` / `memo` / `counterparty`, `source_type`,
  `entry_ref`, `running_balance`, `source{file, sha256, locator}`.
- **`record: "position"`** (loan adapters only, see [Positions](#positions-loans-and-mortgages)):
  `position_id`, institution, `account{ref, kind, currency}`, `as_of`, `as_of_basis`,
  `balances{…}`, `terms{…}`, `source{…}` as a statement's, `reconcile{status, checks[]}`.
- `source.file` is the **masked basename**: a date-stamped name such as `X_20261031.qfx` has
  a 7+ digit run. A consumer that needs the original name maps it by `source.sha256`, since it
  holds the path it passed in.
- Ordering: institution, account, booking date, file sha256, locator. Never argv order.
  Positions: institution, account, `as_of`, file sha256.
- Changes within `/1` are **additive only**: every merge to `main` ships, so consumers should
  assert the schema string.

## Reconcile status

| Status | Means |
|---|---|
| `structural` | QFX: every raw `<STMTTRN>` parsed, no unknown tags, FITIDs unique, LEDGERBAL present, one currency. CSV: every record the header's width, order proven, one currency, native ids unique, running balance chains |
| `asserted` | Structural **and** a balance from `accounts.toml` agrees with the file |
| `proven` | The statement proves itself from printed totals: every row tied to the printed summary or running balance (the PDF adapters) |

`--require asserted` refuses anything weaker.

## Keys are a contract

| Scheme | Used for | Shape |
|---|---|---|
| `fitid` | TD, CIBC, Scotiabank, Tangerine | `Institution\|••1234\|FITID` |
| `content-occurrence/legacy-qfx-v0` | Scotiabank counter FITIDs (`undefined`, `undefined-1`, …) | `Institution\|••1234\|date\|amount\|text\|n` |
| `content-occurrence/legacy-collapse-v0` | Desjardins Visa (PDF) | same, whitespace collapsed, ledger sign |
| `statement-line/1` | Closed accounts: Scotiabank and BMO chequing (PDF); needs `keys.immutable = true` | `Institution\|••1234\|period end\|line n` |
| `content-occurrence/1` | Every other PDF (TD, CIBC, Scotiabank card/LOC, Tangerine) | `Institution\|••1234\|posting date\|amount\|text\|n`, frozen normaliser that also masks space-grouped account numbers |
| `native-id-ts/1` | Wise (CSV) | `Wise\|CAD\|<TransferWise ID>\|<Date Time as printed>` |

- **`native-id-ts/1`:** Wise reuses one id for a charge and its refund or reversal, so the
  millisecond `Date Time` is part of the key. A file in which an (id, Date Time) pair repeats
  is refused (`native_id_unique`, exit 3). The account segment is the **currency**: a Wise
  balance has no number of its own, and the legacy keys spell it that way.
- **Wise PDF** prints the id and the date but not the time, so it cannot build
  `native-id-ts/1`. It uses the frozen `content-occurrence/1`, like every other PDF, and its keys
  **differ** from the CSV's for the same movement. A run holding both for overlapping dates
  is refused (`one source per period`, exit 3). Across runs nothing can catch it: feed one
  source per period, and prefer the CSV.

- The two content normalisers are **frozen** copies of the extractors that made keys already
  stored downstream. Three tests pin them:
  - golden vectors produced by running the legacy code itself (`tests/golden/normalisers.json`);
  - a source hash per function (`tests/golden/frozen.json`);
  - the legacy extractors' own keys over every fixture (`tests/golden/legacy-keys.json`).
- Measured on 40 fixture cases (24 QFX, 5 PDF, 11 Wise CSV): **identical keys**.
- Measured on the operator's **58 real PDF statements**, locally and counts only: **identical
  key sets** for 24/24 Desjardins (654 keys) and 34/34 Scotiabank chequing (776 keys).
- Measured on the operator's **6 real Wise CSV exports** (2 empty), counts only: **identical
  key sets**, 6/6 files, 1,440 keys. A shorter CAD export's 139 keys and payloads are all
  identical to the matching rows of the full export.
- QFX display fields differ in two cases only:
  - whitespace is collapsed for display;
  - a timezone-bearing date shows the day as written. The key keeps the legacy UTC day.
- A normaliser never changes in place. A change is a new scheme name plus a consumer
  migration. Display masking (`mask.py`) is separate, and may improve freely.

## Dedupe

| Layer | Behaviour |
|---|---|
| In-run | Same key and same payload: kept once (`dup_in_run`). Same key, different payload: **exit 3**, both locators named |
| `--seen F` | One key per line, read with `splitlines()` (content keys contain spaces). `--emit-seen` appends what was emitted |
| `--manifest F` | Append-only sha256 log; skips unchanged files (`--force` overrides). Speed only |

## `accounts.toml` (consumer-owned, never in this repo)

```toml
[[account]]
institution = "Scotiabank"
acctid_last4 = "0001"   # last four of the file's own account id
last4 = "4321"          # what keys and labels use: the number on screen
kind = "card"

[[account.balance]]     # optional: upgrades the statement to "asserted"
as_of = "2026-10-31"
amount = "-12.34"       # in the file's sign: a card balance owed is negative
```

Scotiabank's `<ACCTID>` is an internal reference, so its adapter **requires** an entry
(exit 4 without one). Keep `last4` identical on every run, or the keys change.

**A reissued card** (expiry, loss, theft) gets a new number but stays the same card account,
so its old statements print the old number. Map the old number to the current one and mark it,
so the header check accepts the old number for that entry only:

```toml
[[account]]
institution = "TD"
acctid_last4 = "1111"   # the earlier card, as the old statement prints it
last4 = "2222"          # the current card: rows key and label as this account
reissued = true
```

Without `reissued`, a header that disagrees with `last4` is still refused (`header_last4`).

A Wise balance is selected by currency, and takes no `last4`:

```toml
[[account]]
institution = "Wise"
currency = "CAD"

[[account.balance]]     # the balance on Wise's screen on export day
as_of = "2026-10-31"    # = the file name's end date (wise-CAD-…-to-2026-10-31.csv)
amount = "72.43"
```

## Masking and the leak gate

- **stderr never carries a figure.** The summary line shows status and counts, and refusals name
  the failed checks. Balances and expected/actual values go to stdout and `--report` only, so an
  agent can verify real statements by reading stderr.
- Display masking keeps the **last four** of anything account-shaped:
  - long digit runs (TD `TO:`/`FRM:` payees);
  - star-masked payees (Scotiabank);
  - `dddd****dddd` (CIBC card memos as `CC#dddd****dddd`; Wise cards: first four dropped, last four kept);
  - a star run with a short tail, `****ddd` (CIBC HELOC memos, TD e-transfer references);
  - grouped digits, **in PDF statements only** (QFX/OFX and CSV print account numbers as unbroken
    runs, and their dashed store references stay readable, as the legacy extractors showed them),
    with dates and North-American phone numbers (`999-999-9999`) excluded. A
    7+ digit run is masked on its own **before** grouping, so neither a short number beside it nor
    the cents of an amount are glued into one tail.
- Every output string then passes the leak gate:
  `\d{7,}|\d{4} ?\d{2}\*|\d{4}\*{4,}|\*{2,}\d|•{3,}`.
- The gate skips two kinds of value:
  - **hex digests**: a sha256 has ~90% odds of a 7-digit run by chance;
  - **the institution's own transaction id** (`entry_ref`, the FITID segment of a `fitid`
    key, the id segment of a `native-id-ts/1` key): numeric ids are routine (every Wise id
    carries 7+ digits), and key bytes are frozen.

## Run log and OpenTelemetry

- Every run appends **OTel Logs Data Model** records as JSONL. The path is the first that is set:
  - `--log`;
  - `$STATEMENT_EXTRACT_LOG`;
  - `$XDG_STATE_HOME/statement-extract/runs.jsonl`.
- **Events:** run start/end, adapter matched, repair fired, every check (expected/actual),
  refusals, dedupe counts. Masked values only.
- **OTLP push:** with `OTEL_EXPORTER_OTLP_ENDPOINT` (or `…_LOGS_ENDPOINT`) set to http(s), the
  same records are POSTed as OTLP/HTTP-JSON to `/v1/logs`. `OTEL_EXPORTER_OTLP_HEADERS` is
  honoured.
- **A failed push never fails extraction.** It is recorded in the local log.
- An OTLP collector listening on **gRPC only** will not receive this. Give it an `http`
  receiver, or a `filelog` receiver on `runs.jsonl`.

## PDF statements

- Text comes from poppler's `pdftotext -layout`, the same invocation the legacy extractors
  used. `doctor` shows whether it is installed. A file with under 500 characters of text is
  refused as **a scan**.
- A PDF adapter is TOML (identify markers, regex grammar, key scheme) plus a hook
  (`adapters/<inst>/<format>.py`). It may define only `parse_lines`, `post_drafts` or
  `extra_checks`, and each needs a docstring starting `Why not TOML:`. The loader enforces both.
- **Desjardins Visa:** the header prints the account, not the card, so an accounts entry is
  required. Rows are tied to five printed figures. FX detail lines fold into the row above
  with ` — `. A January statement's December rows take the previous year. A month with no
  activity is a proven statement with zero rows.
  The **2021 print** adds a 3-digit Transaction Number column (kept out of the description, so
  out of the key) and splits Credit Charges into purchase and cash-advance interest lines. Its
  row grammar is chosen only when that column header is present, so the frozen 2022+ path is
  unchanged: 24/24 real statements keep identical key sets (654 keys).
- **Scotiabank closed chequing:** direction comes from the running balance, and every row
  must chain. Detail lines attach by indentation. An accounts-file last4 that disagrees with
  the header is refused (`header_last4`).
- **Each statement type stands alone.** A bank's PDF rows get their own key, never one borrowed
  from its QFX: the adapters exist so whatever statement is available can be extracted.
  Coverage by two types for the same period is rare. Feed one source per period, because
  their keys differ and `--seen` cannot dedupe across them.
- **Measured on the operator's real PDFs (R3b, counts only):** every one of 34 statements across
  5 banks is `proven`. Where a QFX covers the same period, the rows match it, except for rows the
  PDF does not print (a $0.00 interest line, rows on a shared boundary day).
- **Date basis:** PDF adapters key on the **posting** date and also emit `transaction_date`.
  TD's and Scotiabank's QFX `DTPOSTED` is the **transaction** date, so a consumer joining the two
  should join on `transaction_date`.
- **Shared parsers:** `hook = "card-pdf.py"` in an adapter's TOML reuses a sibling's hook (the
  Scotiabank LOC prints the card layout). Its bytes enter the adapter's sha256.
- **`chain_across_statements`:** one account's back-to-back statements in a run must hand
  over the balance exactly. "Back to back" means a gap of 1–3 days, because cycles end on
  weekends and holidays (28 real hand-overs measured). The same month delivered twice is
  counted once (`dup_in_run`), and both copies must agree. TD chequing periods overlap by one day
  (gap 0), so its hand-overs are not judged yet: no consecutive months were available to measure. A broken hand-over refuses the
  **whole run**, even with `--keep-going`, as a key collision does: either file could be
  the wrong one.
- **TD chequing, older prints** share one hook. **2021** (`td/chequing-pdf`): a `CLOSING
  BALANCE` row, then the totals as bare amounts (accepted only after that row), and a spaced
  `OD`. **2018** (`td/chequing-2018-pdf`, told apart by its UPPERCASE column row): `BALANCE
  FORWARD`, bare totals (zero as `.00`), and each continuation page opens with its own BALANCE
  FORWARD, which must equal the carried balance (`page_handover`), and closes with its own totals.
- **Scotiabank business chequing, 2020 print** (`scotiabank/chequing-2020-pdf`): MM/DD/YYYY
  dates, direction from the column, a balance on every row, and the Account Summary's **counts**
  as well as totals tied (`summary_counts`). Keyed `content-occurrence/1`: `statement-line/1`
  stays reserved for the closed personal account.
- **Measured on the operator's older real PDFs (counts only):** 7/7 proven, one claimant each
  (Desjardins 2021 ×2, TD 2021 ×1, TD 2018 ×3, Scotiabank 2020 ×1). The 72 statements the touched
  adapters already read (24 Desjardins, 8 TD, 40 Scotiabank) keep the same status, row count and
  key set.
- **Not yet exercised:** the Desjardins grammar carries the French labels from the legacy
  extractor, but every real statement measured was English, and no fixture covers French.

## Positions (loans and mortgages)

A mortgage details page or an annual mortgage statement is a **balance snapshot**, not a list
of movements. Such a document yields one `record: "position"`, additive within `/1`: a
consumer that ignores unknown record types is unaffected.

| Field | Meaning |
|---|---|
| `position_id` | `sha256(institution\|ref\|kind\|as_of)[:16]`. Deterministic: a consumer **upserts** by it. Exempt from the leak gate, like `statement_id` |
| `account.kind` | `mortgage`, `loan` or `heloc`, declared by the adapter's `[position] kind`. An accounts-file `kind` does not apply |
| `as_of`, `as_of_basis` | The snapshot's date, and which printed date it is: `statement_date`, `last_payment_date` or `next_payment_date` (below) |
| `balances` | Decimal strings, **positive as printed** (owed is positive, unlike a statement's holder-view closing). `principal_outstanding` is always present; others only where printed (`arrears`, `interest_outstanding`, `tax_account_balance`, `*_paid_in_period`) |
| `terms` | Whatever terms are printed: `rate`, `rate_type`, `payment`, `frequency`, `principal_interest_payment`, `tax_payment`, `maturity_date`, `remaining_amortization` / `term` (ISO 8601 durations), … |

- **Status:** `structural` when the required fields parsed and every sum the document prints
  ties. `asserted` when an `accounts.toml` balance dated `as_of` equals `principal_outstanding`
  (compared by magnitude, so one holder-view entry serves a loan's statement and its position).
  **Never `proven`**: a snapshot has no rows to tie. `--require proven` refuses a position, and an
  adapter's `minimum` / `proves` govern its statements only.
- **Dedupe:** the same `position_id` with the same payload from two files is kept once. The same
  id with a **different** payload is **exit 3** (`position_collision`): two documents disagree
  about one account on one day. `--seen` does not apply to positions.
- **Not in the transactions CSV** (`--format csv`, `export`): read positions from the JSONL.
- **Ignored by** `one_source_per_period` and `chain_across_statements`, which judge statements.
- **stderr** prints field counts only (`position (mortgage): 6 balances, 10 terms`), never a
  figure.
- A hook returns `PositionDraft`s from `parse_lines`, beside or instead of `StatementDraft`s. Only
  an adapter whose TOML declares `[position] kind = "…"` may do so; no new hook name exists.

| Adapter | Checks that must tie | `as_of` |
|---|---|---|
| `cibc/mortgage-details` | the account line's balance = Mortgage Loan Balance; P&I + tax = payment; every payment-history column: principal + interest + taxes = total | **derived**: the newest payment in its history (`last_payment_date`). The page prints no date |
| `bmo/mortgage-details` | P&I + property tax = total payment; BMO prime + printed spread = current rate | **derived**: the Next Payment Date (`next_payment_date`). The page says "previous business day" but prints no date, so a re-download in the same cycle with a moved balance collides (exit 3) |
| `td/mortgage-statement` | Beginning principal − principal paid = End principal; payment split; the year's payment summary; the property-tax account roll; the later page's repeated principal and rate | the statement's "As at" date = period end. The Beginning-of-Period column is a check input, not a second position: it would share last year's `position_id` |
| `nslsc/loan-statement` | the statement's own: every printed Principal Balance chains (rows print newest first), Opening + movements = Closing, Transaction Amount = Principal + Interest | period end; `interest_outstanding` is the statement's end-date pseudo-row |

- **NSLSC rows are real transactions**, so that adapter also emits a `proven` statement. A row's
  amount is its **principal** movement (holder view: a disbursement is negative), because the
  printed balance is principal only. A payment's interest share is checked, not emitted.
- **Measured on the operator's documents (counts only):** CIBC details 1 position, 1 balance and
  11 terms, 5 checks; BMO details 1 position, 1 + 14, 4 checks; TD annual 1 position, 6 + 10,
  8 checks (its byte-identical second copy dedupes to the same position); NSLSC 1 proven
  statement with 12 rows plus 1 position with 2 balances. All `structural`. The scanned annual
  and discharge/payout statements still refuse as a scan (exit 3).
- **Not yet covered:** a CIBC details page's payment history is checked but not emitted as rows
  (it overlaps any future mortgage statement and has no opening balance to prove it).

## CSV statements

- A CSV adapter is **TOML only**: no hook is needed. The `[csv]` table declares:
  - `encoding` (`utf-8-sig` accepts a BOM);
  - `drop`: columns removed by name as each record is split;
  - `currency`: a column, falling back to the file name's `(?P<currency>)` group;
  - `order` (`newest-first` / `oldest-first`), **proven** on every file (`order_proof`);
  - `[csv.columns]`: `id`, `datetime`, `date`, `amount`, `running_balance`, and text fields
    (`description`, `counterparty`, `memo`, `source_type`) as first-non-empty lists;
  - `[csv.formats]`: `strptime` patterns for `date` and `datetime`.
- `identify` takes `header` (columns that must all be present) and `filename` (regexes; the
  groups `currency`, `start`, `end` give the currency and the period).
- The loader refuses a spec that reads a column it drops, reads a column outside
  `identify.header`, or chains a running balance without a proven order.
- **Wise:** one file per currency, newest first. The running balance must chain, and the
  screen balance in `accounts.toml` upgrades the statement to `asserted`. Not `proven`: the
  oldest row's opening is derived from that row.
- **An empty (header-only) export** is a statement with **zero rows**. Its currency and period
  come from the file name; its balances are **null**, because an export with no movements says
  nothing about a balance that sat idle through it. It stays `structural`, so
  `--require asserted` refuses it.
- **Wise PDF:** proven. Every `Transaction:` detail line becomes a row, every row chains on the
  printed running balance, and the newest equals the printed closing.

## Privacy

- **"Payee Account Number"** (Wise CSV) holds **recipients' full account numbers**. No CSV
  adapter can read it, whatever its TOML says (`csv_driver.NEVER_READ`): its cell is dropped as
  each record is split. `fixture lint` refuses a fixture with a value in that column; an empty
  column is fine. The Wise adapter also drops the card holder's name.

- Fixtures are **synthetic only**, one per quirk.
- Every synthetic account or FITID digit run starts `0000`.
- PDF fixtures are synthetic `*.layout.txt` text, written from `fixture shape` output. Shape
  turns digits into `9` and every word outside a fixed lexicon of generic labels into `x`s,
  keeping the columns. Only shapes ever enter an agent's context.
- CI generates PDFs **in-run** from those fixtures (`tests/make_pdf.py`) and reads them back
  through poppler. No PDF is committed.
- `fixture lint` refuses:
  - a 7+ digit run outside that reserved pattern (`.qfx`, `.csv`, `.layout.txt`, case files);
  - a value under "Payee Account Number" in a `.csv` fixture;
  - a case without `synthetic = true`;
  - any PDF or other binary in this tree.
- Real statements never enter this repo. A private corpus is checked consumer-side with
  `corpus check`, which stores hashes and counts only.

## Adding an institution (until the R4 skill lands)

1. QFX: run `identify --print-identifiers` on a real file **locally** and copy its
   ORG/FID/INTU.BID into `adapters/<institution>/<format>.toml`. PDF: run `fixture shape`
   locally and write the grammar from the shape.
   CSV: print the header row (column names only) and write the `[csv]` table. A CSV
   fixture's name must satisfy the adapter's `identify.filename`, e.g.
   `wise-CAD-2026-01-01-to-2026-01-31.<case>.csv`.
2. Write one synthetic fixture per quirk: `<case>.qfx`, `<case>.csv` or `<case>.layout.txt`,
   `<case>.case.toml` (`synthetic = true`,
   `quirk`, `exit`), and optionally `<case>.accounts.toml` / `<case>.seen.txt`.
3. Generate the goldens: `STATEMENT_EXTRACT_UPDATE_GOLDENS=1 python3 -m unittest test_fixtures`,
   run from `tests/`. Then review the diff.
4. `bash tests/run.sh`, plus `bash tests/run.sh --pdf-smoke` for a PDF adapter.

TOML trap: a key written after a `[table]` header lands inside that table. The loader rejects
unknown `identify` fields for exactly that reason.

## Requires

- **poppler** (`pdftotext`) for PDF statements only.
- Python **≥ 3.11**, standard library only. No uv, no ofxtools: ofxtools is GPL-3.0, and this
  reader is MIT.
- The launcher re-execs under `python3 -I`, so `PYTHONPATH` and the working directory cannot
  inject modules.
