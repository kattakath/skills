---
name: canon-review
description: >-
  Review the fleet's recent commits against the operator's canon (the § Motto handles in
  kattakath/nix-config's claude/CLAUDE.md), read-only. It judges each commit TOWARD / NEUTRAL /
  AWAY per handle with file:line evidence, runs the leak gates, and renders a deterministic
  ok/problem state plus a stable issue body for issue-keeper. Use when the daily canon-review
  cloud task runs it, or when asked to "review the fleet's commits against the canon", "run a
  canon review", "did anything drift from the motto", or to check a window of fleet commits.
---

# canon-review: the fleet's recent commits against the canon

**Read-only, always.** Never push, comment, open an issue or edit a file in any fleet repo.
The daily cloud task's **one** write is the report dispatch in step 4. The workflow it starts
runs issue-keeper, which is the only thing that touches an issue.

- `<scripts>` means this skill's `scripts/` directory (`${CLAUDE_PLUGIN_ROOT}/skills/canon-review/scripts`).
- `$OUT` is a fresh directory (`OUT=$(mktemp -d)`).
- **Needs:** `git`, `curl`, `jq` and `python3`. No `gh`, no local path. The scripts clone the
  public fleet repos themselves.

## 1. Inputs, live

```bash
bash <scripts>/inputs.sh "$OUT"    # --since ISO to review a chosen window instead
bash <scripts>/scan.sh "$OUT"      # leak gates over the same window
```

- **`$OUT/motto.md` is the rubric.** It is § Motto of nix-config's `claude/CLAUDE.md`, read now
  from `main`. Judge against **that text**, its handle table and bullets. Never against a summary
  of it, including any wording here.
- **`$OUT/commits.json`** lists each fleet repo, cloned blob-less into `$OUT/work/<owner>_<repo>`,
  with its default-branch commits in the window. The list itself comes from nix-config's
  `.claude/skills/fleet-doctor/fleet-repos.txt`.
- **`$OUT/window.json`** records the start:
  - normally the last **successful** `canon-review-report.yml` run in kattakath/.github, minus
    2 h, so there's no gap and no double review;
  - with no readable run, 26 h back;
  - never more than 7 days back.
- **`$OUT/gates.json`** holds the mechanical leak gates:
  - **gitleaks** comes from `PATH`, else `nix run`, else a pinned release verified by sha256.
  - **The client literals** run only if the list is reachable. In a cloud session it isn't, so
    they record `skipped`, and the body says so.

## 2. Judge each commit

Read each diff from its clone: `git -C "$OUT/work/<owner>_<repo>" show <sha>`. For every handle
in `motto.md` that a commit touches, give a verdict:

| Verdict | Means |
|---|---|
| `TOWARD` | the commit applies the handle's rule, its stricter part included |
| `NEUTRAL` | the handle doesn't bear on it |
| `AWAY` | the commit breaks the rule. Needs a one-line **fix** |

- **Every verdict carries evidence:** a `path:line` or a short quote from the diff. A verdict
  you can't point at is not a finding.
- **When unsure, write `PLAUSIBLE`, not `CONFIRMED`.** A PLAUSIBLE finding is listed but never
  opens the issue.

**Hunt for these specifically.** Each is an `AWAY` once confirmed:
- hand-rolled code where an upstream or already-pinned primitive does the job;
- a second copy of a fact, and above all one that has **already drifted** (name both places);
- a claim stronger than its evidence: a number never measured, or "verified" with no check;
- an open loop with no watcher: a follow-up nobody is told about, a scheduled job nothing reads;
- leftovers from a reverted path, and dead code. Use `"kind": "leftover"` for these;
- a new failure mode: an activation that can fail, a race, an `errexit` hole, a silent no-op,
  a check that measures nothing;
- data, or a personal or client fact, in these **public** repos;
- a third-party ref that isn't a reviewed, pinned SHA.

Flag a departure from the written rule, not from your taste. The operator's design choices
are his.

## 3. Write the findings, then render

Write `$OUT/findings.json`:

```json
{
  "schema": "canon-review/findings@1",
  "gates": { "gitleaks": "clean", "literals": "skipped" },
  "findings": [
    { "repo": "kattakath/skills", "sha": "<full sha>", "handle": "one source",
      "verdict": "AWAY", "confidence": "CONFIRMED", "severity": "high",
      "evidence": "plugins/x/README.md:12 restates the fleet list",
      "fix": "link to fleet-repos.txt instead" }
  ]
}
```

- `gates` is `$OUT/gates.json` verbatim.
- `handle` is spelled exactly as in `motto.md`.
- `severity` is `high` | `medium` | `low` (default `medium`); `kind` is `leftover` or absent.

Then render. It's deterministic, and no model takes part:

```bash
python3 -I <scripts>/render.py "$OUT/findings.json" --gates "$OUT/gates.json" \
  --commits "$OUT/commits.json" --out "$OUT/body.md" | head -1          # state=ok|problem
```

- `--gates` makes scan.sh's own file the gates, whatever was copied into `findings.json`.
- `--commits` refuses a finding on a repo@sha that inputs.sh didn't list.

- `problem` means a CONFIRMED `AWAY`, or a leak gate that found something or didn't run.
- The body is **stable**: no timestamps, no run ids, no counts, sorted and keyed by repo@sha
  plus handle. So issue-keeper's dedupe holds while nothing changed.
- It's capped at 60,000 characters, because GitHub caps a dispatch's inputs at 65,535. The
  lowest-ranked findings drop first, with a count of how many.
- An invalid findings file exits 1 and renders nothing.

## 4. Report: the cloud task only

**By hand, stop here** and show the user the state and the body. Only the daily cloud task
runs this step, and it runs it as one script, so nothing in between can edit the body or
overrule the state:

```bash
bash <scripts>/report.sh "$OUT"      # --dry-run prints the plan and sends nothing
```

`report.sh` renders the findings again (with `--gates` and `--commits`). It dispatches
kattakath/.github's `canon-review-report.yml` only when render finished with a state of exactly
`ok` or `problem`:
- **Through the REST `dispatches` endpoint, not `gh workflow run`.** In a claude.ai cloud
  session `gh workflow run` fails with "HTTP 403: GitHub GraphQL is not available from Claude
  Code sessions" (measured 2026-11-28).
- **With `source=cloud`,** so the report workflow pings its scheduler heartbeat. A hand
  dispatch defaults to `manual`, so it can't mask a dead schedule.
- **Exit 1 means nothing was dispatched.** Say why instead: a review that didn't finish must not
  close an open issue.
