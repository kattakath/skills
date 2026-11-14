# `kattakath-workspace` — Claude Code plugin

Google Workspace in Claude through the **Kattakath MCP Gateway**: a routing skill
(`kattakath-workspace:kattakath-workspace`) for the account's eight **`Kattakath <App>`**
claude.ai connectors — Gmail, Calendar, Drive, Docs, Sheets, Slides, Chat, People. Nothing in
it can send mail: Claude drafts, you press Send.

Install: `/plugin install kattakath-workspace@kattakath`

Served from the `kattakath` marketplace (`github:kattakath/skills`). Delivery and
enablement are documented once, in this repo's `CLAUDE.md` — not restated here.

## What it ships

- **The skill**: which connector and tool to use, the sign-in fallback, and the
  confirm-before-write rules. It matches connectors by **name**, because the tool prefix
  differs by surface (`mcp__Kattakath_Gmail__…` in cloud sessions,
  `mcp__claude_ai_Kattakath_Gmail__…` in local Claude Code).
- **No connector entries** (since 1.2.0). The official Google connectors move to a separate
  plugin, and the Kattakath connectors are never declared here: a plugin entry with the same
  URL as an account connector hides it.

## Requires

The eight `Kattakath <App>` custom connectors on the Claude account (claude.ai → Customize →
Connectors), each at `https://<app>.kattakath.com/mcp/v1` and signed in once. They are
account-level, so they reach claude.ai, the phone and Claude Code alike. The gateway itself is
infrastructure in `kattakath/nix-config` (`infra/gcp/workspace-gateway.nix`), not part of this
plugin.

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
