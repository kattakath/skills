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
mechanism, some (`mcp-clients/`, `mcp/`) is portable data external harnesses consume
directly.

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
- `INDEX.md` is **generated** (`scripts/build-index.py`) from `index/{routes,sources,
  curation}.json` plus `marketplace.json` — never hand-edit `INDEX.md`; edit the JSON and
  rerun the script. CI's `Index up to date` check fails a PR where they've drifted.
- `mcp/` holds MCP server declarations (one `server.json` per the MCP registry schema) —
  documented, none declared yet.
- `mcp-clients/` holds a portable MCP *client*-config catalog (the plain `mcpServers` shape
  every server's own README shows) — data, not a plugin. nix-config's gateway read it
  directly until that gateway was purged on 2026-10-02; it is now a **reference catalog**
  of real invocations, and the servers themselves live in the owning plugin's `.mcp.json`
  (`page-lab`, `claude-code-nix`, `mac-app-send`, `android-phone`, `rag`, `apify`,
  `wordpress`). A server needing a credential names a launcher BINARY there, because
  `.mcp.json` `env` takes literals and passthroughs only and cannot run a Keychain read —
  that half is a PATH package in nix-config (`local.gmailMcp`, `local.pluginMcp`).
- **Plugins here carry no `version` field: every commit on `main` is a new release**,
  shipped automatically to anyone with marketplace auto-update enabled. That raises the bar
  on what merges to `main` — see § Shipping a change.

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
   not trust the gate to catch a typo'd one. And there is no `version` (see § Never add a `version`).
4. Write `README.md` — **every plugin has one** (all 25, since #40). It is the page a reader
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
  (never forks) the moment they leave draft; `validate` is the required check that actually
  gates the merge.
- Because there's no `version` field, a merge to `main` **is** the release — treat `main`
  accordingly. This is what [`github-release-gate`](plugins/github-release-gate) generalizes.
- Fork PRs land un-armed on purpose — a human merges those after review.

### Never add a `version` to fix the validate warnings

`claude plugin validate .` reports a warning per plugin for the missing `version`. **That
warning is advisory and the answer is to leave it alone.** Omitting `version` is one of the
two release models Anthropic documents, and it is the one this repo chose deliberately
(`6dd2083`). Adding a version silently disables shipping:

- With no `version`, the version Claude Code computes is the **repo HEAD commit SHA**, so
  every merge to `main` is a new version that reaches users. Measured 2026-09-30: a hosted
  install of `harvest` (then still a `source: "./"` entry) and `page-lab` (a `./plugins/*`
  entry) both resolved to `908b76075a61`, exactly `origin/main`.
- With a `version` set, users stay on their cached copy **until the string changes**. Push
  content without bumping and `claude plugin update` reports
  `<name> is already at the latest version (1.0.0)` and `"updateOutcome":"up_to_date"` while
  serving stale files. Measured the same day: two generations of drift, reported as success.
  There is no drift signal — the failure is silent and unbounded.
- The cost is per entry, and there are 25 of them — 25 `plugin.json` strings to bump on
  every commit that touches a shared file, each miss a silent freeze.
- If a version is ever set, set it in **one** place. `plugin.json` wins over the marketplace
  entry at install time (`calculatePluginVersion` precedence) and the entry value is ignored
  without warning; `claude plugin validate` reports the mismatch, and `claude plugin tag`
  refuses to tag until they agree.

Upstream precedent for versionless: `anthropics/skills`, whose `source: "./"` layout this
repo copied until #31, sets no version on any of its entries either.

One property to keep in mind rather than fix: the computed version is the **repo HEAD** SHA,
not a per-directory one, so any commit revs all 25 entries. Since #31 each entry copies only
its own `plugins/<name>` subtree rather than the whole repo (~1.7 MB), so the re-copy is now
proportional to the plugin. Superseded versions are swept 14 days after replacement.

## Conventions

- MIT license on every plugin/skill (`LICENSE` at repo root).
- `homepage`/`repository` point at `github.com/kattakath/skills`, not a per-plugin repo —
  everything ships from this one tree.
- No secrets, no machine-specific paths, no dependency on any other repo's `CLAUDE.md` or
  `~/.claude` — anything here must work from a clean checkout.
