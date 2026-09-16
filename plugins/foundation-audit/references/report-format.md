# Report format — the three-section contract

**Every lane returns three sections. A report missing any one of them is rejected and re-run.**

The findings section is the obvious one. The other two are what make the audit trustworthy, and
they are the parts an agent will drop under length pressure. They are not optional.

```
## FINDINGS        ranked, each verified to a file:line
## CONFIRMED-SOUND  what was checked and is fine — so nobody churns it
## UNKNOWNS         what was NOT established, and why
```

## 1. FINDINGS — ranked, four fields each

Ranked by severity, highest first. No prose paragraphs; one block per finding.

```
### [SEV-1] <one-line title naming the mechanism, not the file>

**What is wrong** — the defect, in one or two sentences.
**Evidence** — `path/to/file.nix:112` — the exact line or construct. Generated file? grep anchor (C3).
**Why it matters for a FOUNDATION** — what a consumer builds on top of this inherits or loses.
**Fix** — the specific change, not a direction.
**Size** — one-line | one-file | cross-cutting
```

### Severity scale

| | Meaning | Examples |
|---|---|---|
| **SEV-1** | **The foundation is unsafe to build on.** Something believed true is false, and nothing reports it | a step that fails **silently**; mixed state on a live host; a guardrail believed armed that matches nothing; personal state shipped in a published artifact |
| **SEV-2** | **Will bite a consumer**, loudly, at a predictable moment | one fact declared in two places that can disagree; a doc step a reader would run and have fail; an unreachable gate; a boundary edge the layer map forbids |
| **SEV-3** | **Cost, not risk.** Nothing breaks; the repo is more expensive than it needs to be | god-file seams, dead options, two entry points for one job, redundant custom code |

**The discriminator is the third field.** If you cannot write a specific sentence for *why it
matters for a foundation*, it is not a foundation finding — it is a style preference. Drop it.
"It is inconsistent" is not an answer to that field.

SEV-3 is a **backlog**, not a to-do list. Say so in the consolidated report.

## 2. CONFIRMED-SOUND — what NOT to churn

A list of the things you **checked and found correct**, each with the file and the reason it is
correct — especially where it *looks* wrong.

```
- `modules/shared/foo.nix` — the `../../claude/CLAUDE.md` source literal is repo-relative by
  necessity (eval-time store copy); it is **not** a missing `$HOME` path. Do not "fix".
- The two `gh-app-*.age` files hold identical key material **on purpose** — `secrets.nix:31`
  states the reason (same App, two owning users) and it still holds.
```

This section is half the product. Knowing what not to touch is what stops an audit becoming a
make-work list, and it is the only defence against the next agent re-flagging the same
deliberate decision.

**It is a record of coverage, not a verdict.** Write "checked X, sound because Y", never "the
architecture is sound".

## 3. UNKNOWNS — mandatory, never empty

> **A labelled gap beats a confident guess.**

Every lane has them. A lane returning an empty UNKNOWNS section did not look hard enough, and
the orchestrator should say so.

```
- **Not tested: whether `activate` is idempotent on a second run.** Establishing it requires
  RUNNING an activation, which mutates this machine. Read-only reasoning says yes for steps
  1-4 and cannot decide step 5 (`modules/darwin/x.nix:88`, writes then re-reads).
- **Not established: whether `local.foo.bar` is read by an out-of-tree consumer.** Dead in this
  tree; it may be a public API. Needs the maintainer.
- **Could not evaluate**: `nix` unavailable in this session, so every claim about what the flake
  BUILDS is eval-free reading only.
```

Three kinds belong here, and the first is the one agents wrongly omit:

1. **Not tested because testing would mutate the machine** — activations, deploys, `switch`,
   anything that writes outside the repo. Say what you would have run.
2. **Not decidable from the tree** — out-of-tree consumers, private downstreams, runtime-only
   behaviour, anything gated on credentials.
3. **Not reached** — you ran out of budget, the file was too large, the generated artifact was
   not present. Name it rather than implying coverage.

## The consolidated report (orchestrator only)

Same three sections, merged, plus two things only the orchestrator can supply:

- **A re-verification line per SEV-1/SEV-2**: `re-verified ✅` / `downgraded to SEV-3 — <why>` /
  `withdrawn — <why>`. The orchestrator opens the cited file itself. Findings it did not
  re-verify are labelled as such.
- **A merge note** where two lanes found the same defect from different angles: keep the sharper
  framing, cite both lanes. Two framings of one defect is signal, not duplication — say so.
