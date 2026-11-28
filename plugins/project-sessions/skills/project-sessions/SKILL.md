---
name: project-sessions
description: >-
  Hand a git repo's work to that repo's own named background Claude Code session. Use when
  the main interactive session is about to do multi-step work in a repo, when the
  SessionStart line says "load the project-sessions skill", or when the user says "send this
  to the project session", "work on <repo> in its own session", "resume the session for this
  repo", or "is there a session for this project".
---

# project-sessions

One background session per git repo, named `<host>:<owner>/<repo>` (for example
`github.com:kattakath/nix-config`). A repo with no `origin` is named `local:<repo root>`.
The main interactive session coordinates. The project session does the work.

`project-session` below means `"${CLAUDE_PLUGIN_ROOT}/bin/project-session"`.

## 1. Ensure the session

Run from anywhere inside the repo (a worktree counts as its main repo):

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/project-session" ensure            # or: ensure <dir> --prompt "<first task>"
```

- **Permission mode.** The plugin's PreToolUse hook adds `--permission-mode <your mode>` to
  this call, so a new session runs in the caller's mode. It amends only the plain
  one-line form above; for any other form (a variable, `env`, inside `if`), pass
  `--permission-mode <mode>` yourself. The mode applies **only on create**: a resumed
  session keeps the mode it was created with. Plan mode is not mirrored.

| Output (stdout) | Meaning |
|---|---|
| `live <name>` | A session is running. Send it the task |
| `resumed <name>` | A `done`, `failed` or `stopped` session (a reboot leaves the last two) was continued under the same id |
| `created <name>` | A new session started with its own task list (`CLAUDE_CODE_TASK_LIST_ID=<name>`) |
| `duplicates <n>` (stderr) | More than one session has this name for this repo. **Tell the user.** Never stop or delete one |
| exit 3 | A matching session is in a state the script does not know. It does nothing; report the state |
| exit 75 | Another `ensure` holds the lock for this repo. Retry once |
| any other non-zero | `claude` refused. Its message is on stderr, verbatim |

- **`Workspace not trusted`** on stderr: `--bg` refuses a folder the operator has not trusted.
  Tell the user to run `claude` in that folder once and accept the trust prompt. Never edit
  `~/.claude.json` to get past it.
- `--dry-run` prints `would-create` / `would-resume` / `live` and starts nothing.
- No session id is ever printed or stored. Each call reads it again from
  `claude agents --json --all`.
- Never resume these sessions by hand. `claude --bg --resume` with a name, a short id or any
  extra flag starts a **copy**. Only `ensure` resumes, with the bare full id.

## 2. Hand over the task

- Send the task with **SendMessage**, `to: "<name>"`, the bare name `ensure` printed.
- If **ListAgents** shows two rows with that name, report it to the user. Do not pick one by
  its `[ref]` on your own.
- Write the task so it stands alone: the goal, the files, what done means, and what to report.
- Keep only coordination in the main session: the user's decisions, cross-repo order, and
  relaying results.
- A session in a different permission mode holds the message for approval. A session
  created without a mode, or by a caller in another mode, still is one: `ensure` cannot see a
  session's mode, so it never recreates one. Say so if no
  reply comes.

`status` prints one line, `<name> <state>` or `<name> none`, for a quick check.

## 3. Project shape

For the repo's own Claude Code files (`CLAUDE.md`, `.claude/settings.json`), load the
`project-shape` skill.
