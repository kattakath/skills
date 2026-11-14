# `kattakath-workspace` — Claude Code plugin

Google Workspace in Claude through **one** claude.ai connector, **Kattakath Workspace**: a
Cloudflare MCP portal at `https://mcp.kattakath.com/mcp` that holds one server per Google app —
Gmail, Calendar, Drive, Docs, Sheets, Slides, Chat, People — behind one sign-in page. This
plugin ships the routing skill (`kattakath-workspace:kattakath-workspace`). Nothing in it can
send mail: Claude drafts, you press Send.

Install: `/plugin install kattakath-workspace@kattakath`

Served from the `kattakath` marketplace (`github:kattakath/skills`). Delivery and
enablement are documented once, in this repo's `CLAUDE.md` — not restated here.

## What it ships

- **The skill**: which tool to use (`<app>_<tool>`, e.g. `gmail_search_threads`), the
  sign-in fallback, and the confirm-before-write rules. It matches the connector by **name**,
  because the tool prefix differs by surface (`mcp__Kattakath_Workspace__…` in cloud
  sessions, `mcp__claude_ai_Kattakath_Workspace__…` in local Claude Code).
- **No connector entries.** A plugin entry with the same URL as an account connector hides
  it (see History).

## Requires

The **Kattakath Workspace** custom connector on the Claude account (claude.ai → Customize →
Connectors → `https://mcp.kattakath.com/mcp`), connected once: the portal page lists every
app with an **Authorize** button (one Google consent each). It is account-level, so it reaches
claude.ai, the phone and Claude Code alike. The portal is infrastructure in
`kattakath/nix-config` (`infra/cloudflare/mcp-portals.nix`), including the per-app tool
allowlist; it replaced the 1.x Pomerium gateway and its eight `Kattakath <App>` connectors on
2026-11-14.

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

Google Tasks, Keep, and Google Messages (SMS).
