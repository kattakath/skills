# project-sessions

One named background Claude Code session per git repo. The main interactive session hands
work to it with `SendMessage` and keeps only coordination.

```
/plugin install project-sessions --marketplace kattakath/skills
```

## What it ships

| Part | What it does |
|---|---|
| `bin/project-session` | `name`, `ensure`, `status`. bash 3.2 + `git` + `jq`; macOS and Linux; no Nix |
| `hooks/session-start` | SessionStart: one line naming the repo's session and the skill to load |
| `skills/project-sessions` | Ensure the session, hand over the task, check the project shape |

## The name

`<host>:<owner>/<repo>` from `git remote get-url origin`: https, `git@host:o/r` and
`ssh://user@host:port/o/r` all give the same name, nested groups kept, `.git` dropped.
No remote: `local:<repo root>`. A worktree maps to its main repo through
`git rev-parse --git-common-dir`, so it shares the main repo's session.

## Facts it is built on (measured on Claude Code 2.1.330)

- **Session names are not unique.** `ensure` matches the name **and** the repo root of each
  row's `cwd`, and reports duplicates on stderr. It never stops or deletes one.
- **Resume continues the same session only as `claude --bg --resume <full sessionId>` with
  no other flag.** By name, by short id or with any extra flag it starts a copy, and by name
  the copy also loses the name. `ensure` uses only the bare form.
- **No id is stored.** `claude agents --json --all` already holds the state; a second copy
  would drift. Ids never reach stdout unless `--debug`.
- **`--bg` refuses an untrusted folder.** `ensure` passes Claude Code's message through
  verbatim; the operator trusts the folder once by running `claude` there.
- The task list (`CLAUDE_CODE_TASK_LIST_ID`, set at creation) survives a bare resume.

## Decision table for `ensure`

| Matching background rows | Action | stdout |
|---|---|---|
| any `working` / `blocked` / `idle` | none | `live <name>` |
| only `done` / `failed` | resume the newest by `startedAt` | `resumed <name>` |
| none | create from the repo root | `created <name>` |
| any other state, none live | nothing, exit 3 | — |

Interactive sessions never match. A row whose `cwd` no longer exists is skipped. Creation and
resume run under a per-repo lock in `${XDG_STATE_HOME:-~/.local/state}/project-sessions/`
(stale after 120 s).

## The hook

Silent outside git, inside any background session (so the project session is never told to
delegate to itself), past a 2 s bound, and on any error. Otherwise it adds one
`additionalContext` line.

## Tests

`bash plugins/project-sessions/tests/run.sh`: a stubbed `claude` on `PATH` logs every call;
the suite asserts the exact create and resume argv, that no id reaches stdout, the lock, and
the hook's silences.

## Known gaps

- Pinning a session in the agent view stays manual: there is no CLI flag.
- Each new repo needs one trust click.
- Task-list folders replace characters outside `[A-Za-z0-9_-]` with `-`, so two names can
  share one list.
