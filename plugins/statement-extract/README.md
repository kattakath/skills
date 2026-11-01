# statement-extract

Turn bank and card statements into **reconciled, masked, deduplicated** transaction records,
many files at once, the same bytes every run. It **fails closed**: a statement that does not
reconcile, a key that collides, or a string that still looks like an account number stops the
run with a distinct exit code and emits nothing.

The plugin ends at canonical JSONL (and a CSV exporter). Writing to a Sheet or a ledger stays
with the consumer.

## Status: releases 1 and 3 (QFX/OFX, PDF)

| Ships now | Later releases |
|---|---|
| Core engine, CLI contract, run log, CSV exporter, fixture lint and shape | R2: Wise via a declarative CSV driver |
| MIT OFX 1.x/2.x reader + 4 named repairs | R4: the `extract` and `adapter` skills, an adapter-author agent, a commit guard |
| QFX adapters: **TD, CIBC, Scotiabank, Tangerine** | |
| PDF text-layer reader (poppler) + adapters: **Desjardins Visa**, **Scotiabank closed chequing** | |

There are **no skills yet** (R4): drive the CLI directly.

## Run it

The launcher is `scripts/statement-extract` inside the installed plugin. Claude Code keeps one
directory per installed version (a 12-character commit prefix), so pick the newest:

```bash
SE=$(ls -td ~/.claude/plugins/cache/kattakath/statement-extract/*/ | head -1)scripts/statement-extract
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

One JSONL stream, statements first, then transactions. No timestamps, so two runs, or one with
shuffled arguments, produce identical bytes.

- **`record: "statement"`**: `statement_id`, institution, `account{ref, kind, currency}`, period,
  balances, `source{file, sha256, format, extractor_version, adapter{id, sha256}, repairs}`,
  `reconcile{status, checks[]}`, `counts{parsed, skipped, emitted, seen, dup_in_run}`.
- **`record: "transaction"`**: `key`, `key_scheme`, `statement_id`, institution, `account`,
  `booking_date`, `transaction_date`, `amount` (decimal string, **+ = money in**), `currency`,
  `credit_debit` (zero = CRDT), masked `description` / `memo` / `counterparty`, `source_type`,
  `entry_ref`, `running_balance`, `source{file, sha256, locator}`.
- `source.file` is the **masked basename**: a date-stamped name such as `X_20261031.qfx` has
  a 7+ digit run. A consumer that needs the original name maps it by `source.sha256`, since it
  holds the path it passed in.
- Ordering: institution, account, booking date, file sha256, locator. Never argv order.
- Changes within `/1` are **additive only**: every merge to `main` ships, so consumers should
  assert the schema string.

## Reconcile status

| Status | Means |
|---|---|
| `structural` | Every raw `<STMTTRN>` parsed, no unknown tags, FITIDs unique, LEDGERBAL present, one currency |
| `asserted` | Structural **and** a balance from `accounts.toml` agrees with the file |
| `proven` | The statement proves itself from printed totals: every row tied to the printed summary or running balance (the PDF adapters) |

`--require asserted` refuses anything weaker.

## Keys are a contract

| Scheme | Used for | Shape |
|---|---|---|
| `fitid` | TD, CIBC, Scotiabank, Tangerine | `Institution\|••1234\|FITID` |
| `content-occurrence/legacy-qfx-v0` | Scotiabank counter FITIDs (`undefined`, `undefined-1`, …) | `Institution\|••1234\|date\|amount\|text\|n` |
| `content-occurrence/legacy-collapse-v0` | Desjardins Visa (PDF) | same, whitespace collapsed, ledger sign |
| `statement-line/1` | Scotiabank closed chequing (PDF); needs `keys.immutable = true` | `Institution\|••1234\|period end\|line n` |

- The two content normalisers are **frozen** copies of the extractors that made keys already
  stored downstream. Three tests pin them:
  - golden vectors produced by running the legacy code itself (`tests/golden/normalisers.json`);
  - a source hash per function (`tests/golden/frozen.json`);
  - the legacy extractors' own keys over every fixture (`tests/golden/legacy-keys.json`).
- Measured on 29 fixture cases (24 QFX, 5 PDF): **identical keys**.
- Measured on the operator's **58 real PDF statements**, locally and counts only: **identical
  key sets** for 24/24 Desjardins (654 keys) and 34/34 Scotiabank chequing (776 keys).
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

## Masking and the leak gate

- Display masking keeps the **last four** of anything account-shaped:
  - long digit runs (TD `TO:`/`FRM:` payees);
  - star-masked payees (Scotiabank);
  - `CC#dddd****dddd` (CIBC card memos);
  - grouped digits, with dates excluded.
- Every output string then passes the leak gate:
  `\d{7,}|\d{4} ?\d{2}\*|\d{4}\*{4,}|\*{2,}\d|•{3,}`.
- The gate skips two kinds of value:
  - **hex digests**: a sha256 has ~90% odds of a 7-digit run by chance;
  - **the institution's own transaction id** (`entry_ref`, and the FITID segment of a
    `fitid` key): numeric FITIDs are routine, and key bytes are frozen.

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
- **Scotiabank closed chequing:** direction comes from the running balance, and every row
  must chain. Detail lines attach by indentation. An accounts-file last4 that disagrees with
  the header is refused (`header_last4`).
- **`chain_across_statements`:** one account's back-to-back statements in a run must hand
  over the balance exactly. "Back to back" means a gap of 1–3 days, because cycles end on
  weekends and holidays (28 real hand-overs measured). The same month delivered twice is
  counted once (`dup_in_run`), and both copies must agree. A broken hand-over refuses the
  **whole run**, even with `--keep-going`, as a key collision does: either file could be
  the wrong one.
- **Not yet exercised:** the Desjardins grammar carries the French labels from the legacy
  extractor, but every real statement measured was English, and no fixture covers French.

## Privacy

- Fixtures are **synthetic only**, one per quirk.
- Every synthetic account or FITID digit run starts `0000`.
- PDF fixtures are synthetic `*.layout.txt` text, written from `fixture shape` output. Shape
  turns digits into `9` and every word outside a fixed lexicon of generic labels into `x`s,
  keeping the columns. Only shapes ever enter an agent's context.
- CI generates PDFs **in-run** from those fixtures (`tests/make_pdf.py`) and reads them back
  through poppler. No PDF is committed.
- `fixture lint` refuses:
  - a 7+ digit run outside that reserved pattern;
  - a case without `synthetic = true`;
  - any PDF or other binary in this tree.
- Real statements never enter this repo. A private corpus is checked consumer-side with
  `corpus check`, which stores hashes and counts only.

## Adding an institution (until the R4 skill lands)

1. QFX: run `identify --print-identifiers` on a real file **locally** and copy its
   ORG/FID/INTU.BID into `adapters/<institution>/<format>.toml`. PDF: run `fixture shape`
   locally and write the grammar from the shape.
2. Write one synthetic fixture per quirk: `<case>.qfx` or `<case>.layout.txt`,
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
