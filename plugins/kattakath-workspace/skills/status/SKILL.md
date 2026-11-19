---
description: "Show which Kattakath Workspace apps are missing tools, and where to authorize them. Run only when the user types /kattakath-workspace:status."
disable-model-invocation: true
---

Report which apps of the **Kattakath Workspace** connector are missing, and how to fix it.

1. Call `portal_list_servers` (any surface prefix; match by the connector name).
2. Read the expected set:
   `${CLAUDE_PLUGIN_ROOT}/skills/kattakath-workspace/references/allowlist.json`
   (generated; `apps.<app>` lists that app's tools).
   - If the path does not resolve (claude.ai chat), report the `portal_list_servers` result
     only, and say the expected set needs Claude Code.
3. List the **missing apps**: an app in `allowlist.json` with no `<app>_` tool visible in
   this session. Do not build a full live/enabled table; `/mcp` already shows live state.
4. For each missing app, point the user to:
   - `/mcp` → Kattakath Workspace (or claude.ai → Connectors) → reconnect;
   - the portal page that opens, then **Authorize** for that app.
   - Add: a tool can be listed before the portal applies it, so a just-changed allowlist may
     show as missing for a while.
5. Do not retry, and do not toggle servers yourself (`portal_toggle_single_server` is C9).
