# stripe-infin8

A second Stripe MCP server, signed in to the **Infin8 IT** Stripe login, next to the official
`stripe` plugin signed in to another one.

## Why a second plugin works

Same mechanism as [`slack-infin8`](../slack-infin8/README.md): Claude Code stores an MCP
server's OAuth sign-in under the **server name plus a hash of its config**, so
`plugin:stripe-infin8:stripe` and `plugin:stripe:stripe` keep separate tokens.

**The URL must differ from the official plugin's**, or Claude Code drops this server as a
duplicate. It carries a query string Stripe ignores, `?workspace=infin8-it`. Measured
2026-10-16: an unauthenticated `initialize` to `https://mcp.stripe.com` and to
`https://mcp.stripe.com/?workspace=infin8-it` both return `401` with the same
`resource_metadata` (`https://mcp.stripe.com/.well-known/oauth-protected-resource`).
Keep that exact URL: changing it discards the sign-in.

## Sign in

1. Start Claude Code in any folder, run `/mcp`, pick `plugin:stripe-infin8:stripe`, **Authenticate**.
2. In the browser, sign in to the Infin8 IT Stripe login and choose the account.

## Install

```
/plugin install stripe-infin8@kattakath
```
