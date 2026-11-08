---
name: runbook-reparse
description: A selector broke or a new field is needed — re-extract OFFLINE from the saved snapshots with `<cli> reparse` instead of re-fetching. Use when parsed listings miss a field, a parser changed, or someone proposes re-crawling to pick up new data.
---

# Selector broke → fix the parser → reparse offline (zero requests)

Every fetched ad page is kept as a gzipped snapshot (`DATA/raw/<site>/<id>/<time>.html.gz`,
recorded in `listing.v1.raw_ref` with its sha256). So a parser fix never needs the network.

1. Reproduce on a SYNTHETIC fixture in `tests/fixtures/` (never paste a real page into the repo).
2. Fix the Source's `parse_ad` and **bump its `parser` version tag** (e.g. `@1` -> `@2`).
3. Prove it: the Source's tests, then the full suite (`nix flake check`).
4. `<cli> reparse --site <site>`: appends a new version per changed ad with
   `fetch_reason = "reparse"` and `derived.method = <parser tag>`; an unchanged one appends nothing.
   A snapshot whose sha256 no longer matches is refused, never parsed.
5. Report: versions appended, ads unchanged, snapshots refused — from the command's JSON output.

Never re-fetch to pick up a new field: each ad-page GET is a counted view on a real page.
