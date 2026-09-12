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

## Wiring

`superhook` is a **wrapper**, not a hook. It goes in front of the hook you
already run, in your project's `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "node /path/to/superhook.js Stop -- node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/my-gate.js\""
      }]
    }]
  }
}
```

⚠ **Known constraint.** Project `settings.json` cannot expand
`${CLAUDE_PLUGIN_ROOT}` — that variable only exists inside a plugin's *own* hook
context — and a wrapper must be named by the consumer, so it cannot be declared
in this plugin's `hooks.json` either. You therefore need a stable path to
`scripts/superhook.js`. Pick one:

- **Put it on `PATH`** (what the author's fleet does — Nix packages this script
  as a `superhook` binary, and `settings.json` just calls `superhook Stop -- …`).
- Vendor `scripts/superhook.js` into your repo's `.claude/hooks/`.
- Reference the installed plugin path directly, accepting that it moves on
  upgrade.

The plugin still earns its place: it ships the scripts, the `/superhook-review`
command, and this contract in one installable unit.

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
