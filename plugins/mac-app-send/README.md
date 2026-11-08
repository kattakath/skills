# mac-app-send

Drive a native macOS app with the **computer-use** MCP to send a formatted message and attach
files — with the three moves that measurably cost a turn caught by a confirm prompt before they happen.

Native desktop apps have no API, so computer-use *is* the right tool for them. Two things make
it fail, and neither is discoverable from the tool descriptions.

## What it ships

| Component | What it does |
|---|---|
| `skills/mac-app-send` | The method: control scopes, the Open/Save panel, multi-line entry, formatting, verification |
| `/mac-app-doctor` | Resolves install path, **bundle id** and running state in one shot |
| `/mac-send` | Pins the send order and both verification points |
| `scripts/file-manifest.sh` | Bytes, **KB as the app will show it**, and page count — to check a send against disk |
| `hooks/` PreToolUse guard | Asks before three known-wrong moves, with the fix in the prompt |

## The guard

| Asks before | Why | Instead |
|---|---|---|
| `osascript` / `cliclick` sending keystrokes or clicks | The computer-use refusal explicitly forbids it | `request_full_control` → `computer_batch` |
| Multi-line `app_type` without `element_index` | Coordinate targeting sends raw keystrokes; **Enter sends**, so the message arrives one bubble per line | `app_ax_find` → `app_type element_index=N` |
| `request_access` on `openAndSavePanelService` | Not an installed app: returns `notInstalled`, **short-circuits the whole call**, never reaches the user | Display scope |

Reading a property with `osascript` stays allowed — the rule matches an *input verb*, not the
binary — and only when `osascript`/`cliclick` actually RUNS: the words as data (a `grep` pattern,
a `printf` body, a heredoc written to a file and never run) do not ask. Each match is a confirm prompt (`permissionDecision: "ask"`), not a refusal: the
one-line reason names the better route, and it is also what Claude reads if you decline.
`tests/guard-cases.sh` asserts that, plus every ask, plus that the guard never throws.

```bash
bash tests/guard-cases.sh    # 16 cases
```

The never-throw half matters: the guard exits 0 on any error so it cannot wedge a turn, which
means a throw would fail **open** and silently disarm every rule above it.

## Requires

- **Node.js (`npx`)**: the plugin's `.mcp.json` launches `@steipete/macos-automator-mcp@0.4.7`
  through `npx` on first use (pinned version).

**The `computer-use` MCP server.** This plugin does **not** ship or install one — on this fleet
an MCP server is declared in its owning plugin's `.mcp.json`, adopted through `nix-config`'s `mcp-scout`.
If the computer-use tools are absent, the skill and commands still explain the method but
nothing can be driven.

Also assumes macOS (`mdfind`, `mdls`, `/usr/bin/stat`) and `node` for the hook.

## Why a plugin and not just a skill

The knowledge alone leaves the model rediscovering bundle ids, re-deriving file sizes, and —
twice measured — trying the two workarounds that cannot work. The scripts turn those into
facts and the guard turns them into confirm prompts, so the same send costs materially less inference.
