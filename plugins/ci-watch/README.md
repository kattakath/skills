# ci-watch

Push to the default branch and keep working. A `PostToolUse` **asyncRewake** hook waits on
every GitHub Actions run (or, for a gitlab.com remote, every GitLab pipeline) the pushed
commit triggered, and wakes the session on every outcome, green included. Each status, and what it needs, is
in one table: [`skills/ci-watch/SKILL.md` § When a wake-up arrives](skills/ci-watch/SKILL.md#when-a-wake-up-arrives).

**Green wakes too, on purpose** (since 1.2.0). A silent green looked exactly like a watch
that was lost, so no push could be told apart from an unwatched one. Every watched push now
writes a JSON report (`schema: ci-watch/report@1`). Every wake-up names its outcome, and all
but GREEN print the report's path. For a failure, the report holds the full sha, changed files, run/job/step ids and URLs, the numbered log
lines around `##[error]` cut to the failing step, and the rerun commands.

It's deterministic: only `gh` or `glab`, with no model in the loop. Usage, the landing procedure and
the pitfalls are in [`skills/ci-watch/SKILL.md`](skills/ci-watch/SKILL.md).

**Needs:** `node` and an authenticated `gh` on `PATH` — or `glab` for a gitlab.com remote. The
repo's CI needs a `push` trigger for the default branch, or every push reports `NO_RUNS`.
Self-hosted GitLab is not detected: nothing says which other hosts are GitLab, so their
pushes stay quiet.

**Tests:** `bash tests/run.sh` (no network; `gh`, `glab` and `git` are one fixture stub).
