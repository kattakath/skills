# bash-language-server

A Claude Code **LSP plugin** for shell scripts. It registers
[`bash-language-server`](https://github.com/bash-lsp/bash-language-server) for `.sh`, `.bash`
and `.ksh` files, so Claude Code gets diagnostics after an edit plus hover, go-to-definition
and find-references through its built-in LSP tool.

The whole plugin is one `lspServers` block in `.claude-plugin/plugin.json`. It ships **no
hooks, no scripts, no MCP servers and no `bin/`**, and it installs nothing.

## Requirements

Two binaries must be on `PATH` when Claude Code starts:

- **`bash-language-server`** — the server itself. Without it the config still loads, but the
  server cannot start.
- **`shellcheck`** — where the diagnostics come from. The server runs it when it is on
  `PATH`; without it you get hover and navigation but **no lint diagnostics**
  ([upstream README](https://github.com/bash-lsp/bash-language-server#installation)).

Pick one way to install both:

| Way | Command or setting | Notes |
|---|---|---|
| NixOS / nix-darwin | `environment.systemPackages = [ pkgs.bash-language-server pkgs.shellcheck ];` | Declarative, machine-wide. |
| Home Manager | `home.packages = [ pkgs.bash-language-server pkgs.shellcheck ];` | Declarative, per user. |
| Nix profile | `nix profile install nixpkgs#bash-language-server nixpkgs#shellcheck` | Imperative; a manual step you own. |
| One session | `nix shell nixpkgs#bash-language-server nixpkgs#shellcheck -c claude` | Nothing persists. |
| Homebrew | `brew install bash-language-server shellcheck` | Outside Nix. |
| npm | `npm install -g bash-language-server` | Server only; install `shellcheck` separately. |

Check both with `command -v bash-language-server shellcheck` before you start a session.

Then install the plugin:

```
/plugin install bash-language-server --marketplace kattakath/skills
```

## Which files it covers

| Extension | Covered | Why |
|---|---|---|
| `.sh`, `.bash` | yes | What the server is for: it parses with tree-sitter-bash. |
| `.ksh` | yes | Kept from the attributed upstream config. ShellCheck accepts ksh (a `#!/bin/ksh` file lints with exit 0). This is a judgement call: the parser is still a Bash grammar, so ksh-only syntax can mis-parse. |
| `.zsh` | **no** | ShellCheck refuses zsh outright: a `#!/bin/zsh` file fails with `SC1071 ShellCheck only supports sh/bash/dash/ksh/'busybox sh' scripts` (measured, exit 1). The server describes itself as a Bash server. Mapping `.zsh` would put a false error on every zsh file. |

## Why there is no auto-install hook

The community `bash-language-server` plugin in
[boostvolt/claude-code-lsps](https://github.com/boostvolt/claude-code-lsps) adds a
`SessionStart` hook (`check-bash-language-server.sh`) that runs `brew install
bash-language-server`, or else `npm install -g bash-language-server`, when the binary is
missing. That hook was rejected for this marketplace:

- It installs software over the network at session start, **outside** a declarative config,
  so the binary drifts from what the system declares.
- It ends in `exit 0` on every path, so a failed install is silent.
- It never installs `shellcheck`, so even a successful run leaves you without diagnostics.

Here, installing the binaries is your system config's job. The plugin only tells Claude Code
how to launch the server.

## How it loads

- `lspServers` sits **inline in this plugin's own `plugin.json`**. When a plugin has a
  `plugin.json`, an `lspServers` block in its marketplace entry is not applied
  ([marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference.md)),
  so the marketplace entry carries none and sets no `strict: false`.
- A debug run (`claude --debug`) logs `Loaded 1 LSP server(s) from plugin:
  bash-language-server` when the config is read. That line proves the config loaded, not
  that the server started.

## Attribution

The LSP server config is reused from
[boostvolt/claude-code-lsps](https://github.com/boostvolt/claude-code-lsps) at commit
`351b4e08ec3752af4ec70802e4a08d1f05b5d98d` (`bash-language-server/.lsp.json`), MIT licensed,
© 2025 Jan Kott. Its licence ships here as
[`LICENSE-claude-code-lsps.md`](LICENSE-claude-code-lsps.md).

**Modifications:** the config moved from `.lsp.json` into `plugin.json`'s `lspServers` key,
the `.zsh` mapping was removed (see § Which files it covers), and the `hooks/` directory
(`check-bash-language-server.sh`, `hooks.json`) was dropped. The rest of the plugin is MIT,
per this repo's `LICENSE`.

A second community config, in Piebald-AI/claude-code-lsps, was not reused: that repo
publishes no licence.
