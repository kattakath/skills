---
name: plaid-pfc
description: Plaid Personal Finance Category (PFC) names, pinned and strictly validated. Use when choosing, checking or explaining a transaction category ("what's the right Plaid category for X", "is this a valid Plaid name", "validate my category rules", "categorise these transactions"), when converting old PFC v1 names to v2, when an LLM must return a category (use the JSON Schema so it can only emit a valid name), or when refreshing the pin from Plaid's CSV.
---

# plaid-pfc — Plaid's spending categories, pinned and enforced

## What and when

- **What:** Plaid's PFC taxonomy (v2) is a de facto standard for budgeting categories:
  18 primary groups and 127 detailed names, e.g. `FOOD_AND_DRINK_COFFEE`.
- **What this skill gives you:** the list pinned as data, plus a CLI that **refuses** any name
  not on it.
- **When:** use it whenever a category is chosen, written to a rules or decisions file, or
  returned by a model.

```bash
PFC="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.claude/plugins/installed_plugins.json")))["plugins"]["plaid-pfc@kattakath"][0]["installPath"])')/scripts/pfc"
```

## Steps

1. **Check a candidate before writing it anywhere:**
   `"$PFC" validate NAME [NAME ...]`. Exit 0 means every name is PFC v2. **Exit 3 lists the
   unknown ones**, with the v2 name when the input is a v1 name.
2. **Validate a whole file:** `"$PFC" validate --csv rules.csv --column category`. The
   column is given by header name or 0-based index.
3. **Read Plaid's definition before choosing between two close names:**
   `"$PFC" describe GENERAL_SERVICES_OTHER_GENERAL_SERVICES`.
4. **Browse a group:** `"$PFC" list --primary FOOD_AND_DRINK`.
5. **Ask a model for a category with the schema, never free text:**
   - `"$PFC" schema suggestion` gives JSON Schema whose `category` is an enum of the pinned
     names, so structured output cannot invent one;
   - still run `validate` on what comes back.
6. **Old v1 names:** `"$PFC" crosswalk NAME`.
   - `renamed` maps one to one, so apply it;
   - `split` means one v1 name became several v2 names, so **list it for the operator**;
     never pick one silently.

## Suggest from the consumer's own history (phase 3)

1. **Export labelled history.** For a Beancount ledger, run `beancount-kit history` (same
   inputs as `build`, `--out FILE`). It writes one row per transaction: `key`, `payee`, `memo`,
   `category`, `source` (decision | rule | none), `ref` and `note`.
   - **It contains row text:** keep it in the consumer's data folder, never in a repository.
2. **Suggest:** `"$PFC" suggest --history H.jsonl --input T.jsonl` emits `Suggestion` JSONL for
   rows whose merchant key (`"$PFC" merchant PAYEE`) has history.
   - **Weights:** decision 2, rule 1, provisional 0.5 (a note matching `--provisional`,
     default `\bauto\b`).
   - **Confidence** is the top category's share of the weight.
3. **Measure before trusting:** `"$PFC" eval --history H.jsonl` prints coverage and precision
   at each confidence threshold, as counts only.
   - **seen:** 20% of rows held out;
   - **unseen:** 20% of merchants held out, every row of each;
   - **provisional labels are never scored**;
   - `--show` lists misses, with row text: never paste that output anywhere public.

**Exact match cannot know a new merchant.** `unseen` coverage is 0% by design.

- **`--fuzzy` (on `suggest` and `eval`)** falls back to trigram similarity on the payee text.
- **Measured 2026-11-01:** about 56% of unseen-merchant rows get a suggestion at ≥ 0.5, at about
  83% precision.
- **Use fuzzy suggestions for review only, never auto-accept.** Rows a human had to decide stay
  hard (about 9% coverage at 60%).

## Updating the pin (deliberate, never automatic)

1. `"$PFC" refresh` fetches Plaid's CSV and prints the diff (added, removed, redescribed)
   against the pin. It writes nothing.
2. **Removed names refuse (exit 3).** Add their crosswalk first, then rerun with
   `--accept-removals --write`.
3. Commit `data/` in one release. The pin records the source URL, the fetch date and the
   CSV's sha256.

## Rules

- **`NEEDS_REVIEW` is the only non-Plaid value accepted:** it means "not yet decided".
- **No consumer data lives in this plugin:** no rules, decisions or overrides. A consumer's
  mapping of a name to a ledger account belongs in the consumer's own config.
- **Measured 2026-11-01:**
  - v2 is **not** a pure superset of v1: `INCOME_WAGES`, `INCOME_OTHER_INCOME` and
    `TRANSFER_IN_CASH_ADVANCES_AND_LOANS` were renamed;
  - Plaid's CSV leaves `OTHER_OTHER` without a description.

## References

- Plaid taxonomy CSV: https://plaid.com/documents/pfc-taxonomy-all.csv
- Design and later phases (suggest, evidence adapters, eval): `docs/plaid-pfc-design.md` in
  this repository.
