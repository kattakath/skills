# `kattakath-workspace` — Claude Code plugin

One install for Google Workspace: the official Google connectors for **Gmail, Calendar,
Drive, Docs, Sheets and Slides**, plus a routing skill (`kattakath-workspace:kattakath-workspace`).

Install: `/plugin install kattakath-workspace@kattakath`

Served from the `kattakath` marketplace (`github:kattakath/skills`). Delivery and
enablement are documented once, in this repo's `CLAUDE.md` — not restated here.

## What it declares

Six connector entries, each with an **empty URL**: `gmail`, `google calendar`,
`google drive`, `google docs`, `google sheets`, `google slides`. This is the exact shape
of Anthropic's own `design` plugin (`anthropics/knowledge-work-plugins` →
`design/.mcp.json`, whose `gmail` and `google calendar` entries are `"url": ""`), which
claude.ai lists as the official Gmail and Google Calendar connectors.

The servers behind those connectors are Google's own (`gmailmcp`, `calendarmcp`,
`drivemcp`, `docsmcp`, `sheetsmcp`, `slidesmcp` `.googleapis.com/mcp/v1`). The sign-in
is the account's existing claude.ai connector; this plugin adds none.

## Why empty URLs — measured 2026-11-14, so nobody repeats it

| Shape tried | Claude Code result |
|---|---|
| URL + `oauth.clientId: "${user_config.…}"` | Google: `401 invalid_client — The OAuth client was not found` (userConfig is not substituted into `oauth`) |
| URL + literal `oauth.clientId` | Consent screen, then `client_secret is missing.` (no plugin field carries a secret) |
| **Bare URL** (1.0.0; the shape of `small-business` and `claude-for-financial-advisors`) | The plugin entry **displaces** the working claude.ai connector of the same URL, then every call fails: `Incompatible auth server: does not support dynamic client registration` |
| **Empty URL** (1.0.1, this) | Plugin entries read `Not configured`; the claude.ai connectors stay `✔ Connected` and keep working |

Two more facts behind those results:

- **Google's Workspace MCP servers do no dynamic client registration**, so only a
  pre-registered client plus its secret can sign in — which the claude.ai connectors have
  and a plugin cannot carry.
- **A green tick is not a sign-in.** These servers answer `initialize` and `tools/list`
  with HTTP 200 and no token, so `/mcp` can show "✔ N tools" for an entry that fails on
  the first real call.

## Requires

The six Google connectors connected on the Claude account (claude.ai → Settings →
Connectors), signed in as the Google account to use. In Claude Code their tools appear as
`mcp__claude_ai_Gmail__*`, `mcp__claude_ai_Google_Drive__*` and so on.

## Not bundled

Google Chat, Contacts, Tasks and Keep.
