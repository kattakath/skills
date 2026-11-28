# markup-lsp

A Claude Code **LSP plugin** for config and markup files. It registers seven language
servers, so Claude Code gets diagnostics after an edit plus hover, go-to-definition and
find-references through its built-in LSP tool.

| Language | Server |
|---|---|
| YAML | [yaml-language-server](https://github.com/redhat-developer/yaml-language-server) |
| TOML | [taplo](https://github.com/tamasfe/taplo) |
| JSON, HTML, CSS | [vscode-langservers-extracted](https://github.com/hrsh7th/vscode-langservers-extracted) |
| XML | [lemminx](https://github.com/eclipse/lemminx) |
| Markdown | [marksman](https://github.com/artempyanykh/marksman) |

Which file extensions go to which server, and the exact command lines, live only in
[`.lsp.json`](.lsp.json).

The plugin ships **no hooks, no scripts and no MCP servers**, and it installs nothing.
Nix and shell files have their own plugins here: [nixd](../nixd) and
[bash-language-server](../bash-language-server). No extension is claimed twice; the tests
check that across the whole marketplace.

## Requirements

The seven commands must be on `PATH` when Claude Code starts. Without them the config still
loads, but those servers cannot start.

| Files | Role |
|---|---|
| `.lsp.json` | What Claude Code reads: extensions, commands and arguments. |
| `servers.nix` | The nixpkgs packages that provide those commands, as `{ pkgs }: [ … ]`. |
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
- That verdict holds for this pin only. If a later pin's darwin `dotnet-runtime` stops being
  cached, the override becomes the better trade: a short marksman build beats a long .NET
  source compile. The gate below is how you find out.
- `tests/run.sh --cache` is the gate. It fails when a dry-run on the current system would
  build anything except the `buildEnv`. A negative run with that override in place lists the
  marksman build, so the gate is not vacuous.

CI runs on Linux only, so the darwin numbers come from a local run. Rerun the gate on a Mac
after a pin bump.

## Bumping the nixpkgs pin (by hand)

`flake.lock` has **no updater**, and the cache verdict above holds only for the rev it pins.
Bump it by hand, on a Mac, when nix-config's own nixpkgs pin moves. **A GitHub issue
tells you when.** The daily `markup-lsp-pin` workflow runs `tests/lock-parity.py` against
nix-config's `main` (logic in `tests/pin-watch.sh`, cases in `tests/lock-parity-cases.sh`):
- the pins differ: it opens **one** issue, *markup-lsp: nixpkgs pin lags nix-config*,
  **assigned** to the operator. Assignment is what notifies someone; a bot-opened issue
  alone reaches only repo watchers. The workflow carries the operator's **immutable numeric
  account id**, the one kattakath/nix-config's `auto-merge.yml` and `bump-watch.yml` use,
  and resolves it to a login at run time, so a renamed login still works. Only a `User`
  account is assigned. If the lookup fails, or names a bot, the issue opens **unassigned**,
  never on a bot. It doesn't use `github.triggering_actor`: on scheduled runs nix-config
  measured that resolving to a bot. It comments on that issue only when the revs change
  again;
- the pins match: it closes that issue;
- the check itself breaks: the run **fails**. Whether that sends mail depends on the
  schedule owner's GitHub Actions notification settings.

The lag can sit for up to a day after nix-config's Monday bump merges before the issue opens.

```bash
cd plugins/markup-lsp
nix flake lock --override-input nixpkgs "$(jq -r .nodes.nixpkgs.locked.url <nix-config>/flake.lock)"
bash tests/run.sh --cache   # must print "nothing to compile" on aarch64-darwin
```

Then bump the PATCH version, update the rev and numbers in § Cache, and push. CI reruns
`--cache` on Linux.

Why not a bot:
- Dependabot's `nix` ecosystem updates GitHub, GitLab, SourceHut and plain-git inputs. It
  doesn't list tarball or FlakeHub URLs, and this pin is a FlakeHub tarball, matching
  nix-config.
- A lock-only PR would also fail this repo's `Plugin version bumped` gate, which has no
  exemptions.
- The darwin half of the gate runs only on a Mac, so an automatic bump would land unchecked.
- **Considered and rejected: `DeterminateSystems/update-flake-lock`**, the action nix-config
  itself runs weekly (`.github/workflows/update-flake-lock.yml`). It runs `nix flake update`,
  which moves the pin to whatever the FlakeHub URL serves now, not to nix-config's rev. The
  goal here is parity with nix-config, so that is the wrong target. Its PR would also be
  lock-only, failing the version gate above, and still need the darwin rerun. The
  `markup-lsp-pin` workflow above is the watcher instead.

How the watcher reports, and what it beat:

| Option | Why it lost |
|---|---|
| `JasonEtco/create-an-issue` | It can find an open issue by title and overwrite its body (`update_existing`, `search_existing`), but it can't comment only when the revs change, and it can't close the issue on parity. It also adds a third-party pin. |
| `peter-evans/create-issue-from-file` | It updates an issue only by number (`issue-number`), with no lookup by title and no close. It also adds a third-party pin. |
| `repository_dispatch` from nix-config's bump | It needs a token that can write to this repo from nix-config, and it couples nix-config's lock bump to one plugin here. |
| Warnings in ci-watch's GREEN line | ci-watch wakes only on pushes to this repo, and the lag is created by a nix-config merge, not by a push here. |

**What has not run for real.** `pin-watch.sh`'s create, comment and close paths are tested
against a stub `gh` only (`tests/lock-parity-cases.sh`). The one live run so far hit the
match path. A real `gh` call that **errors** fails the step, so the run goes **red** rather
than passing silently. A call that succeeds but returns a different shape from the stub's
(say, a title that no longer matches) is **not** caught, and could open a second issue.

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

Same stance as [nixd](../nixd): installing binaries is your Nix config's job, not a
`SessionStart` hook's.

On 2026-11-28 a GitHub code search on `filename:.lsp.json` found 11–33 hits per server. The
top hits were inspected, alongside the known marketplaces:

| Candidate | Covers | Binaries | Licence | Why not |
|---|---|---|---|---|
| rldyourmnd/rldyour-claudecode (one plugin) | 6 of 7, no XML | PATH | AGPL-3.0 | Copyleft can't sit in this MIT tree. One bundle of 15 servers. |
| zircote/{yaml,json,html-css,markdown}-lsp | 5 of 7, one repo each | PATH, empty hooks | MIT | No TOML or XML. Four repos to pin. 1–3 stars. |
| boostvolt/claude-code-lsps | YAML only, of these | `SessionStart` installs via brew/npm | MIT | The install hook is rejected here. |
| Piebald-AI/claude-code-lsps | HTML, CSS | PATH | none found | No licence, so it cannot be vendored. No JSON, YAML, TOML or XML. |
| scristobal/claude-plugins | YAML, TOML, XML, Markdown | PATH | none found | No licence. No JSON, HTML or CSS. |

Nothing covered all seven under a licence that allows reuse, and none ships a Nix package
list. Each `.lsp.json` entry is a plain fact about a server's documented CLI, written for
this plugin.
