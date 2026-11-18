# page-tools

Drive a Chrome tab that is already connected to the Kapture extension. The
method is the `page-tools` skill. The MCP server is this plugin's `.mcp.json`.

## What it ships

| Piece | Role |
|---|---|
| `.mcp.json` server `kapture` | `npx -y kapture-mcp@2.6.1 bridge` — stdio MCP, reuses `127.0.0.1:61822` |
| `skills/page-tools` | When to call `list_tabs`, when `evaluate` is hidden, what not to copy out |

## Requires

- `npx` on `PATH`. The spec is pinned to `kapture-mcp@2.6.1` (MIT, William Kapke, `github.com/williamkapke/kapture`).
- The Kapture extension, popup reading **Connected**. Allow JS must be on or `evaluate` is omitted from `tools/list`.
- A fresh session after the plugin is installed. A session already running does not gain the server.

The bridge binds `127.0.0.1:61822` when nothing else has it. A request with no `Origin` can reach that control plane. That is the loopback trust the bridge itself uses.

## Install

```
/plugin install page-tools@kattakath
```
