# Contributing

Pull requests from forks are welcome.

- **CI runs the full suite on your PR.** `quick` and `validate` both run, so every failure
  shows up on your PR before review. First-time contributors wait for a maintainer to approve
  the workflow run.
- **Bump the `version`** in `plugins/<name>/.claude-plugin/plugin.json` of every plugin you
  change. A merge to `main` is a release, and `validate` goes red without a bump.
- **A maintainer merges through the merge queue.** After review, they add your PR to the queue.
  The queue re-runs `validate` on your change combined with the latest `main` and merges it if
  green. If it fails there, the PR leaves the queue with the reason on its timeline. Push a fix
  and a maintainer re-queues it.
- The required check is `gate`. It passes only when every other job ended as expected.

The details are in [`CLAUDE.md`](CLAUDE.md) § Shipping a change.
