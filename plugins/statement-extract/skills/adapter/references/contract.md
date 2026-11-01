# Adapter contract

## The surface
- An adapter **identifies** a file and **extracts** raw drafts (statements, and for loans
  positions), each with its **checks**.
- The engine owns masking, keys, dedupe, the leak gate, the reconcile gate, ordering and output.
- Files: `adapters/<institution>/<name>.toml`, plus optionally `<name>.py` (or a shared
  `hook = "<sibling>.py"`), plus `adapters/<institution>/fixtures/`.
- Adapter id = `<institution dir>/<name>`. Its sha256 covers the TOML and the hook bytes.

## TOML top-level keys (anything else is refused at load)
| Key | Meaning |
|---|---|
| `institution` | Key prefix, **frozen**: it is inside every stored key (`TD`, `CIBC`, `Scotiabank`, `Tangerine`, `Desjardins`, `BMO`, `Wise`, `NSLSC`) |
| `format` | `ofx`, `pdftext` or `csv` |
| `description` | One line, shown by `adapters` |
| `identify` | Per format: `ofx` uses `org`/`fid`/`intu_bid` lists (every listed field must match); `pdftext` uses `text` regexes (all must match); `csv` uses `header` columns + `filename` regexes |
| `repairs` | OFX only: named repairs from `repairs/ofx.py`, applied in registry order |
| `keys` | `scheme`, optional `fallback` (`fitid_pattern` → scheme), `immutable` (required for `statement-line/1`) |
| `account` | `require_override` (accounts file must give `last4`), `verify_last4` (refuse an override that disagrees with the header), `ref = "currency"` (Wise) |
| `reconcile` | `minimum` (`structural`/`asserted`/`proven`), `proves` (status is `proven` when every check passes) |
| `skip` | rows to drop before keying, e.g. `{amount = "0", name_prefix = "Posted :"}` |
| `sign` | `flip = true` to invert a non-holder-view export |
| `grammar` | regexes a PDF hook reads (`{AMT}`-style placeholders are the hook's business) |
| `csv` | the declarative CSV grammar: `encoding`, `drop`, `currency`, `order`, `[csv.columns]`, `[csv.formats]` |
| `hook` | a sibling hook file name to share |
| `position` | `kind = "mortgage"\|"loan"\|"heloc"`: opts the adapter into position records |

**TOML trap:** a key written after a `[table]` header lands inside that table. Top-level keys
go before the first table.

## Hooks
- Only `parse_lines(lines, spec, text)`, `post_drafts`, `extra_checks` may be defined. Helpers
  are prefixed `_`.
- Each hook's docstring must start `Why not TOML:` and say why data could not express it.
- `parse_lines` returns `StatementDraft`s (and `PositionDraft`s for a `[position]` adapter).
  Raise `Refusal(Exit.REFUSED, reason)` for a layout you do not understand. Never guess.
- Signs are **holder view**: + = money in. A card purchase is negative.

## Key schemes (`keys.py`)
| Scheme | When |
|---|---|
| `fitid` | the file has the institution's own id |
| `native-id-ts/1` | an id that repeats for a charge and its refund, plus a precise timestamp (Wise CSV) |
| `statement-line/1` | a closed account whose statements can never be reissued (`immutable = true`) |
| `content-occurrence/1` | everything else (PDFs) |
| `content-occurrence/legacy-qfx-v0`, `legacy-collapse-v0` | frozen copies of the legacy extractors; existing stored keys only |

## Statuses and exit codes
- **Statuses:** `structural` < `asserted` < `proven`. Positions are never `proven`.
- **Exits:**
  - 0 ok
  - 1 bug
  - 2 usage
  - 3 refused (check failed, key or position collision, one source per period, broken chain)
  - 4 unidentified, ambiguous or override missing
  - 5 leak
  - 6 partial (`--keep-going`)
