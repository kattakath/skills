# Fixtures

## Rules (enforced by `fixture lint`)
- Inputs live only in `adapters/<institution>/fixtures/` as `<case>.qfx`, `<case>.ofx`,
  `<case>.csv` or `<case>.layout.txt`.
- **No PDF, XLSX or other binary anywhere in the plugin.** A PDF fixture is the text layer,
  written by hand from `fixture shape` output.
- Each input has `<case>.case.toml` with `synthetic = true`, a `quirk` line, and `exit`.
  Optional: `stderr_has`, `args`, `pdf_smoke = true`.
- Each input has `<case>.expected.jsonl`, the golden. It is generated, never hand-written.
- Optional companions: `<case>.accounts.toml` and `<case>.seen.txt`.
- **No 7+ digit run** except the reserved synthetic pattern, a run starting `0000`. OFX
  `<DT…>` values are exempt.
- A CSV fixture may never fill a "Payee Account Number" column.

## Goldens
- From `tests/`: `STATEMENT_EXTRACT_UPDATE_GOLDENS=1 python3 -m unittest test_fixtures`, then
  review the diff. A golden that moves without a reason is the bug.
- The engine hash is normalised in goldens. The adapter sha256 is not, so editing a hook moves
  its own goldens' `source.adapter.sha256` only. Check that nothing else moved.
- Where a legacy extractor exists, its keys over the fixtures are frozen in
  `tests/golden/legacy-keys.json`. The plugin must emit exactly those keys.

## PDF smoke
`bash tests/run.sh --pdf-smoke` writes a Courier PDF from each `pdf_smoke = true` fixture
(`tests/make_pdf.py`), reads it back through poppler, and requires the same records. Mark
geometry-neutral cases only: poppler regroups far-left blocks on a generated page.

## The gate
`bash tests/run.sh` runs these, and fails if any fails:
- compile;
- count floors (raise them when you add adapters or cases);
- unit and golden tests;
- `fixture lint`;
- the commit-guard cases.
