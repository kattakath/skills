# The Agent Map — reader's edition

*How an AI coding agent's discoveries become reusable routes: chart once, route every later
session through the chart, prune what nobody uses, and inherit other people's charts first.*

2026-09-23 · Ismail Kattakath, with Claude Code · repo: https://github.com/kattakath/skills

> **About this edition.** This is the condensed, read-straight-through version of
> [The Agent Map](agent-map.md). Every claim here comes from the full edition, where each
> one is tagged `[measured]`, `[source]` or `[inferred]` and linked to its evidence. Here the
> tags are kept only where the difference matters. For the full discovery log, all nineteen
> decision records, every reference, and the content kit for posts, slides and video, read
> the full edition.

**Contents:** [1. The short version](#1-the-short-version) ·
[2. The problem](#2-the-problem) · [3. The idea](#3-the-idea) ·
[4. What happened](#4-what-happened) · [5. How it works](#5-how-it-works) ·
[6. Fourteen lessons](#6-fourteen-lessons) · [7. What the research says](#7-what-the-research-says) ·
[8. Why this, not that](#8-why-this-not-that) · [9. Where to start](#9-where-to-start) ·
[10. Limits and open questions](#10-limits-and-open-questions) ·
[11. Further reading](#11-further-reading)

---

## 1. The short version

*One working session relearned, one failure at a time, something a neighbouring repo had
already written down. The fix is a map.*

- **The discovery.** On 2026-09-23, one session in `kattakath/skills` worked out how to
  make a GitHub branch a safe, auto-merging release. The correct answer (arm auto-merge
  with a GitHub App token) was already documented in the author's other repo,
  `kattakath/nix-config`. The knowledge existed; nothing pointed to it. [measured]
- **The idea.** Treat an agent's hard-won know-how as a **map**, with three verbs:
  **route** (find the way before walking it), **chart** (record a way once it is proven),
  **prune** (retire ways nobody travels).
- **Inherit, don't build.** Most of the map already exists in public collections and
  indexes, such as Anthropic's community plugin index (2,282 pinned, security-scanned
  plugins) and skills.sh. Keep in your own repo only the glue nobody else has. [measured]
- **Curation is what makes it work.** In the SkillsBench benchmark, skills agents wrote for
  themselves gave **no average benefit**. Curated skills gave **+16 percentage points**.
  [source] This repo curates by human review of every harvested skill; that review
  closes the gap is its bet, not a measurement. [inferred]
- **Pruning matters too.** Libraries that only grow get worse, and Claude Code drops the
  least-used skill descriptions once its listing budget overflows. [source]
- **The idea is old.** It is the case-based-reasoning cycle from 1994 (Retrieve, Reuse,
  Revise, Retain), applied to coding agents.

```
                  goal arrives
                       |
                       v
          +------------------------+
          |  1. ROUTE              |
          |  capability-broker     |
          |  reads the map first   |
          +------------------------+
             ^                   |
             |                   v
+------------------------+  +------------------------+
|  4. PRUNE              |  |  2. USE                |
|  skill-curator         |  |  follow the route,     |
|  retires unused routes |  |  or walk an uncharted  |
|  (PR, never delete)    |  |  one and learn it      |
+------------------------+  +------------------------+
             ^                   |
             |                   v
          +------------------------+
          |  3. CHART              |
          |  harvest -> gated PR   |
          |  adds skill + route    |
          +------------------------+

        centre of the loop:  INDEX.md  (the map)
```
*The whole idea as one loop. Every step reads or writes one generated map, `INDEX.md`.*

---

## 2. The problem

*Without a map, every session pays the full discovery cost again, and a library that only
grows gets worse.*

```
 session N          session N+1         session N+2
 +---------+        +---------+         +---------+
 | figure  |        | figure  |         | figure  |
 | it out  |        | it out  |         | it out  |
 | (again) |        | again   |         | again   |
 +----+----+        +----+----+         +----+----+
      |                  |                   |
      v                  v                   v
   forgotten          forgotten           forgotten
```
*Each session re-derives what an earlier one, or a neighbouring repo, already knew.*

What goes wrong:

- **Rediscovery.** Each session re-derives a procedure someone already worked out.
- **Loose knowledge.** The answer sits in docs, runbooks and workflow comments that no
  skill search looks at.
- **Bloat.** Skills pile up and compete for a fixed listing budget.
- **Staleness.** A procedure stops being true after later changes, and gets followed anyway.
- **Unreviewed self-written skills.** On average they don't help, and some make tasks worse.
- **Rebuilding what exists.** Hand-rolling a marketplace, a router or an action that is
  already maintained elsewhere.

The obvious fix, "let the agent write skills for itself", makes this worse unless something
charts carefully and prunes on evidence.

---

## 3. The idea

*A map with three verbs, the 1994 case-based-reasoning cycle, built mostly from inherited
parts.*

The author's framing: a "Google Maps for my AI agents". Once a way is figured out it is
charted, so nobody reinvents it; charts get cross-referenced and corrected over time. The
metaphor is illustrative, not literal.

| Verb | The question | Component | The key rule |
|---|---|---|---|
| **Route** | Has someone already charted this? | `capability-broker` | Read the map first, then outside indexes. The lightest capability that works wins. |
| **Chart** | Is this worth keeping, and in what form? | `harvest` | Skills are not the default. One operation per learning; modifying beats creating. Land by reviewed PR. |
| **Prune** | Does anyone still take this route? | `skill-curator` | Count real use. Stale at 14 idle days, retirement proposed at 30. Retire by PR; never delete. |

**It has a formal name.** The loop is the case-based-reasoning 4R cycle (Aamodt & Plaza,
1994), with pruning as what that field calls case-base maintenance:

```
   RETRIEVE ----> REUSE ----> REVISE ----> RETAIN
   (route)        (use)       (correct)    (chart)
      ^                                       |
      |          case-base maintenance        |
      +--------------- (prune) <--------------+
```
*The CBR cycle, relabelled with the verb that does each step here.*

**Inherit, don't build.** The author's motto: *"Off-the-shelf over hand-rolled. Proven
patterns over reinvented wheels. Community Legos over proprietary monoliths."*

| Inherited (someone else maintains it) | Kept here (glue nobody else has) |
|---|---|
| Anthropic's `skill-creator` for drafting and testing skills | the order and pitfalls of a release gate |
| skills.sh search and its quality bar | harvest → reviewed PR → content repo → one-line enable |
| the Official MCP Registry, then Smithery | a Nix-declared, reproducible set of marketplaces |
| Anthropic's community plugin index (2,282 plugins) | a generated map that points outward first |
| the Hermes Agent curator design (ported) | the evidence-window rule (not in Hermes) |
| Letta Code's reflection triage (adopted) | usage counted from existing transcripts, no new hook |

**The growth arc.** A personal map is expected to start by mostly pointing outward (receiving help), adds
routes only it has (receiving and giving), and eventually shares its proven routes back
(mostly giving). At commit 308e0c6 (PR #13) it held 18 routes, 8 of them charted nowhere
else, and indexed 11 outside sources. [measured]

---

## 4. What happened

*Seven moments in one day. The dead ends are the useful part.*

1. **The merge that was a release.** Since the marketplace carries no version numbers, every
   merge to `main` ships to every user with auto-update on. When the agent tried to merge,
   Claude Code's permission classifier blocked it. That was correct: a release deserves a
   human or a gate.
2. **The PR that merged itself.** A workflow to auto-merge same-repo PRs was written before
   any check was required. On a clean PR with nothing to wait for, `gh pr merge --auto`
   merges immediately instead of arming. PR #5 merged itself about 4 seconds into its own
   job, at 12:02:07 UTC. [measured]
3. **The ruleset that wasn't there.** A required check was reported as added; the API showed
   none. The Codespace's built-in token couldn't create it (HTTP 403), and a pasted one-line
   JSON body wrapped in the terminal and split a word in two. The fix: pass the body as a
   file, authenticate as the owner, and read the rule back from the branch. [measured]
4. **The silent merges.** PR #7, armed by `GITHUB_TOKEN`, triggered no `push: main`
   workflow and left its branch undeleted (#5 got no push run either). [measured]
5. **The answer next door.** The author's other repo already documented the fix: arm with a
   GitHub App token, because "events produced by GITHUB_TOKEN do not start workflow runs".
   After the switch, PR #8 ran its push check and its branch was auto-deleted.
   [measured]
6. **Charting the lessons.** `harvest` turned the day's lessons into a skill
   (`github-release-gate`), then was itself fixed: its "already covered?" check now searches
   neighbouring repos' docs. A code search for "App token" returns the missing doc as its
   first hit. [measured]
7. **Building the map.** Research found the idea's roots and the parts to inherit. The same
   day added a generated, CI-checked `INDEX.md`, a curator ported from Hermes Agent, and
   Letta's triage rules inside `harvest`. [measured]

Eleven PRs merged in `kattakath/skills` that day. From PR #8 on, the CI bot App merged each
one after the required `validate` check passed. [measured]

---

## 5. How it works

*Two repos, one gate, and three skills around one generated map.*

| Piece | Role | Where |
|---|---|---|
| `capability-broker` | Route: inventory, then the map, then outside indexes; adopt the lightest thing through the harness | `skills/capability-broker/` |
| `harvest` | Chart: extract, triage, choose one operation, clean, test with `skill-creator`, land by PR, add a route | `skills/harvest/` |
| `skill-curator` | Prune: count use from transcripts, propose retirements by PR | `skills/skill-curator/` |
| `INDEX.md` | The map: goal → route, generated from `index/*.json` and `marketplace.json`, checked in CI | repo root |
| `github-release-gate` | The safety layer: required check, then auto-merge, then App-token arming | `skills/github-release-gate/` |
| `kattakath/nix-config` | The harness: declares which marketplaces and skills each machine gets | its `modules/shared/home.nix` |

**Delivery.** A merge to the content repo ships through the auto-updating marketplace. A
brand-new skill also needs one line in the harness to be enabled; changes to an enabled
skill need nothing.

**The gate, in the only safe order:**

```
 ① REQUIRE  a ruleset makes `validate` a required check
            verify: GET /repos/{o}/{r}/rules/branches/main ≠ []
      │
      ▼
 ② ALLOW    allow_auto_merge + delete_branch_on_merge
      │
      ▼
 ③ ARM      auto-merge.yml with a GitHub App token
      │
      ├─ from a fork, or a draft? ──▶ never armed ──▶ human merges
      │
      └─ same repo, not a draft
            ▼
      armed ──▶ validate passes ──▶ GitHub merges as the App
                                     ├─ push:main checks run
                                     └─ branch auto-deleted
```
*Require first, allow second, arm third. Getting the order or the token wrong caused
steps 2 and 4 above.*

**The map is generated, not written.** `scripts/build-index.py` builds `INDEX.md` from a
list of routes and a list of outside sources. CI fails if a route points at nothing, an entry
has no route, or someone edits the page by hand. Hand-written maps drift.

**The curator retires on evidence only.** It reads Claude Code's transcripts, where skill use
is already recorded, so no new hook is needed. Its one rule that is not in Hermes
Agent: "never used" only counts over the days the transcripts actually cover. The first real
run had a zero-day window and, correctly, proposed nothing. [measured]

---

## 6. Fourteen lessons

*The session in fourteen rules.*

1. Require the check before arming auto-merge. Arming with no required check is merging.
2. Arm with an App token, never `GITHUB_TOKEN`, or auto-merges are silent.
3. Verify settings on the branch, not by trust.
4. Pass long JSON bodies as files; terminal paste wraps and splits tokens.
5. In a Codespace, use `env -u GITHUB_TOKEN` for owner-only admin calls.
6. Before calling something new, search your neighbouring repos' docs.
7. Inherit collections and indexes; keep only glue.
8. Human-reviewed PRs are what make harvested skills help.
9. Prune on counted evidence, bounded by the evidence window, never on an LLM's judgement alone.
10. Generate the index from data and gate it in CI.
11. The skill description is the in-session index; the map covers what the listing can't.
12. Skills are not the default: facts go to memory, corrections to hooks.
13. A thin-wrapper community action is still worth adopting. Say it is thin.
14. A merge that is a release deserves a human or a gate.

---

## 7. What the research says

*This is an established field with a formal name, benchmarks, and known failure modes.*

- **The loop is 1994 case-based reasoning:** Retrieve, Reuse, Revise, Retain
  (Aamodt & Plaza). [source]
- **A skill is an "option"** in the 1999 reinforcement-learning sense (Sutton, Precup &
  Singh): when it applies, what to do, when it's done. That maps onto a SKILL.md's
  description, body and success checks. [source]
- **Library learning as compression** (DreamCoder, Stitch, LILO): a skill earns its place
  only if it shortens many future solutions. That is the principle behind merging and
  pruning. [source]
- **Curation is decisive.** SkillsBench (2026): self-generated skills gave no average benefit;
  curated ones gave +16 points; 16 of 84 tasks got worse with skills. [source]
- **Small edits beat rewrites.** ACE (ICLR 2026): full rewrites cause "brevity bias" and
  "context collapse". [source]
- **Descriptions decide discovery.** A study of 138K public SKILL.md files found that weak
  descriptions hurt retrieval and bloated bodies are a dominant defect. [source]
- **Bad judges break pruning.** The Blind Curator (2026): a biased LLM judge silently
  disables skill retirement. Retire on hard signals. [source]
- **Anthropic's own guidance** treats the description as the index ("what Claude matches
  your request against") and gives the skill listing about 1% of the context window.
  [source]

**What goes wrong, per the literature:** bloat, context collapse, stale skills, retrieval
failure, negative transfer, silent curator failure, and supply-chain or prompt-injection risk
through shared SKILL.md files.

---

## 8. Why this, not that

*The six decisions readers ask about most.*

- **Why an App token, not `GITHUB_TOKEN`?** Merges armed by `GITHUB_TOKEN` start no
  workflows: no push checks run and branches aren't deleted. Measured on PRs #7 and #8.
- **Why no merge queue?** The harness repo tried one for a month: it doubled CI time, is
  organization-only, and needs every required workflow to handle its own trigger.
- **Why a generated index?** Hand-written maps drift. Generating it and checking it in CI
  makes a missing or dangling route a build failure.
- **Why human-reviewed PRs for harvested skills?** Unreviewed self-written skills gave no
  average benefit and curated ones helped (SkillsBench). Review is how this repo
  curates. [inferred]
- **Why retire through the harness instead of deleting?** Removing one enable line is
  reversible with a revert, and the skill directory stays in the content repo.
- **Why not build a marketplace?** Public indexes already pin, scan and rank what they list.
  The map's job is to point to them.

The full edition has nineteen of these, including why a thin-wrapper action, why not Mergify,
why not an embedding router, and why not adopt Hermes or Letta wholesale.

---

## 9. Where to start

*Map first, inherited second, glue last.*

```
+--------------------------------------------------------------+
|  Before building anything:  map  ->  inherited  ->  glue     |
|  1. Is there a route in INDEX.md?          take it           |
|  2. Does a public index/collection have it? adopt it         |
|  3. Neither?  build the smallest glue, then chart it         |
+--------------------------------------------------------------+
```
*The whole on-ramp in three checks, in this order.*

**Day 1: consume the map.**
```
/plugin marketplace add kattakath/skills
/plugin install <name>@kattakath
```
Turn on auto-update (`/plugin` → Marketplaces → `kattakath`), read `INDEX.md`, and install
the three map skills: `capability-broker`, `harvest`, `skill-curator`.

**Week 1: chart one route, behind a gate.** Run `harvest` at the end of a task you'd hate to
repeat; expect "not a skill" more often than you think. Gate your content repo before
anything auto-merges, following `github-release-gate` in order. Add the route to
`index/routes.json` and regenerate:
```
python3 scripts/build-index.py          # write INDEX.md
python3 scripts/build-index.py --check  # what CI runs
```

**Month 1: prune on evidence.**
```
python3 skills/skill-curator/scripts/skill-usage.py \
  --repo <content-repo-checkout>
```
Read the header first: it says how many days of transcripts it saw. Retire by PR, never by
deleting.

**For a team:** the same loop. What changes is who reviews harvested skills, where the App
token lives, and that usage must be combined across everyone's machines.

---

## 10. Limits and open questions

*What this evidence can and cannot tell you.*

- **One author, one day.** The measurements come from one developer's repos on 2026-09-23.
- **Usage is per machine.** Transcripts are local, so a skill used only elsewhere looks
  unused. Claude Code deletes transcripts after 30 days by default, which caps the evidence.
- **The curator is untested on real history.** Its first run had a zero-day window, so
  it correctly proposed nothing. [measured]
- **Star counts and index sizes change.** Every figure here is as of 2026-09-23.
- **Stage three (giving back) hasn't started.** Gaps found in the community index, such as a
  release-gate plugin and a Nix flake plugin, are candidates to contribute.

---

## 11. Further reading

- **The full edition:** [agent-map.md](agent-map.md), with the discovery log, nineteen
  decision records, every reference, and the content kit.
- **This repo's map:** [INDEX.md](../INDEX.md).
- **Anthropic:** [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) ·
  [Claude Code skills docs](https://code.claude.com/docs/en/skills) ·
  [skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- **Indexes to inherit:** [claude-plugins-community](https://github.com/anthropics/claude-plugins-community) ·
  [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) ·
  [skills.sh](https://skills.sh) ·
  [Official MCP Registry](https://github.com/modelcontextprotocol/registry)
- **Designs ported:** [Hermes Agent curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator) ·
  [Letta Code](https://github.com/letta-ai/letta-code)
- **Papers:** [SkillsBench](https://arxiv.org/abs/2602.12670) ·
  [ACE](https://arxiv.org/abs/2510.04618) ·
  [138K SKILL.md files](https://arxiv.org/abs/2608.08453) ·
  [The Blind Curator](https://arxiv.org/abs/2607.07436) ·
  [SkillOps](https://arxiv.org/abs/2605.13716)
- **Classic foundations:** Aamodt & Plaza 1994,
  [doi 10.3233/AIC-1994-7104](https://doi.org/10.3233/AIC-1994-7104) ·
  Sutton, Precup & Singh 1999,
  [doi 10.1016/S0004-3702(99)00052-1](https://doi.org/10.1016/S0004-3702(99)00052-1)
