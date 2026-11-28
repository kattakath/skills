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

### Why green wakes the session instead of only writing a file

**Rejected: write a `GREEN` report but stay quiet.** The report would sit on disk, and the
session would still see nothing. A watch that died, timed out or never started would look
the same as a pass, unless someone went looking for the file.

**The evidence (audit, 2026-11-28).** Of 120 watched pushes, **111 left no report** under the
quiet-green design. Checked against GitHub afterwards:

| Of the 111 silent pushes | Count |
|---|---|
| green, so the silence was right | 98 |
| Dependabot `dynamic` runs created 17–26 min after the push | 3 |
| unverifiable, because GitHub returned 404 | 10 |

- In 13 of 111 cases, the silence proved nothing. The 3 late runs started after any watch
  of the push would have ended, and the other 10 couldn't be checked.
- The only way to tell the cases apart was a manual check after the fact, and 10 couldn't be
  checked at all.
- Waking on green costs one line per push, and it makes a lost watch visible: no line means
  no watch.

It's deterministic: only `gh` or `glab`, with no model in the loop. Usage, the landing procedure and
the pitfalls are in [`skills/ci-watch/SKILL.md`](skills/ci-watch/SKILL.md).

**Needs:** `node` and an authenticated `gh` on `PATH` — or `glab` for a gitlab.com remote. The
repo's CI needs a `push` trigger for the default branch, or every push reports `NO_RUNS`.
Self-hosted GitLab is not detected: nothing says which other hosts are GitLab, so their
pushes stay quiet.

**Tests:** `bash tests/run.sh` (no network; `gh`, `glab` and `git` are one fixture stub).
