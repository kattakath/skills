# `kattakath-workspace` — Claude Code plugin

Google Workspace in Claude through **one** connector, **Kattakath Workspace**: a Cloudflare
MCP portal at `https://mcp.kattakath.com/mcp` that holds one server per Google app behind one
sign-in page. The app list lives in `.claude-plugin/plugin.json`'s description; the tool list
is generated (below). Nothing in this plugin can send mail: Claude drafts, you press Send.

Install: `/plugin install kattakath-workspace@kattakath`

Served from the `kattakath` marketplace (`github:kattakath/skills`). Delivery and enablement
are documented once, in this repo's `CLAUDE.md`.

## What it ships

| Part | Path | Does |
|---|---|---|
| Router skill | `skills/kattakath-workspace/` | Policy, the confirm table, intent → tool, what is refused. Detail in `references/` |
| Tool list | `skills/kattakath-workspace/references/allowlist.json` | **GENERATED** from nix-config. Do not edit |
| `/kattakath-workspace:where` | `skills/where/` | User-only: one cross-app search as a locator table |
| `/kattakath-workspace:status` | `skills/status/` | User-only: which apps are missing, and where to Authorize |
| Write guard | `scripts/write-guard.js` | PreToolUse `ask` for the risky writes C1–C10 (the router's confirm table) |
| Locator | `scripts/corpus-locator.js` | Gates `workspace_search_corpus` and reduces its ~100k-char result to a table |
| Connector | `.mcp.json` | `Kattakath Workspace` → `https://mcp.kattakath.com/mcp` |

## The write guard

- **Why a hook:** a settings-file `mcp__…` permission rule matches a tool name, never its
  arguments, so it cannot tell a task "complete" from a task "delete".
- **Matcher:** `^mcp__.+__<bare name>$` for the 16 guarded tools, so every surface prefix
  matches. Every call counts as this connector's, and the rule decides, unless the bare name
  is one another known server also exposes (today only `drive_create_file` / `drive_copy_file`)
  AND `mcp_server.name` positively names that server (Google Drive) → silent. A missing field
  (builds before 2.1.274) or an unrecognised label asks.
- **Fails closed:** unreadable input, a missing or unknown `action`, unparseable arguments,
  or a tool with no rule → `ask`. It never emits `allow`, and always exits 0.
- **`onFailure: "block"`** is defence in depth only (needs 2.1.295+). `engines` says
  `>=2.1.295` but is enforced only from 2.1.323, so it is advisory.
- **Depends on managed settings.** Without them, a non-organization mod's approval can skip a
  hook prompt (nix-config `modules/darwin/claude-managed-settings.nix`).
- **Exempt writes**, each with its reason, are `EXEMPT_WRITES` in the script.

## The locator

- **Gate:** the `locator_mode` setting (`/config`): `ask` (default), `auto` (silent) or `off`
  (refuse). It replaces 2.x's `KATTAKATH_WORKSPACE_LOCATOR` env var.
- **Reducer:** writes `updatedToolOutput`. Rows are grouped per app and open tool, bodies and
  snippets are dropped, and the table is capped at 10,000 chars (a token-budget choice).
  Measured on 2.x: 96,169 → 12,632 chars.
- **Fails open:** on anything it cannot parse, the raw result passes through and a
  `systemMessage` says why.

## Enforcement by surface

| Surface | Allowlist | Skill | Hooks (guard + locator) | `locator_mode` |
|---|---|---|---|---|
| Claude Code CLI / Desktop Code tab | yes | yes | yes | `/config` |
| Cowork | yes | yes | yes | fixed at `ask` |
| claude.ai chat / phone | yes | if the plugin is enabled on the account | **no** | — |
| Cloud sessions / routines | yes | per spike S5 | **no** | — |
| Headless `-p`, scheduled | yes | yes | guarded writes **refused** | — |
| Org per-tool ask (if S9 passes) | applies everywhere except Desktop local/SSH sessions | | | |

- **Only the portal allowlist holds on every surface.** Every rule is also in the skill text.
- **Bypass mode (spike S1).** 3.0.0 ships the branch where a hook `ask` prompts under
  bypassPermissions. If S1 shows it does not, nix-config adds name-only `permissions.ask`
  entries, **only for the high-risk tools** (C3, C5, C7, C9). The others then rely on the
  skill text in bypass.
- **Later step (D4):** set claude.ai per-tool "ask" on the C1–C10 tools for chat and phone,
  once S9 shows the account can.

## Regenerating the tool list

```bash
plugins/kattakath-workspace/scripts/gen-allowlist.sh <nix-config checkout>          # rewrite
plugins/kattakath-workspace/scripts/gen-allowlist.sh <nix-config checkout> --check  # drift?
```

It runs `nix eval --json --file infra/cloudflare/workspace-mcp-apps.nix` and keeps
`apps.<app>.tools`. Order of a change: regenerate and push here, then in ONE nix-config
commit change the apps file and bump the `kattakath-skills` pin, then `cf-mcp-portals-apply`.

## Tests

```bash
node --test plugins/kattakath-workspace/tests/*.test.js
```

- `write-guard.test.js`: a positive and a negative case per rule, plus every fail-closed path.
- `corpus-locator.test.js`: gate modes, prefixes, the mimeType open map, the 10k cap.
- `consistency.test.js`: allowlist ↔ skills ↔ RULES ↔ hooks.json ↔ descriptions.
- **Evals** (`evals/`, 10 cases, mocks in `evals/mocks/Kattakath_Workspace/`) run locally
  before a release, not in CI: `claude plugin eval plugins/kattakath-workspace`. A machine
  whose managed `deniedMcpServers` lists `plugin:kattakath-workspace:Kattakath Workspace`
  blocks the mock stand-in, so the run needs that entry lifted for the eval.
- **Fixtures are not live captures.** `tests/fixtures/tools-list/` holds annotations read from
  the pinned workspace-mcp 2.5.0 source (self-hosted apps only). `tests/fixtures/tool-inputs/`
  is schema-derived. Re-capture both when the Cloud Run image is bumped.

## Requires

The **Kattakath Workspace** custom connector on the Claude account for chat and cloud
sessions; local Claude Code can use this plugin's `.mcp.json`. Connect once, then press
**Authorize** per app on the portal page. The portal is infrastructure in
`kattakath/nix-config` (`infra/cloudflare/mcp-portals.nix`).

## History

- **3.0.0:** write guard; `/where` and `/status` as user-only skills (commands/ removed);
  `locator_mode` setting replaces the env var; generated allowlist.
- **2.1.0:** the plugin declares the connector. 1.x used empty URLs because Google's servers
  do no dynamic client registration, and a bare URL displaced the claude.ai connector. The
  Cloudflare portal in front of them does DCR.
- **A green tick is not a sign-in.** These servers answer `initialize` and `tools/list` with
  no token, so `/mcp` can show tools for an entry that fails on the first real call.
