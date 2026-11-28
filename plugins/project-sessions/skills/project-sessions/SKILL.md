---
name: project-sessions
description: >-
  Hand a git repo's work to that repo's own named background Claude Code session, and check
  the repo is a valid Claude Code project. Use when the main interactive session is about to
  do multi-step work in a repo, when the SessionStart line says "load the project-sessions
  skill", or when the user says "send this to the project session", "work on <repo> in its
  own session", "resume the session for this repo", "is there a session for this project",
  or "set this repo up for Claude Code".
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

| Output (stdout) | Meaning |
|---|---|
| `live <name>` | A session is running. Send it the task |
| `resumed <name>` | A stopped session was continued under the same id |
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
- A session in a different permission mode holds the message for approval. Say so if no reply
  comes.

`status` prints one line, `<name> <state>` or `<name> none`, for a quick check.

## 3. Check the project shape

Look for `CLAUDE.md` and `.claude/settings.json` at the repo root.

**Both missing or one missing:** propose the standard shape, then ask with AskUserQuestion
before writing or committing anything.

- `CLAUDE.md`: generate it with the built-in `/init`.
- `.claude/settings.json`, exactly:

  ```json
  {
    "$schema": "https://json.schemastore.org/claude-code-settings.json"
  }
  ```

- The scaffold must read as something any developer wrote. **Do not mention this plugin, its
  marketplace or any personal setup in either file.**
- Committing needs the user's yes, given in AskUserQuestion. Commit only the two files.

**Present:** validate what is there.

- Settings: `check-jsonschema --schemafile https://json.schemastore.org/claude-code-settings.json .claude/settings.json`
  when `check-jsonschema` is installed. Otherwise run `jq empty .claude/settings.json` and say
  that only the JSON syntax was checked, not the schema.
- If the repo has `.claude-plugin/`: `claude plugin validate .`.
- Report failures. Fix them only after the user agrees.
