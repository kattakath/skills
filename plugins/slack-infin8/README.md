# slack-infin8

A second Slack MCP server, signed in to the **Infin8 IT** workspace (`infin8-it.slack.com`),
next to the official `slack` plugin signed in to another workspace.

## Why a second plugin works

Claude Code stores an MCP server's OAuth sign-in under the **server's name plus a hash of its
config**, not under its URL. Read at the source (Claude Code 2.1.295, the function that builds
the `mcpOAuth` key):

```js
function zl(e, n) {
  let r = _({ type: n.type, url: n.url, headers: n.headers || {} }),
      s = FL("sha256").update(r).digest("hex").substring(0, 16);
  return `${e}|${s}`;
}
```

This plugin's server is `plugin:slack-infin8:slack`, the official one `plugin:slack:slack`, so
they keep separate tokens. Both use the same OAuth client (`clientId` and `callbackPort` copied
from the official plugin's `.mcp.json`).

**The URL must differ from the official plugin's.** Claude Code drops a plugin MCP server whose
config duplicates an earlier plugin's (2.1.295: `Suppressing plugin MCP server "…": duplicates
earlier plugin server "…"`). With the identical `https://mcp.slack.com/mcp`, `slack-infin8` never
appeared in `/mcp` or `claude mcp list`. So the URL carries a query string Slack ignores,
`?workspace=infin8-it`; with it, `claude mcp list` shows `plugin:slack-infin8:slack … Needs
authentication`. Keep that exact URL: the sign-in is stored under the server name plus a hash of
its config, so changing the URL discards it.

## Install

```
/plugin install slack-infin8 --marketplace kattakath/skills
/plugin install slack-infin8@kattakath
```

## Sign in

1. Start Claude Code in any folder, run `/mcp`, pick `plugin:slack-infin8:slack` and
   **Authenticate**.
2. In the browser, choose **infin8-it.slack.com** (top-right workspace switcher on Slack's
   consent page) and approve.
3. Check: `slack_read_user_profile` from this plugin shows the Infin8 IT organization.

Both servers use callback port 3118, so sign in to one at a time.

## Tools

Same tools as the official plugin, under the prefix `mcp__plugin_slack-infin8_slack__`.
Which folder may use which workspace is enforced outside this repo, by a PreToolUse hook in
the operator's nix-config.

## Posting without the footer: the `post` server

Slack's hosted server appends `*Sent using* <@…|Claude>` to every message it posts. The second
server here, `post`, runs [korotovsky/slack-mcp-server](https://github.com/korotovsky/slack-mcp-server)
with the operator's own user token (`xoxp`), so posts carry no footer. Its binary,
`nix-mcp-slack-infin8`, comes from the operator's nix-config, which reads the token from the
login Keychain (service `mcp:infin8-it.slack.com:xoxp`). Tools are prefixed
`mcp__plugin_slack-infin8_post__`; posting is `conversations_add_message`.
