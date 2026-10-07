---
name: desktop-commander
description: Work a session whose Bash tool is REFUSING — "This session is isolated in the worktree … Refusing to run it there", a deleted worktree, or spawned agents inheriting that lock. Covers how to run commands and edit files through the Seatbelt-fenced desktop-commander MCP server instead, what the fence allows, and the two tools that will waste your turn. Use ONLY when Bash is actually refusing; if Bash works, use Bash.
---

# Working a Bash-locked session

**First, the gate.** If the Bash tool works in this session, **stop and use Bash.**
This server runs commands outside it, which means outside every PreToolUse hook and
outside the permission rules written in terms of command text. Same result, none of
the supervision. The plugin's own guard will tell you the same thing on every call.

Read on only if Bash is returning something like:

> This session is isolated in the worktree … Refusing to run it there

or the worktree you were started in has been deleted under you. Spawned agents
inherit that lock, so delegating does not escape it either.

## Confirm the lock is real before working around it

A deleted worktree and a stale path look identical from the wrong instrument.
Check with something that **can** come back negative:

- `read_file` on a file you expect in the worktree → "File does not exist" is proof.
- Do **not** infer it from a process's working directory. A process keeps its cwd
  after the directory is unlinked, so `lsof -d cwd` happily reports a path that is
  gone. That exact check produced a confident wrong answer on 2026-10-07.

If the worktree is gone, work in the repository's **main checkout** instead.

## The three tools that do the work

| Tool | Use |
|---|---|
| `start_process` | run a command. Returns a **PID and almost nothing else** |
| `read_process_output` | the output. You must call this — `start_process` alone shows you nearly nothing |
| `interact_with_process` | send another line to a process that is still running |

The pattern that is not obvious:

1. `start_process` with `{command: "git -C /path/to/repo status --porcelain", timeout_ms: 25000}`
2. note the PID in the reply
3. `read_process_output` with that PID

For an interactive session — a REPL, a database shell, anything that expects more
input — `start_process` a long-lived process (`python3 -i`, `psql …`) and then drive
it with `interact_with_process`. That is the one capability Bash genuinely lacks, and
it is worth reaching for even in a healthy session.

## What the fence allows

Writes land **only** under the projects directory, plus temp and package caches.
Everything else fails `Operation not permitted`, and the operator's secret paths fail
`EPERM` on read. So:

- **Do** edit source, run tests, run `git`, `gh`, `nix develop` — all measured working.
- **Don't** try to write the home directory, shell rc files, or Claude Code's own
  state. Those are denied, and a denied write costs you a turn.
- **Don't** try to edit any repo's `.claude/settings*.json`, `.claude/hooks/`,
  `.claude/agents/`, `.claude/commands/`, `.claude/skills/`, or `.mcp.json`. Those
  are denied on purpose — they are the files that would let a session grant itself
  permissions or install a hook that runs unsandboxed. A worktree's **source** stays
  writable; only the policy files inside it do not.

## Two tools that will waste your turn

- **`set_config_value` — do not call it.** Under the fence it
  **hangs**: no error, no response, the call never returns, though the server stays
  responsive to everything else. The configuration is managed declaratively by the
  operator's Nix configuration and is meant to change there.
- **`get_config`** is fine to read, but changing what it reports is not possible from
  here, by design.

## What the fence does NOT cover — this is on you

The Seatbelt profile governs **file paths only**. It cannot express, and therefore
does not stop:

- printing a secret value to stdout
- decrypting an age/agenix file
- a force-push, or merging a pull request

The plugin's guard blocks the known shapes of those, but treat the general rule as
binding rather than relying on the guard: **the operator's command-text policy still
applies to you here.** Being able to run a command outside the Bash tool is not
permission to do something that was denied inside it. If you need one of those,
surface it to the operator instead of routing around the block.

## When the work is done

Nothing here persists configuration, and nothing here needs cleanup. If the lock was
caused by a deleted worktree, say so in your final message — the fix is a fresh
session, and the operator may also want the stale worktree registration pruned
(`git worktree list` will still show it; `git worktree prune` clears it).
