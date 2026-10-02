---
name: prior-art-recon
description: "Use before building, standardising, publishing or investing effort in anything meant to fill a perceived gap. Triggers on 'is there anything like this already?', 'search if this exists', 'is this a real gap?', 'am I reinventing the wheel?', 'has someone solved this?', 'should I build this or is it taken?', 'is this worth doing?', 'is there a standard for this?', 'I think I found an opportunity'. Returns a kill-first verdict, the terrain map of standards, bodies and regulations that govern the space, the primary sources where the decision was actually argued, and — when the gap is real but should not be filled — what to change in the operator's own design so the need disappears."
version: 0.1.0
---

# Prior-art recon — find out if the gap is real before you spend a year on it

**What:** a multi-lane research mission that tries to **kill** a proposed idea, and — whether it
dies or survives — hands back the **vocabulary and terrain** of the space so the operator knows
what to search for next time.

**When:** before writing a spec, originating a convention, starting a project meant to fill a
gap, or investing in a pattern you believe is novel. Also when you simply want the map of a
domain you are new to.

**The failure it prevents:** months of work on something the ecosystem already decided against,
discovered only after publication — or never, leaving a live public repo as a monument to it.

---

## Rule 0 — the mission must be able to kill the idea

Every lane is told, in its own brief, verbatim:

> **Your job is to find the existing solution and end this project. A null result ("nothing
> exists") is the WEAKEST outcome of your work. Finding prior art is SUCCESS.**
> The operator has explicitly said the goal is NOT to validate his enthusiasm.

Without this, lanes find gaps because gaps are the pleasing answer.

**Set the bar BEFORE dispatching**, as explicit AND-conditions, so the answer comes back
decision-shaped:

> Worth pursuing = (a) nothing existing covers it, AND (b) evidence people feel the pain,
> AND (c) the mechanism actually reaches the tools claimed, AND (d) no incumbent is shipping it.
> **Any one failing kills it.**

One lane per condition. The lane most likely to earn its keep is the one that kills.

---

## The four lanes

| Lane | Question | Kill verdict |
|---|---|---|
| **Prior art** | Does the thing already exist, under a name I don't know? | `EXISTS — stop` |
| **Demand** | Does anyone actually feel this pain, or is it an absence nobody minds? | `NO DEMAND — stop` |
| **Reach** | Does the proposed mechanism actually work where it's claimed to? | `CLAIM FAILS` |
| **Incumbent** | Is someone bigger already shipping it, and can an individual win here anyway? | `ALREADY TAKEN — stop` |
| **Doctrine** | **Even if the gap is real — SHOULD it be filled, and filled this way?** | `GAP REAL — WRONG APPROACH` · `GAP IS AN ARTIFACT` |

Fewer than five for a small question; never fewer than **prior art + demand + doctrine**.
**Doctrine is not optional.** The other four can all come back positive and the answer still be
no — see § The fourth kill.

---

## Rule 1 — hunt where decisions are MADE, not where they are published

**This is the rule that produces the knowledge you cannot find by searching.** Documentation
states conclusions. The reasoning, the dissent and the rejected alternatives live elsewhere:

| Source | What it yields |
|---|---|
| **Commit messages on the spec/policy itself** | why it changed, and the rationale in the author's own words |
| `Reviewed-by` / `Acked-by` counts on that commit | how much consensus it carried |
| **Issue and PR threads, especially closed-as-rejected** | the alternative that lost, and why |
| **Mailing lists, RFC threads, governance votes** | the strongest objection anyone raised |
| **`git log -S` / `git log -p` on the spec's own history** | features that were **added then removed** — the single highest-value find |
| Working-group minutes, SIG agendas | what is in flight but unpublished |

> **Demand at least one verbatim quote from a human arguing**, with its date, author and link —
> not a documentation sentence.

**A feature that was specified, shipped, then deliberately deleted is the strongest possible
finding.** It means the idea was not overlooked; it was tried and rejected by people with
standing. Look for it explicitly.

---

## The fourth kill — a real gap that should not be filled

**The other lanes answer "does it exist / does anyone want it / does it work / can I win".
None of them asks "SHOULD it be done, and done this way?"** A gap can be genuine and filling it
still be wrong, for four distinct reasons. The Doctrine lane must test all four and name which
applies.

| Reason | What it looks like | What to report |
|---|---|---|
| **Direction** | the gap is real, but the ecosystem is actively moving away from it | who is moving, which way, dated |
| **Doctrine** | a principled argument against this approach, held by people with standing | the argument at full strength, with its author and venue |
| **Alternative** | a different mechanism already achieves the same end, in a shape you did not recognise | the alternative, and why it was not obvious |
| **Artifact** | **the gap exists only because of how the operator built the thing he is building** | **what to change in his design so the need disappears** |

### The Artifact case is the highest-value finding in this whole skill

The operator discovered the "gap" *while architecting something*. That is exactly the condition
under which a gap can be self-inflicted: it is real inside his design and absent in a different
one. **Adopting the existing answer may require rearchitecting the system he was building when
he found it — and that is a legitimate, even preferable, outcome.**

So the Doctrine lane must explicitly ask:

> **Is this gap a property of the problem, or a property of my design?**
> If I removed the assumption that led here, does the need survive?

And when the answer is "artifact", the deliverable is **not "stop"** — it is:

1. **The assumption that created the gap**, named.
2. **The design change that dissolves it**, concretely.
3. **What that change costs**, honestly — because the rearchitecture may be larger than the
   workaround, and the operator decides, not the lane.

**Worked examples, both measured in one session (2026-10-01):**

- *A Bluetooth beacon as a secondary channel to a server.* Real gap: no out-of-band path. But
  the serial console was **already enabled** in the host's boot config, and `ICMP + LAN :80`
  already separated every recorded failure. The gap existed because the question assumed a
  *new radio* rather than *an unused existing channel*. Design change: use what is already on.
- *Per-agent VCS attribution.* Real gap at role level. But cloud agents already carry distinct
  **bot identities in the author field**, and the "human is the accountable party" principle
  dissolves the rest. The gap existed because the design put many agents behind one credential.
  Design change: give the agents identities, or accept the human as the actor.

---

## Rule 2 — name the terrain, including every dead end

The operator cannot search for what he cannot name. **Every standard, body, spec, regulation,
protocol, acronym and tool encountered goes in the map — especially the ones that turned out
irrelevant**, with one line on what it governs and one on why it did or didn't apply.

Starting points by domain, to be expanded per mission, never treated as complete:

- **Supply chain / provenance:** in-toto, SLSA, SPDX, CycloneDX, SBOM / ML-BOM / AI-BOM, sigstore, OpenSSF
- **Telemetry / observability:** OpenTelemetry semantic conventions (and its SIGs), W3C Trace Context
- **Provenance modelling:** W3C PROV-O / PROV-DM
- **Regulatory:** EU AI Act (cite the *article*), NIST SP 800-218 / 218A, ISO/IEC 42001, SOC 2, OMB memoranda
- **Governance precedent:** Linux kernel `Documentation/process/`, Debian General Resolutions, Apache/CNCF/LF policies, git's own `SubmittingPatches`
- **VCS convention:** DCO, Conventional Commits, Gerrit, git trailers, git notes

**A dead end explained is worth as much as a hit.** "W3C PROV-O has exactly the right shape and
no git binding anywhere" teaches more than silence.

---

## Rule 3 — specified is not adopted. Measure them separately.

A spec existing proves nothing about use. Measure adoption **outside its originating project**:
code search, dependent counts, stars with dates, whether tooling enforces it.

**Beware search instruments that lie.** GitHub commit search *tokenises* — identical phrase
queries returned 65M and 94M minutes apart in one mission. **Any count you cannot reproduce is
retracted, loudly.** Prefer facets (labels, dependents, releases) over full-text counts.

---

## Rule 4 — report the direction of travel, not just the state

> Is the ecosystem **adding** this or **removing** it?

A field being stripped out, a mandate being softened, projects banning the practice — these are
worth more than a feature's presence, because they predict where it is going. State it with
dates and name the projects moving each way.

---

## Rule 5 — write the counter-argument at full strength

Each lane must compose **the best possible version of "this is a non-problem"** — not a straw
man — and then say whether it believes it. Where an adjacent problem was already solved by
other means, that solution is the counter-argument and must be engaged, never dismissed.

---

## Rule 6 — evidence discipline

- Label every claim **measured** (you ran it) / **cited** (URL) / **assumed**.
- **An unsearched "nothing exists" is a guess, not a finding.** List negative searches
  explicitly — they are part of the deliverable and they show where the gaps in the sweep are.
- **Flag the weakest assumption and what single measurement would settle it.**
- Report exhausted budgets, unreachable sources and retracted numbers. A lane that says
  "Reddit was unreachable, so enterprise pain is uncovered" is more useful than one that
  quietly omits it.

---

## Required deliverable shape

```
VERDICT: <EXISTS — stop | NO DEMAND — stop | ALREADY TAKEN — stop | CLAIM FAILS
          | GAP REAL — WRONG APPROACH | GAP IS AN ARTIFACT OF MY DESIGN
          | PARTIAL | GENUINE GAP — proceed>
         ...in the FIRST LINE, unsoftened. If the verdict is GAP IS AN ARTIFACT,
         the redesign section below is MANDATORY and is the main deliverable.

TERRAIN MAP        every standard/body/spec/regulation/tool met, incl. dead ends,
                   one line each on what it governs and why it did or didn't apply
WHERE IT WAS       primary sources that are NOT documentation — commits, reviews,
DECIDED            threads, votes — with verbatim quotes, authors and dates
CLOSEST EXISTING   described precisely, and exactly what it does NOT cover
DIRECTION OF       adding or removing, dated, with projects named on each side
TRAVEL
SPECIFIED vs       separately measured; instruments named; unreproducible counts retracted
ADOPTED
COUNTER-ARGUMENT   at full strength, then assessed honestly
NEGATIVE SEARCHES  explicit list, including what could not be reached
WEAKEST            and the one measurement that would settle it
ASSUMPTION
SHOULD IT BE       direction / doctrine / alternative / artifact — which applies, or none
FILLED AT ALL
IF ARTIFACT        the assumption that created the gap · the design change that dissolves
                   it · what that change costs. THIS REPLACES "stop" AS THE DELIVERABLE.
IF IT SURVIVES     what the job actually is — who won comparable fights and what they had
                   (a legal forcing function? a server that refuses? a tool that breaks
                   the build? multi-vendor coordination?) — and the realistic timeline
```

---

## Pitfalls

- **A lane that wants to please finds a gap.** Rule 0 is not decoration; without the explicit
  "finding prior art is success", briefs drift toward confirmation.
- **Zero-friction conventions do not spread.** If nothing breaks when you ignore it, nothing
  drives adoption. Assess the uptake engine, not the idea's merit.
- **Absence of evidence is weak evidence.** Say which venues were unreachable.
- **Don't let recognisable names stand in for verification.** Every row in a precedent table
  needs its own source; a famous name in a table is not a citation.
- **Check what the operator already has.** Local measurement in his own repos often beats a
  cited example from someone else's.
- **A real gap is not a mandate.** The most expensive mistake this skill prevents is not
  building something that exists — it is building something that exists *as a gap* because
  everyone who considered it decided not to. Direction, doctrine, alternative and artifact each
  kill an idea that passes every "is it novel" test.

## Siblings — do not confuse these

| Skill | Question it answers |
|---|---|
| **`capability-broker`** | *"I need to DO something — what tool gets it done?"* Ends in an install |
| **`prior-art-recon`** (this) | *"I think I found a GAP — should I fill it?"* Ends in a verdict, often `stop` or `rearchitect` |

Reach for `capability-broker` when the next step is installing something; reach for this when the
next step is **building** something nobody has built.

## Why this exists

> *Off-the-shelf over hand-rolled — and look before concluding nothing is off the shelf.
> Proven patterns over reinvented wheels. Every choice carries its evidence — the math, the
> data, or the precedent — and names the alternative it beat.*

The motto says look first. This skill is what *looking* costs when the stake is a project rather
than a dependency: a few agent-hours, against the years a public repo can spend being a monument
to a gap the ecosystem had already closed, re-opened, and closed again for better reasons.
