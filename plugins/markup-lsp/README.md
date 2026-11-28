# markup-lsp

A Claude Code **LSP plugin** for config and markup files. It registers seven language
servers, so Claude Code gets diagnostics after an edit plus hover, go-to-definition and
find-references through its built-in LSP tool.

| Language | Extensions | Server | Command |
|---|---|---|---|
| YAML | `.yaml` `.yml` | [yaml-language-server](https://github.com/redhat-developer/yaml-language-server) | `yaml-language-server --stdio` |
| TOML | `.toml` | [taplo](https://github.com/tamasfe/taplo) | `taplo lsp stdio` |
| JSON | `.json` `.jsonc` | [vscode-langservers-extracted](https://github.com/hrsh7th/vscode-langservers-extracted) | `vscode-json-language-server --stdio` |
| HTML | `.html` `.htm` | vscode-langservers-extracted | `vscode-html-language-server --stdio` |
| CSS | `.css` `.scss` `.less` | vscode-langservers-extracted | `vscode-css-language-server --stdio` |
| XML | `.xml` `.xsd` `.xsl` `.xslt` | [lemminx](https://github.com/eclipse/lemminx) | `lemminx` |
| Markdown | `.md` `.markdown` | [marksman](https://github.com/artempyanykh/marksman) | `marksman server` |

The plugin ships **no hooks, no scripts and no MCP servers**, and it installs nothing.
Nix and shell files have their own plugins here: [`nixd`](../nixd) and
[`bash-language-server`](../bash-language-server). No extension is claimed twice; the tests
check that across the whole marketplace.

## Requirements

The seven commands must be on `PATH` when Claude Code starts. Without them the config still
loads, but those servers cannot start.

| Files | Role |
|---|---|
| `.lsp.json` | Extension → server map Claude Code reads. |
| `servers.nix` | **The one package list.** `{ pkgs }: [ … ]`, plain nixpkgs. |
| `flake.nix` | Builds that list (`packages.default`) and checks it against `.lsp.json`. |

Pick one way to get the binaries:

| Way | Command or setting | Notes |
|---|---|---|
| Home Manager / nix-darwin | `home.packages = import "${src}/plugins/markup-lsp/servers.nix" { inherit pkgs; };` | Declarative, on your own nixpkgs pin. `src` is this repo as a non-flake input. |
| Nix profile | `nix profile install 'github:kattakath/skills?dir=plugins/markup-lsp'` | Imperative; uses this flake's pin. |
| One session | `nix shell 'github:kattakath/skills?dir=plugins/markup-lsp' -c claude` | Nothing persists. |

Then install the plugin:

```
/plugin install markup-lsp@kattakath
```

## Cache, measured

On aarch64-darwin with nixpkgs `d5cc6833` (2026-11-28), a first install **compiles
nothing**. An empty store fetches 68 paths (148.7 MiB) in about **42 s**, and only the
`buildEnv` symlink tree is built locally.

- **marksman needs no override here.** Stock `marksman` and its `dotnet-runtime-9.0.22` are
  both on cache.nixos.org.
- Overriding `dotnetCorePackages.runtime_9_0` to `runtime_9_0-bin` **makes things worse**.
  It changes marksman's hash, so marksman rebuilds from source (dotnet-sdk, NuGet restore,
  xunit).
- `tests/run.sh --cache` is the gate. It fails when a dry-run on the current system would
  build anything except the `buildEnv`. A negative run with that override in place lists the
  marksman build, so the gate is not vacuous.

CI runs on Linux only, so the darwin numbers come from a local run. Rerun the gate on a Mac
after a pin bump.

## Tests

```bash
bash plugins/markup-lsp/tests/run.sh          # static checks, nix flake check, build, LSP smoke
bash plugins/markup-lsp/tests/run.sh --cache  # also the cache gate
```

- **static**: every server has a command and extensions, and no extension is claimed twice
  anywhere in the marketplace.
- **`checks.commands`**: every `command` in `.lsp.json` is an executable in the built
  `bin/`. Package names don't match commands (`vscode-langservers-extracted` ships three
  servers), so the check reads the built output, not the package list.
- **LSP smoke**: each server starts the way Claude Code starts it and must answer
  `initialize` with `capabilities`.

## Why no auto-install hook, and why not adopt a community plugin

Same stance as [`nixd`](../nixd): installing binaries is your Nix config's job, not a
`SessionStart` hook's. These are the community options checked on 2026-11-28:

| Candidate | Covers | Binaries | Licence | Why not |
|---|---|---|---|---|
| zircote/{yaml,json,html-css,markdown}-lsp | 5 of 7, one repo each | PATH, empty hooks | MIT | No TOML or XML. Four repos to pin. 1–3 stars. |
| boostvolt/claude-code-lsps | YAML only, of these | `SessionStart` installs via brew/npm | MIT | The install hook is rejected here. |
| Piebald-AI/claude-code-lsps | HTML, CSS | PATH | none found | No licence, so it cannot be vendored. No JSON, YAML, TOML or XML. |
| scristobal/claude-plugins | YAML, TOML, XML, Markdown | PATH | none found | No licence. No JSON, HTML or CSS. |

Nothing covered all seven under a licence that allows reuse, and none ships a Nix package
list. Each `.lsp.json` entry is a plain fact about a server's documented CLI, written for
this plugin.
