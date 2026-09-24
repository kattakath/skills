---
name: marketplace-entry
description: Add, update, or validate a skill or plugin entry in this repo's own marketplace.json/INDEX.md. Use when adding a new skill under skills/, a new plugin under plugins/, or when marketplace.json, index/*.json, or INDEX.md need to change together.
---

Scoped to this repo only — it assumes the `kattakath/skills` layout documented in `CLAUDE.md`.

## Checklist

1. **Files first.**
   - Skill: `skills/<name>/SKILL.md` (or `plugins/<bundle>/skills/<name>/SKILL.md`).
   - Plugin: `plugins/<name>/.claude-plugin/plugin.json` + its `skills/`/`agents/`/
     `commands/`/`hooks/` subdirs.
2. **Catalog entry** — `.claude-plugin/marketplace.json`, one object per plugin/skill:
   - Standalone skill: `"source": "./"`, `"skills": ["./skills/<name>"]`.
   - Bundled plugin: `"source": "./plugins/<name>"`.
   - Always include `name`, `description`, `author`, `license` (MIT, matching
     `LICENSE`), `homepage` pointing at `github.com/kattakath/skills` (not a fork or a
     per-plugin repo).
3. **Route it (optional but preferred)** — if the new entry answers a "how do I do X"
   question, add a row to `index/routes.json` under `routes[].steps`; add a
   `sources.json` entry only if the route points outward to another repo/marketplace.
   Then regenerate:
   ```bash
   python3 scripts/build-index.py
   ```
   Never hand-edit `INDEX.md` — it is generated output and CI's `Index up to date` step
   will fail a PR where the two have drifted.
4. **Validate before opening the PR:**
   ```bash
   npx -y @anthropic-ai/claude-code plugin validate .
   for p in plugins/*/; do npx -y @anthropic-ai/claude-code plugin validate "$p"; done
   python3 scripts/build-index.py --check
   ```
5. **Ship it** per `CLAUDE.md` § Shipping a change — a branch + PR, never a direct push to
   `main`. There is no `version` field on any entry: the PR merging **is** the release.

## Common mistakes this catches

- Adding a skill under `skills/` but forgetting the `marketplace.json` entry — the skill
  works locally but is invisible to `/plugin install`.
- Editing `INDEX.md` by hand instead of `index/routes.json` — the next `build-index.py
  --check` (or CI) reverts your understanding of what's current.
- Pointing `homepage`/`repository` at a different repo — everything here ships from this
  one tree, never a per-plugin split.
