# Merge queue — when it is worth it, and the three traps

Plain auto-merge (SKILL.md) is the default. A merge queue is a second gate on top of it,
and it was adopted and then removed on a real fleet (2026-08-22 → 2026-09-22). This is the
record, so the next adoption is a decision rather than a reflex.

## What it costs

A queue cannot reduce a pipeline to one CI run. GitHub: *"Once a pull request has passed
all required branch protection checks, a user with write access to the repository can add
the pull request to the queue"* — the PR is gated first, then the queue re-runs the same
gate on its own `gh-readonly-queue/main/...` entry. Measured on one PR: 10m27s CI on the
PR, 21 s to enqueue, **7m29s** in the queue, 18m56s open → merged.

## What it buys

- **No stall under "require branches up to date".** Plain auto-merge does not update a
  stale head branch, so with `strict_required_status_checks_policy` on, the second of two
  open PRs waits forever. A queue tests the projected merge instead. But: with strict
  **off**, plain auto-merge has nothing to stall on, and that reason disappears.
- **Cross-PR semantic conflicts** (two PRs green alone, broken together). Only real at
  queue depth > 1; a solo maintainer's queue depth is usually always 1.

Adopt one when several people land PRs concurrently and strict up-to-date matters. Not
otherwise.

## The accidental grace period

The queue's extra run also delayed every merge by minutes after going green. A branch still
being pushed to was silently relying on that. Without a queue, auto-merge fires the moment
the required checks go green — measured: a PR squashed two phases and left five later
commits behind. **Mitigation: open work-in-flight as a draft.** Arming survives the draft
state and releases on `ready_for_review`.

## Before re-adopting: three traps

1. **Organization-only.** `POST /repos/{owner}/{repo}/rulesets` with a `merge_queue` rule
   on a repo owned by a *user* account returns `422 Validation Failed, Invalid rule
   'merge_queue'`, with no hint that ownership is the cause. A Free org is enough for
   public repos.
2. **Every workflow producing a required context needs `merge_group:`.** A queue entry's
   ref emits neither `pull_request` nor `push`; a required check without the trigger never
   reports, and the entry times out (`check_response_timeout_minutes`, 60 min default).
3. **The queue merges as the GitHub Merge Queue app, not as you.** It re-evaluates every
   ruleset rule as itself and is not in `bypass_actors`; an admin bypass does not transfer.
   A rule it cannot satisfy removes the entry in ~15 s ("branch protection failure that
   could not automatically be resolved") with no queue ref, no runs and no rule-suite
   entry — the queue page looks empty while the PR still shows "queued". The "bypass
   rules" merge checkbox does not help.

Source: kattakath/nix-config `docs/auto-merge-and-merge-queue.md` §3.
