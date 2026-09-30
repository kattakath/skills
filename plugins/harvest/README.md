# harvest

At the end of a task that produced something worth repeating, turn it into a **pinned, reviewed
artifact** — not a loose file in `~/.claude` that no repo, pin or review ever sees, and that a
declarative harness may delete on its next activation.

```
worth keeping? --> which artifact --> clean --> write --> land (PR + pin)
```

## Extract before you judge

What a session teaches is usually not the procedure it set out to do. Sweep, in order: mistakes
and corrections, preferences and patterns, new facts, contradictions, then reusable procedures.
Drop everything **ephemeral** — line numbers, exact error strings, temp paths, ports, commit
hashes — and keep the pattern, with the event as its evidence.

Then all three must be yes: it **repeats**, it was **hard-won**, and it is **not already covered**.
The counterfactual test settles the middle one: *if this were never written down, would the next
session redo the digging?* Declining to harvest is a valid outcome, and the common one.

**"Not already covered" means more than the skill list.** Search the harness and sibling repos'
own docs, ADRs, runbooks and workflow comments — an operator often solved the same problem in
another repo and wrote it down there. That exact miss happened on 2026-09-23: a harvested skill
armed auto-merge with `GITHUB_TOKEN` while the harness repo already recorded why an App token is
required, so it needed a follow-up PR.

## Skills are not the default

A fact or preference is memory; a correction that should block an action is a hook rule; a role
with a restricted tool set is a subagent. Reach for a skill only for a repeatable, multi-step
procedure that generalises.

And prefer modifying over creating. For a procedure, pick exactly one operation — `update`,
`extend`, `deprecate`, `split`, `create` or `none` — with two tie-breakers: unsure between
`create` and `none` → `none`; unsure between `create` and a modify operation → the modify
operation. **Contradictions are fixed at the source**, never appended alongside the stale text.

## Landing is two PRs, in order

A content-repo PR first, then — for a genuinely new artifact only — a one-line harness PR enabling
it. A change to an already-enabled artifact needs no harness PR at all: the marketplace's
auto-update delivers it. Until the harness PR activates, a new skill is not loaded globally, and a
project-local copy is acceptable only if deleted before that PR lands, because two copies of one
skill shadow each other.

Drafting and testing hand off to `skill-creator` rather than being re-implemented here: harvest
owns *whether*, *what type*, *what to strip* and *where it lands*; skill-creator owns *does it
work*.

## Pairs with

[`capability-broker`](../capability-broker) (find before building) and
[`skill-curator`](../skill-curator) (retire what nobody uses). Harvest is the middle verb.
