# canon-review

**Say "canon review" in any session.** The skill reviews every fleet commit since the last
review against the operator's canon: the § Motto handles in kattakath/nix-config's
`claude/CLAUDE.md`, read live.
- For each commit it gives a verdict per handle (TOWARD, NEUTRAL or AWAY) with diff evidence.
- It runs the leak gates, the client literals included, because it runs **locally**.
- It ends in a **deterministic** state (`ok` or `problem`) plus a **stable** body.
  kattakath/.github's `canon-review-report.yml` passes both to issue-keeper, which keeps one
  issue open while something is AWAY.

The procedure is [`skills/canon-review/SKILL.md`](skills/canon-review/SKILL.md). It's read-only,
apart from that one report dispatch.

## The split: a model judges, scripts decide

| Part | Who | Why |
|---|---|---|
| fleet list, rubric, clones, window, size | `scripts/inputs.sh`, read **live** from nix-config `main` | one source: no copy of the list or the rubric lives here |
| window start | `scripts/window.py` + `inputs.sh` | the last successful report run minus 2 h, or `--since ISO\|sha`. **No cap**, because on-demand runs can be weeks apart. No prior report means exit 3: pass `--since` |
| gitleaks, client literals | `scripts/scan.sh` | mechanical. gitleaks comes from `PATH`, else a **pinned release checked by sha256**, through the ONE resolver it shares with ci-land (ci-watch's `gitleaks-resolve.sh`, copied here by `build-index.py` and drift-checked). The literals come from ci-land's config |
| reading | `scripts/dump.sh` | one file per repo: a short-to-full sha table, then each commit's message, `--stat` and diff capped at 400 lines. A cut is marked with the files it hid |
| TOWARD / NEUTRAL / AWAY per handle | the model, following SKILL.md | judgement, with evidence. CONFIRMED only when re-checkable at HEAD in one step; anything else is PLAUSIBLE, which never opens the issue. Operator-ruled exceptions sit in `references/exceptions.md` |
| `ok` / `problem` and the body | `scripts/render.py`, stdlib only | deterministic. It refuses a listed commit with no verdict, an unknown handle, or an unlisted sha. The body has no timestamps, ids or counts, and is capped at 60,000 characters (GitHub caps dispatch inputs at 65,535) |
| the report | `scripts/report.sh` | renders, then dispatches `state` and `body` through the REST `dispatches` endpoint, and only for a state of exactly `ok` or `problem` |

**The size comes first.** `inputs.sh` writes the commit count and changed lines to
`window.json` before any reading starts.
- Measured cost: about **4 minutes and ~320k tokens** for 48 commits and ~7,000 diff lines.
- A weeks-long window is therefore the user's call, splittable with `--since`, never a silent cut.

**Why a new plugin, not a foundation-audit skill:** foundation-audit audits a whole repo's
foundation with five agent contexts, and its README says not to run it "as a per-PR gate". This
is per commit, against one rubric, ending in a machine state.

## History: the daily cloud task (retired 2026-11-28)

It ran daily as a claude.ai cloud task for one day, and three lessons from it stay in the code:
- **The first live run rubber-stamped:** it read subjects only and wrote `findings: []`.
  `render.py` now refuses any listed commit without a verdict.
- **`gh workflow run` failed** there with "HTTP 403: GitHub GraphQL is not available from
  Claude Code sessions", so `report.sh` uses REST.
- **The cloud proxy refused `api.github.com` for repos that weren't session sources,** so
  per-repo work goes through `git`.

The operator then made the review on-demand. The scheduler heartbeat and its `source` input
are gone.

## Tests

`bash plugins/canon-review/skills/canon-review/tests/run.sh` runs 68 cases:
- **golden bodies:** a fixture with a confirmed AWAY and leftover gives `problem`; a clean one
  gives `ok`;
- **stability:** identical bytes for the same input twice and for shuffled findings, no
  timestamp in the body, and a stable cap that keeps the top-ranked finding;
- **coverage:** empty or partial findings are refused, and `report.sh` sends nothing on a
  rubber stamp;
- **`--gates`, `--commits` and `--motto`:** scan.sh's file wins, unlisted shas are refused, and
  misspelt handles are refused;
- **the window:** minus 2 h, no cap, and no prior report exits 3;
- **`scan.sh`, offline:** exit 42 is `found`, exit 1 (an error) is `failed`, a planted literal
  is `found`, a broken pattern is `failed`, and no pattern text is printed;
- **the shared resolver:** a tampered download fails its sha256 and installs nothing;
- **`dump.sh`:** sections, stat, the sha table, the cap and the files it names;
- **`report.sh`:** REST endpoint, exactly `state` and `body`, nothing sent on invalid findings or
  `--dry-run`;
- **usage:** usage errors exit 2, and `--help` goes to stdout with exit 0.

Mutants each fail the suite: no sort, PLAUSIBLE opening the issue, no coverage check, no handle
check. Measured live: the pinned gitleaks fires on a planted fake token (exit 42). Without
`--exit-code`, gitleaks exits **1 on an error too**, which is why scan.sh sets its own leak code.

## Requires

The plugin enabled where you say "canon review" (on the operator's Mac, nix-config's declared
plugin set). Also `git`, `curl`, `jq`, Python 3, and `gh` for the report dispatch.
