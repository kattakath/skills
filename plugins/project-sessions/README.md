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
| `hooks/session-start` | SessionStart: in auto mode, resumes a stopped session (detached) and names it; otherwise names it and the skill |
| `hooks/user-prompt-submit` | UserPromptSubmit, auto mode only: one line per prompt; creates a missing session in the caller's mode (detached) |
| `hooks/lib.sh` | Shared by the two: the gate, the 2 s bound, the detached `ensure` |
| `hooks/pre-tool-use` | PreToolUse (Bash): adds the caller's `--permission-mode` to a `project-session ensure` call that names none |
| `skills/project-sessions` | Hand the task over with SendMessage and relay the result; `ensure` by hand when not in auto mode |
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
- **Task lists are Claude Code's default per session; they survive stop/resume and reset
  when a session is removed and recreated.** `ensure` sets no task list (since 1.4.0).
- **While the daemon runs, the client env does not reach a `--bg` session, but it can reach
  the daemon.**
  `claude --bg` hands the session to the long-lived `claude daemon` (or a spare it
  pre-started).
  - History: 1.3.0 passed an env prefix, and the session read back the daemon's value instead
    (measured 2.1.330). 1.3.1 then used `--settings`, and 1.4.0 dropped the custom list.
  - **Measured, the daemon's env only:** on 2026-11-28, `ps eww` on the running daemon showed
    `CLAUDE_CODE_TASK_LIST_ID=github.com:kattakath/nix-config`, inherited from the 00:31
    `claude --bg` that started it.
  - **Inferred, not measured for this variable:** every later session that daemon started
    would then get that one list. The basis is the 1.3.0 read-back above: a session saw the
    daemon's value, not the client's.
  - That is why `ensure` still scrubs the variable (`env -u`) on create and resume.
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

## Auto mode — the hooks start the session

**Why hooks, not the skill:** a measured eval (10 fresh `claude -p` runs, 2.1.330) saw the
SessionStart line reach the agent **10/10**, the skill loaded **2/10**, and `ensure` run
**0/10** — even agents that loaded the skill skipped it. So the hooks run it.

**Why `/ps`:** with the hooks creating the session (1.2.0), the handover is still the model's
choice, and the CLI cannot give a task to a running session (`--bg --resume <id> "<task>"`
starts a copy). Measured: SendMessage handovers **0/10** under `-p`, **1/3** in real
interactive sessions (that one worked end to end). `/ps <task>` makes the handover the user's
decision instead.

| Env | Effect |
|---|---|
| `CLAUDE_CODE_SESSION_ATTENDED=1` | Auto mode on. Measured 2.1.330: interactive `1`, `-p` `0` (`CLAUDE_CODE_ENTRYPOINT`: `cli` vs `sdk-cli`) |
| `PROJECT_SESSIONS_AUTO=1` | Force auto mode on (evals under `-p`) |
| `PROJECT_SESSIONS_AUTO=0` | Force it off: SessionStart only names the session, UserPromptSubmit is silent |

Both hooks stay silent outside git, inside any background session, past a 2 s bound, and on
any error. The background check is `status --session`: the hook's `session_id` matches a
`kind: background` row of `claude agents`.
- The suite proves it with `PROJECT_SESSIONS_AUTO=1` and no task list, across every state
  that row can hold.
- Removing the check turns those 18 cases red.

- **SessionStart has no `permission_mode` in its input** (measured 2.1.330, `-p`, `startup`;
  UserPromptSubmit has it). A create without the mode would run in default mode for good, so
  SessionStart **resumes** a stopped session (bare, it keeps its own mode) but leaves a
  **missing** one to the first prompt. If a future input carries the mode, it creates then.
- **UserPromptSubmit** creates a missing session with `--permission-mode <caller's mode>`.
  `plan` and unknown modes are not mirrored: nothing is created, and the line says why.
- **Detached:** `( ( ensure …; echo $? >rc ) </dev/null >/dev/null 2>&1 & )`, all three fds
  redirected so Claude Code does not wait. Measured with a real `claude -p` and an 8 s stubbed
  `--bg`: the run ended in 7 s, and `ensure` finished afterwards (rc 0, lock released).
- Not stacked: no spawn while the repo's `ensure` lock is held.
- The session it creates keeps its own hooks out through `status --session` alone. 1.4.0
  also passed `PROJECT_SESSIONS_AUTO=0` as an env prefix, but it did not arrive while the
  daemon was running. The session's `printenv PROJECT_SESSIONS_AUTO` printed nothing (exit 1),
  measured live on 2.1.330 with the daemon up. 1.4.1 dropped the prefix.
- **Result files** per repo in `${XDG_STATE_HOME:-~/.local/state}/project-sessions/`:
  `<name>.ensure.{out,err,rc}`. A failure shows as one line, `could not start: <reason>`
  (ensure's own last stderr line, or claude's message when ensure only says "claude
  exited N"). After a spawn, either hook waits up to 1 s for a fast answer, so an untrusted
  folder is reported on the same prompt; a standing failure keeps showing.
- **Exit 5 is never retried:** a resume that started a copy would start more. Delete
  `<name>.ensure.rc` once the duplicate is sorted out.

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
auto-mode gating matrix, that SessionStart returns while a slow `--bg` still runs, the
UserPromptSubmit lines, fail-open on garbage input, and what the mode hook amends and leaves
alone.

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
