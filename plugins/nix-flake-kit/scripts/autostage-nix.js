#!/usr/bin/env node
// @ts-check
/**
 * PostToolUse auto-stage hook (Write|Edit).
 *
 * Safety net for the git-purity rule: flakes evaluate the git tree, so a newly
 * written .nix file must be known to git to be visible to evaluation. This stages
 * it right after the write. Only files under CLAUDE_PROJECT_DIR are touched
 * (hook-input.js owns that test).
 *
 * Hook input arrives as JSON on stdin (NOT via env vars). The earlier
 * $CLAUDE_TOOL_FILE_PATH version was a silent no-op because that variable is never
 * populated for PostToolUse.
 *
 * NO SHELL. `git` is spawned with an argument vector, and `--` ends its options, so
 * a filename is only ever a pathspec. The old `execSync(\`git add ${JSON.stringify(abs)}\`)`
 * put the path inside shell double quotes, where `$(…)` and backticks still expand:
 * writing `$(touch PWNED).nix` ran `touch` (measured 2026-11-07).
 *
 * RUN FROM THE FILE'S OWN DIRECTORY, not the project root. git then finds the
 * repository the file actually belongs to. Claude Code creates its worktrees INSIDE
 * the project (`.claude/worktrees/<name>/`, code.claude.com/docs/en/worktrees) and
 * keeps CLAUDE_PROJECT_DIR at the main checkout, so running from the root asked the
 * MAIN repo to add a path inside a nested worktree; git refused and the hook stayed
 * silent, leaving the file untracked in exactly the isolated sessions that need the
 * net. The same applies to a submodule or a nested repo holding its own flake.
 *
 * Never blocks, always exits 0. Silent when the file is in no repository or is
 * gitignored (both deliberate). Any OTHER failure (e.g. a concurrent index.lock) is
 * told to Claude via additionalContext, so a missed stage is never silent.
 */

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { readNixTarget } = require("./hook-input.js");

// Types only — erased at run time, so the hook still needs nothing but `node`. They come
// from Anthropic's own SDK (CI installs it as a dev dependency and runs tsc over this file).
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SyncHookJSONOutput} SyncHookJSONOutput */

const QUIET_FAILURE = /not a git repository|paths are ignored by one of your \.gitignore/i;

try {
  const t = readNixTarget();
  if (!t) process.exit(0);
  const shown = path.relative(t.projectDir, t.abs);

  try {
    execFileSync("git", ["add", "--", path.basename(t.abs)], {
      cwd: t.dir,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 8000,
    });
    /** @type {SyncHookJSONOutput} */
    const staged = { systemMessage: `auto-staged ${shown} (git-purity safety net)` };
    process.stdout.write(JSON.stringify(staged) + "\n");
  } catch (e) {
    const err = /** @type {{ stderr?: unknown, message?: unknown } | undefined} */ (e);
    const stderr = String((err && err.stderr) || (err && err.message) || "");
    if (!QUIET_FAILURE.test(stderr)) {
      const first = stderr.trim().split("\n")[0] || "git add failed";
      /** @type {SyncHookJSONOutput} */
      const missed = {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            `nix-flake-kit could NOT auto-stage ${shown}: ${first}\n` +
            `A flake does not see an untracked file. Stage ${t.abs} yourself before evaluating.`,
        },
      };
      process.stdout.write(JSON.stringify(missed) + "\n");
    }
  }
  process.exit(0);
} catch {
  process.exit(0); // a PostToolUse net must never wedge a turn
}
