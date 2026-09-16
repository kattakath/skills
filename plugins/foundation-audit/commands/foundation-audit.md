---
description: Four-dimension foundation audit of a config monorepo — is it solid enough to build on?
argument-hint: "[path] [--lane architecture|duplication|validation|dead-surface]  # default: whole repo, all four lanes"
---

Run the **foundation-audit** skill
(`${CLAUDE_PLUGIN_ROOT}/skills/foundation-audit/SKILL.md`) end to end. Read it, and
`${CLAUDE_PLUGIN_ROOT}/references/calibration.md`, before launching a single agent.

## Arguments

Parse `$ARGUMENTS` loosely:

| Token | Meaning |
|---|---|
| a path | The repo to audit (default: the current working directory) |
| `--lane <name>` | Run **one** lane only, in this session, no fan-out. Repeatable |
| nothing | Whole repo, all four lanes, in parallel |

## Required sequence

1. **Phase 0 — calibrate, blocking.** Build the ONE brief: the repo's stated conventions and
   motto, the intended layer map, **the gate inventory**, the file-size median/p90, which trees
   are pinned vs generated, and what is mid-flight in `git log`. Every lane gets the same brief.
   Also establish whether this session can evaluate/build at all — if not, say so in every lane's
   UNKNOWNS.
2. **Phase 1 — fan out, one message, four agents in parallel.** Each gets its lane skill, the
   whole brief, **the lane table naming what the other three cover**, and the three-section
   output contract. Tell lane 3 explicitly: **read, do not run** — no activation, switch or
   deploy.
3. **Phase 2 — re-verify yourself.** Open the cited `file:line` for **every** SEV-1 and SEV-2
   before relaying it, and mark each `re-verified` / `downgraded` / `withdrawn` / `not
   re-verified`. Merge cross-lane duplicates. Reject any lane report missing CONFIRMED-SOUND or
   UNKNOWNS and re-run that lane.
4. **Phase 3 — consolidate.** One ranked findings table, then merged CONFIRMED-SOUND, then merged
   UNKNOWNS. Never trim the last two for length.

## Non-negotiable

- **Three sections per lane**: FINDINGS, CONFIRMED-SOUND, UNKNOWNS. UNKNOWNS may not be empty.
- **Every claim carries a `file:line` you read.** An unverified claim is worse than none.
- **If a gate already catches it, it is not a finding** — name the gate and drop it.
- **Report; do not fix.** The maintainer picks what to act on.
