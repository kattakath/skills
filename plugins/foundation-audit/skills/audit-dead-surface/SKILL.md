---
name: audit-dead-surface
description: >-
  Lane 4 of the four-dimension foundation audit — dead surface and doc drift. Hunts
  options declared and never read, unreachable outputs and entry points, guardrails
  whose pattern can no longer match anything (nothing anywhere reports a rule that
  never fires), and the only doc drift that counts: a step, path, count, flag or URL
  a reader would ACT on and be wrong. Past-tense history in a comment is explicitly
  NOT drift. Use when running the foundation audit, or when asked "what here is dead",
  "are our rules actually armed", or "are the docs still true". Returns findings, a
  CONFIRMED-SOUND list, and mandatory UNKNOWNS.
---

# Lane 4 — dead surface and doc drift

You are **one of four parallel lanes**. Stay in yours.

| Lane | Owns | You report it? |
|---|---|---|
| 1 — architecture | layer map, boundary edges, invisible channels, god-file seams | ❌ |
| 2 — duplication | one job / two executables, one fact / two declarations, custom vs upstream | ❌ |
| 3 — validation | how every mutating step fails, blast radius, recovery | ❌ |
| **4 — you** | unread options, unreachable outputs, rules matching nothing, actionable doc drift | ✅ |

**Arbitration at the seams:**

- An option read **across a forbidden boundary** → lane 1. An option read by **nothing** → yours.
- One fact in two places → lane 2. A doc simply **wrong** → yours.
- A step that fails silently → lane 3. A **rule** that never fires → yours, even when its purpose
  was to prevent a silent failure. Note the overlap; the orchestrator merges.

## Before anything: calibrate

Read [`../../references/calibration.md`](../../references/calibration.md). **C1 governs this
lane** — past-tense history in a comment is an asset, not drift, and a lane that deletes decision
records is doing damage. **C7** matters too: a dead-code linter (`deadnix`, `vulture`,
`ts-prune`) probably already runs; do not re-derive it.

## E1 — options declared and never read

```bash
# every declared option
grep -rn 'mkOption\|mkEnableOption\|lib\.types\.' --include='*.nix' . | head -60
# then, per option, find its readers
grep -rn 'config\.<ns>\.<opt>\|cfg\.<opt>' --include='*.nix' .
```

**The trap that makes this lane easy to get wrong:** an option read by **nothing in this tree**
may still be a **public API** read by an out-of-tree consumer. Before calling it dead, ask:

- Is it documented as consumer-facing? Is it named in a template, a README, an ADR?
- Is this repo consumed as a flake input / library / package by anything?
- Is it a deliberate **compatibility stub** kept after a feature was removed, so consumers do not
  break? (C4 — quote the reason.)

If you cannot answer, that is an **UNKNOWN**, not a finding. Write it as *"dead in this tree; may
be a public API — needs the maintainer."*

## E2 — unreachable outputs and entry points

Things that exist and nothing can reach:

```bash
nix flake show --json 2>/dev/null | jq -r 'paths(scalars) | join(".")' | head -50
ls .claude/commands/ .claude/skills/ .claude/agents/ 2>/dev/null
grep -rn 'passthru\|apps\.\|checks\.\|packages\.' --include='*.nix' .
```

For each output, command, skill, agent, script, workflow: **what invokes it?** A flake check no
CI job runs, a package nothing installs and no doc mentions, a script not on any `PATH` and not
called by any other script, a workflow with a trigger that cannot fire, a command whose skill was
deleted.

Distinguish **unreachable** (nothing can call it) from **unused** (callable, nobody calls). Only
the first is reliably a finding; the second needs the maintainer's intent.

## E3 — guardrails that match nothing

> **Nothing, anywhere, reports a rule that never fires.**
>
> A permission list, a hook pattern, a CI path filter, a lint ignore and a `.gitignore` entry are
> all *allowed* to match nothing — that is a normal state, not an error. A dead rule and a rule
> that has simply not been triggered yet are indistinguishable from the inside.

This is lane 4's SEV-1 hunt. Read worked example 2 before starting.

**Method: for every pattern-shaped rule, enumerate the real namespace it targets and prove at
least one possible match exists.**

| Rule kind | The namespace to check it against |
|---|---|
| permission `allow`/`deny` entries | the **live tool names** a session actually sees — including plugin/server prefixes, which change on rename |
| hook matchers | the real event + tool-name spellings |
| CI `paths:` / `paths-ignore:` filters | the tree — does any file match the glob? |
| `CODEOWNERS` globs | the tree |
| lint `exclude` / `ignore` lists | the tree |
| `.gitignore` entries | the tree (a stale entry is harmless, a stale *negation* is not) |
| firewall / routing rules | the interfaces and ports that exist |
| log alerts, `grep`-based monitors | a real sample of the log format |

```bash
# permission-shaped rules
grep -rhoE '"(mcp__|Bash\(|Write\(|Edit\(|WebFetch)[^"]*"' .claude/settings.json modules/ 2>/dev/null | sort -u
# CI path filters vs the tree
grep -rn 'paths:' -A6 .github/workflows/*.yml
# every glob-shaped config value, then test it
```

**The tell to look for**: the same namespace spelled two ways in one repo — one file updated
after a rename and another not. Two spellings side by side, one live and one dead, is proof the
rename happened and was applied incompletely.

**Rank by the rule's purpose, not its size.** A one-line deny rule that a maintainer believes is
protecting them, and is not, is SEV-1.

## E4 — doc drift a reader would ACT on

Three tiers. **Only the first is a finding.**

| Tier | Example | Verdict |
|---|---|---|
| **Actionable and wrong** | a command that fails, a path that moved, a flag that was removed, a **count** that is stale, a URL that 404s, an install step in the wrong order | ✅ **finding** |
| Stale prose that misleads no action | a description written before a refactor, still roughly true | SEV-3 at most |
| **Past-tense history** | *"Rejected 2026-09-13 because X. Do not re-propose."* | ❌ **not drift** (C1) — leave it |

**Counts are the classic.** "N secrets", "zero runners", "six capsules", "three hosts" — every one
of these goes stale silently, and a reader trusts them. **Recount from the source of truth every
time:**

```bash
ls secrets/*.age | wc -l          # vs whatever the doc says
ls modules/features/ | wc -l
grep -c 'hostedSites' ...
```

**Test every command a doc tells a reader to run.** Not by executing it — by checking that the
flake output, the file, the flag and the target exist:

```bash
grep -rhoE '^\s*(\$ )?[a-z][a-z0-9-]+ [^|]*$' docs/*.md README.md | head -40   # candidate commands
nix flake show 2>/dev/null                                                     # do the named outputs exist?
```

A doc command naming an output that no longer exists is SEV-2: a reader runs it, it fails, and
their trust in the rest of the doc goes with it.

## E5 — dangling cross-references

```bash
grep -rhoE '\]\(([^)#][^)]*)\)' --include='*.md' . | sed -E 's/^\]\(|\)$//g' | sort -u \
  | while read -r p; do [ -e "${p%%#*}" ] || echo "DANGLING: $p"; done
```

Also check: a skill referencing a reference file that moved, a README linking a plugin path that
was renamed, a `CLAUDE.md` index row for a deleted directory, a repo URL that changed owner or
slug after a rename.

## Output

The three sections from [`../../references/report-format.md`](../../references/report-format.md).

Lane-4-specific reminders:

- **CONFIRMED-SOUND**: the rules you verified are **armed** (with the match you found), the
  options you verified **are** read (with the reader's `file:line`), and the doc commands you
  verified still resolve. This is unusually valuable output — it is the only evidence anywhere
  that the guardrails work.
- **UNKNOWNS**: every option that is dead in-tree but might be a public API; every rule whose
  target namespace you could not enumerate (you cannot see a live session's tool list, a remote
  log format, a private consumer); every doc command you could not check without running it.
