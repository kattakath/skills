# github-release-gate

Make a repo's default branch a safe release: same-repo PRs merge on their own once CI passes, fork
PRs wait for a human, and nothing reaches `main` unvalidated.

Every part of that is off the shelf. What is not off the shelf is **the order**.

```
1. CI check runs on PRs --> 2. require it (ruleset) --> 3. allow auto-merge --> 4. arm it
```

## Why the order is the whole product

**`gh pr merge --auto` merges immediately when the repo has no required checks.** Auto-merge only
waits for *required* checks, so a PR with none pending is already "clean". Measured 2026-09: the PR
that added the arm workflow merged itself **4 seconds into its own `arm` job**, before its
`validate` finished. Step 2 exists before step 4 for that reason.

Get step 2 wrong in the other direction — auto-merge not yet allowed, a required check pending —
and the arm job fails with `Auto merge is not allowed for this repository`. That is safe; nothing
merges.

## Why the App token is not optional

Arm auto-merge with a **GitHub App installation token**, never `GITHUB_TOKEN`. Events produced by
`GITHUB_TOKEN` start no workflow runs, so every auto-merge lands on `main` silently: no `push: main`
CI, no deploy. Measured 2026-09 — two auto-merged PRs, zero `push: main` runs, and the head branch
was not deleted either despite `delete_branch_on_merge`.

Setting the gate up is a different credential again: **the repo owner's own login**. A
`GITHUB_TOKEN` injected by a Codespace or a runner cannot create a ruleset, patch repo settings or
re-run workflow jobs — all three return `403 Resource not accessible by integration`. And `gh`
prefers the env token over a stored login, so every admin call needs the `env -u GITHUB_TOKEN`
prefix or it silently runs as the wrong identity.

## What it ships

| File | Role |
|---|---|
| `assets/ruleset.json` | The required-status-check ruleset; pass it as a **file** (`--input`), never a pasted one-liner |
| `assets/auto-merge.yml` | The arm workflow — mints the App token, arms squash auto-merge, both actions SHA-pinned; skips drafts and forks; runs on `pull_request`, not `pull_request_target` |
| `references/merge-queue.md` | The costs and three traps of a merge queue, before adopting one |

## Verify on the branch, not by trust

```
gh api repos/<owner>/<repo>/rules/branches/main -q '.[]|.type'
```

Must print `required_status_checks`. An empty result means no rule applies to `main`, whatever the
settings page appeared to say — the first "ruleset added" in the session this came from was not
actually there.

## One pitfall that costs commits

**Auto-merge fires the moment required checks go green, even while commits are still being
pushed** — a PR can merge with its later commits left behind. Open work in progress as a **draft**:
arming survives the draft state and releases on `ready_for_review`.
