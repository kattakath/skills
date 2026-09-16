# foundation-audit

**Is this repo solid enough to build on?**

Not *does it build* — the repo's own gates answer that, and this audit is explicitly told to skip
anything they catch. It hunts the class of defect that has a **green build**: eval passes, the
linters pass, CI is green, and nothing anywhere reports the problem.

Four dimensions, four parallel lane-scoped agents, one orchestrator that **re-verifies the top
findings itself** before relaying them.

```
/foundation-audit
```

## When to run it

| Run it | Don't run it |
|---|---|
| Before committing to a large piece of work **on top of** an existing config repo | As a per-PR gate — it is five agent contexts over a whole repo |
| After absorbing a big change (a merge, an extraction, a satellite absorbed in-tree) | When the build is **red** — fix that first; it tells you more, faster, free |
| Onboarding to an unfamiliar repo you now own | As a security review — different threat model, different method |
| When something felt wrong and **nothing failed** | To generate a chore list |

## The four dimensions

Each lane is a separate agent, **told explicitly what the other three cover** so it stays in its
lane. Without that, all four report the same three obvious findings and the run yields one lane's
value at four lanes' cost.

| Lane | Catches |
|---|---|
| **1 · architecture** | Whether the asserted layering actually holds — and specifically the violations a structural linter **cannot** see: a value smuggled across a boundary via `specialArgs`, an overlay mutating `pkgs` for everyone from inside a leaf, a **string interpolated into a path** (no import edge until substitution), a runtime-built store path, a lower layer `mkForce`-ing an upper layer's decision. Plus god-file seams — and for every oversized file, **what must stay fused**, not just what splits |
| **2 · duplication** | Redundancy judged by **purpose**, not text: two executables for one job even when they share no code; **one fact declared in two places** — a port, a path, a label, a URL — which can silently disagree because the two copies are in different *languages* and no single linter sees both; and custom code an upstream dependency already ships, proved by grepping the **pinned** input's option surface and citing the result |
| **3 · validation** | Every activation/setup/deploy step classified into four buckets — cannot-fail, fails **loud and early**, fails **mid-way leaving mixed state**, fails **silently**. The last two are the findings. Plus blast radius per step, and the question everyone skips: *does the stated rollback actually cover this step?* |
| **4 · dead surface** | Options declared and never read, unreachable outputs and entry points, **guardrails whose pattern can no longer match anything**, and the only doc drift that counts — a step, path, count, flag or URL a reader would **act on** and be wrong |

## What made it work — the parts that are the product

A vague "audit this repo" reproduces none of this. The specificity in
[`skills/`](skills/) and [`references/`](references/) is the deliverable.

- **A mandatory CONFIRMED-SOUND section per lane**, separate from findings. *Knowing what not to
  churn is half the value* — and it is the only thing stopping the audit becoming a make-work
  list, or the next agent re-flagging the same deliberate decision.
- **Mandatory, non-empty UNKNOWNS.** *A labelled gap beats a confident guess.* Including what was
  **not tested because testing would mutate the machine** — lane 3 reads activation scripts, it
  never runs one.
- **Calibration against the repo's own conventions**, blocking, built once by the orchestrator
  and handed identically to all four lanes. Uncalibrated agents flag correct things as bugs, and
  a report whose first three items are deliberate decisions gets closed with the two real
  findings still inside it. Eight rules in
  [`references/calibration.md`](references/calibration.md); three that carry most of the weight:

  | | |
  |---|---|
  | **C1** | Past-tense **history** in a comment is not drift. *"Rejected 2026-09-13 because X"* is an asset; deleting it re-opens a settled question. Drift is a **present-tense** claim the code does not perform |
  | **C2** | A `${pkgs.foo}/bin/foo` reference **cannot** be missing at runtime — it is in the closure by construction. A **bare command name** or a **non-store absolute path** can. Only flag the latter two |
  | **C3** | A line-number citation into a **pinned input** is stable; one into a **generated** file rots — the same construct was measured at **three different line numbers in one afternoon**. Cite generated files by grep anchor |

- **Verify every claim to a `file:line`.** An unverified claim is *worse* than none: it costs a
  human a round-trip and teaches them to distrust the rest of the report.
- **The orchestrator re-verifies the top findings itself** before relaying. Four agents producing
  confident, well-formatted, cited findings are persuasive; some are wrong. In the real run this
  phase caught **the orchestrator's own over-flag**.
- **Findings ranked by severity**, each with four fields: what is wrong, **why it matters for a
  foundation**, the fix, and its size. The second field is the discriminator — if you cannot write
  a specific sentence for it, the finding is a style preference.

## Worked examples — what the real run found

One repo, one afternoon, 2026-09-15. All three were fixed the next day. None was visible to any
of the five gates that repo already ran. Full write-ups, each as *symptom → why no gate saw it →
the general pattern → how to hunt it*, in
[`references/worked-examples.md`](references/worked-examples.md).

### Silent success — lane 3

An upstream module's `exit 0` — perfectly reasonable inside a function — sat inside a snippet
that the framework **string-concatenates** into one activation script. So it was a top-level exit
of the *whole* script, at line **1818 of 2040**. Everything after it never ran, including the
`ln -sfn … /run/current-system` at line 2034. The system profile advanced; the symlink that
`PATH` resolves through did not. `switch` printed no error and exited 0.

> **The pattern:** a snippet authored as if it owns the process, composed into a script it does
> not own. `exit`, top-level `return`, `trap … EXIT`, `set -e`/`set +e` — all change meaning when
> concatenated, and the composition is invisible from the snippet's own file.

### A guardrail that matched nothing — lane 4

A `deny` rule existed specifically to block the one thing the repo's own ADR forbids. It had
never fired: the tool's **plugin prefix had been renamed**, and the rule kept the old spelling.
Twelve more rules in the same repo had the same rot. The tell was already in the tree —
**one** entry had been updated and twelve had not, and one file carried *both* spellings for the
same server, seven dead lines directly above seven live ones.

> **The pattern:** a pattern is only a guardrail if something it is meant to match still exists.
> A rename on the *matched* side silently disarms every rule on the *matching* side — and
> **nothing, anywhere, reports a rule that never fires.** Generalises to `.gitignore`, CI path
> filters, `CODEOWNERS`, lint excludes, log alerts, firewall rules.

### A template shipping personal state — lane 1

A published starter template (`nix flake init -t`) called the repo's composition API with a host
**name**, which the API interpolated into a path indexing **its own** `hosts/` directory. A
stranger following the template's own instructions would have materialised the author's second
**admin account**, both self-hosted CI runner lanes, and 34 of his Homebrew casks — and the
create switch is also the *delete* switch, so it was destructive in both directions.

> **The pattern:** a parameter that is a **name resolved in the provider's namespace** is not a
> parameter — it is a default the consumer cannot see. The fix is always *pass the thing, not its
> name*. And because the seam is a string substituted into a path, there is no import edge for a
> structural linter to follow.

**What the three have in common:** builds ✅, evaluates ✅, CI ✅, reported ❌.

## Layout

| Piece | What it owns |
|---|---|
| `skills/foundation-audit/` | The orchestrator: the calibration brief, the fan-out, the re-verification phase, consolidation |
| `skills/audit-architecture/` | Lane 1 — layer map, the five invisible channels, god-file seams with the fused column |
| `skills/audit-duplication/` | Lane 2 — D1 one job/two executables, D2 one fact/two declarations, D3 custom vs pinned upstream |
| `skills/audit-validation/` | Lane 3 — the four-bucket classification, the silent-failure grep list, blast radius, rollback coverage |
| `skills/audit-dead-surface/` | Lane 4 — unread options, unreachable outputs, rules that match nothing, actionable doc drift |
| `references/calibration.md` | **Blocking.** The eight rules that stop the audit flagging deliberate decisions |
| `references/report-format.md` | The three-section contract and the severity scale |
| `references/worked-examples.md` | The three real SEV-1s, in full, with the hunt recipes |
| `commands/foundation-audit.md` | `/foundation-audit` — the four required phases |

Each lane skill is also usable on its own: `/foundation-audit --lane validation`, or invoke
`foundation-audit:audit-validation` directly.

## Limits — read before trusting a report

- **N = 1.** One repo, one afternoon. The four dimensions and the three non-obvious mechanics are
  validated by that run; **the severity calibration is not.** Treat SEV boundaries as a starting
  proposal.
- **It reads; it does not execute.** Lane 3 never runs an activation, so everything that would
  need running is an **UNKNOWN by construction** — which is precisely why the UNKNOWNS section is
  mandatory rather than a courtesy.
- **A clean lane means four passes found nothing, not that nothing is there.** CONFIRMED-SOUND is
  a record of **coverage**, never a verdict. It says *"checked X, sound because Y"*, never *"the
  architecture is sound"*.
- **It is Nix-shaped.** The four dimensions are general; the grep recipes assume
  Nix / nix-darwin / home-manager / flakes. On a non-Nix repo the lanes still apply and most of
  the commands do not — expect to re-derive them, and expect lane 2's D3 (pinned upstream option
  surface) to need the most translation.
- **It cannot replace the repo's gates**, and is explicitly told not to duplicate them. If your
  build is red, this is the wrong tool.
- **Cost is real:** five agent contexts over a whole repo. Not a pre-commit hook.
- **Findings need a human.** The orchestrator re-verifies; it does not fix. Most foundation
  findings have more than one right fix and the choice is the maintainer's.
- **Make-work is the residual risk.** The CONFIRMED-SOUND section, the severity scale and the
  mandatory *why it matters for a foundation* field all exist to suppress it, and a determined
  agent can still produce plausible SEV-3s. **SEV-3 is a backlog, not a to-do list.**
- **No scripts, no gates, no CI hook.** This plugin is prompts and references only, deliberately:
  every mechanism it hunts is one that resisted mechanisation. Where a check *would* work, the
  repo should have the check instead — and lane 4 will tell you so.

## Licence

MIT.
