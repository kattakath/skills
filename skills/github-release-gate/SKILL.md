---
name: github-release-gate
description: This skill should be used when a GitHub repo's main branch is (or is becoming) the release, and merges should happen on their own once CI passes — the user says "set up auto-merge", "auto-merge PRs that aren't from forks", "require CI before merging", "add a ruleset", "make validate required", "delete branches on merge", "every merge to main ships", or reports that "gh pr merge --auto merged immediately" or "Resource not accessible by integration" on a repo setting. Sets up the gate in the one order that is safe, with off-the-shelf parts, and verifies each step against GitHub rather than trusting it.
version: 0.1.0
---

# GitHub release gate — required check first, auto-merge second

For a repo where a merge to the default branch is a release (a versionless plugin
marketplace, a continuously deployed site), you want same-repo PRs to merge on their own once
CI passes, fork PRs to wait for a human, and nothing to reach `main` unvalidated. Every part
of that is off the shelf; what is not is the **order** and the checks. Get the order wrong
and the auto-merge workflow ships unvalidated code the moment a PR opens.

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ 1. CI check  │-->│ 2. Require   │-->│ 3. Allow     │-->│ 4. Arm       │
│ exists, runs │   │ it (ruleset) │   │ auto-merge + │   │ workflow     │
│ on PRs       │   │ VERIFY       │   │ auto-delete  │   │ (not forks)  │
└──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘
```

## 0. Credentials — which token can do what

Steps 2 and 3 are **repo admin** actions. The token a Codespace or an Actions runner injects
as `GITHUB_TOKEN` cannot do them, and cannot re-run workflow jobs either: all three return
`403 Resource not accessible by integration` (measured 2026-09 in a Codespace). Reading
works; PRs, pushes and merges work.

**Human gate:** the repo owner authenticates themselves, for the admin steps only:

```
env -u GITHUB_TOKEN gh auth login --web      # device code; the human approves in a browser
env -u GITHUB_TOKEN gh api ...               # every admin call, same prefix
env -u GITHUB_TOKEN gh auth logout           # when done — the login is saved in plain text
```

`env -u GITHUB_TOKEN` matters: `gh` prefers the env token over a stored login, so without
it the call still runs as the injected token and still gets 403. Leave the admin calls to the
human to run: an agent's permission layer may (rightly) refuse repo-setting changes.

## 1. A CI check that runs on every PR

Confirm the repo has a workflow triggered by `pull_request`, and note its **job name**: that
name (e.g. `validate`), not the workflow name, is the status-check context.

Check: `gh pr checks <n>` on any open PR lists it.

## 2. Require it on the default branch — before anything else

Edit `assets/ruleset.json` (the `context` is the job name from step 1), then:

```
env -u GITHUB_TOKEN gh api -X POST repos/<owner>/<repo>/rulesets --input assets/ruleset.json
```

Pass the body as a **file**. Pasting a long one-line JSON into a terminal wraps it and splits
tokens (`required_status_checks` became `r` + `equired_status_checks`), and a heredoc
pasted with indentation never finds its closing `EOF`.

**Verify on the branch, not by trust** — the first "ruleset added" in the session this came
from was not there:

```
gh api repos/<owner>/<repo>/rules/branches/main -q '.[]|.type'   # must print required_status_checks
```

An empty result means no rule applies to `main`, whatever the settings page seemed to say.

## 3. Allow auto-merge and auto-delete head branches

```
env -u GITHUB_TOKEN gh api -X PATCH repos/<owner>/<repo> \
  -F allow_auto_merge=true -F delete_branch_on_merge=true \
  -q '{allow_auto_merge, delete_branch_on_merge}'
```

Check: both print `true`. If `-q` prints nothing, read it back with a plain
`gh api repos/<owner>/<repo>` — a typo in the filter hides a PATCH that did apply.

## 4. Arm auto-merge on same-repo PRs

Copy `assets/auto-merge.yml` to `.github/workflows/`. It uses
`peter-evans/enable-pull-request-automerge` (pinned by SHA), skips drafts, and skips any PR
whose head repo is not this repo, so fork PRs wait for a human merge. It runs on
`pull_request`, not `pull_request_target`: a fork's run gets a read-only token anyway, and
nothing checks out PR code.

Open it as a PR. Check: on that PR, the `arm` job passes, `gh pr view <n> --json
autoMergeRequest` shows `SQUASH`, and the PR merges only **after** the required check passes.

## Pitfalls

- **`gh pr merge --auto` merges immediately** when the repo has no required checks, instead
  of arming — auto-merge only waits for *required* checks, and a PR with none pending is
  already "clean". The peter-evans action wraps the same call. Measured 2026-09: the PR that
  added the arm workflow merged itself 4 s into its own `arm` job, before its `validate`
  finished. That is why step 2 comes before step 4.
- **Auto-merge off + a required check pending** makes the arm job fail with `Auto merge is not
  allowed for this repository`. Safe (nothing merges), and it means step 3 was skipped.
- **A merge made by `GITHUB_TOKEN` triggers no other workflows**, so the CI's `push: main` run
  does not fire after an auto-merge. The PR run is the gate.
- **A PR opened before the arm workflow existed** is not armed until its branch gets a new
  push. Arm it by hand: `gh pr merge <n> --auto --squash`.
- **Squash merges hide merged branches from `git branch --merged`.** To clean up branches
  left from before auto-delete, match each branch tip to its merged PR's `headRefOid`
  (`gh pr list --state merged --head <branch> --json headRefOid`); a tip that moved after the
  merge needs a look before deleting. For local branches whose remote is gone, the official
  `commit-commands` plugin's `/clean_gone` does it.

## Declarative alternative

The **Settings app** (`repository-settings/app`) keeps steps 2–3 in `.github/settings.yml`:
`repository:` (e.g. `delete_branch_on_merge`) and `rulesets:`. As of 2026-09 its docs mark
rulesets "still under development … expect breaking changes", so verify with the step-2 check
after every sync.

## References

- GitHub: [Automatically merging a pull request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request)
- GitHub REST: [Repository rulesets](https://docs.github.com/en/rest/repos/rules), [Get rules for a branch](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch)
- GitHub: [Triggering a workflow from a workflow](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow) (the `GITHUB_TOKEN` rule)
- [peter-evans/enable-pull-request-automerge](https://github.com/peter-evans/enable-pull-request-automerge)
- [repository-settings/app](https://github.com/repository-settings/app) — `docs/plugins/rulesets.md`
- Source session: kattakath/skills #5 (the self-merge), #6, ruleset 23878103, 2026-09-23
