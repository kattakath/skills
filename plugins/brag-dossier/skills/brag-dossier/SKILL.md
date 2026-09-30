---
name: brag-dossier
description: This skill should be used when a session produced a discovery worth telling others about and the user wants it written up as one organized, sourced document — "document this discovery", "write a brag doc / brag dossier about this", "show off what we figured out", "write this up properly", "turn this session into a field guide / white paper / case study", "make a grand document with diagrams, tables, Q&A and references", "prepare source material for LinkedIn / Medium / YouTube / slides", or "structure this vague idea into a prompt for the next agent". Turns a vague intent into a BRIEF, the session's records into a FACTS sheet, then runs parallel section writers, an adversarial fact-check against FACTS, assembly and a completeness critic, and lands the result as a draft PR.
version: 0.1.0
---

# Brag dossier — from a session's discovery to one fact-checked source document

A discovery usually lives in a transcript nobody will reread. This skill turns it into one
structured document that people can learn from and that **other agents can safely derive
content from** — posts, articles, slides, videos — because every claim in it is tagged and
traced to a record. It does the part nobody else does: the fact-grounded source. Channel
formatting is inherited (see § 6).

The name joins two ideas: a **brag document**, the practice of keeping a record of what you
did and why it mattered so others can see it (Julia Evans, "Get your work recognized: write a
brag document", 2019, https://jvns.ca/blog/brag-documents/), and a **dossier**, a file of
sourced documents on one subject. Bragging here is earned: every claim carries its evidence.

```
┌──────────┐   ┌──────────┐   ┌──────────────────────┐   ┌──────────┐   ┌──────────┐
│ 1. BRIEF │-->│ 2. FACTS │-->│ 3. write ─> verify   │-->│ 4. review│-->│ 5. draft │
│ intent   │   │ records  │   │ assemble ─> critique │   │ by hand  │   │    PR    │
└──────────┘   └──────────┘   └──────────────────────┘   └──────────┘   └──────────┘
```

## 1. BRIEF — absorb the intent, write the spec

Users ask for this vaguely ("a grand document with diagrams, Q&A, references…"). Restate it
as a brief before any writing: copy `assets/BRIEF.template.md` and fill in

- the discovery as one testable claim, and the one-sentence core idea;
- audiences in priority order — when agents will derive content from it, they come first;
- the author's framing constraints (e.g. "the metaphor is illustrative, not literal");
- format preferences stated in the request (ASCII diagrams first is the default);
- the component list for § 7 and seed questions for "why this, not that".

Show the user a short summary of the brief. Check: every requirement in their message
maps to a line in the brief.

## 2. FACTS — from records, never from memory

The writer agents do **not** see the conversation. Everything they may state goes into
`FACTS.md` (from `assets/FACTS.template.md`): the setting, a chronological log with the
dead ends, a change ledger, verified research, the resulting system, distilled lessons.

- Build the ledger from the records, e.g.
  `gh pr list --state merged --json number,title,mergedAt,mergeCommit,mergedBy`,
  `gh run list --workflow <ci>.yml --event push`, `git log --format='%h %as %s'`.
- Tag every line `[measured]` / `[source]` / `[inferred]`; date anything that changes
  (stars, counts).
- Research from subagents is a claim until checked: spot-check the load-bearing items
  (papers via the arXiv API over **https**, repos via `gh api`) and drop what fails.
- Name the checkout path writers may read, and say they must not write inside it.

Check: pick three numbers at random from FACTS and trace each to a record.

## 3. Write → verify → assemble → critique

Put BRIEF.md and FACTS.md in one scratch directory, then run the pipeline:

- **With multi-agent orchestration opted in** (the user said so, or ultracode is on): run
  `assets/dossier-workflow.js` with the Workflow tool, `args: {dir: "<scratch dir>", out:
  "<repo>/docs/<name>.md"}` (optionally `sections: [...]` to change the default 9-way split).
- **Otherwise:** the same stages with the Agent tool — writers in parallel, then one
  fact-checker per section, then one assembler, then one critic — or say what it would cost
  and ask.

What each stage does (all in the script):

| Stage | Per | Job |
|---|---|---|
| Write | section group | Draft from BRIEF + FACTS + repo files only; save to `sections/NN.md` |
| Verify | section, as soon as it is written | Assume errors; check every number, date, link, tag and diagram against FACTS and the repo; fix in place; report corrections and removals |
| Assemble | once | One H1, structure order, TOC, reconcile terms and numbers, no new facts |
| Critique | once | Compare with BRIEF and FACTS; list gaps with exact fixes; a fixer applies them |

## 4. Review — the gate the agents cannot be

Before landing, by hand:

- Trace five numbers and two quotes back to FACTS and a record.
- Every `[inferred]` still says inferred; nothing measured is overstated.
- ASCII diagrams render in a plain code fence and fit 70 columns. Count display
  characters, not bytes: box-drawing characters are 3 bytes each, and `awk length` (even
  under a UTF-8 locale with mawk) reported 142 "wide" lines where there were none.
  ```
  python3 -c "import sys,unicodedata as u;f=0
  for i,l in enumerate(open(sys.argv[1],encoding='utf-8'),1):
   if l.startswith('\`\`\`'):f=not f;continue
   w=sum(2 if u.east_asian_width(c) in 'WF' else 1 for c in l.rstrip('\n'))
   if f and w>70:print(i,w)" <doc>
  ```
  Wide JSON or command blocks are fine; wide diagrams are not.
- Mermaid blocks parse (paste one into a renderer if unsure).
- Nothing private leaked: tokens, one-time codes, personal data, third parties by name.

## 5. Land — as a draft PR

Open it as a **draft** PR in the content repo. If the document describes files that are not
merged yet (the skill that produced it, say), ship them in the same PR so its claims stay
true. On a repo where same-repo PRs auto-merge
(`github-release-gate`), a ready PR ships the moment CI passes; publishing a public
document is the author's call. Human gate: they mark it ready.

## 6. Derivatives — inherit, don't build

The dossier's content kit (§ 16 of the structure) is the hand-off. For the channel work,
use an existing skill before writing one (search the map and the indexes as
`capability-broker` does); candidates seen 2026-09: `claude-blog`'s `blog-repurpose`
(skills.sh, 2.2K installs), `linkedin-poster` and `social-banner` in the community
marketplace, `content-repurposing` skills on skills.sh. Vet each by the usual bar before
adopting it through the harness.

## First run (measured, 2026-09-23)

`docs/agent-map.md` in kattakath/skills: 21 agents (9 writers, 9 fact-checkers, assembler,
critic, fixer), about 30 minutes, about 2.0M subagent tokens, 280 tool calls, no agent errors.

- The fact-checkers made **132 corrections** and **removed 42 claims** they could not trace:
  overgeneralizations ("every", "on", "all PRs"), plausible but unrecorded details (durations,
  "voice-typed", repo owners not in FACTS), and opinions tagged `[measured]`. Writers invent
  details even with a strict FACTS sheet, so the verify stage is essential.
- The critic found **22 gaps**, mostly cross-section contradictions (the same number stated
  from two baselines, the same rule drawn in two orders) that no per-section checker can see.
- The document came out at **37,852 words** against a 6–10k target.

## Pitfalls

- **Length overshoot.** Nine writers each "complete" their part, and the total came out at
  about 4× the target. If length matters, give each section group a word budget in `sections`
  and have the critic check it.
- **Writers invent what FACTS lacks.** The fix is a fuller FACTS, not a stricter prompt.
- **Numbers from memory drift.** Rebuild the ledger from the API every time.
- **Parallel agents hit GitHub's rate limit** (HTTP 429 on raw and content reads, measured
  2026-09-23 with three research agents). Give writers local files; keep network reads to
  the fact-checkers, or pre-fetch into the scratch directory.
- **Agents drop scratch files into the repo.** Say where they may write; check
  `git status` before committing.
- **A ready PR auto-publishes** on an auto-merge repo. Draft first.

## References

- Pattern sources: adversarial verification and completeness critic (workflow authoring
  guidance), evidence tagging, ACE's itemized updates (arXiv 2510.04618).
- Templates: `assets/BRIEF.template.md`, `assets/FACTS.template.md`; pipeline:
  `assets/dossier-workflow.js`.
- First use: kattakath/skills `docs/agent-map.md`, 2026-09-23.
