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
