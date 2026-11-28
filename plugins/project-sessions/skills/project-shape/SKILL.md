---
name: project-shape
description: >-
  Check that a git repo is a valid Claude Code project, and scaffold the standard committed
  shape where it is missing: `CLAUDE.md` and `.claude/settings.json`. Use when the user says
  "set this repo up for Claude Code", "is this a valid Claude Code project", "add a
  CLAUDE.md", "check the Claude settings", or "validate this plugin repo", or before handing
  work to a repo that has no `CLAUDE.md`.
---

# project-shape

Look for `CLAUDE.md` and `.claude/settings.json` at the repo root.

**Both missing or one missing:** propose the standard shape, then ask with AskUserQuestion
before writing or committing anything.

- `CLAUDE.md`: generate it with the built-in `/init`.
- `.claude/settings.json`, exactly:

  ```json
  {
    "$schema": "https://json.schemastore.org/claude-code-settings.json"
  }
  ```

- The scaffold must read as something any developer wrote. **Do not mention this plugin, its
  marketplace or any personal setup in either file.**
- Committing needs the user's yes, given in AskUserQuestion. Commit only the two files.

**Present:** validate what is there.

- Settings: `check-jsonschema --schemafile https://json.schemastore.org/claude-code-settings.json .claude/settings.json`
  when `check-jsonschema` is installed. Otherwise run `jq empty .claude/settings.json` and say
  that only the JSON syntax was checked, not the schema.
- If the repo has `.claude-plugin/`: `claude plugin validate .`.
- Report failures. Fix them only after the user agrees.
