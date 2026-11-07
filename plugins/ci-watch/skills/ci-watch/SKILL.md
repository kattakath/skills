---
name: ci-watch
description: >-
  Land a change by pushing straight to the default branch and keep working, while a
  background hook waits on the CI it triggered and wakes the session ONLY if something
  is wrong. Use when the user says "push to main", "don't wait for the checks", "watch CI
  in the background", "interrupt me only if it fails", "no PR, just push", or when a
  `ci-watch RED` / `NO_RUNS` / `STILL_RUNNING` reminder arrives and has to be acted on.
  Also use to watch a commit by hand: "is CI green for <sha>", "watch the checks on main".
  Covers the pre-push leak gates, what each wake-up means, and how to fix forward.
---

# ci-watch — push, keep working, hear about it only when it breaks

The plugin's `PostToolUse` hook runs after every Bash command that pushes. It waits on
**every** GitHub Actions run the pushed commit triggered. All green → it exits silently and
nothing reaches the conversation. Anything else → it wakes the session with a summary and a
path to the full JSON report.

## Landing a change

1. **Run the leak gates first.** A push to a public repo publishes every pushed commit,
   and that cannot be undone. Use whatever the repo names, typically
   `gitleaks git --log-opts="origin/<branch>..HEAD" --redact --no-banner`, plus any
   project-specific literal check.
2. **Fast-forward onto the remote:** `git fetch && git rebase origin/<branch>`.
3. **Push from a Bash tool call:** `git push origin HEAD:<branch>`. Do not wait on CI;
   go on with the next task. **Never force-push the default branch.** A red build gets a
   fix-forward commit.
4. **Green means silence.** Don't announce it, poll it or check on it.

The hook fires only for pushes **the agent** runs. A push the user types (`! git push`)
or makes outside the session is unwatched. Watch it by hand (below).

## When a wake-up arrives

It arrives as a system reminder that Claude Code labels a **"Stop hook blocking error"**
from `PostToolUse:Bash`. That is just how an `asyncRewake` exit 2 is shown, so it isn't a
broken hook. The text starts `ci-watch <STATUS>: <owner/repo>@<sha12> "<subject>"`.

| Status | Meaning | Do |
|---|---|---|
| `RED` | A run ended `failure`, `cancelled`, `timed_out` or similar | Read the report; fix forward; push again |
| `NO_RUNS` | Nothing ran on the commit within the appear window, or every run was skipped | The repo has no `push` trigger for this branch, or every workflow was path-filtered or `if:`-gated out. Tell the user. This is not a pass |
| `STILL_RUNNING` | A run was still going at the 45-min ceiling | Watch it by hand with the same sha; don't assume either outcome |
| `WATCH_FAILED` | The push landed, but a GitHub lookup failed (network, rate limit, expired login) | Watch it by hand once `gh` works again |

**The report has everything the next step needs**, so don't look anything up:

- the full sha, subject, commit URL and changed files;
- for each failed job: run id and URL, job id and URL, the failing step's number, name
  and times;
- the numbered log lines around `##[error]`, cut to that step's time window;
- ready `gh run view … --log-failed` and `gh run rerun … --failed` commands.

Diagnose from the excerpt and the changed files first. Reach for the full log only if the
excerpt doesn't explain it. A rerun is right only for a flake; a real failure needs a fix.

### RED with several failures: one fix per cause, one push

1. **Group `failures[]` by error signature first.** One cause that turns several jobs red
   (e.g. `gate` failing because `build` did) is ONE cause.
2. **One cause:** fix it in the main thread, with no subagent. A flake gets
   `gh run rerun … --failed`, with no agent at all. `NO_RUNS` and `STILL_RUNNING` never fan out.
3. **Two or more distinct causes:** use `superpowers:dispatching-parallel-agents`. Run one
   **background, read-only** diagnoser per cause, and give each the report path and its job
   id(s). Use a fresh subagent by default. Use a fork only when the fix depends on intent
   the commit message doesn't carry.
4. **Diagnosers never push.** Each returns a root cause and a proposed patch. The main
   thread applies them and makes **one** fix-forward push. Parallel pushes race on the
   branch, each push sets off another watch, and they make each other's runs compete.

This is orchestrator-workers
(<https://www.anthropic.com/engineering/building-effective-agents>). Subagent results return
to the spawner (<https://code.claude.com/docs/en/sub-agents>). The PR-lane alternative,
`anthropics/claude-code-action`'s `examples/ci-failure-auto-fix.yml`, does not apply here:
it is gated on `pull_requests[0]`, and a direct push has no PR.

## Watching by hand

```bash
node "<plugin>/scripts/ci-watch.js" --sha <sha> [--repo owner/name] [--cwd <checkout>]
```

Run it with `run_in_background`. Exit codes: 0 green (prints nothing), 1 red, 3 no runs,
4 still running, 64 usage or lookup error. The report lands in `$CLAUDE_PLUGIN_DATA`, or
`<tmp>/ci-watch` outside a hook.

## Pitfalls

- **A short sha matches no runs.** `gh run list --commit` needs all 40 characters. The
  script always reads the full sha from the API; pass a short one only through `--sha`,
  which expands it.
- **Zero runs is never green, and neither is all-skipped.** At least one run must
  succeed. A watcher that reports success on an empty or all-skipped list passes every push
  in a repo whose workflows don't run on push.
- **A commit can carry older runs** from a PR or another branch. The hook counts only runs
  created since the push. `--sha` by hand counts every run on the commit.
- **Runs register late**, e.g. a `workflow_run` chain that starts only when its parent
  ENDS. The script requires the run set (ids and statuses) to stay unchanged for the settle
  period after everything has completed.
- **A newer push can cancel an older one's pending run** when the workflow's
  `concurrency` group is keyed on the ref. Key it on `github.sha` for `push` events, or
  every superseded push reports `RED (cancelled)`.
- **The hook reads only the first refspec.** `git push origin feat main` watches nothing.
  Push one branch per command.
- **`asyncRewake` is measured to 25 min** (a 2026-11-07 spike woke an idle session after
  1500 s). The worst case here is about 52 min under the 60-min hook timeout. No cap is
  documented, but that range is unmeasured.
- **`gh run view --log-failed` drops step attribution.** It labels lines `UNKNOWN STEP`.
  That is why the excerpt comes from the raw job log (`gh api …/jobs/<id>/logs`).
