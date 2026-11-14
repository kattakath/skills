# `kattakath-workspace` — Claude Code plugin

One install for Google Workspace: Google's own hosted MCP servers for **Gmail, Calendar,
Drive, Docs, Sheets and Slides**, plus a routing skill (`kattakath-workspace:kattakath-workspace`).

Install: `/plugin install kattakath-workspace@kattakath`

Served from the `kattakath` marketplace (`github:kattakath/skills`). Delivery and
enablement are documented once, in this repo's `CLAUDE.md` — not restated here.

## What it bundles

| Server | URL |
|---|---|
| `gmail` | `https://gmailmcp.googleapis.com/mcp/v1` |
| `google-calendar` | `https://calendarmcp.googleapis.com/mcp/v1` |
| `google-drive` | `https://drivemcp.googleapis.com/mcp/v1` |
| `google-docs` | `https://docsmcp.googleapis.com/mcp/v1` |
| `google-sheets` | `https://sheetsmcp.googleapis.com/mcp/v1` |
| `google-slides` | `https://slidesmcp.googleapis.com/mcp/v1` |

These are the endpoints the official claude.ai Google connectors call (read from
`claude mcp list` on an account with all six connected, 2026-11-14).

## Why bare URLs, with no `oauth` block

Measured 2026-11-14, so nobody has to repeat it:

- **Google's servers do no dynamic client registration.** Signing in needs a pre-registered
  OAuth client **and its secret**. A plugin can carry neither: `${user_config.*}` is not
  substituted into `oauth.clientId` (Google answered `401 invalid_client: The OAuth client
  was not found`), and there is no plugin field for a secret (a literal client ID got as
  far as consent, then Claude Code reported `client_secret is missing.`).
- **A bare URL reuses the connector the account already has.** This is the shape
  Anthropic's own plugins use for the same servers
  (`anthropics/knowledge-work-plugins` → `small-business/.mcp.json`;
  `anthropics/claude-for-financial-advisors` → `.mcp.json`). No client ID is published, so
  nothing per-person lands in this public repo.
- **Claude Code de-duplicates by URL.** A plugin entry and a claude.ai connector with the
  same URL are listed once, and which line it keeps can vary per server. The skill's
  "needs you to sign in" section covers the case where the kept entry is not signed in.
- **A green tick is not a sign-in.** These servers answer `initialize` and `tools/list`
  with HTTP 200 and no token, so `/mcp` shows "✔ N tools" before anyone has signed in.
  Sign-in is demanded on the first real tool call.

## Requires

- The matching Google connectors connected on the Claude account (claude.ai → Settings →
  Connectors, or the plugin's Connectors tab), or a Claude Code sign-in via `/mcp`.

## Not bundled

Google Chat, Contacts, Tasks and Keep.
