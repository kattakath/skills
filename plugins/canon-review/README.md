# canon-review

A **read-only** review of the fleet's recent commits against the operator's canon: the
§ Motto handles in kattakath/nix-config's `claude/CLAUDE.md`.
- For each commit it gives a verdict per handle (TOWARD, NEUTRAL or AWAY) with `file:line`
  evidence, and runs the leak gates.
- It ends in a **deterministic** state (`ok` or `problem`) plus a **stable** body.
  `kattakath/.github`'s `canon-review-report.yml` passes both to issue-keeper, which keeps one
  issue open while something is AWAY.
- The procedure is [`skills/canon-review/SKILL.md`](skills/canon-review/SKILL.md). A claude.ai
  cloud task runs it daily, and a session can run it by hand.

## The split: a model judges, scripts decide

| Part | Who | Why |
|---|---|---|
| fleet list, rubric, window, clones | `scripts/inputs.sh`: `curl` + `git`, read **live** from nix-config `main` | one source: no copy of the list or the rubric lives here. No `gh`, no local path, so a cloud session can run it |
| window start | `scripts/window.py` | last successful report run minus 2 h (no gap, no double review); else 26 h; never past 7 days |
| gitleaks, client literals | `scripts/scan.sh` | mechanical. gitleaks comes from `PATH`, else nix, else a **pinned release checked by sha256** (8.30.1). The literal list is ci-land's config, unreachable in a cloud session, so it's `skipped` and the body says so |
| TOWARD / NEUTRAL / AWAY per handle | the model, following SKILL.md | judgement, with evidence. Unsure means PLAUSIBLE, which never opens the issue |
| `ok` / `problem` and the body | `scripts/render.py`, stdlib only | deterministic and tested. No timestamps, ids or counts; sorted by repo@sha plus handle; capped at 60,000 characters by dropping the lowest-ranked findings |

**Why the body cap:** the body travels as a `workflow_dispatch` input, and GitHub's docs say
"The maximum payload for `inputs` is 65,535 characters". 60,000 leaves room for `state`.

**Why a new plugin, not a foundation-audit skill:** foundation-audit audits a whole repo's
foundation with five agent contexts, and its README says not to run it "as a per-PR gate". This
is the opposite shape: per commit, daily, against one rubric, ending in a machine state.

## The daily cloud task

- **Sources:** give the task **kattakath/skills** at `stable`. Nothing here shows a cloud task
  can install a marketplace plugin, so the prompt points at the skill's file in that checkout.
  The other fleet repos don't need to be sources, because `inputs.sh` clones the public ones
  itself.
- **Access:** `gh` authenticated with Actions write on kattakath/.github, for step 4's one
  dispatch.

The prompt line:

> Follow `plugins/canon-review/skills/canon-review/SKILL.md` in the kattakath/skills checkout
> end to end, read-only, with its `scripts/` directory as `<scripts>`. Run inputs.sh and
> scan.sh, judge every commit in the window, write findings.json, then do step 4 by running
> `bash <scripts>/report.sh "$OUT"`, which renders and dispatches. Never dispatch by hand.

- **What `report.sh` sends:** render's state and body, unchanged, to `canon-review-report.yml`
  through the REST `dispatches` endpoint (not `gh workflow run`), with `source=cloud` for the
  scheduler heartbeat.
- **When:** only if the state is exactly `ok` or `problem`.
- **An earlier prompt still works.** A task whose prompt reads "render it, then dispatch" still
  reaches step 4 as SKILL.md now writes it, because the prompt says to follow the skill.

- **Why REST:** in a cloud session (measured 2026-11-28), `gh workflow run` fails with "HTTP 403:
  GitHub GraphQL is not available from Claude Code sessions", while REST calls succeed.
- **The window lookup was REST already:** `inputs.sh` reads `api.github.com` with `curl`, not
  `gh`.

**Network, measured in a real cloud session** (2026-11-28, sources kattakath/.github and
kattakath/skills):

| Reach | Result |
|---|---|
| `raw.githubusercontent.com` (nix-config's CLAUDE.md) | 200 |
| `git clone` of public fleet repos, user-owned ones included | works |
| the gitleaks v8.30.1 release download | 200 |
| REST `dispatches` on kattakath/.github | works; the report run succeeded |
| `api.github.com` on a repo that is **not** a session source | **403** |

So the scripts make exactly one `api.github.com` read: the window lookup on kattakath/.github,
which must stay a session source. Everything per fleet repo goes through `git`. A rejected
`$GH_TOKEN` is retried anonymously; that path was run live with a bogus token.

- **The state is render's, never the model's.** The task passes `render.py`'s first line and
  body file on unchanged.
- **A failed render dispatches nothing,** so a review that didn't finish can't close an open
  issue.
- **Weakest link: the judgement itself.** A model can miss an AWAY, or call a fine commit AWAY.
  PLAUSIBLE keeps guesses out of the issue. A wrong CONFIRMED shows up as an issue the operator
  closes, not as a silent pass.

## By hand

Ask for "a canon review of the fleet's recent commits". The skill runs the same scripts in a
fresh directory and shows you the state and the body, with no dispatch.

## Tests

`bash plugins/canon-review/skills/canon-review/tests/run.sh` runs 61 cases on `render.py`, `window.py`, `scan.sh`, `dump.sh` and `report.sh`:

- golden bodies: a fixture with a confirmed AWAY and leftover gives `problem`; a clean one
  gives `ok`;
- identical bytes for the same input twice, and for the same findings shuffled; no timestamp
  in the body;
- PLAUSIBLE alone stays `ok`, while a gate that found something or failed is `problem`;
- the cap: fits its budget, keeps the top-ranked finding, drops PLAUSIBLE first, counts what's
  hidden, always keeps the gates line, and is stable;
- the window: minus 2 h, the 26 h fallback, the 7-day cap, and a bad timestamp;
- `--gates` overrides a copied `clean` with scan.sh's `failed`; `--commits` refuses a finding on
  an unlisted repo@sha;
- `scan.sh` offline, on a fixture repo with a stub gitleaks: exit 42 is `found`, exit 1 (an
  error) is `failed`, a planted literal is `found`, a broken pattern is `failed`, and no
  pattern text reaches the output;
- invalid input exits 1 with nothing rendered; usage exits 2; `--help` goes to stdout with
  exit 0.

Mutants that drop the sort, or let PLAUSIBLE open the issue, each fail the suite.

**Run live:**
- **Cloud-like shell** (no `gh` or nix, no literal list): `inputs.sh` read 182 commits across 5
  fleet repos through `git log`. `scan.sh` downloaded and checksum-verified gitleaks, then
  scanned clean, with the literals `skipped`.
- **The real pinned gitleaks fires:** a planted fake token exits 42 with
  `--exit-code 42`. Without it, gitleaks exits **1 on an error too** (measured), which is why
  scan.sh sets its own leak code.

## Requires

`git`, `curl`, `jq` and Python 3; `gh` only for the cloud task's dispatch.
