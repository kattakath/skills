---
name: foundation-audit
description: >-
  Orchestrates a four-dimension foundation audit of a config monorepo — is this repo
  solid enough to build on? Builds ONE calibration brief, fans out four lane-scoped
  agents in parallel (architecture/boundaries, duplication-by-purpose, validation and
  failure modes, dead surface and doc drift), each told what the others cover so it
  stays in its lane, then RE-VERIFIES the top findings itself before relaying a ranked
  report. Use when the user asks "is this repo solid enough to build on", "audit the
  foundations", "what would bite us later", "full architecture review", or before
  committing to a large piece of work on top of an existing config repo. Finds what
  eval gates, structural linters, dead-code linters and CI structurally cannot see.
---

# Foundation audit — four dimensions, four agents, one re-verified report

**The question this answers:** *is this repo solid enough to build on?* Not *does it build* —
the repo's own gates answer that, and this audit is explicitly told to skip anything they catch.

**The premise, from the run this was extracted from:** every finding worth the cost has a
**green build**. Eval passes, the linters pass, CI is green, and nothing reports the defect.
See [`../../references/worked-examples.md`](../../references/worked-examples.md) — three real
SEV-1s, none visible to any of five gates the repo already ran.

## When NOT to run it

- **As a per-PR gate.** It is five agent contexts over a whole repo. Run it at a decision point:
  before a large build-on-top, after absorbing a big change, when onboarding to an unfamiliar
  repo, or when something felt wrong and nothing failed.
- **When the build is red.** Fix the build first; a red build tells you more, faster, for free.
- **As a security review.** It is not one. Different threat model, different method.

## Phase 0 — the calibration brief (blocking, orchestrator only)

**Build it once and hand the same brief to all four lanes.** Four agents calibrating
independently calibrate four different ways, and the report then contradicts itself.

Follow [`../../references/calibration.md`](../../references/calibration.md) § Step 0. The brief
must contain:

1. **The repo's stated conventions and motto** — the grading rubric. Quote it.
2. **The intended layer map**, as the repo asserts it, with which gate enforces each edge.
3. **The gate inventory** — every check, linter, hook and CI job, and what each one catches.
   Lanes are told: *if a gate catches it, it is not a finding.*
4. **The size distribution** — median and p90 lines per source file, so "oversized" is relative
   to this repo.
5. **Pinned vs generated** — which trees have stable line numbers and which rot (C3).
6. **What is mid-flight** — `git log --oneline -40`. A half-landed refactor is not rot.

Also decide and state: **can this session evaluate/build at all?** (`nix --version`, is the
toolchain present). If not, every lane's claims are reading rather than measurement, and that
goes in every lane's UNKNOWNS.

## Phase 1 — fan out, four agents, ONE message

Launch all four in a **single** message so they run in parallel. Each gets, verbatim:

- the path to its lane skill,
- **the whole calibration brief**,
- **the lane table** — what it owns and what the other three cover. This is not decoration:
  without it, all four report the same three obvious findings and the run yields one lane's value
  for four lanes' cost,
- the output contract from
  [`../../references/report-format.md`](../../references/report-format.md).

| Lane | Skill | Hunts |
|---|---|---|
| 1 | [`audit-architecture`](../audit-architecture/SKILL.md) | layer map, **boundary violations no linter can see** (`specialArgs`, overlays, string-interpolated paths, runtime-built store paths, cross-boundary `mkForce`), god-file seams **with the must-stay-fused column** |
| 2 | [`audit-duplication`](../audit-duplication/SKILL.md) | two executables for one **job**; one fact declared twice and able to **silently disagree**; custom code upstream already ships (grep the **pinned** input, cite the line) |
| 3 | [`audit-validation`](../audit-validation/SKILL.md) | every mutating step classified: cannot-fail / loud-and-early / **mid-way mixed state** / **silent**; blast radius; does rollback actually cover it |
| 4 | [`audit-dead-surface`](../audit-dead-surface/SKILL.md) | options declared and never read; unreachable outputs; **guardrails that match nothing**; doc drift a reader would **act on** |

Three instructions go in every lane prompt, and they are the ones agents drop under length
pressure:

- **A CONFIRMED-SOUND section is mandatory** — what you checked and found fine, especially where
  it looks wrong. Knowing what *not* to churn is half the value and it is the only thing stopping
  this becoming a make-work list.
- **An UNKNOWNS section is mandatory and may not be empty.** A labelled gap beats a confident
  guess. Include what you did not test **because testing would mutate the machine**.
- **Verify every claim to a `file:line`.** An unverified claim is worse than none — it costs a
  human a round-trip and teaches them to distrust the rest.

**Lane 3 must be told explicitly: read, do not run.** No activation, no switch, no deploy.

## Phase 2 — re-verify, yourself (non-negotiable)

> **Open the cited file for every SEV-1 and SEV-2 finding and confirm it yourself before you
> relay it.**

In the real run this caught the **orchestrator's own** over-flag — a finding that looked
structural and dissolved on reading the line. Four agents producing confident, well-formatted,
`file:line`-cited findings are persuasive; some of them are wrong.

Mark each one:

```
re-verified ✅              — you opened it and it holds
downgraded to SEV-3 — <why> — real, but not foundation-critical
withdrawn — <why>           — did not survive reading
not re-verified             — say so explicitly; never imply coverage you did not do
```

Also in this phase:

- **Merge cross-lane duplicates.** The same defect will surface in two lanes with two framings.
  Keep the sharper one, cite both lanes, and say that two independent lanes found it — that is
  signal, not noise.
- **Check each finding's third field.** If *"why it matters for a FOUNDATION"* is missing or reads
  as "it is inconsistent", it is a style preference. Cut it or demote it.
- **Reject any lane report missing CONFIRMED-SOUND or UNKNOWNS**, and re-run that lane. An empty
  UNKNOWNS means the lane did not look hard enough — say so.

## Phase 3 — consolidate

One report, the same three sections, in this order:

1. **FINDINGS** — one ranked table, SEV-1 first, each with what / evidence / why-for-a-foundation
   / fix / size / re-verification mark.
2. **CONFIRMED-SOUND** — merged across lanes. A record of **coverage**, never a verdict: write
   "checked X, sound because Y", never "the architecture is sound".
3. **UNKNOWNS** — merged, and never trimmed for length. This is the section that makes the rest
   believable.

Then two lines of framing the maintainer needs:

- **SEV-3 is a backlog, not a to-do list.** Say it explicitly or the report becomes a chore list.
- **A clean lane means four passes found nothing, not that nothing is there.** Absence of
  findings is not proof of soundness.

## Offer, do not apply

The orchestrator **re-verifies and reports**. It does not fix. A foundation finding usually has
more than one right fix and the choice is the maintainer's — present the ranked report and let
them pick what to act on, one change at a time.

## Where to read next

- [`../../references/calibration.md`](../../references/calibration.md) — the eight rules that stop
  the audit flagging deliberate decisions. **Blocking; read it first.**
- [`../../references/report-format.md`](../../references/report-format.md) — the three-section
  contract and the severity scale.
- [`../../references/worked-examples.md`](../../references/worked-examples.md) — the three real
  SEV-1s, each as symptom → why no gate saw it → the general pattern → how to hunt it.
