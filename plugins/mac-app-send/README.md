# mac-app-send

Drive a native macOS app with the **computer-use** MCP to send a formatted message and attach
files — with the three moves that measurably cost a turn blocked before they happen.

Native desktop apps have no API, so computer-use *is* the right tool for them. Two things make
it fail, and neither is discoverable from the tool descriptions.

## What it ships

| Component | What it does |
|---|---|
| `skills/mac-app-send` | The method: control scopes, the Open/Save panel, multi-line entry, formatting, verification |
| `/mac-app-doctor` | Resolves install path, **bundle id** and running state in one shot |
| `/mac-send` | Pins the send order and both verification points |
| `scripts/file-manifest.sh` | Bytes, **KB as the app will show it**, and page count — to check a send against disk |
| `hooks/` PreToolUse guard | Blocks three known-wrong moves, with the fix in the refusal |

## The guard

| Blocked | Why | Instead |
|---|---|---|
| `osascript` / `cliclick` sending keystrokes or clicks | The computer-use refusal explicitly forbids it | `request_full_control` → `computer_batch` |
| Multi-line `app_type` without `element_index` | Coordinate targeting sends raw keystrokes; **Enter sends**, so the message arrives one bubble per line | `app_ax_find` → `app_type element_index=N` |
| `request_access` on `openAndSavePanelService` | Not an installed app: returns `notInstalled`, **short-circuits the whole call**, never reaches the user | Display scope |

Reading a property with `osascript` stays allowed — the rule matches an *input verb*, not the
binary. `tests/guard-cases.sh` asserts that, plus every block, plus that the guard never throws.

```bash
bash tests/guard-cases.sh    # 16 cases
```

The never-throw half matters: the guard exits 0 on any error so it cannot wedge a turn, which
means a throw would fail **open** and silently disarm every rule above it.

## Requires

**The `computer-use` MCP server.** This plugin does **not** ship or install one — on this fleet
MCP servers are adopted only through `nix-config`'s `mcp-scout`, never a plugin `.mcp.json`.
If the computer-use tools are absent, the skill and commands still explain the method but
nothing can be driven.

Also assumes macOS (`mdfind`, `mdls`, `/usr/bin/stat`) and `node` for the hook.

## Why a plugin and not just a skill

The knowledge alone leaves the model rediscovering bundle ids, re-deriving file sizes, and —
twice measured — trying the two workarounds that cannot work. The scripts turn those into
facts and the guard turns them into refusals, so the same send costs materially less inference.
