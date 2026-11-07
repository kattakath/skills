# nix-flake-kit

Hooks and an MCP server for working on **Nix flakes** with Claude Code. Two
`PostToolUse` hooks on `Write|Edit`, both **no-ops in a repo with no `.nix`
files** — so enabling this globally is safe.

| Component | What it does |
|---|---|
| `autostage-nix.js` | `git add`s a `.nix` file as soon as it is written or edited — only under `CLAUDE_PROJECT_DIR`, and in the repository the file belongs to. |
| `nix-home-path-lint.js` | Flags a hardcoded per-user home directory (`/Users/<name>`, `/home/<name>`) in a `.nix` **value** — except the line that *declares* one, `users.users.<name>.home = "/Users/<name>";`. |
| `nixos` MCP server | [`mcp-nixos`](https://github.com/utensils/mcp-nixos): live, read-only lookup of nixpkgs packages and NixOS / home-manager / nix-darwin options. |

## Why auto-staging is not a convenience

**Flakes evaluate the git tree, not the working directory.** A `.nix` file that
has not been `git add`ed is *invisible* to the evaluator — `nix flake check`
fails with a confusing "path does not exist", or worse, silently evaluates a
previous version of the file and reports success. Staging at write time removes
the whole class of error.

### What it covers, and what it cannot

- **Every built-in tool that writes a `.nix`**: `Write` and `Edit`. There is no
  `MultiEdit` in the current [tools reference](https://code.claude.com/docs/en/tools-reference),
  and `NotebookEdit` only writes `.ipynb`.
- **Worktrees, nested repos and submodules.** `git` runs from the file's own
  directory, so a `.nix` in Claude Code's own `.claude/worktrees/<name>/` is staged in
  *that* worktree. `CLAUDE_PROJECT_DIR` stays at the main checkout after Claude enters a
  worktree ([hooks reference](https://code.claude.com/docs/en/hooks)), so running from
  the project root used to miss these files without a word.
- **Not covered: files written by `Bash`** (a heredoc, `cp`, a generator). No hook
  input names the file. Stage those yourself, or run `git add -A` before evaluating.
- **Never silent on failure.** A file in no repository, or a gitignored one, is left
  alone on purpose. Any other `git add` failure (a held `index.lock`, say) reaches Claude
  as `additionalContext`, so a missed stage is never mistaken for a done one.
- **No shell.** `git` gets an argument vector and `--`, so a filename can only ever be
  a pathspec.

Why a full `git add` and not `git add -N` (intent-to-add)? `-N` is enough for Nix:
`nix flake init` uses it, and Nix's own untracked-file error suggests it. Measured on
Determinate Nix 3.24.2 (Nix 2.35.3): an untracked file fails to evaluate, and after
`git add -N` it evaluates, later edits included. But an intent-to-add file is left
out of a plain `git commit`. The full add keeps "written means committed-with-the-rest",
which is what this net has always promised.

## Why the home-path lint is value-only

There are two different path axes in Nix and conflating them is the actual bug:

| Axis | Correct form |
|---|---|
| **Source path literal** (`../../foo.nix`, `"${../skills/x}"`) | repo-relative, resolved at eval and copied to the store. A `../..` literal is **correct and idiomatic** — never "fix" it to a home path. |
| **Runtime path** (env vars, data dirs, `home.file` targets) | `$HOME`/XDG-relative — **never** a hardcoded `/Users/<name>`. |

The hook flags only the second: a literal per-user home directory in a `.nix`
*value* (not in a comment). `$HOME` is undefined at eval time and a runtime home
path is neither reproducible nor store-addressable, so the hardcoded form is the
one real anti-pattern here.

The one exception is the line that *declares* a home:
`users.users.<name>.home = "/Users/<name>";`. `$HOME` is undefined at eval and
`config.users.users.<n>.home` there would be a self-reference, so the literal is
required. The hook exempts it by **shape** (the string is the direct value of a
`…home =` binding on the same line), not by account name, so it survives a
rename — every other use of a home path stays flagged.

The hook is the advisory half of a pair. The gate half is
[`kattakath/nix-config`](https://github.com/kattakath/nix-config)'s
`ast-grep/rules/nix-hardcoded-home-path.yml`, which runs in CI on every commit;
the two carry the same regex and exemptions and must change together (last
synced 2026-11-07: the rule's leading `(^|[^a-zA-Z])` guard).

## The MCP server

`.mcp.json` names the bare `mcp-nixos` command, so **`mcp-nixos` must be on `PATH`**
(nixpkgs ships it: `nix profile install nixpkgs#mcp-nixos`). Without it the server
does not start. The hooks do not need it.

A bare binary is deliberate, not an unpinned spec. The version is pinned by whatever
installs it (on the operator's fleet, `pkgs.mcp-nixos` in nix-config's `flake.lock`),
so no registry fetch happens when a session starts. The alternative,
`uvx mcp-nixos==<version>`, would put the pin here, but it fetches from PyPI at spawn
and needs `uv`.

## Tests

```bash
node --test plugins/nix-flake-kit/tests/
```

`autostage-nix.test.js` builds throwaway git repos and asks git what got staged. It
covers worktrees, nested repos, injection-shaped filenames, a prefix-sibling
directory, a symlink out of the project and a held `index.lock`. The lint fixtures
mirror the ast-grep rule's own `valid:`/`invalid:` test file, so both halves are
proven against the same inputs. CI runs both (`validate.yml`, step `nix-flake-kit
hook cases`).

## Install

```bash
/plugin marketplace add kattakath/skills
/plugin install nix-flake-kit@kattakath
```

The hooks are declared in `hooks/hooks.json` against `${CLAUDE_PLUGIN_ROOT}`, so
they work as soon as the plugin is enabled — no `settings.json` edit needed.

## Pairs with

[`superhook`](../superhook) — wrap either hook to get crash safety and a loop
breaker. Neither hook here is a *decision* hook, so the wrapper is optional.

## License

MIT.
