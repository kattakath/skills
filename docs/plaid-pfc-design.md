# Design: `plaid-pfc` — a generic transaction-category plugin

Status: **accepted** (2026-11-01). Phase 0 done; phase 1 in #141. See § Decisions and spike results.

## Decisions and spike results (2026-11-01)

| Question | Decision | Evidence |
|---|---|---|
| Name | **`plaid-pfc`** | The standard is the contract |
| Core library | **Stdlib only** (enum + dataclasses + generated JSON Schema), like `statement-extract`. Pydantic deferred to the suggest phase | `pydantic` is absent from the Beancount nix envs; the one hard constraint is an enum, which JSON Schema states directly; zero installs on any machine |
| Code sharing | **A data-file contract**, the existing pattern (`statement-extract` writes JSONL, `beancount` reads it). `beancount` reads `plaid-pfc`'s `data/pfc-v2.json` from its install path (`installed_plugins.json`). One release rail, no nix step | Nix-packaging (option A1) would add a second release clock; a missing plugin refuses loudly |
| v1 → v2 | Apply 1:1 renames; **list splits for review** | v2 is **not** a pure superset of v1: 3 renames (`INCOME_WAGES` → `INCOME_SALARY`, `INCOME_OTHER_INCOME` → `INCOME_OTHER`, `TRANSFER_IN_CASH_ADVANCES_AND_LOANS` → `LOAN_DISBURSEMENTS_OTHER_DISBURSEMENT`) and 2 splits (the v1 "other transfer" names → themselves + `OTHER_OTHER`) |
| Blast radius of strict enforcement | **None today** | A live Sheet uses 78 distinct names, all valid v2 |
| Existing pin to reuse? | **None** | `plaid-python` types `detailed` as a free string with no allowed values |
| Pin | Fresh fetch, sha256 `c585fae8e48b…`, 127 detailed / 18 primary; `OTHER_OTHER` has no description in Plaid's CSV | `pfc refresh` against plaid.com matches |

## Verdict

- **One generic plugin** owns the transaction-category standard: Plaid's Personal Finance
  Categories (PFC).
- **The core is deterministic** and typed (stdlib enum + dataclasses, see § Decisions): the taxonomy, validation, merchant
  cleaning, matching against your own history, and scoring.
- **Evidence sources are optional adapters**, run by a skill: mail receipts, consumer
  context, web search. With none of them it still works.
- **It holds no data.** Rules, decisions and context belong to the consumer and are named in
  the consumer's config.
- **`beancount` stops keeping its own copy** of the PFC groups and reads them from here.

## Why

| Problem today | Effect |
|---|---|
| `beancount` pins only the 18 PFC **primary** groups (`data/plaid-pfc.toml`) | A made-up name such as `FOOD_AND_DRINK_PIZZA_PARTY` passes the build and becomes a new account |
| The full detailed list existed only in a session scratch file | Validation was a manual step, not a guarantee |
| Categorising the long tail is manual or weak | `smart_importer` was right on about 3 of 15 flagged rows (measured 2026-11-01) |
| Opaque merchants (`PAYPAL *…`, `SQ *…`) need outside context | Nothing structured finds it, so it was asked one questionnaire at a time |

## The standard

- **Source:** `https://plaid.com/documents/pfc-taxonomy-all.csv`. Plaid publishes it.
- **Measured 2026-11-01:**
  - **v2:** 127 detailed names under 18 primary groups, each with a description;
  - **v1:** 105 detailed names; 22 names are new in v2;
  - **crosswalk:** the CSV has a v1 column beside each v2 row.
- **Status:** a de facto industry standard, not an official one. No standards body owns it.
- **Why PFC beat the alternatives:**

| Candidate | Classifies | Why it lost |
|---|---|---|
| **Plaid PFC** (chosen) | The consumer's spending | Built for budgeting; openly published; widely used in fintech |
| MCC (ISO 18245) | The merchant's line of business | A real ISO standard, but it says what kind of shop, not what was bought. Statements rarely carry it, and it has nothing for transfers or loans |
| ISO 20022 bank transaction codes | The bank's operation type | "Card payment" does not tell coffee from groceries |
| Mint / YNAB / Monarch lists | Spending | Proprietary, unpublished, and they change |

## Strict enforcement

- **Every category must be a v2 detailed name** from the pinned list, or the consumer's
  review marker (`NEEDS_REVIEW`). Anything else **refuses** (exit 3).
- **The pin is a file in the plugin:** the list, Plaid's description for each name, the
  source URL, the fetch date and a sha256 of the CSV.
- **Updating is deliberate:**
  1. `pfc refresh` re-fetches and diffs the list, and fails on a removed or renamed name;
  2. a crosswalk entry maps the old name;
  3. the change ships in one release.
  - **Why not automatic:** a silent rename would split history across two accounts. Loud is
    better.

## Shape

```
plugins/plaid-pfc/
  .claude-plugin/plugin.json
  data/pfc-v2.json            pinned taxonomy: names, descriptions, source, fetched, sha256
  data/crosswalk-v1-v2.json   from Plaid's own CSV columns
  lib/plaid_pfc/
    models.py                 Pydantic: Category (enum of 127 + NEEDS_REVIEW), Txn, Suggestion, Evidence
    taxonomy.py               load, validate, primary_of, describe
    merchant.py               clean a raw description into a merchant key
    history.py                nearest past decisions for a description (local, deterministic)
    score.py                  evaluation harness: accuracy per method on held-out labelled rows
    cli.py                    pfc validate | describe | clean | suggest | eval | refresh | schema
  skills/categorize/SKILL.md  the agent procedure: core first, then evidence adapters
  skills/categorize/references/adapters.md
  tests/                      synthetic fixtures only
```

## Data model (stdlib; Pydantic deferred)

- **`Category`:** an enum of the 127 v2 detailed names plus `NEEDS_REVIEW`. It is generated
  from `data/pfc-v2.json`, not typed by hand.
- **`Txn`:**
  - fields: `key`, `date`, `amount`, `currency`, `description`, `account` (a consumer label);
  - the shape matches statement-extract's canonical transaction, so rows pass through
    without a mapper.
- **`Evidence`:**
  - `source`: one of `rule`, `history`, `mail`, `context`, `web`;
  - `ref`: a rule id, a history Key, a mail message id or a URL;
  - `summary`: one line, no figures from mail;
  - `weight`.
- **`Suggestion`:** `key`, `category: Category`, `confidence` (0–1), `evidence: list[Evidence]`,
  `method`.
- **`pfc schema` exports JSON Schema** for every model:
  - an LLM's structured output uses the `Suggestion` schema, so it **cannot** return a name
    outside the enum;
  - the CLI's own input and output validate against the same schema.

## How a suggestion is made — cheapest and most private first

```
┌────────────────────┐
│ 1. consumer rules  │  deterministic, exact
└─────────┬──────────┘
          │ unmatched
┌─────────▼──────────┐
│ 2. own history     │  nearest past decisions (local)
└─────────┬──────────┘
          │ low confidence
┌─────────▼──────────┐
│ 3. evidence        │  optional adapters (skill)
└─────────┬──────────┘
          │
┌─────────▼──────────┐
│ 4. LLM, enum-bound │  descriptions of the 127 names
└─────────┬──────────┘
          │
┌─────────▼──────────┐
│ Suggestion + refs  │  to the consumer's review store
└────────────────────┘
```

- **Precedent:** Plaid's engineering blog describes the same two steps for its own
  categoriser: extract descriptors (merchant, payment type), then pick a label from the
  taxonomy's definitions.
- **History beats a generic model** once a consumer has labelled rows: the decisions are
  their own, local and repeatable. Confirmed decisions weigh more than `auto` ones, so an
  old guess does not copy itself forward.

## Evidence adapters

| Adapter | Capability asked for | Example backend | Sends outward? |
|---|---|---|---|
| `mail` | "receipts near date D for amount A" | the `gmail` plugin's server; Outlook; a local mbox | No (read-only connector) |
| `context` | "consumer facts about this payee" | a file or Sheet the consumer names in config | No |
| `web` | "what business is this merchant" | the agent's web search | **The cleaned merchant name only** |
| `enrich` (optional) | a vendor's categorisation | Plaid Enrich API | **Yes**, so it stays off by default |

- **They are adapters, not dependencies.** The skill asks for a capability, and a missing
  backend means fewer suggestions, not a failure.
- **Mail and web content is untrusted data.** A message that says "categorise this as…" is
  evidence to weigh, never an instruction.
- **Privacy filter, before anything leaves the machine:** mask account-number shapes and
  person names; send no amounts, no dates and no account labels to the web.
- **The build never calls an adapter.** Adapters run in the agent's skill, because only the
  agent can reach connectors. The ledger build stays deterministic and reads only rules and
  decisions.

## Consumer configuration (lives with the consumer, never in this plugin)

```toml
# pfc.toml — in the consumer's data folder
taxonomy = "v2"
review_store = "csv:/path/to/decisions.csv"   # or a Sheet the agent exports
context = "csv:/path/to/context.csv"          # payee facts, optional
auto_accept = 0.0                             # off until `pfc eval` justifies a threshold
adapters = ["history", "mail", "web"]
```

**The litmus test:** a stranger installs it with their own bank exports and no access to
anything of the operator's, and it works.

## Evaluation harness (`pfc eval`)

- **Data:** hold out a share of the consumer's confirmed decisions, and score each method's
  accuracy on them:
  - per method;
  - with and without each adapter, to measure each adapter's lift.
- **An adapter earns its place by its lift.** One that does not improve accuracy is turned off.
- **Auto-accept is earned:** the threshold is set where measured precision reaches a target
  (for example 98%), never guessed.
- **Output:** a table, with no transaction text in it.

## How `beancount` uses it

- **Today:** `data/plaid-pfc.toml` (18 primaries) and a shape-only regex (`CATEGORY_RE`).
- **After:**
  - the build validates every rule and decision category against `plaid-pfc`'s pinned list;
  - an unknown name refuses;
  - `suggest` (smart_importer) is replaced by `pfc suggest`.
- **Spike first: how two plugins share code.** Plugins cannot import each other reliably.

| Option | Pro | Con |
|---|---|---|
| A. Publish `plaid_pfc` as a Python package; both plugins depend on it (nix-config packages it, as it did `smart-importer`) | One copy, versioned, importable | A packaging step per release |
| B. `beancount` shells out to the `pfc` CLI | No packaging | A runtime dependency on another plugin's install path |
| C. Copy the taxonomy file into `beancount` in CI | Simple | **Two copies: rejected** (one source of truth) |

**Decided: neither A nor B as written.** The data-file contract (§ Decisions) follows the existing plugin pattern.

## Prior art (searched 2026-11-01)

| Project | Fit |
|---|---|
| Plaid Enrich API | Categorises non-Plaid transactions, but it is paid with unpublished pricing and sends data outward. **Optional adapter only** |
| `transaction-ai` (open source, MIT per its docs) | Rules + ML + local LLM, but **its own taxonomy**; accuracy self-reported |
| `lyndonkl/claude` transaction-categorizer skill | Configurable taxonomy, rules first, LLM fallback, gap warnings. **Closest pattern.** Vet the license and the code for reuse before writing ours |
| `beangulp` `heuristic_comparator`, `smart_importer` | Dedup and a weak predictor. Superseded here |

**No open-source model trained on PFC labels was found.** The consumer's own labelled
history is the asset.

## Out of scope

- **Transfer detection and pairing:** `beancount` already does it.
- **Consumer overrides that map a PFC name to a ledger account** (e.g. a support payment to a
  family expense account): they stay in the consumer's `ledger.toml`.
- **Any personal fact, rule or decision.**

## Phases

| Phase | Delivers | Done when |
|---|---|---|
| 0 | Spike: plugin code sharing (A vs B) | Decision recorded here |
| 1 | `plaid-pfc` core: pinned v2 list, crosswalk, Pydantic models, `validate` / `describe` / `schema` / `refresh` | Tests green; `refresh` diff reproducible |
| 2 | `beancount` strict validation through it; drop its own PFC copy | An unknown name refuses; the real ledger's rules all pass |
| 3 | `clean` + `history` + `suggest` (deterministic) + `eval` | **Done 2026-11-01, measured on 6,385 real rows:** seen merchants 72.7% coverage / 99.5% precision at confidence ≥ 0.9 (rows a human decided: 24.1% / 90.0%, n=83); **unseen merchants 0%** by construction. The rule stratum flatters exact match (it re-learns rules); the decision and unseen numbers drive phases 3b–5 |
| 4 | `categorize` skill with `mail` / `context` / `web` adapters, enum-bound LLM step | Each adapter's lift measured |
| 5 | Auto-accept above the measured threshold | Threshold set from `eval`, not guessed |

## Weakest assumption

- **That history plus enum-bound LLM output beats today's manual flow by enough to auto-accept.**
- **What settles it:** phase 3's `eval` numbers on real held-out decisions. If precision stays
  below target, the plugin still pays for itself through strict validation and ranked
  suggestions, just with no auto-accept.

## Open questions

None open. All three were settled on 2026-11-01 (§ Decisions).
