# history-scrub

A procedure skill for taking a literal that must not be public out of a public git repo's
history — and for the parts a rewrite cannot reach.

## What it carries

- **Order that avoids re-leaking:** census → fix the tip forward and merge it → back up by
  SHA to a private repo → rewrite the minimal range → prove → push. Rewriting before the
  fix-forward merges brings the literal back in the merge's diff.
- **A proof, not a hope:** zero matches in every rewritten commit and message, and the new
  tip **tree** hash equal to the old one — the rewrite changed history and nothing the code
  does.
- **A SHA-pinned lease** (`--force-with-lease=<branch>:<sha>`), because a bare lease follows
  whatever your last fetch saw.
- **What survives a rewrite**, per GitHub's own docs: read-only `refs/pull/*`, cached SHA
  views, PR "Files changed" and body edit history (GitHub Support), forks and clones. On
  GitLab, `refs/merge-requests/*` reject push-deletes even after the MR is deleted.
- **A sandbox fallback:** `git filter-branch --tree-filter` over a branch, for agent sessions
  that cannot make the fresh clone git-filter-repo requires.

## Requires

`git`; `git-filter-repo` for the preferred path; `gh` for PR text.
