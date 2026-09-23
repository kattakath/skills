# claude-code-nix

Hooks for working on **Nix flakes** with Claude Code. Two `PostToolUse` hooks on
`Write|Edit`, both **no-ops in a repo with no `.nix` files** — so enabling this
globally is safe.

| Hook | What it does |
|---|---|
| `autostage-nix.js` | `git add`s a `.nix` file as soon as it is written or edited. |
| `nix-home-path-lint.js` | Flags a hardcoded per-user home directory (`/Users/<name>`, `/home/<name>`) in a `.nix` **value** — except the line that *declares* one, `users.users.<name>.home = "/Users/<name>";`. |

## Why auto-staging is not a convenience

**Flakes evaluate the git tree, not the working directory.** A `.nix` file that
has not been `git add`ed is *invisible* to the evaluator — `nix flake check`
fails with a confusing "path does not exist", or worse, silently evaluates a
previous version of the file and reports success. Staging at write time removes
the whole class of error.

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
synced 2026-09-16, nix-config PR #532).

## Tests

```bash
node --test plugins/claude-code-nix/tests/nix-home-path-lint.test.js
```

The fixtures mirror the ast-grep rule's own `valid:`/`invalid:` test file, so
both halves are proven against the same inputs.

## Install

```bash
/plugin marketplace add kattakath/skills
/plugin install claude-code-nix@kattakath
```

The hooks are declared in `hooks/hooks.json` against `${CLAUDE_PLUGIN_ROOT}`, so
they work as soon as the plugin is enabled — no `settings.json` edit needed.

## Pairs with

[`superhook`](../superhook) — wrap either hook to get crash safety and a loop
breaker. Neither hook here is a *decision* hook, so the wrapper is optional.

## License

MIT.
