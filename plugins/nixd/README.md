# nixd

A Claude Code **LSP plugin** for the Nix language. It registers the
[`nixd`](https://github.com/nix-community/nixd) language server for `.nix` files, so Claude
Code gets diagnostics after an edit plus hover, go-to-definition and find-references through
its built-in LSP tool.

The whole plugin is one `lspServers` block in `.claude-plugin/plugin.json`. It ships **no
hooks, no scripts, no MCP servers and no `bin/`**, and it installs nothing.

## Requirements

`nixd` must be on `PATH` when Claude Code starts. Without it the config still loads, but the
server cannot start. Pick one way to install it:

| Way | Command or setting | Notes |
|---|---|---|
| NixOS / nix-darwin | `environment.systemPackages = [ pkgs.nixd ];` | Declarative, machine-wide. |
| Home Manager | `home.packages = [ pkgs.nixd ];` | Declarative, per user. |
| Nix profile | `nix profile install nixpkgs#nixd` | Imperative; a manual step you own. |
| One session | `nix shell nixpkgs#nixd -c claude` | Nothing persists. |

Check it with `command -v nixd` before you start a session.

## Why there is no auto-install hook

The community `nixd` plugin in
[boostvolt/claude-code-lsps](https://github.com/boostvolt/claude-code-lsps) adds a
`SessionStart` hook that runs `nix profile install nixpkgs#nixd` when the binary is missing.
That hook was rejected for this marketplace:

- It installs software over the network at session start, **outside** a declarative Nix
  config, so the binary drifts from what the system declares.
- It always exits `0`, so a failed install is silent.

Here, installing `nixd` is your Nix config's job. The plugin only tells Claude Code how to
launch it.

## How it loads

- `lspServers` sits **inline in this plugin's own `plugin.json`**. When a plugin has a
  `plugin.json`, an `lspServers` block in its marketplace entry is not applied
  ([marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference.md)),
  so the marketplace entry carries none and sets no `strict: false`.
- A debug run (`claude --debug`) logs `Loaded 1 LSP server(s) from plugin: nixd` when the
  config is read.

## Attribution

The LSP server config is reused from
[boostvolt/claude-code-lsps](https://github.com/boostvolt/claude-code-lsps) at commit
`351b4e08ec3752af4ec70802e4a08d1f05b5d98d` (`nixd/.lsp.json`), MIT licensed,
© 2025 Jan Kott. Its licence ships here as
[`LICENSE-claude-code-lsps.md`](LICENSE-claude-code-lsps.md).

**Modifications:** the config moved from `.lsp.json` into `plugin.json`'s `lspServers` key
unchanged, and the `hooks/` directory (`check-nixd.sh`, `hooks.json`) was dropped. The rest of
the plugin is MIT, per this repo's `LICENSE`.
