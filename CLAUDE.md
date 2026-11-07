# CLAUDE.md

This is `kattakath/skills` — Ismail Kattakath's general library of agent resources: Claude
Code skills and plugins, plus portable data catalogs external harnesses consume directly.
This file, plus `.claude/`, exist so this repo can be opened and worked
on with **zero outside context**: no `~/.claude` personal config, no other repo's
`CLAUDE.md` to inherit conventions from. If you're in a fresh Codespace or a clean
container, everything needed to maintain this repo is in this tree.

## What this repo is

This repo is broader than "plugin marketplace" — it's the operator's general library of
agent resources; some of it (skills, plugins) installs via Claude Code's marketplace
mechanism, some (`mcp/`) is portable data external harnesses consume directly.

- Published as `github:kattakath/skills`. Consumers run `/plugin marketplace add
  kattakath/skills` then `/plugin install <name>@kattakath`.
- **One shape: every unit of content is a plugin.** `plugins/<name>/` carries its own
  `.claude-plugin/plugin.json` and bundles one or more skills
  (`plugins/<name>/skills/<skill>/SKILL.md`) plus whatever commands, agents, hooks or
  output-styles it needs. A lone skill is a plugin with one skill in it — there is **no root
  `skills/` tree** and no `source: "./"` entry anywhere (see § Never use `source: "./"`).
- `.claude-plugin/marketplace.json` is the catalog: one entry per plugin, always
  `source: "./plugins/<name>"`, the list kept **alpha-sorted by `name`**. Adding a plugin
  means adding an entry here too.
- `INDEX.md` and the plugin table in `README.md` (between the `plugins:` markers) are
  **generated** (`scripts/build-index.py`) from `index/{routes,sources,curation}.json`,
  `marketplace.json` and each plugin's own tree — never hand-edit them; edit the source and
  rerun the script. CI's `Index up to date` check fails a PR where they've drifted.
- `mcp/` holds MCP server declarations (one `server.json` per the MCP registry schema) —
  documented, none declared yet.
- **MCP servers live in the owning plugin's `.mcp.json`** (`plugins/*/.mcp.json`) — the
  only lane since nix-config's gateway was purged on 2026-10-02. (The old `mcp-clients/`
  catalog the gateway read was deleted once nothing read it.) A server needing a
  credential gets it from the plugin's own launcher script, which resolves a
  `credential_command` userConfig, then the environment, then prompted userConfig. A plugin that still names a bare
  launcher BINARY depends on a PATH package from nix-config (`local.pluginMcp`), so it
  works only on that fleet.
- **Every plugin carries a semver `version` in its `plugin.json`, and CI forces it up on
  every change** (§ Versioning). A merge to `main` is the release; auto-update ships it.

## Adding a plugin — a single skill is a plugin too

1. `mkdir -p plugins/<name>/.claude-plugin plugins/<name>/skills/<name>`, plus whichever of
   `agents/`, `commands/`, `hooks/`, `output-styles/` it needs. **The skill directory name is
   half the invocation string** `<plugin>:<skill>`, so for a one-skill plugin keep the two
   names identical (`rag:rag`) — renaming either breaks every caller.
2. Write `skills/<name>/SKILL.md` with YAML frontmatter — `description` is what Claude Code
   matches against to auto-invoke it, so make it specific. A skill's own `scripts/`,
   `references/`, `assets/` and `tests/` sit **next to its `SKILL.md`**, because SKILL.md
   refers to them by skill-relative path (`assets/foo.yml`, not `<plugin>/assets/foo.yml`).
3. Write `.claude-plugin/plugin.json` — `$schema`, `name`, `description`, `author`,
   `homepage`, `repository`, `license`, `keywords`. **An unknown key does NOT fail validation** —
   measured 2026-10-06, it is a **warning with exit 0**, and the validator even suggests the field
   you probably meant ("did you mean 'workflows'?"). Claude Code ignores unrecognised fields at load
   time. So do not avoid a legitimate new manifest field out of fear of the gate — but equally, do
   not trust the gate to catch a typo'd one. Start `version` at `1.0.0` (§ Versioning).
4. Write `README.md` — **every plugin has one** (since #40). It is the page a reader
   lands on from the marketplace: what the plugin ships, the non-obvious facts and
   measurements it exists to carry, and what it requires. Source it from the `SKILL.md`;
   do not restate the frontmatter.
   One consequence to know: `skill-usage.py` treats a backticked entry name **anywhere** in
   another plugin's markdown as a dependency, so naming a sibling in a README marks that
   sibling `exempt` from curation.
5. Add the entry to `.claude-plugin/marketplace.json`, `source: "./plugins/<name>"`, keeping
   the list alpha-sorted by `name` — the validate action's I1 invariant checks the order.
6. If it fills a goal, add a route to `index/routes.json` (and a `sources.json` entry if it
   points outward), then run `python3 scripts/build-index.py` to regenerate `INDEX.md`.

### Never use `source: "./"`

Upstream's `"source": "./"` + `"strict": false` + `"skills": [...]` entry is a **shim for
FOREIGN repos** that cannot be made to carry a `plugin.json` — all three uses in
`anthropics/claude-plugins-official` are third-party. This repo owns its own tree, so the
correct fix for "this is just a skill" is to write the manifest, not to borrow the shim. The
shim also costs real things: no `plugin.json` means no `keywords` and no per-plugin
`homepage`, the entry is the only place a version could ever live, and each such entry copies
the **whole repo** on install instead of one `plugins/<name>` subtree. 11 of the then-18 entries used
it until it was removed wholesale (#31); do not reintroduce it.

## Validating before you push

```bash
npx -y @anthropic-ai/claude-code@2.1.268 plugin validate .
for p in plugins/*/; do npx -y @anthropic-ai/claude-code@2.1.268 plugin validate "$p"; done
python3 scripts/build-index.py --check
```

**The `@2.1.268` pin is load-bearing — do not drop it back to bare `npx`.** Measured 2026-10-06 on
this machine: bare `npx -y @anthropic-ai/claude-code --version` resolves to a **cached 2.1.197**,
the local `claude` is **2.1.278**, and CI pins **2.1.268**. Three different CLIs, and the
unpinned command is none of them — so "matching it locally" was false while this said `npx` alone.
Raise the pin here only together with the one in `validate.yml`.

This is otherwise exactly what `.github/workflows/validate.yml` runs. Plugins with test suites
(`page-lab`, `mac-app-send`, `skill-curator`) have their own commands in that workflow; check it
before assuming "validate passes" is sufficient for those. Two steps there cover assets the
manifest validator never reads: `Nix assets parse`, and `Plugin workflows load-shape` — the latter
exists because a workflow script whose `export const meta` literal is not the **first** statement
is valid JavaScript that loads as **zero workflows, with no error emitted**.

## Shipping a change

- Branch off `main`, open a PR. `auto-merge.yml` arms squash-auto-merge on same-repo PRs
  (never forks) the moment they leave draft. `gate` is the ONLY required check: it asserts
  every job in `validate.yml` ended as the event expects. The full `validate` suite runs
  **once**, in the merge queue (own-branch PRs get the cheap `quick` job instead); fork PRs
  run it on the PR too. Open work in progress as a **draft**: `gate` is green in seconds, so
  an armed PR is queued almost at once. Never rename the `gate` job; every ruleset names it.
- A merge to `main` **is** the release — treat `main` accordingly. Bump the `version` of
  every plugin the PR touches, or `validate` goes red. This is what [`github-release-gate`](plugins/github-release-gate) generalizes.
- Fork PRs land un-armed on purpose — a maintainer adds them to the merge queue after review.
- **A merge is released, not delivered.** An installed copy moves only when Claude Code
  refreshes the marketplace on its own schedule. `/reload-plugins` re-reads the **local cache**
  and fetches nothing — measured 2026-10-18: after #87 merged, a reload still ran the
  pre-merge cache dir because the marketplace clone sat on the old HEAD. To see a merged
  change now: `claude plugin marketplace update kattakath`, then
  `claude plugin update <name>@kattakath`, then `/reload-plugins`. Verify by behaviour (or
  the cache dir a hook runs from), not by the merge.

### Versioning

**Each `plugins/<name>/.claude-plugin/plugin.json` carries a semver `version`; the marketplace
entry never does.** Operator ruling 2026-11-01, overturning the versionless model this section
used to defend. That model's measured risk was real: with a `version` set, users stay on their
cached copy **until the string changes**, so a push without a bump makes `claude plugin update`
report `already at the latest version` while serving stale files — silent and unbounded
(measured 2026-09-30). The answer now is a gate rather than no version at all:

- **`Plugin version bumped`** (`scripts/check-version-bump.py`, in `validate`) fails a PR that
  changes anything under `plugins/<name>/` unless that plugin's version rises. New plugins need
  only a valid `MAJOR.MINOR.PATCH`. It also fails if a marketplace entry grows a `version`:
  `plugin.json` wins over the entry at install time and the entry is ignored without warning.
- **`release-tags`** runs on every merge to `main` and gives each new version a
  `<plugin>--v<version>` tag via Claude Code's own `claude plugin tag`. A dependency's version
  RANGE (`{"name": "x", "version": "^1.2"}`) resolves against those tags, not `plugin.json`.
- Bump by impact: PATCH for fixes and docs, MINOR for new capability, MAJOR when a caller must
  change (a renamed skill, tool or setting).

What the versionless model bought, and why it no longer wins: every merge reached users with
no bookkeeping, at the cost of every commit revving all plugins (the computed version was the
repo HEAD SHA) and no way to name a release a dependency could rely on. Upstream precedent
cuts both ways (`anthropics/skills` is versionless; `claude plugin tag` exists for the
versioned model).

## Conventions

- MIT license on every plugin/skill (`LICENSE` at repo root).
- `homepage`/`repository` point at `github.com/kattakath/skills`, not a per-plugin repo —
  everything ships from this one tree.
- No secrets, no machine-specific paths, no dependency on any other repo's `CLAUDE.md` or
  `~/.claude` — anything here must work from a clean checkout.
- **Hook exit codes follow what the hook IS.** A hook that *blocks* (PreToolUse guard) exits
  `2` with the reason on stderr. A hook that *advises* — every PostToolUse lint — exits `0`
  and prints stdout JSON `{"hookSpecificOutput":{"hookEventName":"PostToolUse",
  "additionalContext":"…"}}` ([docs](https://code.claude.com/docs/en/hooks)). Exit `2` on an
  advisory still reaches the model, but the UI shows *"hook returned blocking error"* on
  every hit; two plugins shipped that way until #87. Tests for an advisory therefore assert
  the parsed JSON for a finding and empty stdout + stderr for quiet — exit code alone can't
  tell them apart.
