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
| `hooks/pre-tool-use` | PreToolUse (Bash): adds the caller's `--permission-mode` to a `project-session ensure` call that names none |
| `skills/project-sessions` | Ensure the session, hand over the task |
| `skills/project-shape` | Check the repo's `CLAUDE.md` and `.claude/settings.json`; scaffold them on a yes |

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
- **A session created without `--permission-mode` runs in default mode**, even when user
  settings set `permissions.defaultMode`. A `SendMessage` to it from a bypass-mode session is
  then held, not delivered. Created with `--permission-mode bypassPermissions`, it receives.
  No env var exposes the caller's mode; the PreToolUse hook input's `permission_mode` does.

## Decision table for `ensure`

| Matching background rows | Action | stdout |
|---|---|---|
| any `working` / `blocked` / `idle` | none | `live <name>` |
| only `done` / `failed` / `stopped` | resume the newest by `startedAt`, bare | `resumed <name>` |
| none | create from the repo root, with `--permission-mode` when given | `created <name>` |
| any other state, none live | nothing, exit 3 | — |

Interactive sessions never match. A row whose `cwd` no longer exists is skipped. Creation and
resume run under a per-repo lock in `${XDG_STATE_HOME:-~/.local/state}/project-sessions/`
(stale after 120 s).

## The hook

Silent outside git, inside any background session (so the project session is never told to
delegate to itself), past a 2 s bound, and on any error. Otherwise it adds one
`additionalContext` line.

## The mode hook

[PreToolUse](https://code.claude.com/docs/en/hooks#pretooluse-decision-control), matcher
`Bash`. When the command runs `project-session ensure` in command position (start, or after
`;` `&` `|` `(`) and names no `--permission-mode`, it returns `updatedInput` with the flag
added right after `ensure`. It sets **no** `permissionDecision`, so the normal permission flow
still decides; `updatedInput` replaces the whole `tool_input`, so the other fields are carried
over. The mode passes verbatim (`default`, the hook's name for Manual, is accepted on 2.1.323 and
2.1.330). A multi-line command is never touched, since a heredoc could hold the words.
`plan` is not mirrored: a plan-mode worker cannot execute, and a bare resume keeps its mode.
Any doubt — no jq, bad JSON, an unknown mode — and it prints nothing. A wrapped call
(`"$P" ensure` via a variable, `env X=1 … ensure`, inside `if`) gets no flag: pass it yourself.

## Tests

`bash plugins/project-sessions/tests/run.sh`: a stubbed `claude` on `PATH` logs every call;
the suite asserts the exact create and resume argv, that no id reaches stdout, the lock, the
SessionStart hook's silences, and what the mode hook amends and leaves alone.

## Known gaps

- **A mode mismatch is invisible.** `claude agents --json --all` (2.1.330) exposes `cwd`, `id`,
  `kind`, `name`, `pid`, `sessionId`, `startedAt`, `state`, `status` and `waitingFor`, but no
  permission mode. So `ensure` cannot tell that an existing session runs in another mode, and
  prints no `mode-mismatch` note. Recreating it is the operator's call.
- `stopped` and `failed` as reboot states come from the agent-view docs; `failed` was measured
  in `--json`, `stopped` was not.

- Pinning a session in the agent view stays manual: there is no CLI flag.
- Each new repo needs one trust click.
- Task-list folders replace characters outside `[A-Za-z0-9_-]` with `-`, so two names can
  share one list.
