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

### `scripts/poll-guard.js`: no foreground CI polling (since 1.4.0)

A `PreToolUse` (Bash) hook that **denies** waiting on CI inside a turn, with the fix in the
reason. It catches a loop that sleeps around `gh pr checks`, `gh run` or the runs API, and a
blocking `gh run watch` or `gh pr checks --watch`. ci-watch already is the wait for a push to
the default branch; anything else gets ONE `run_in_background` watch.
- **Left alone:** a `run_in_background` call, a one-shot `gh` read, a script being written in
  a heredoc, and words inside quoted text.
- **Measured before it shipped** (2026-11-28, 55,639 Bash calls in 1,155 local transcripts,
  counts only): **63 hits (0.11%)**. Hand-checking all 63 found about **60 real foreground
  waits** (≈95% precision). The doubtful 3 are a markdown note and two multi-part commands
  whose loop, `sleep` and `gh` call may be unrelated.
- **The contract:** a deny is one stdout JSON; otherwise nothing; always exit 0; never
  `updatedInput`.
- **Tests:** 25 cases through the real hook entry (`tests/poll-guard-cases.js`). Mutants that
  ignore `run_in_background`, skip heredoc stripping or skip quote stripping each fail it.
- **The sibling habit** (in-place edits from Bash) is advice, not a deny. It lives in the
  `tool-habits` plugin, with its own measurement.

### `scripts/ci-land`: the landing procedure as one command (since 1.3.0)

The most repeated multi-step Bash across 467 sessions in 31 repos was this procedure, run by
hand. The census counted 520+ `git add` → `nix fmt` → `git add` calls, 430 `git commit` →
`git push`, 317 `git fetch` → `git rebase`, and 261 `git fetch` → `git worktree add`.
`ci-land` does steps 1–4 of it in one process, and the push is the last step:

| Step | What it does | Refuses with |
|---|---|---|
| tree | a dirty tree is never landed | exit 4 |
| sync | `git fetch origin`, `git rebase origin/<default>` | exit 1 |
| repo check | `<root>/.ci-land/check <changed files…>` if the repo ships one (a nix repo runs `nix fmt` and builds the changed output there). It must not change the tree | exit 1 |
| leak gates | gitleaks over `origin/<default>..HEAD`, then the client-literal patterns over the added lines and the messages. Counts only; a pattern is never printed | exit 3 |
| push | `git push <remote> <sha>:<default>`, the sha the gates scanned, over SSH when `.github/workflows` changed. Never a force push | exit 1 |

**Why one command, and why here.**
- **The push stays inside the command.** A preflight that ends with "now run `git push`"
  was rejected: anything between the check and the push could skip or reorder the gates.
- **It lives in ci-watch, not a new plugin,** because this hook has to recognise it. Its
  `if:` matches `Bash(*ci-land*)` and `findPush` reads a `ci-land` run as a push of HEAD to
  the default branch, even from a feature branch. Both copies of that knowledge sit in one
  plugin.
- **Under `scripts/`, not `bin/`:** a plugin with `bin/` can't be installed on claude.ai or
  Cowork, per the plugins reference.

**The literal list fails closed.** Its path comes from `$CI_LAND_LITERALS`, else
`${XDG_CONFIG_HOME:-~/.config}/ci-land/literals`. That's usually a symlink the operator
creates to the real list, which never lives in a repo. If the file is missing, unreadable,
has no patterns or holds a pattern grep can't run, the command **refuses**. A machine with
truly no list says so with the line `# ci-land: no literal patterns`.

**Tests:** `tests/ci-land-cases.sh` runs 22 cases against real git and a local bare remote,
so "nothing was pushed" is checked on the remote itself. Only gitleaks is stubbed. Mutants
that disable the gitleaks gate, the literal gate, the dirty check or the grep-error check
each fail the suite. The hook side has 6 cases in `tests/run.sh`.

### Why green wakes the session instead of only writing a file

**Rejected: write a `GREEN` report but stay quiet.** The report would sit on disk, and the
session would still see nothing until someone went looking for the file.

**The evidence (audit, 2026-11-28) measured the OLD design, not the rejected one.** The old
design wrote **no report at all** on green. Of 120 watched pushes, **111 left no report**.
Checked against GitHub afterwards:

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

**Why that is a judgement call, not a proof.**
- The rejected "report but don't wake" option would **also** have told green apart from a
  lost watch: a green push leaves a file, and a lost one leaves none. The audit doesn't
  separate the two newer designs, because it never ran either.
- The choice rests on ergonomics. A wake-up is a **dead-man signal you see** without asking.
  A file is a signal **you must go and look for**. The audit can't say how often anyone
  would have looked, because the old design left no file to look for.

**What waking on green still misses: late runs.** The 3 Dependabot `dynamic` runs started
17–26 min after the push, after a watch of that push would already have ended. A wake-up on green says the
runs it saw passed. It says nothing about a run that starts later. Watch such a run by sha
by hand (`ci-watch.js --sha <sha>`).

It's deterministic: only `gh` or `glab`, with no model in the loop. Usage, the landing procedure and
the pitfalls are in [`skills/ci-watch/SKILL.md`](skills/ci-watch/SKILL.md).

**Needs:** `node` and an authenticated `gh` on `PATH` — or `glab` for a gitlab.com remote. The
repo's CI needs a `push` trigger for the default branch, or every push reports `NO_RUNS`.
Self-hosted GitLab is not detected: nothing says which other hosts are GitLab, so their
pushes stay quiet.

**Tests:** `bash tests/run.sh` (no network; `gh`, `glab` and `git` are one fixture stub).
