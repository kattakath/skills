# CLAUDE.md

This is `kattakath/skills` — Ismail Kattakath's standalone Claude Code plugin marketplace
and skill library. This file, plus `.claude/`, exist so this repo can be opened and worked
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
- Two shapes of content, one catalog:
  - `skills/<name>/SKILL.md` — bare Agent Skills, no bundling.
  - `plugins/<name>/` — bundles skills with commands/agents/hooks/output-styles under its
    own `.claude-plugin/plugin.json`.
- `.claude-plugin/marketplace.json` is the catalog, and it lists **both** kinds: a plugin
  bundle (`source: "./plugins/<name>"`) and a standalone skill (`source: "./"`, `skills:
  ["./skills/<name>"]`). Adding either means adding an entry here too.
- `INDEX.md` is **generated** (`scripts/build-index.py`) from `index/{routes,sources,
  curation}.json` plus `marketplace.json` — never hand-edit `INDEX.md`; edit the JSON and
  rerun the script. CI's `Index up to date` check fails a PR where they've drifted.
- `mcp/` holds MCP server declarations (one `server.json` per the MCP registry schema) —
  documented, none declared yet.
- `mcp-clients/` holds a portable MCP *client*-config catalog (the plain `mcpServers` shape
  every server's own README shows) — data, not a plugin; nix-config's gateway reads it
  directly.
- **Plugins here carry no `version` field: every commit on `main` is a new release**,
  shipped automatically to anyone with marketplace auto-update enabled. That raises the bar
  on what merges to `main` — see § Shipping a change.

## Adding a skill

1. `mkdir -p skills/<name>` (or `plugins/<name>/skills/<name>` if it belongs to a bundle).
2. Write `SKILL.md` with YAML frontmatter — `description` is what Claude Code matches
   against to auto-invoke it, so make it specific.
3. Add an entry to `.claude-plugin/marketplace.json`: standalone skills use `"source":
   "./"`, `"skills": ["./skills/<name>"]`.
4. If it fills a goal, add a route to `index/routes.json` (and a `sources.json` entry if it
   points outward), then run `python3 scripts/build-index.py` to regenerate `INDEX.md`.

## Adding a plugin

1. `mkdir -p plugins/<name>/.claude-plugin`, plus whichever of `skills/`, `agents/`,
   `commands/`, `hooks/` it needs.
2. Write `plugin.json` (`$schema`, `name`, `description`, `author`, `license`, `keywords`).
3. Add its entry to `.claude-plugin/marketplace.json`, `source: "./plugins/<name>"`.
4. Same `INDEX.md` step as above if it fills a goal.

## Validating before you push

```bash
npx -y @anthropic-ai/claude-code plugin validate .
for p in plugins/*/; do npx -y @anthropic-ai/claude-code plugin validate "$p"; done
python3 scripts/build-index.py --check
```

This is exactly what `.github/workflows/validate.yml` runs — matching it locally means CI
tells you nothing new. Plugins with test suites (`page-lab`, `mac-app-send`, `skill-curator`)
have their own commands in that workflow; check it before assuming "validate passes" is
sufficient for those.

## Shipping a change

- Branch off `main`, open a PR. `auto-merge.yml` arms squash-auto-merge on same-repo PRs
  (never forks) the moment they leave draft; `validate` is the required check that actually
  gates the merge.
- Because there's no `version` field, a merge to `main` **is** the release — treat `main`
  accordingly. This is what [`github-release-gate`](skills/github-release-gate) generalizes.
- Fork PRs land un-armed on purpose — a human merges those after review.

## Conventions

- MIT license on every plugin/skill (`LICENSE` at repo root).
- `homepage`/`repository` point at `github.com/kattakath/skills`, not a per-plugin repo —
  everything ships from this one tree.
- No secrets, no machine-specific paths, no dependency on any other repo's `CLAUDE.md` or
  `~/.claude` — anything here must work from a clean checkout.
