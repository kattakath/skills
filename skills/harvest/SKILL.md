---
name: harvest
description: This skill should be used at the end of a task that produced something worth repeating — the user says "save this as a skill", "remember how to do this", "make this reusable", "turn this into an agent/workflow", "harvest this session", or a capability-broker run found a procedure, site flow or tool combination that should not be rediscovered next time. Decides the right artifact type, strips anything machine- or secret-specific, writes it in the standard format, and lands it through the operator's content repo — not as a loose file in ~/.claude.
version: 0.2.0
---

# Harvest — turn a session's discovery into a pinned, reusable artifact

A session that figured something out (how a site's flow works, which CLI flags matter, the
order that avoids a footgun) should leave that knowledge somewhere the next session loads it.
The failure this prevents is not forgetting — it is **saving into the wrong place**: a
loose file in `~/.claude` that no repo, pin or review ever sees, and that a declarative
harness may delete on the next activation.

```
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│ 1. Worth │-->│ 2. Type  │-->│ 3. Clean │-->│ 4. Write │-->│ 5. Land  │
│ keeping? │   │ artifact │   │ portable │   │ standard │   │ PR + pin │
└──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘
```

## 1. Worth keeping? — all three must be yes

- **Repeats:** will this come up again (a yearly filing, a recurring migration, a tool
  used monthly)? One-off answers are not skills.
- **Hard-won:** did it take measurement, failed attempts or reading that the next
  session would repeat? Common knowledge is not worth the context it costs.
- **Not already covered:** search where this knowledge may already be written, not just
  where skills live:
  - existing skills: the listing in context, the content repo, `find-skills`;
  - **the harness and sibling repos' own docs, ADRs, runbooks and workflow comments** —
    an operator often solved the same problem in another repo and wrote it down there
    (`gh search code --owner <owner> '<key term>'`, or `grep -ril` over a checkout's
    `docs/` and `.github/`);
  - official and community marketplaces, for an off-the-shelf equivalent.

  Found it written down? Cite and adapt it; don't rediscover it. (Missed 2026-09-23: a
  harvested skill armed auto-merge with `GITHUB_TOKEN` while the harness repo's
  `docs/auto-merge-and-merge-queue.md` already recorded why an App token is required,
  so it needed a follow-up PR.) Extending an existing skill beats adding a sibling.

If any answer is no, say so and stop. Declining to harvest is a valid outcome.

## 2. Type — pick the artifact by what the knowledge IS

| Knowledge is… | Artifact | Lives in |
|---|---|---|
| A procedure with steps, checks and pitfalls | **Skill** (`SKILL.md` + optional `references/`, `scripts/`) | Content repo `skills/<name>/` |
| A role with a restricted tool set | **Subagent** (`agents/<name>.md`) | Content repo, or a plugin |
| A fan-out orchestration that worked | **Workflow** — save from `/workflows` with `s` | Project or `~/.claude/workflows/`, then the content repo |
| Hooks, commands and skills that ship together | **Plugin** | Content repo `plugins/<name>/` + marketplace entry |
| A fact about the user or a project | **Memory**, not an artifact | The memory system / project `CLAUDE.md` |
| Specific to one repo | **Project config** | That repo's `.claude/`, never the global set |

Most harvests are skills. Choose a plugin only when there is a hook or command that must
travel with the skill.

## 3. Clean — make it portable before writing a line

Remove or generalise, in this order:

1. **Secret values** — never copy a token, key or password; name the credential and where
   it is read from (Keychain entry name, env var name).
2. **Personal data** — account numbers, addresses, anything about third parties.
3. **Machine paths** — `/Users/<name>/…` becomes `$HOME`/XDG or a placeholder.
4. **Session noise** — dead ends go into one "pitfalls" line each, with the measured
   reason; the narrative of the session does not go in at all.

## 4. Write — the standard shape

Frontmatter: `name` (kebab-case, matches the directory), `description` (third person,
quoting the phrases a user would actually say, so the skill triggers on them), `version`.

Body, kept under ~500 lines with detail pushed into `references/`:

- **What and when** — two sentences.
- **Steps** — numbered, each with the check that proves it worked.
- **Human gates** — auth, money, irreversible steps, stated where they occur.
- **Pitfalls** — measured, dated where the date matters ("as of 2026-09").
- **References** — official docs and the source that supplied each non-obvious claim.

Re-read the description against the original request: would this session have triggered it?

## 5. Land — through the operator's rail

**Detect the harness first** (as in `capability-broker`): if `~/.claude/settings.json`
resolves into a store, skills are declared, not dropped into `~/.claude/skills`.

**With a declarative harness — two PRs, in order:**

1. **Content repo PR** — add `skills/<name>/` (or the plugin and its marketplace entry) on a
   branch; one PR per artifact; title and commit style follow that repo.
2. **Harness PR, after (1) merges, for a NEW artifact only** — enable it. If the harness
   registers the content repo as a git marketplace with auto-update, that is one line (the
   plugin's name in the enabled list) and no pin bump; run the harness's own checks before
   opening it. A change to an artifact that is already enabled needs no harness PR at all:
   the marketplace's auto-update delivers it.

Until (2) activates, a new skill is not loaded globally. For immediate use in the
current project only, a copy under that project's `.claude/skills/` is acceptable if it is
deleted before the harness PR lands (two copies of one skill shadow each other).

**Without a harness:** a personal skill goes to `~/.claude/skills/<name>/`, ideally a
symlink into a version-controlled directory so it is not the only copy.

## Adapter: the kattakath fleet

| Piece | Value |
|---|---|
| Content repo | `github:kattakath/skills` (`skills/`, `plugins/`, `.claude-plugin/marketplace.json`) |
| Harness repo | `github:kattakath/nix-config` |
| Prior art to search | nix-config `docs/` (ADRs, runbooks), `.github/workflows/` comments, `.claude/rules/`; `gh search code --owner kattakath` |
| Delivery | git marketplace `kattakath` with auto-update: a merge to `main` ships, no pin |
| New skill | `skills/<name>/` plus a marketplace entry (`"source": "./"`, `"strict": false`, `"skills": ["./skills/<name>"]`) |
| Enable | append the plugin name to `local.claudePlugins.marketplaces.kattakath.plugins` in `modules/shared/home.nix` |
| Harness checks | `git add -A && nix flake check`; PR title per its `pr-title` rule |
| MCP servers | never harvested here — adopted only through nix-config's `mcp-scout` |

## Output

```
Harvested:  <name> (<artifact type>)
Why:        <repeats / hard-won / not covered — one line each>
Cleaned:    <what was removed or generalised>
PR 1:       <content repo branch or URL>
PR 2:       <harness branch or URL, or "after PR 1 merges">
Loaded:     <now in this project only | globally after activation>
```
