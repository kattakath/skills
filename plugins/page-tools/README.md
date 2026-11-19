# page-tools

Three browser rails for any MCP client that loads Claude Code plugins (Claude Code,
grok, qwen). The method is the `page-tools` skill; the servers are this plugin's
`.mcp.json`.

## What it ships

| Piece | Role |
|---|---|
| server `playwright` → `playwright-chrome-mcp` | Microsoft Playwright MCP in `--extension` mode: the operator's real Chrome, one tab group per client |
| server `chrome-devtools` → `chrome-devtools-cft-mcp` | Google chrome-devtools-mcp launching a pinned, headless Chrome for Testing with a throwaway profile |
| server `cft-profile` → `chrome-devtools-cft-profile-mcp` | The same server and browser, headed, on a persistent profile the operator logs into once |
| `skills/page-tools` | Which rail, in what order, and what neither can do |

## Requires

- The three launchers on `PATH`. They carry every argument, so no client config adds any.
  In `kattakath/nix-config` they come from `modules/home/pinned-chrome.nix`:
  - `playwright-chrome-mcp` = nixpkgs `playwright-mcp` + `--extension`
  - `chrome-devtools-cft-mcp` = `npx -y chrome-devtools-mcp@1.13.0 --executablePath <pinned CfT> --isolated --headless --no-usage-statistics`
  - `chrome-devtools-cft-profile-mcp` = the same, with `--userDataDir <state>/cft-profile --ignoreDefaultChromeArg=--use-mock-keychain` and no `--isolated`/`--headless`
  - `cft-profile` (not a server) opens that profile by hand, so the operator can log in
  Elsewhere, put your own scripts with those names on `PATH`.
- The [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)
  (`mmlmfjhmonkocbjadbfplnigmagldckm`) installed in Chrome.
- A fresh session after the plugin is installed or updated.

## Why these three

| Option | Verdict |
|---|---|
| Playwright MCP `--extension` | **Chosen** for the real browser: per-tab-group scope, no listening port, in nixpkgs |
| chrome-devtools-mcp `--autoConnect` | Rejected for the real browser: needs Chrome's remote-debugging switch, which grants any local app the whole browser |
| chrome-devtools-mcp, launch mode | **Chosen** for debugging: richest tools, and the browser it drives holds nothing |
| chrome-devtools-mcp, launch mode, persistent CfT profile | **Chosen** for logged-in automation outside the real Chrome: Chrome's enrollment and policy do not reach CfT, and the pipe opens no port |
| Kapture (`kapture-mcp`, 1.0.0 of this plugin) | Replaced: one maintainer, and its loopback port admits requests with no Origin |

## Install

```
/plugin install page-tools@kattakath
```

grok and qwen read the same plugin (`qwen extensions install <marketplace-url>:page-tools`).
