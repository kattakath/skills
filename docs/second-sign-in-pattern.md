# A second sign-in to the same hosted MCP server

How to use two accounts of one OAuth-hosted MCP server (two Slack workspaces, two Stripe
logins) from one machine, with no proxy. This repo ships **no** plugin that does it: a
second sign-in is always someone's employer or client, so the plugin belongs in that
person's **private** overlay marketplace (`<your-handle>/skills`), not here. This page is
the pattern only; `<workspace>` and `<plugin>` are placeholders.

## Why it works

Claude Code stores an MCP server's OAuth sign-in under the **server's name plus a hash of
its config**, not under its URL. Read at the source (Claude Code 2.1.295, the function that
builds the `mcpOAuth` key):

```js
function zl(e, n) {
  let r = _({ type: n.type, url: n.url, headers: n.headers || {} }),
      s = FL("sha256").update(r).digest("hex").substring(0, 16);
  return `${e}|${s}`;
}
```

So `plugin:<plugin>:slack` and the official `plugin:slack:slack` keep separate tokens. Copy
the official plugin's `oauth` block (`clientId`, `callbackPort`) unchanged.

## The URL must differ

Claude Code drops a plugin MCP server whose config duplicates an earlier plugin's
(2.1.295: `Suppressing plugin MCP server "…": duplicates earlier plugin server "…"`). With
the identical URL the second server never appears in `/mcp`. Give it a query string the
vendor ignores:

```json
{
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp?workspace=<workspace>",
      "oauth": { "clientId": "<copied from the official plugin>", "callbackPort": 3118 }
    }
  }
}
```

Measured: the bare URL and the `?workspace=` URL return the same `401` challenge, so the
vendor ignores the parameter. It separates the two keys and nothing else: **you still pick
the account on the vendor's consent screen.** A default-port suffix (`:443`) does **not**
work; the docs say it normalises to the same endpoint.

## Keep the URL fixed

The hash covers `type`, `url` and `headers`. Change any of them, or rename the plugin or the
server, and the stored sign-in is orphaned: the server shows **Needs authentication** again.

## Routing between the two

Which account a folder should use is a PreToolUse hook that denies the other plugin's tool
prefix (`mcp__plugin_<plugin>_<server>__`). Ship it in the private plugin's own
`hooks/hooks.json`: plugin hooks fire only while that plugin is enabled, so the routing
leaves with the plugin.

## Limits

- One project enabling the stock plugin still shares the single user-scope credential with
  every other project (anthropics/claude-code#39952, closed not planned).
- Slack's hosted server appends a `Sent using Claude` footer with no opt-out
  (slackapi/slack-skills-plugin#25). Posting as yourself needs a user-token stdio server
  instead, such as korotovsky/slack-mcp-server, one process per workspace.
