---
name: adapter
description: >
  This skill should be used when statement-extract cannot read a statement and an adapter has
  to be added or repaired — "add support for {bank}", "statement-extract refuses this file",
  "exit 4 no adapter identifies this file", "this bank changed its PDF layout", "write an
  adapter", "the summary check fails on a new statement", or when the extract skill hands over
  a refusal. It covers identify → shape → synthetic fixture → TOML (a hook only if needed) →
  named repairs → golden cases → run.sh → PR, under the key-freeze rule and the privacy
  boundary.
---

# Add or repair an adapter

**An adapter is data first:** `adapters/<institution>/<format>.toml`, plus a Python hook only
when TOML genuinely can't express the layout. The engine owns everything else: masking, keys,
dedupe, the leak gate, ordering and output. So an adapter can't weaken any of them.

## Two hard rules

1. **The privacy boundary.** Real statement text reaches you ONLY through
   `statement-extract fixture shape FILE` (digits → 9, non-label words → x) and
   `identify --print-identifiers` (bank ids, never the account).
   - Never `cat` a statement, run `pdftotext` to the terminal, or print a real value.
   - Real-file verification prints counts, statuses and check names; stderr is figure-free.
   - Fixtures are **synthetic**: every 7+ digit run starts `0000`, names like ALEX SAMPLE.
   - The commit guard and `fixture lint` enforce this; don't fight them.
2. **The key-freeze rule.** Stored keys must never change bytes, or every downstream row is
   duplicated.
   - Never edit a normaliser in `keys.py` (golden vectors + a source hash pin them).
   - Never change an existing adapter's key scheme or the fields it feeds the key (date
     basis, amount sign, description text) without a new scheme name and a consumer
     migration.
   - When repairing an adapter, re-run every real file it already handled and prove the key
     sets are **identical** (counts only).

## Procedure

1. **Reproduce.** Run `identify FILE`, then `extract FILE --report r.json`. Read the refusal or
   the failed check. Run `explain FILE` for adapters, repairs and checks.
2. **Shape.** Run `fixture shape FILE` on the oldest and the newest statement of that product,
   to see layout drift.
3. **Pick the lane:**
   - **QFX/OFX:** identify by `ORG`/`FID`/`INTU.BID` from `identify --print-identifiers`. A
     non-spec export gets a **named repair** in `repairs/ofx.py`. Each repair is idempotent and
     carries 3 tests: before→after, twice = once, clean unchanged.
   - **CSV:** declarative `[csv]` TOML (columns, drop list, order, currency source). Drop any
     column holding other people's account numbers by name.
   - **PDF:** `[identify] text` regexes plus `[grammar]` regexes, and a hook `parse_lines`
     whose docstring starts `Why not TOML:`. Reuse `pdfkit`: amounts, months, `infer_year`,
     `columns`/`nearest_column`, `running_chain`. A sibling with the same layout shares a hook
     via `hook = "x.py"`.
4. **Key scheme.** Prefer the institution's own id (`fitid`, `native-id-ts/1`). A PDF with
   none uses `content-occurrence/1`. A closed account may use `statement-line/1` with
   `immutable = true`. Never borrow another format's keys.
5. **Checks.** Tie every printed figure you can: balance equation, running chain, section and
   summary totals. Set `minimum = "proven"` and `proves = true` only if every row is tied.
6. **Synthetic fixtures**, one per quirk: `<case>.{qfx,csv,layout.txt}` + `<case>.case.toml`
   (`synthetic = true`, `quirk`, `exit`, optional `stderr_has`, `args`, `pdf_smoke`).
   - Include at least one refusal case per check you rely on.
   - Generate goldens from `tests/`: `STATEMENT_EXTRACT_UPDATE_GOLDENS=1 python3 -m unittest test_fixtures`. Read them.
7. **Verify on real files, counts only.** Exit codes, statuses and rows. `identify` must give
   exactly one claimant per file. Where another format covers the same period, cross-check
   (date, amount) multisets.
8. **Gates:**
   - `bash tests/run.sh`, plus `--pdf-smoke` for PDFs;
   - `python3 scripts/build-index.py --check`;
   - the pinned `plugin validate` commands in the repo's CLAUDE.md.
   Then branch → PR.

The `adapter-author` agent runs steps 2–8 in an isolated worktree when the work should happen
out of the main conversation.

## References
- `references/contract.md`: the adapter surface, TOML keys, hook rules, exit codes.
- `references/schema.md`: the JSONL records and every field.
- `references/quirks.md`: the layout traps already met, and where each is handled.
- `references/fixtures.md`: fixture rules, lint, goldens, the PDF smoke.
