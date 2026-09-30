# brag-dossier

Turn a session's discovery into **one organized, fact-checked source document** — the kind other
agents can safely derive posts, articles, slides and video from, because every claim is tagged and
traced to a record.

```
BRIEF (intent) --> FACTS (records) --> write / verify / assemble / critique --> review --> draft PR
```

The name joins a **brag document** — Julia Evans' practice of recording what you did and why it
mattered — with a **dossier**, a file of sourced documents on one subject. The bragging is earned:
every claim carries its evidence.

## The two stages that do the work

**FACTS comes from records, never memory.** The writer agents never see the conversation; `FACTS.md`
is their only source of truth, built from `gh pr list`, `gh run list`, `git log` and spot-checked
research, with every line tagged `[measured]` / `[source]` / `[inferred]`.

**Verification is adversarial, per section, as soon as each is written.** It assumes errors and
checks every number, date, link, tag and diagram against FACTS.

## What it ships

| File | Role |
|---|---|
| `assets/BRIEF.template.md` | The spec: the discovery as one testable claim, audiences in priority order, the author's framing constraints |
| `assets/FACTS.template.md` | Setting, chronological log **with the dead ends**, change ledger, verified research, distilled lessons |
| `assets/dossier-workflow.js` | The pipeline — parallel writers, per-section fact-checkers, one assembler, one critic, one fixer |

## First run, measured 2026-09-23

`docs/agent-map.md` in this repo: 21 agents, ~30 minutes, ~2.0M subagent tokens, 280 tool calls,
no agent errors. The numbers that should change how you use it:

- The fact-checkers made **132 corrections** and **removed 42 claims** they could not trace —
  overgeneralisations, plausible-but-unrecorded details, and opinions tagged `[measured]`. Writers
  invent details even with a strict FACTS sheet, so the verify stage is not optional.
- The critic found **22 gaps**, nearly all cross-section contradictions that no per-section checker
  can see: the same number stated from two baselines, the same rule drawn in two orders.
- The document came out at **37,852 words against a 6–10k target**. Nine writers each "complete"
  their part. Give each section group a word budget if length matters.

## Pitfalls worth knowing before the first run

- **Writers invent what FACTS lacks.** The fix is a fuller FACTS, not a stricter prompt.
- **Parallel agents hit GitHub's rate limit** (HTTP 429 on raw and content reads, three research
  agents was enough). Give writers local files; keep network reads to the fact-checkers.
- **Agents drop scratch files into the repo.** Say where they may write, and check `git status`.
- **A ready PR auto-publishes** on an auto-merge repo. Land it as a **draft** —
  see [`github-release-gate`](../github-release-gate).

## The human gate

Trace five numbers and two quotes back to a record, confirm nothing `[inferred]` has been promoted
to `[measured]`, and check the ASCII diagrams by **display width, not bytes** — box-drawing
characters are 3 bytes each, and `awk length` reported 142 over-wide lines where there were none.
