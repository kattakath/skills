---
name: history-scrub
description: >
  This skill should be used when a literal that must not be public — a client or employer
  name, a real identity, an internal hostname, a leaked value — has landed in a PUBLIC git
  repo's history and has to come out of it. Triggers on "scrub this from git history",
  "rewrite history to remove X", "this name must not be in the public repo", "purge the
  client name from main", "force-push a cleaned history", "remove sensitive data from the
  repo". Census first, fix the tip forward, back up, rewrite the minimal range, prove the
  tree is unchanged, push with a pinned lease — then clean the places a rewrite cannot reach.
---

# history-scrub

Removing a literal from a public repo's history is three jobs, and a rewrite does only the
middle one: **stop the bleeding** (tip + PR text), **rewrite** (commits), **chase the
copies** a rewrite cannot touch (PR refs, cached views, forks, other clones).

## 0. Is it a SECRET? Rotate first.

A token, key or password is compromised the moment it was pushed — scrapers index public
pushes within minutes. Rotate it at the issuer **before** anything below; the rewrite is
hygiene, not remediation. GitHub's own guidance says Support assists with removal mainly
when rotation cannot mitigate the risk. A name or hostname cannot be rotated — that is when
the rewrite is the remediation.

## 1. Census — find every copy before touching anything

```bash
git fetch origin
git log --all -i -G '<term>' --format='%h %ad %s' --date=short   # diffs (content)
git log --all -i --grep '<term>' --oneline                        # commit MESSAGES
git log --all -i -G '<term>' --format='== %h' --name-only          # WHICH files
git grep -i -c '<term>' origin/<default> -- .                      # live tree
```

- **`-G` hits that `git show` does not print** are files git classes as binary, or very long
  single-line files (minified HTML). Use `--name-only` to see which; do not conclude "false
  positive" because the diff looks clean.
- Also search the forge's text, which no rewrite touches: PR/MR titles, bodies, comments,
  review comments (`gh pr view <n> --json title,body,comments`), release notes, issues.
- **Decide the range.** Older hits outside the change you are cleaning may have been
  deliberate (a résumé page naming an employer). Ask before widening a rewrite into years of
  history; a wider range rewrites more SHAs and breaks more references.

## 2. Stop the bleeding on the tip

1. **Open PRs touching the term:** convert to draft (`gh pr ready <n> --undo`) so auto-merge
   cannot land mid-edit; fix them, or merge/close them. GitHub's guidance is to merge or close
   open PRs before rewriting — every rewritten SHA strands a PR built on it.
2. **Fix forward** on the default branch through the normal lane, so the tip tree is clean.
   Rename identifiers generically (`claude:work:oauth`, not `claude:<client>:oauth`), and
   migrate any runtime state keyed by the old name.
3. **Rewrite PR/issue text** with `gh pr edit <n> --body-file <clean.md>`. The forge keeps the
   **edit history**, visible to anyone — note it for § 6.

Done right, the tip tree after the rewrite equals the tip tree before it — which is the
check in § 4.

## 3. Back up, then rewrite the minimal range

1. **Backup to a PRIVATE repo, by SHA, before rewriting:**
   `git push git@github.com:<owner>/<repo>-prerewrite-backup.git <old-tip-sha>:refs/heads/prerewrite-<YYYY-MM-DD>`
   and confirm with `git ls-remote` that the branch points at `<old-tip-sha>`.
2. **Rewrite.** Preferred (GitHub's recommendation): `git filter-repo --replace-text
   <expressions.txt>` in a **fresh clone** (filter-repo refuses a non-fresh one). Where a
   fresh clone is unavailable (a sandboxed agent session limited to its own worktree), the
   fallback rewrites only a branch over the minimal range:

   ```bash
   git switch -c scrub origin/<default>
   FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --tree-filter \
     'test -f <path> && perl -pi -e "s/<old>/<new>/g" <path>; true' \
     -- <last-clean-sha>..scrub
   git update-ref -d refs/original/refs/heads/scrub    # drop filter-branch's backup ref
   ```

   Replace with the SAME generic value the fix-forward used, so history and tip agree.

## 4. Prove it — three checks, all must pass

```bash
git grep -i -c '<term>' $(git rev-list <last-clean-sha>..scrub) -- .   # expect: no output, exit 1
git log --format=%B <last-clean-sha>..scrub | grep -ci '<term>'         # expect: 0
git rev-parse <old-tip-sha>^{tree} scrub^{tree}                         # expect: the SAME hash twice
git rev-parse 'scrub~<N>'                                               # expect: <last-clean-sha>
```

An identical tip tree proves the rewrite changed history and nothing the code does. If the
trees differ, stop: the fix-forward and the rewrite disagree.

## 5. Push with a PINNED lease

```bash
git push --force-with-lease=<default>:<old-tip-sha> origin scrub:<default>
```

Pin the lease to the backed-up SHA, not a bare `--force-with-lease`: a bare lease compares
against whatever `origin/<default>` your last fetch saw, so a background fetch can silently
re-arm it over a peer's push. A protected branch needs an admin bypass; the push output lists
the rules it bypassed. Bare `--force` is never needed.

## 6. Chase what the rewrite cannot reach

| Copy | What happens | Action |
|---|---|---|
| Other checkouts / worktrees | `pull --ff-only` now FAILS (diverged) | `git fetch && git reset --keep origin/<default>` — `--keep` refuses to clobber local changes |
| Open PR branches | still on old SHAs | rebase onto the new default (not merge) |
| GitHub `refs/pull/*` | **read-only**, keep the old commits reachable | GitHub Support |
| PR "Files changed", cached SHA views, PR body edit history | still served | GitHub Support |
| GitLab `refs/merge-requests/*` | push-delete REJECTED ("deny deleting a hidden ref"), even after the MR is deleted | keep the project private, or rebuild it clean before it goes public |
| Forks, others' clones | untouchable | accept, or ask owners |

## Pitfalls

- **Binary-classified matches** look like a clean `git show` — see § 1.
- **Rewriting before the PR merges** brings the literal's removal diff back on top: merge the
  fix-forward PR first, rewrite after.
- **Runtime state keyed by the old name** (Keychain items, env bindings, config keys) outlives
  the code change — migrate it, verify the new name works end to end, then delete the old one.
- **Do not narrate the literal** in the commit messages, PR bodies or memory that record the
  scrub — describe it ("the client name"), never spell it.

## References

- GitHub Docs, *Removing sensitive data from a repository* — git-filter-repo,
  `refs/pull/` read-only, cached views and PR references need Support, collaborators must
  rebase: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository
- git-filter-repo `--replace-text`: https://github.com/newren/git-filter-repo
- `git push --force-with-lease=<ref>:<expect>`: https://git-scm.com/docs/git-push
