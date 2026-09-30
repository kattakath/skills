# skill-curator

Keep a skill library from only growing. Counts **real usage** from Claude Code transcripts,
classifies each marketplace entry, and proposes retirements as a reviewable PR. It never deletes,
and never retires on a model's judgement.

A library that only grows turns into noise: near-duplicates compete for one trigger, descriptions
get truncated once the listing passes its budget, and stale procedures send agents down dead
routes.

Ported from the **Hermes Agent curator** (MIT, `NousResearch/hermes-agent`), keeping its thresholds
and safety rules and swapping its runtime for what a fleet already has: transcripts for usage, git
for the ledger, PRs for approval.

## What it ships

| File | Role |
|---|---|
| `scripts/skill-usage.py` | The deterministic half — no LLM, no writes. `--repo`, `--projects`, `--now`, `--json` |
| `tests/usage-cases.sh` | Nine cases over fixture transcripts and a scratch repo dated 2026-09-01, so ages are stable in a shallow CI checkout |

```bash
python3 scripts/skill-usage.py --repo <content-repo-checkout>
```

A use is counted when the model called the `Skill` tool, or the user typed `/<name>` — a plugin's
own skills (`<plugin>:<skill>`) count for the plugin.

## The states

| State | Rule |
|---|---|
| `pinned` | Listed in `index/curation.json`. Never proposed. |
| `exempt` | Another entry's files name it in backticks — it is depended on. |
| `active` | Used within 14 days, **or** never used but younger than 14 days. |
| `stale` | Idle ≥ 14 days. Report only. |
| `archive-candidate` | Idle ≥ 30 days. Propose retirement. |
| `deprecated` | Frontmatter says `deprecated: true`. Propose retirement whatever the usage. |

## The evidence window is the part that matters

**Absence of use only counts over the days the transcripts actually cover.** The script caps
"idle" at that window, so a fresh machine or a short window proposes nothing — and says so. This
is why a first run on a new host is silent, and that is correct rather than broken.

Two limits of the signal, restated in every PR: transcripts are **per machine**, so a skill used
only on another host looks unused here; and Claude Code deletes them after `cleanupPeriodDays`
(default 30), which is the ceiling on how far back anything can be seen.

## Retire from the harness, not from the repo

An archive-candidate loses its line in the harness's enabled list. The skill stays published, and
one line restores it — the git revert is the rollback Hermes needed tar snapshots for. **Never
delete a skill directory as part of curation.**

## Known coarseness

Backtick references are blunt: naming an entry anywhere in another entry's markdown marks it
`exempt`. It errs toward keeping, which is the safe direction. A README added to a plugin is part
of that text, so it can exempt whatever it mentions.

## Pairs with

[`harvest`](../harvest) (retain) and [`capability-broker`](../capability-broker) (retrieve). This
is the prune verb neither of them covers.
