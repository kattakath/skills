---
name: page-tools
description: >-
  Pick and drive a browser rail. Use when a task needs a web page driven or
  inspected: in the operator's real, logged-in Chrome through Playwright MCP
  (`playwright` server, Playwright Extension), or in a throwaway headless Chrome
  for Testing through chrome-devtools-mcp (`chrome-devtools` server) for
  debugging, performance traces and Lighthouse, or in a persistent, logged-in
  Chrome for Testing (`cft-profile` server). Covers which rail to use, in what
  order, and what none of them can do. Do not use this to author a userscript.
---

# Page tools — three browser rails

| Server | Browser | Sessions | Use it for |
|---|---|---|---|
| `playwright` → `playwright-chrome-mcp` | The operator's **real Chrome**, via the Playwright Extension | **The operator's own logins** | Acting as the operator: reading, forms, uploads |
| `chrome-devtools` → `chrome-devtools-cft-mcp` | A **throwaway, headless Chrome for Testing**, pinned | **None** | Debugging, repro, performance traces, Lighthouse |
| `cft-profile` → `chrome-devtools-cft-profile-mcp` | The same pinned CfT, **headed, persistent profile** | **Whatever the operator logged into there** | Repeated logged-in automation that should stay out of the real Chrome |

All three commands are launchers on `PATH` that carry every argument (in
`kattakath/nix-config`, `modules/home/pinned-chrome.nix`). Never add arguments
in a client config.

## Which rail — pick once per task, say which, never switch silently

1. **A Claude Code session whose Claude in Chrome connects** (`tabs_context_mcp`
   answers) → use **Claude in Chrome**, not this plugin.
2. **Anything else that needs the real browser** — grok, qwen, Antigravity, or
   a Claude session whose Claude in Chrome is signed into another account →
   **`playwright`**.
3. **No logins needed, or a debugging job** → **`chrome-devtools`**.
4. **The operator names `cft-profile`, or the task is logged-in automation he
   has set up there** → **`cft-profile`**.
5. On a permission wall, a site that refuses, or a tool error: **stop and ask
   the operator.** Do not fall back to another rail on your own.

## `playwright` (real Chrome)

- Start with `browser_tabs` (`action: "list"`) or `browser_navigate`. The client
  gets **its own tab group**; it does not see or touch the operator's other tabs.
- Measured 2026-11-18: a connection completes in ~2 s with no prompt waiting (any
  earlier approval may be remembered). If Chrome ever shows a Playwright **Allow /
  connect** page, the operator clicks it; do not try to.
- Act from a fresh `browser_snapshot`. `browser_click` takes `element` (a human
  description) and `target` (the `ref` from the snapshot, e.g. `e13`). Refs go
  stale after a navigation: snapshot again.
- **Measured 2026-11-18** (nixpkgs `playwright-mcp` 0.0.83, extension 0.6.0, Chrome
  158): clicks are **trusted** (`event.isTrusted === true`), and it worked on an
  https page with Claude in Chrome also installed.
- A page that embeds another extension's `chrome-extension://` frame can detach
  the debugger. If a tab drops mid-task, say so; don't retry in a loop.
- Do not type a secret. Do not close a tab the operator opened.

## `chrome-devtools` (throwaway CfT)

- Launches its own headless Chrome for Testing with an **isolated, temporary
  profile** and talks to it over a pipe: no port, no operator data, nothing
  survives the session.
- Tools take a `pageId`: get it from `list_pages` or `new_page`, then pass it to
  `take_snapshot`, `click` (`uid`), `evaluate_script`, `close_page`.
- **Measured 2026-11-18** (`chrome-devtools-mcp` 1.13.0, CfT 156): clicks are
  trusted.
- The CfT version trails stable Chrome. A rendering difference may be the version,
  not the site.

## `cft-profile` (persistent CfT)

- The same tools as `chrome-devtools` (`pageId`, `uid`), on a **headed** CfT whose
  profile lives in `$XDG_STATE_HOME/cft-profile` and survives between sessions.
- **The operator logs in, never the agent.** He runs `cft-profile` (a command on
  `PATH`, not a tool), which opens that profile with no automation flags, signs in,
  and closes the window. Google sign-in can refuse a browser started by the agent.
- **One process per profile.** If the launch fails because the profile is in use,
  the `cft-profile` window is still open: ask the operator to close it.
- Cookies are encrypted with the login Keychain, not puppeteer's mock key, so the
  first launch may show a Keychain prompt. The operator answers it.
- Chrome's enrollment and policy do not reach CfT (measured 2026-11-19: it answered
  on a debugging port with `RemoteDebuggingAllowed = false` set). This rail still
  uses a pipe, so it opens no port.

## No rail opens `chrome://` pages

- Extensions are not allowed to debug `chrome://` pages, and `chrome-devtools-mcp`
  refuses them itself (`Navigating to chrome: URLs is not allowed`, measured).
- Browser configuration (extensions, DevTools, settings) is **declared as Chrome
  policy**, not clicked. To read what applied, ask the operator to open
  `chrome://policy`.
- The operator's real Chrome has remote debugging **disabled by policy**
  (`RemoteDebuggingAllowed = false`), so there is no CDP port to attach to. Do not
  ask for it to be turned on.
