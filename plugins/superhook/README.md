# superhook

A **supervising dispatcher for command-type Claude Code hooks.**

A hook that throws, hangs, or exits non-zero can wedge a session. A gate that
blocks on the same reason forever can trap an agent in a loop it cannot escape.
`superhook` wraps your existing hook and removes both failure modes without
changing what the hook decides when it is working.

## What it does, in order of reliability

1. **Crash safety** — if the inner hook throws, times out, or exits with anything
   but `0` or `2`, never wedge the session. The wrapper emits **no decision**, only
   a `systemMessage`, so the call goes through the normal permission flow
   ("staying silent doesn't approve it" —
   [hooks reference](https://code.claude.com/docs/en/hooks#exit-code-output)).
   Before 1.1.0 it emitted `decision: "approve"`, which on `PreToolUse` maps to
   `allow` and **skips the permission prompt**. Always logged.
2. **Blocks pass through** — a JSON block (`decision: "block"` or
   `hookSpecificOutput.permissionDecision: "deny"`) and an **exit-2** block (reason
   on stderr, the documented convention) reach the harness unchanged. Before 1.1.0
   an exit-2 block was treated as a crash and approved.
3. **Loop breaker, `Stop`/`SubagentStop` only** — if the *same* block reason fires 3
   times in a row, let the agent stop, loudly (`systemMessage` + log). A `Stop`
   block can trap an agent; a `PreToolUse` deny cannot — Claude just runs
   something else. So a repeated `PreToolUse` deny is logged as `loop-detected`
   and **never downgraded**. Before 1.1.0 the third identical retry of a
   hard-blocked command was turned into an allow. Upstream also caps Stop loops
   itself (8 consecutive continuations, `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` —
   [Stop input](https://code.claude.com/docs/en/hooks#stop-input)); this breaker
   is lower and leaves a log line, which is why it stays.
4. **Log + recommend** — every invocation is appended to `superhook.log` as a JSON
   line (rotating, 5 MB × 3 backups). The wrapper never edits hook files itself.

### Fail-closed where it is safe

The `PreToolUse` entry sets `"onFailure": "block"`
([docs](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails),
Claude Code 2.1.295+). If the **wrapper itself** cannot start or hits the 20 s
harness timeout, the Bash call is blocked instead of silently running unguarded.
An inner-hook crash is still crash-safe (item 1): the wrapper exits 0. `Stop` does
not get the field — upstream ignores it there, since Claude cannot repair a hook
that will not run.

### Timeouts

Each inner budget sits **below** its `hooks.json` `timeout`: `Stop` 600 s inside
630 s, `PreToolUse` 15 s inside 20 s. A harness timeout discards the output and
writes no log line, so the wrapper has to give up first to record the incident.
Before 1.1.0 `Stop` had a 60 s harness timeout around a 600 s inner budget, so a
cold `nix flake check` was cancelled and the gate silently never ran.

## Requirements

**Node.js on `PATH`.** Every script here runs with `node`, and the Claude Code CLI is a native binary that does not ship one. Without node, the `PreToolUse` entry dies at `exec node` (exit 127), and `onFailure: "block"` turns that failure into a block: in a repo with `.claude/hooks/pretooluse-bash-guard.js`, **every Bash call is blocked** until node is installed. That is fail-closed working as designed, so a SessionStart hook written in POSIX `sh` (`scripts/node-check.sh`, no node needed) says so at session start: it is silent when `command -v node` succeeds, and otherwise prints a `systemMessage` naming the floor plugins that cannot run (superhook, nix-flake-kit, brain-signals).

The hook scripts import nothing at run time. CI type-checks them (`tsc --checkJs`, `tsconfig.hooks.json` at the repo root) against the hook input and output types in Anthropic's `@anthropic-ai/claude-agent-sdk`; those types exist only in JSDoc comments.

## Wiring — the plugin ships the hooks

Installing this plugin is the whole wiring. `hooks/hooks.json` declares four
entries that auto-merge into your effective hook set; **nothing goes in your
`settings.json`**:

| Event | Matcher | Wraps |
|---|---|---|
| `Stop` | — | `<repo>/.claude/hooks/stop-gate.js` |
| `PreToolUse` | `Bash` | `<repo>/.claude/hooks/pretooluse-bash-guard.js` |
| `SessionStart` | — | `scripts/superhook-digest.js` (reads `superhook.log`) |
| `SessionStart` | — | `scripts/node-check.sh` (warns when `node` is missing; not a wrapper) |

### The path convention

The supervisor is a **wrapper**, so it has to be told which script to supervise.
Rather than make that a per-project setting, the plugin fixes it by convention:
each entry looks for **one specific filename** under the repo's own
`.claude/hooks/`. Put your gate at that path and it is supervised; put it
anywhere else and the plugin ignores it.

Each wrapper command (all but `node-check.sh`) does three things, in order:

1. **Resolves the repo root itself.** `CLAUDE_PROJECT_DIR` is the session's
   *launch CWD*, **not** the git root — a session started in `<repo>/sub` gets
   `CLAUDE_PROJECT_DIR=<repo>/sub` (measured, Claude Code 2.1.268). So every
   command runs `git rev-parse --show-toplevel` and falls back to
   `CLAUDE_PROJECT_DIR` outside a repo. A naive
   `${CLAUDE_PROJECT_DIR}/.claude/hooks/…` would silently miss the gate for
   anyone who starts sessions in subdirectories or worktrees.
2. **Exits 0 silently when the target is absent.** No gate at the conventional
   path (or, for the digest, no `superhook.log`) means the hook does nothing and
   emits nothing. That one test is also what keeps the plugin **inert in every
   unrelated repo** — install it globally, and it only wakes up where a gate
   exists.
3. **Re-exports `CLAUDE_PROJECT_DIR` as the resolved root** before `exec`ing the
   supervisor, so `superhook.log` and `.superhook-state.json` land in the repo
   root's `.claude/hooks/` — one log per repo, not one per subdirectory you
   happened to launch from.

### Correction: this used to say it was impossible

Earlier versions of this README claimed `${CLAUDE_PLUGIN_ROOT}` does not expand
outside a plugin's own hook context and that a *wrapper* therefore could not be
declared in `hooks.json` at all — so the author's fleet consumed the scripts as a
Nix-packaged `superhook` binary on `PATH` instead. **Measured on Claude Code
2.1.268, both halves were wrong.** Inside a plugin hook command, both
`${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` expand — as inline
substitution into the command string *and* as exported process environment
variables:

```
EVENT=SessionStart INLINE_PLUGIN=[…/plugin] INLINE_PROJECT=[…/proj] \
                   ENV_PLUGIN=[…/plugin]    ENV_PROJECT=[…/proj]
```

A plugin hook can therefore name the supervisor by absolute path and pass the
inner command as arguments — which is exactly what wrapping means. Expansion was
proven for `SessionStart`; `Stop` and `PreToolUse` are **inferred** (an isolated
`CLAUDE_CONFIG_DIR` cannot authenticate, so those events never fired in the
probe). Step 2's existence test is the defensive answer to that: if the
expansion ever failed, the resolved path would not exist and the hook would
no-op rather than crash.

### If you need the wrapper elsewhere

The conventional paths cover the common case. For a gate at some other path, call
`scripts/superhook.js` directly from your own `settings.json`:

```
node /path/to/superhook.js Stop -- node "$root/.claude/hooks/my-gate.js"
```

Several arguments after `--` run as an argv, with no shell, so a path with a space
survives. A single argument runs as a shell string.

⚠ Do **not** do this for a gate the plugin already covers. A `settings.json`
entry and a plugin entry both fire, so the gate would run **twice**.

## Why the digest reads the log, not the native counters

Claude Code *does* emit a native `hook_execution_complete` OTel event with
`num_blocking` / `num_non_blocking_error`. It is **structurally blind to exactly
the two events this tool exists to catch**: the wrapper always exits 0 and turns
both a crash and a loop into an *approve*, so from the harness's side those are
indistinguishable from a clean run. Measured over a live stream,
`PreToolUse:Bash` reported 15,102 records at `num_blocking 0,
num_non_blocking_error 0`. Hence `superhook-digest.js` reads `superhook.log`.

## Tests

`bash plugins/superhook/tests/supervisor-cases.sh` — stub inner hooks only, no
consumer repo needed. CI runs it in `validate`.

## Scope note

Security gating implemented as a `type: "prompt"` hook is evaluated by the model,
not spawned as a subprocess — it does not route through this wrapper and can
never be overridden here.

## License

MIT.
