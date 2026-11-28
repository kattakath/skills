# tool-habits

A `PreToolUse` (Bash) advisory for one agent habit: **editing an existing file in place from
Bash** with `sed -i`, `perl -pi`, or an inline Python body that reads a file and writes it back.
When it sees one, it adds a note to Claude's context suggesting the **Edit tool**, which shows a
reviewable diff and is permission-scoped. It never blocks and never rewrites the command.

## Why advice, not a deny

Measured on 2026-11-28 over 55,639 Bash calls in 1,155 local transcripts (counts only, read-only):

| | Count |
|---|---|
| Bash calls flagged by this rule | 4,721 (**8.5%**) |
| real edits of existing files, in a hand-checked sample of an EARLIER draft of the detector | about 13 in 15 (an estimate; the shipped rule wasn't re-sampled) |

- **A deny would block about 1 Bash call in 12** while agents unlearn the habit.
- **Claude Code's own bypass-mode system prompt endorses the habit:** it tells agents to make
  "small, mechanical file changes with sed, heredocs, or short scripts". A hard block would
  fight the harness. So the operator chose advice (2026-11-28); revisit with hit counts.
- **The sibling rule does deny:** foreground CI polling lives in
  [`ci-watch`](../ci-watch)'s `poll-guard.js`. That one is written policy and rare (0.11%).

## What it leaves alone

- Writing a **new** file. Only a read followed by a write counts.
- Anything whose every path is a temp or scratch path (`/tmp`, `/var/folders`, `$TMPDIR`,
  `$S/`, a session `scratchpad` or job `tmp` dir).
- A Python script run **by path** (`python3 -I "$S/x.py"`). Only inline bodies are read.
- `sed` without `-i`, and text that only mentions `sed -i` (grep, commit messages).

## Contract

It follows nix-dev-toolkit's `references/cli-contract.md` § "Never wire a CLI straight in as a
hook". A finding prints one stdout JSON with `hookSpecificOutput.additionalContext` and no
`permissionDecision`, then exits 0. Anything else prints nothing and exits 0, garbage input
included. It never exits 2, so a bug can't block a call.

## Tests

`bash plugins/tool-habits/tests/run.sh` runs 23 cases through the real hook entry: 11 advised,
11 quiet, plus garbage input. Two mutants fail the suite: scratch paths no longer exempt (4
cases fail), and the Python rule switched off (4 fail).

## Requires

Node.js on `PATH`.
