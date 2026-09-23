---
name: skill-curator
description: This skill should be used to keep a skill library from only growing — the user says "curate my skills", "which skills are unused", "prune stale skills", "clean up the skill library", "are there duplicate skills", "what should I retire", or a periodic maintenance run is due (weekly, or before adding many skills). Counts real usage from Claude Code transcripts, classifies each skill active / stale / archive-candidate with pinned and depended-on skills exempt, optionally proposes merges, and lands every change as a reviewable PR — never deletes, never retires on an LLM's judgement alone.
version: 0.2.0
---

# Skill curator — retire on evidence, through a PR

A library that only grows turns into noise: near-duplicates compete for the same trigger,
descriptions get truncated once the listing passes its budget (about 1% of the context
window in Claude Code), and stale procedures send agents down dead routes. This is the
pruning half of the loop `harvest` (retain) and `capability-broker` (retrieve) do not cover.

Ported from the **Hermes Agent curator** (MIT, `NousResearch/hermes-agent`,
`docs/user-guide/features/curator`), keeping its thresholds and safety rules and replacing
its runtime with what this fleet already has: transcripts for usage, git for the ledger,
PRs for approval.

```
┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐
│ 1. Count  │-->│ 2. Check  │-->│ 3. Decide │-->│ 4. (opt)  │-->│ 5. Land   │
│ usage     │   │ window    │   │ per state │   │ merges    │   │ one PR    │
└───────────┘   └───────────┘   └───────────┘   └───────────┘   └───────────┘
```

## 1. Count — deterministic, no LLM

```
python3 <this skill>/scripts/skill-usage.py --repo <content-repo-checkout>   # add --json for data
```

It reads every transcript under `~/.claude/projects` and counts a skill as used when the
model called the `Skill` tool with it, or the user typed `/<name>` (a plugin's own skills,
`<plugin>:<skill>`, count for the plugin). It then classifies each entry in the content
repo's `.claude-plugin/marketplace.json`:

| State | Rule (defaults from Hermes) |
|---|---|
| `pinned` | Listed in `index/curation.json` → `pinned`. Never proposed. |
| `exempt` | Another entry's files name it in backticks — it is depended on (Hermes skips cron-referenced skills for the same reason). |
| `active` | Used within `stale_after_days` (14), **or** never used but younger than 14 days: zero uses is absence of evidence, not proof. |
| `stale` | Idle ≥ 14 days. Report only. |
| `archive-candidate` | Idle ≥ `archive_after_days` (30). Propose retirement. |
| `deprecated` | Its `SKILL.md` frontmatter has `deprecated: true` (harvest's `deprecate` operation). Propose retirement whatever the usage. |

Third-party skills that were used are listed, report only: this curator never edits content it
does not own (Hermes treats hub-installed skills the same way).

Check: the header says how many days the transcripts cover.

## 2. Check the evidence window — before believing any "unused"

Absence of use only counts over the days the transcripts actually cover. The script caps
"idle" at that window, so a fresh machine or a short window proposes nothing, and says so.

Two limits of the signal, stated in the PR every time:

- **Per machine.** Transcripts are local. A skill used only on another host looks unused
  here. On a multi-host fleet, run on each and take the most recent use, or treat a
  single-host "unused" as `stale` at most.
- **Retention.** Claude Code deletes transcripts after `cleanupPeriodDays` (default 30).
  To see further back, raise it in the declared settings; otherwise 30 days is the ceiling.

## 3. Decide — per state

- **deprecated** → propose retiring it the same way, naming its `replaced_by`.
- **archive-candidate** → propose retiring it from the **harness**, not the repo: remove its
  name from the enabled list (for the kattakath fleet, `local.claudePlugins.marketplaces.kattakath.plugins`
  in nix-config `modules/shared/home.nix`). The skill stays published and one line restores
  it: the git revert is the rollback Hermes needed snapshots for.
- **stale** → list it in the PR description as next to go; change nothing.
- **Never delete** a skill directory as part of curation. Deleting is a separate, explicit
  decision (Hermes' `purge` is also explicit-only).
- **Signals, not judgement.** Retire only on counted usage. The Blind Curator result
  (arXiv 2607.07436): once an LLM judge passes enough failures, skill retirement silently
  stops working and no aggregate metric shows it.

## 4. Optional: propose merges

Off by default, as in Hermes (`consolidate: false`); run it only when asked. Read the
descriptions of `stale`/`archive-candidate` skills and of any pair whose descriptions share
their trigger phrases. For each overlap, propose one of: keep both (they trigger on different
requests), merge into an umbrella, or fold the smaller one into the larger one's
`references/`. Treat a skill with `scripts/`, `references/` or `assets/` as a whole package:
move its files with it or keep it standalone; never flatten only its `SKILL.md`.

Merges rewrite content, so each is **its own PR** in the content repo, re-tested with
`skill-creator`'s evals when it is installed, and with `index/routes.json` updated so CI's
index check passes.

## 5. Land — one PR per run

Human gate: a person merges it. The PR carries:

```
Window:     <N days from YYYY-MM-DD, host(s)>
Retire:     <archive-candidates, idle days, last use> -> harness PR
Watch:      <stale>
Exempt:     <pinned / depended-on, and by what>
Merges:     <proposals, or "not run">
Limits:     <per-machine, retention>
```

Everything is reversible by reverting the PR. The git history is the ledger.

## Pitfalls

- **A new machine proposes nothing.** Correct, not a bug. Its window is days long.
- **"Used" includes a mis-trigger.** A skill that fires on the wrong requests looks healthy.
  If one is used a lot but its output keeps getting overridden, that is a description
  problem for `skill-creator`'s trigger tuning, not a curation decision.
- **Backtick references are coarse.** Naming a skill anywhere in another entry's markdown
  exempts it. It errs toward keeping.

## References

- Hermes Agent curator docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/curator (thresholds, pin, grace floor, cron exemption, opt-in consolidation, archive not delete)
- The Blind Curator (arXiv 2607.07436), SkillOps (arXiv 2605.13716): why retirement needs verifier-like signals, and "skill technical debt"
- Claude Code skills docs, the skill-listing budget: https://code.claude.com/docs/en/skills
- Source session: kattakath/skills, 2026-09-23
