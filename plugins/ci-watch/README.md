# ci-watch

Push to the default branch and keep working. A `PostToolUse` **asyncRewake** hook waits on
every GitHub Actions run (or, for a gitlab.com remote, every GitLab pipeline) the pushed
commit triggered:

| Outcome | What reaches the session |
|---|---|
| all runs pass | **nothing** |
| a run fails, is cancelled or times out | a `ci-watch RED` wake-up |
| no run appears | `NO_RUNS` |
| a run is still going at the ceiling | `STILL_RUNNING` |

Each wake-up carries a summary and the path to a JSON report (`schema: ci-watch/report@1`).
The report holds the full sha, changed files, run/job/step ids and URLs, the numbered log
lines around `##[error]` cut to the failing step, and the rerun commands.

It's deterministic: only `gh` or `glab`, with no model in the loop. Usage, the landing procedure and
the pitfalls are in [`skills/ci-watch/SKILL.md`](skills/ci-watch/SKILL.md).

**Needs:** `node` and an authenticated `gh` on `PATH` — or `glab` for a gitlab.com remote. The
repo's CI needs a `push` trigger for the default branch, or every push reports `NO_RUNS`.
Self-hosted GitLab is not detected: nothing says which other hosts are GitLab, so their
pushes stay quiet.

**Tests:** `bash tests/run.sh` (no network; `gh`, `glab` and `git` are one fixture stub).
