# superhook

A **supervising dispatcher for command-type Claude Code hooks.**

A hook that throws, hangs, or exits non-zero can wedge a session. A gate that
blocks on the same reason forever can trap an agent in a loop it cannot escape.
`superhook` wraps your existing hook and removes both failure modes without
changing what the hook decides when it is working.

## What it does, in order of reliability

1. **Crash safety** — if the inner hook throws or exits non-zero, never wedge the
   session. Decision events (`PreToolUse`, `Stop`, `StopFailure`, `SubagentStop`)
   get a safe `approve`; non-decision events pass silently. Always logged.
2. **Loop breaker** — if the *same* block reason fires 3 times in a row for an
   event, downgrade that block to `approve` so a mis-firing gate cannot trap the
   agent forever. Loudly logged and surfaced via `systemMessage`.
3. **Pass-through** — otherwise the inner hook's decision is honoured verbatim. A
   single legitimate block is **not** downgraded.
4. **Log + recommend** — every invocation is appended to `superhook.log` as a JSON
   line (rotating, 5 MB × 3 backups). The wrapper never edits hook files itself.

## Wiring — the plugin ships the hooks

Installing this plugin is the whole wiring. `hooks/hooks.json` declares three
entries that auto-merge into your effective hook set; **nothing goes in your
`settings.json`**:

| Event | Matcher | Wraps |
|---|---|---|
| `Stop` | — | `<repo>/.claude/hooks/stop-gate.js` |
| `PreToolUse` | `Bash` | `<repo>/.claude/hooks/pretooluse-bash-guard.js` |
| `SessionStart` | — | `scripts/superhook-digest.js` (reads `superhook.log`) |

### The path convention

The supervisor is a **wrapper**, so it has to be told which script to supervise.
Rather than make that a per-project setting, the plugin fixes it by convention:
each entry looks for **one specific filename** under the repo's own
`.claude/hooks/`. Put your gate at that path and it is supervised; put it
anywhere else and the plugin ignores it.

Each command does three things, in order:

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

## Scope note

Security gating implemented as a `type: "prompt"` hook is evaluated by the model,
not spawned as a subprocess — it does not route through this wrapper and can
never be overridden here.

## License

MIT.
