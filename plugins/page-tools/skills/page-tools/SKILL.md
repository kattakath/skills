---
name: page-tools
description: >-
  Drive the operator's real Chrome through the Kapture MCP extension
  (kapture-mcp@2.6.1 bridge on 127.0.0.1:61822). Use when a task needs the
  connected Kapture tab: list tabs, click, fill, read the DOM, screenshot, or
  run JavaScript. The extension popup must already say Connected. Do not use
  this to author a userscript.
---

# Page tools — Kapture

This plugin's `.mcp.json` starts `npx -y kapture-mcp@2.6.1 bridge`. The bridge
speaks MCP on stdio and reuses whatever is already listening on
`127.0.0.1:61822`. If nothing is listening, the bridge starts the server
itself (detached, or in-process when a detached child cannot bind). Do not
start a second server, and do not add Chrome policy.

## Before any tool call

1. Call `list_tabs`. A connected tab has a `tabId`.
2. An empty `tabs` array means the popup is not Connected. `new_tab` opens
   Kapture's own docs page and waits until that page connects. It takes no
   URL. Use `navigate` for the page you actually want.
3. `evaluate` is left out of `tools/list` until some connected tab has Allow JS
   on (`tool-handler.js`). If it is absent, ask for that toggle. Do not call
   `evaluate` to test the gate. When the toggle flips, the server sends
   `notifications/tools/list_changed` — list the tools again.

Spawn-tested 2026-11-18 against a tab that was Connected with Allow JS on:
`initialize` returned server `kapture-mcp` 2.6.1, `list_tabs` returned that
tab with `evalAllowed: true`, and `evaluate` was one of the 32 tools.

## How to act

Prefer the purpose-built tool: `click`, `fill`, `select`, `type`, `dom`,
`elements`, `screenshot`, `navigate`. Pass the `tabId` from `list_tabs`.

`getUniqueSelector` in extension 1.2.1 (`page-helpers.js`) writes
`id="kapture-N"` when the element has no id, and otherwise adds the class
`kapture-N`. That selector is real for this DOM and gone on reload. Use it
for the next action in this tab. Never copy it into a userscript.

`:contains()` is rejected. Pass the tool's `xpath` argument instead.

`compose` runs several actions on one tab. Its last line may be a read
(`screenshot`, `dom`, `elements`, `elementsFromPoint`, `console_logs`,
`watch_console`). `evaluate` is not allowed inside `compose`.

## Exposure

The listener is loopback only. A request with no `Origin` is allowed on the
HTTP and WebSocket control plane (`origin-policy.js` in `kapture-mcp@2.6.1`);
that is how the bridge connects. The extension origin is accepted only on the
root WebSocket. `/assistants` writes require a localhost browser Origin, so a
caller with no Origin cannot use them.

Do not navigate to `chrome://` or an extension page. Do not type a secret.
Do not close a tab the operator did not name.
