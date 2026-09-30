---
name: marketplace-entry
description: Add, update, or validate a plugin entry in this repo's own marketplace.json/INDEX.md. Use when adding a plugin under plugins/ (a lone skill is a one-skill plugin), or when marketplace.json, index/*.json, or INDEX.md need to change together.
---

Scoped to this repo only — it assumes the `kattakath/skills` layout documented in `CLAUDE.md`.

**One shape, no exceptions:** every unit of content is a plugin under `plugins/<name>/` with
its own `.claude-plugin/plugin.json`. A lone skill is a plugin with one skill in it. There is
no root `skills/` tree, and **no `source: "./"` entry** — see `CLAUDE.md` § Never use
`source: "./"` for why the upstream shim is wrong here.

## Checklist

1. **Files first.**
   - `plugins/<name>/skills/<skill>/SKILL.md` — for a one-skill plugin keep `<skill>` equal to
     `<name>`, because the invocation string is `<plugin>:<skill>` and renaming either breaks
     every caller.
   - `plugins/<name>/.claude-plugin/plugin.json`, plus whichever of `agents/`, `commands/`,
     `hooks/`, `output-styles/` it needs.
   - A skill's `scripts/`, `references/`, `assets/` and `tests/` live **beside its
     `SKILL.md`**, not at the plugin root: SKILL.md refers to them by skill-relative path.
   - `plugins/<name>/README.md` — every plugin has one. It is the marketplace-facing page:
     what it ships, the non-obvious facts it carries, what it requires. Written from the
     `SKILL.md`, not a restatement of the frontmatter. Note that `skill-usage.py` reads a
     backticked entry name anywhere in a plugin's markdown as a dependency, so naming a
     sibling in a README marks that sibling `exempt` from curation.
2. **The plugin manifest** — `plugin.json`, exactly these keys: `$schema`, `name`,
   `description`, `author`, `homepage`, `repository`, `license`, `keywords`. An **extra key
   fails validation**; there is deliberately no `version` (`CLAUDE.md` § Never add a
   `version`).
3. **Catalog entry** — `.claude-plugin/marketplace.json`, one object per plugin:
   - `"source": "./plugins/<name>"` — always a directory, never `"./"`, never with `strict`
     or `skills`.
   - `name`, `description`, `author`, `category`, `keywords`, `homepage`, `license`, `source`.
   - `license` MIT (matching `LICENSE`); `homepage`/`repository` point at
     `github.com/kattakath/skills` (not a fork or a per-plugin repo).
   - Keep the array **alpha-sorted by `name`** — the validate action's I1 invariant checks it.
4. **Route it (optional but preferred)** — if the new entry answers a "how do I do X"
   question, add a row to `index/routes.json` under `routes[].steps` (steps are bare entry
   names, so they survive a path move); add a `sources.json` entry only if the route points
   outward to another repo/marketplace. Then regenerate:
   ```bash
   python3 scripts/build-index.py
   ```
   Never hand-edit `INDEX.md` — it is generated output and CI's `Index up to date` step
   will fail a PR where the two have drifted.
5. **Validate before opening the PR:**
   ```bash
   npx -y @anthropic-ai/claude-code plugin validate .
   for p in plugins/*/; do npx -y @anthropic-ai/claude-code plugin validate "$p"; done
   python3 scripts/build-index.py --check
   ```
   Every plugin reports one warning — the missing `version` — and that is the intended state.
6. **Ship it** per `CLAUDE.md` § Shipping a change — a branch + PR, never a direct push to
   `main`. There is no `version` field on any entry: the PR merging **is** the release.

## Common mistakes this catches

- Reaching for `"source": "./"` + `"strict": false` + `"skills": [...]` because the content is
  "just a skill". That is upstream's shim for foreign repos with no `plugin.json`; here it
  costs the `keywords`, the per-plugin `homepage`, and a whole-repo copy per install.
- Adding a plugin directory but forgetting the `marketplace.json` entry — it works locally but
  is invisible to `/plugin install`.
- Renaming the skill directory to something other than the plugin name on a one-skill plugin,
  which silently changes the `<plugin>:<skill>` invocation string.
- Moving a skill's `scripts/`/`tests/` up to the plugin root — SKILL.md's relative references
  and the tests' own `dirname`-relative paths both break.
- Editing `INDEX.md` by hand instead of `index/routes.json` — the next `build-index.py
  --check` (or CI) reverts your understanding of what's current.
