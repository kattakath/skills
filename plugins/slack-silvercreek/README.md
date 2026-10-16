# slack-silvercreek

Posts to the **Silver Creek Insights** Slack workspace (`silvercreekinsights.slack.com`) as
the operator, using their own **user token** (`xoxp`). Reads, search and canvases stay on the
official `slack` plugin.

## Why not the official plugin

Slack's hosted MCP (`mcp.slack.com`) appends `*Sent using* <@…|Claude>` to every message it
posts, with no opt-out (slackapi/slack-skills-plugin#25). This server
([korotovsky/slack-mcp-server](https://github.com/korotovsky/slack-mcp-server), MIT) calls
`chat.postMessage` with the user token and adds nothing to the text.

## What it needs

- The binary `nix-mcp-slack-silvercreek` on PATH. The operator's nix-config builds it
  (`local.pluginMcp.servers`, `packages/slack-mcp-server.nix`) and reads the token from the
  login Keychain at launch, service `mcp:silvercreekinsights.slack.com:xoxp`.
- A Slack app installed to the workspace with the **user** scopes from upstream's
  [manifest](https://github.com/korotovsky/slack-mcp-server/blob/master/docs/01-authentication-setup.md).

## Tools

All upstream tools, under `mcp__plugin_slack-silvercreek_post__`. Posting
(`conversations_add_message`) is enabled for every channel. The operator's PreToolUse hook
denies this plugin under the Infin8 IT folder.
