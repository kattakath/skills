# Calibration — read before producing a single finding

An uncalibrated audit agent flags the repo's **deliberate decisions** as bugs. That is the
dominant failure mode, not missed findings: a report whose first three items are things the
maintainer chose on purpose gets closed, and the two real findings underneath it go with it.

Calibration is therefore **blocking**. Do it first, in full, then audit.

## Step 0 — build the brief (the orchestrator does this ONCE)

Four agents calibrating independently calibrate four different ways. The orchestrator reads
these and hands **one** brief to all four lanes:

| Read | For |
|---|---|
| `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.cursorrules` | the repo's stated conventions and its **motto** — the grading rubric |
| `.claude/rules/*`, `.claude/skills/*` | rules the maintainer already mechanised; a rule's existence means the question is settled |
| `docs/`, especially ADRs and any `*-adr.md` | decisions with reasons. An ADR's §"what execution found the design got wrong" is gold |
| the gate inventory — CI workflows, `checks.*`, lint configs, hooks | **what already fails the build** |
| `git log --oneline -40` | what is mid-flight. A half-landed refactor is not rot |

Then measure two numbers and put them in the brief:

```bash
# file-size distribution, so "oversized" is relative to THIS repo
find . -name '*.nix' -not -path './.git/*' | xargs wc -l | sort -n | awk '{print $1}' \
  | awk '{a[NR]=$1} END {print "median", a[int(NR/2)], "p90", a[int(NR*0.9)]}'
# which trees are pinned inputs (stable line numbers) vs generated (rotting line numbers)
git ls-files | grep -E 'lock|\.generated\.|result' ; ls -d /nix/store/*-source 2>/dev/null | head
```

## The calibration rules

### C1 — past-tense HISTORY in a comment is not drift

A comment that records what **was** is a decision record, and deleting it re-opens a settled
question:

```nix
# Rejected 2026-09-13: stylix rewrites every app's config; measured 4/16 coverage on
# Terminal.app anyway, so it bought nothing. Do not re-propose.
```

That is an asset. **Drift is a comment in the PRESENT tense asserting behaviour the code does
not perform** — `# opens port 8096` above a module that opens nothing. Test: strip the tense.
If the sentence claims a fact about the code as it is now, verify it. If it narrates a past
event, leave it alone and do not count it.

### C2 — in Nix, a store reference cannot be missing at runtime

| Construct | Can it be absent when the code runs? | Flag it? |
|---|---|---|
| `${pkgs.foo}/bin/foo`, `${cfg.package}/bin/x`, `lib.getExe pkgs.foo` | **No.** It is a store path; the reference puts it in the closure by construction | **Never** |
| a bare command name — `jq`, `curl`, `gh`, `rg` | **Yes.** Depends on the caller's `PATH`, which activation and launchd do not guarantee | Yes |
| a non-store absolute path — `/opt/homebrew/bin/x`, `/usr/local/bin/x`, `~/.local/bin/x` | **Yes.** Nothing in the closure provides it | Yes |
| `/usr/bin/*`, `/bin/*` on macOS | No (OS image), but it **is** an undeclared assumption | Note, do not rank as a defect |

The inverse trap, and it is real: a **bare** `stat`/`rm`/`sed` may resolve to **GNU** coreutils
where the code wants BSD. `stat -f` and `rm -P` are BSD-only spellings — a bare call is the bug
and `/usr/bin/stat` is the fix, which is the exact opposite of the usual advice. Read what the
flags mean before ranking either direction.

### C3 — a line number is only as stable as the file under it

- Into a **pinned input** (a flake-locked store path, a vendored tree, a tagged dependency):
  stable for the life of the pin. Cite `file:line` freely.
- Into a **generated file** (a rendered activation script, a built wrapper, `result/*`, a
  lockfile, anything under `/nix/store/*-activate`): **it rots.** The same construct was
  measured at three different line numbers in one afternoon. Cite it by a **unique grep-able
  string** instead, and give the grep:

  ```
  BAD   /nix/store/…-activate:412
  GOOD  /nix/store/…-activate — the line matching `grep -n 'exit 0' …` (3 hits, the 2nd)
  ```

### C4 — a documented, dated exception is not a finding

If the repo names an anti-pattern and says why it keeps it, the only finding available to you is
**"the stated justification has expired"** — and you must quote the justification and say what
changed. Without that, it goes in CONFIRMED-SOUND.

### C5 — the repo's motto is the rubric, not yours

A repo whose stated priority is *off-the-shelf over hand-rolled* makes "custom code that
upstream already ships" a **real** finding. A repo that deliberately vendors to avoid supply
chain risk makes the same observation a non-finding. Read the motto; grade against it.

### C6 — "oversized" and "too many" are relative

Use the median/p90 from the brief. A 600-line file in a repo with a 40-line median is a
god-file; in a repo with a 400-line median it is ordinary. Never carry a line-count threshold in
from another project.

### C7 — do not report what a gate already catches

If `nix flake check`, a linter, a hook or CI **already fails** on it, it is a red build, not a
foundation finding. Name the gate and move on. The entire value of this audit is what the gates
**structurally cannot see** — so if you can point at the gate that catches your finding, delete
the finding.

### C8 — verify to a `file:line`, or do not say it

Every claim carries the path and line you read to establish it. An inferred claim ("this
probably reads the option") is worth **less than no claim**, because it costs a human a
verification round-trip and it teaches them to distrust the rest of the report.

If you could not verify it, it is not a finding — it is an **UNKNOWN**, and it goes in that
section with the reason.
