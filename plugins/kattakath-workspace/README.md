# `kattakath-workspace` — Claude Code plugin

Google Workspace in Claude through **one** connector, **Kattakath Workspace**: a
Cloudflare MCP portal at `https://mcp.kattakath.com/mcp` that holds one server per Google app —
Gmail, Calendar, Drive, Docs, Sheets, Slides, Chat, People, Maps, plus Google's cross-app search (a locator, off by default) — behind one sign-in page. This
plugin ships the routing skill (`kattakath-workspace:kattakath-workspace`) and the connector
entry. Nothing in it can send mail: Claude drafts, you press Send.

Install: `/plugin install kattakath-workspace@kattakath`

Served from the `kattakath` marketplace (`github:kattakath/skills`). Delivery and
enablement are documented once, in this repo's `CLAUDE.md` — not restated here.

## What it ships

- **The skill**: which tool to use (`<app>_<tool>`, e.g. `gmail_search_threads`), the
  sign-in fallback, and the confirm-before-write rules. It matches the connector by **name**,
  because the tool prefix differs by surface (`mcp__Kattakath_Workspace__…` in cloud
  sessions, `mcp__claude_ai_Kattakath_Workspace__…` in local Claude Code).
- **The connector** (since 2.1.0): `.mcp.json` declares `Kattakath Workspace` →
  `https://mcp.kattakath.com/mcp`, so the plugin page lists it and installing the plugin brings
  it. Before 2.1.0 this was not possible (see History): Google's servers have no Dynamic Client
  Registration, but the Cloudflare portal in front of them does, for claude.ai and local
  (loopback) clients. The key is Title Case on purpose: claude.ai shows it as the connector's
  name, and a spaced key is legal for plugins (Anthropic's knowledge-work-plugins use
  `"google calendar"`); only `claude mcp add` restricts names. Where a machine also has the account connector, denying the plugin copy
  (`deniedMcpServers`: `plugin:kattakath-workspace:Kattakath Workspace`) keeps one sign-in.

- **The locator** (since 2.3.0, Claude Code only): `/kattakath-workspace:where <term>` runs
  Google's cross-app search (`workspace_search_corpus`) when the thing could be anywhere.
  Two hooks (`hooks/hooks.json` → `scripts/corpus-locator.js`) wrap it:

  | Hook | Does | Why |
  |---|---|---|
  | PreToolUse `gate` | **Asks** before every call; `KATTAKATH_WORKSPACE_LOCATOR=auto` in settings `env` skips the ask | Off by default, on demand. Measured: a headless (`claude -p`) call does not run, in default or bypass mode; interactive sessions show the prompt |
  | PostToolUse `reduce` | Replaces the result with a locator table (app, title, date, sender/type, link, the tool to open it); drops every Chat body and Gmail snippet | The server ignores `pageSize`: every query returns ~30 hits and ~100k chars, over Claude Code's cap. Measured 96,169 → 12,632 chars |

  Claude Code saves an overflowing result to `~/.claude/projects/…/tool-results/` and hands
  the hook only a pointer, so the reducer reads that file, and **only** from that directory.
  On anything it cannot parse it prints nothing, and the original result passes through.
  claude.ai chat runs no plugin hooks, so there the skill routes to the per-app search tools.
  Tests: `node --test plugins/kattakath-workspace/tests/corpus-locator.test.js`.

## Requires

The **Kattakath Workspace** custom connector on the Claude account (claude.ai → Customize →
Connectors → `https://mcp.kattakath.com/mcp`) for claude.ai chat and Claude Code cloud/phone
sessions; local Claude Code can use this plugin's `.mcp.json` instead. Connect once: the
portal page lists every app with an **Authorize** button (one Google consent each). The
portal is infrastructure in `kattakath/nix-config` (`infra/cloudflare/mcp-portals.nix`; the
per-app tool allowlist is data in `infra/cloudflare/workspace-mcp-apps.nix`). It replaced the
1.x Pomerium gateway and its eight `Kattakath <App>` connectors on 2026-11-14.

## History: why 1.0.1–1.1.0 used empty URLs (measured 2026-11-14)

| Shape tried | Claude Code result |
|---|---|
| URL + `oauth.clientId: "${user_config.…}"` | Google: `401 invalid_client — The OAuth client was not found` (userConfig is not substituted into `oauth`) |
| URL + literal `oauth.clientId` | Consent screen, then `client_secret is missing.` (no plugin field carries a secret) |
| **Bare URL** (1.0.0; the shape of `small-business` and `claude-for-financial-advisors`) | The plugin entry **displaces** the working claude.ai connector of the same URL, then every call fails: `Incompatible auth server: does not support dynamic client registration` |
| **Empty URL** (1.0.1–1.1.0) | Plugin entries read `Not configured`; the claude.ai connectors stay `✔ Connected` and keep working |

Two more facts behind those results:

- **Google's Workspace MCP servers do no dynamic client registration**, so only a
  pre-registered client plus its secret can sign in — which the claude.ai connectors have
  and a plugin cannot carry.
- **A green tick is not a sign-in.** These servers answer `initialize` and `tools/list`
  with HTTP 200 and no token, so `/mcp` can show "✔ N tools" for an entry that fails on
  the first real call.

## No connector exists

Google Keep, and Google Messages (SMS). (Tasks joined on 2026-11-18 through a self-hosted
portal upstream; see the skill's § 5.)
