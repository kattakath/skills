---
name: project-sessions
description: >-
  Hand a git repo's work to that repo's own named background Claude Code session. Use when
  the main interactive session is about to do multi-step work in a repo, when a
  project-sessions context line names this repo's session, or when the user says "send this
  to the project session", "work on <repo> in its own session", "resume the session for this
  repo", or "is there a session for this project".
---

# project-sessions

One background session per git repo, named `<host>:<owner>/<repo>` (for example
`github.com:kattakath/nix-config`). A repo with no `origin` is named `local:<repo root>`.
The main interactive session coordinates. The project session does the work.

## The hooks start it — your job is the handover

The user can also type **`/ps <task>`**: that decides the handover, so send it without asking.

In an attended session (or with `PROJECT_SESSIONS_AUTO=1`) the plugin's hooks create or
resume the session themselves and name it in a context line, at start and on every prompt.
Do **not** run `ensure` yourself then.

1. Send the task with **SendMessage**, `to: "<name>"`, the bare name the line shows.
2. Write it so it stands alone: the goal, the files, what done means, what to report.
   If the task has more than one step, also ask the session to:
   - track each step with **TaskCreate**, for its own task panel;
   - **SendMessage** you ONE line each time a step completes (`✓ 3/8 <subject>`);
   - still send the full report at the end.

   Ask for those lines because nothing else shows you progress: `claude agents --json` has
   no task or progress field, and the `~/.claude/tasks` files have no documented format.
   A successful send is not a read receipt, so never wait on a progress line. Relay lines as
   they arrive, and wait only for the final report.
3. Keep only coordination here: the user's decisions, cross-repo order, relaying results.
4. Relay its reply to the user. If none comes, say so: a session in another permission
   mode holds the message for approval, and nothing here can see a session's mode.

| The line says | Do |
|---|---|
| `(idle)`, `(working)`, `(starting)`, `(created)`, `(resumed)` … | SendMessage the task |
| `could not start: Workspace not trusted: the trust prompt is open in a Ghostty split below …` | Tell the user the prompt is waiting in that split; after they accept, retry once. Never edit `~/.claude.json` |
| `could not start: Workspace not trusted …` (no split) | Tell the user to run `claude` in that folder once and accept the prompt. Never edit `~/.claude.json` |
| `could not start: …` (anything else) | Report the reason; do not retry by hand |
| `not started: permission mode … is not mirrored` | Plan mode is not mirrored; the first prompt in another mode starts it |

- If **ListAgents** shows two rows with that name, report it. Do not pick one by `[ref]`.
- Never resume these sessions by hand. `claude --bg --resume` with a name, a short id or any
  extra flag starts a **copy**. Only `ensure` resumes, with the bare full id.

## By hand (no context line: unattended, `PROJECT_SESSIONS_AUTO=0`)

`project-session` means `"${CLAUDE_PLUGIN_ROOT}/bin/project-session"`.

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/project-session" ensure            # or: ensure <dir> --prompt "<first task>"
```

The PreToolUse hook adds `--permission-mode <your mode>` to that one-line form; any other
form, pass it yourself. The mode applies only on create.

| Output | Meaning |
|---|---|
| `live <name>` / `resumed <name>` / `created <name>` | Ready: SendMessage it |
| `duplicates <n>` (stderr) | Tell the user. Never stop or delete one |
| exit 3 | Unknown session state; it did nothing. Report the state |
| exit 75 | Another `ensure` holds the lock. Retry once |
| exit 77 | Untrusted folder: the trust prompt opened in a Ghostty split below. Tell the user; retry once after they accept |
| other non-zero | `claude` refused; its message is on stderr, verbatim |

`--dry-run` starts nothing. `status` prints `<name> <state>` or `<name> none`.

## Project shape

For the repo's own Claude Code files (`CLAUDE.md`, `.claude/settings.json`), load the
`project-shape` skill.
