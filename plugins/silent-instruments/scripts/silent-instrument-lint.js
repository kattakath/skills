#!/usr/bin/env node
/**
 * PostToolUse advisory for Bash commands that measure SILENTLY — commands that will
 * exit 0 having measured nothing, or the wrong thing, so their output looks like
 * evidence and is not. Each rule names its catalogue entry
 * (skills/silent-instruments/references/catalogue.md) so the advice is traceable to a
 * measurement rather than to an opinion.
 *
 * WHY PostToolUse AND NOT PreToolUse — this is the load-bearing design decision, and
 * it is a security one. PreToolUse cannot advise without taking a permission
 * decision: the documented `permissionDecision: "allow"` means "tool call proceeds
 * WITHOUT permission prompt", so a globally-enabled plugin hook that used it would
 * bypass the user's own permission rules on every command it matched. `"deny"` blocks
 * legitimate work, `"ask"` adds a prompt to every match, and emitting
 * `additionalContext` with no decision is undocumented. PostToolUse has NO permission
 * authority at all — the tool has already run — so it cannot widen anything.
 *
 * It is also the better moment on the merits. These are not dangerous commands; they
 * are outputs about to be misread. PostToolUse fires between execution and
 * interpretation, which is exactly where the misreading happens.
 *
 * EXIT DISCIPLINE, matching this repo's claude-code-nix hooks:
 *   0  nothing to say, or anything went wrong (an advisory must never wedge a turn)
 *   2  surface the advisory to Claude; reverts nothing, blocks nothing
 *
 * FALSE POSITIVES ARE THE REAL RISK. This hook is enabled globally, so a noisy rule
 * is worse than a missing one: advice that fires on ordinary work gets ignored, and an
 * ignored channel protects nothing. Every rule below is therefore shaped to the exact
 * construct that was measured, not to the general topic — and `tests/lint-cases.sh`
 * asserts the must-stay-QUIET half as carefully as the must-FLAG half.
 */

"use strict";

const RULES = [
  {
    id: "A16",
    // `for x in $list` — unquoted, and not a glob. In zsh (the default shell on
    // macOS) an unquoted parameter is NOT field-split, so this iterates ONCE over the
    // whole value and exits 0. Excludes "$list" (correct) and $list* (a glob).
    test: (c) => /\bfor\s+[A-Za-z_][A-Za-z0-9_]*\s+in\s+\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)(?![*?[\w])/.test(c),
    say: "`for x in $var` is not field-split in zsh, so it iterates ONCE over the whole value and exits 0 — the loop can do nothing and still look successful. Use `while IFS= read -r x; do …; done < <(producer)`, and cross-check the loop's count against an independent one.",
  },
  {
    id: "A6",
    test: (c) => /\$\{PIPESTATUS\[/.test(c) && !/set\s+-o\s+pipefail|set\s+-[a-z]*o\s+pipefail/.test(c),
    say: "`${PIPESTATUS[...]}` lies two different ways, and neither announces itself. In bash it is rewritten by the next command, so a stale read returns the INTERVENING command's status — usually 0, i.e. it reads as SUCCESS. In zsh there is no `PIPESTATUS` at all (it is `pipestatus`) and arrays are 1-indexed, so `[0]` is always empty. Prefer `set -o pipefail`; if you must read it, next line only, and `${pipestatus[1]}` in zsh.",
  },
  {
    id: "A4",
    // A pipeline whose status is then tested, without pipefail: the test sees only
    // the LAST stage. Shaped narrowly: an explicit `$?` read after a pipe.
    test: (c) => /\|/.test(c) && /\$\?/.test(c) && !/pipefail/.test(c) && !/\$\{PIPESTATUS\[/.test(c),
    say: "Without `set -o pipefail` a pipeline's `$?` is the LAST stage's status only, so a failing producer reads as success. Add `set -o pipefail` — and note `${PIPESTATUS[0]}` is NOT a safe substitute in zsh, where that index does not exist.",
  },
  {
    id: "A21",
    test: (c) => /\bps\s+(?:aux|-ef|ax)\b[^|]*\|\s*grep/.test(c),
    say: "`ps … | grep name` matches its own grep, so it can never report 'not running' — measured: a count of 3 for a process that did not exist. Use `pgrep -x name` (exit 1, no output, when absent).",
  },
  {
    id: "A20",
    test: (c) => /\bcurl\b/.test(c) && /(?:^|\s)-[a-zA-Z]*s/.test(c) && !/(?:^|\s)-[a-zA-Z]*f|--fail/.test(c),
    say: "`curl -s` exits 0 on HTTP 404/500 and hands you the error body, so a piped `jq` returns a clean empty answer from an error page. Use `curl -fsS`, or capture `-w '%{http_code}'` and branch on it.",
  },
  {
    id: "A10",
    test: (c) => /\bfind\b[^|]*-exec\b/.test(c),
    say: "`find … -exec cmd \\;` does NOT propagate the command's status — measured: `-exec false {} \\;` exits 0. Pipe through `xargs -0 -r` (which does propagate), or loop with `|| exit 1`.",
  },
  {
    id: "A1",
    test: (c) => /\b(?:local|export|declare|readonly)\s+[A-Za-z_][A-Za-z0-9_]*=\$\(/.test(c),
    say: "`local`/`export`/`declare` return THEIR own status, always 0, so the command substitution's failure vanishes and `set -e` never fires (ShellCheck SC2155). Declare and assign on separate lines.",
  },
  {
    id: "A14",
    test: (c) => /\bwc\s+-l\b/.test(c),
    say: "`wc -l` counts newlines, so a file whose last line has no trailing newline is undercounted by one — silently. `grep -c ''` counts lines. The same shape makes a `while read` loop drop the final item unless you add `|| [ -n \"$line\" ]`.",
  },
  {
    id: "B4",
    test: (c) => /merge-base\s+--is-ancestor|\bbranch\s+--merged\b/.test(c),
    say: "Ancestry answers 'is this commit OBJECT reachable', so squash, rebase and cherry-pick all make it say 'not merged' for work that IS merged. Use content — `git cherry <upstream> <branch>` or `git diff --quiet` on the paths — or ask the authority: `gh pr view --json state,mergedAt`.",
  },
  {
    id: "B5",
    test: (c) => /\bgit\s+diff\s+--quiet\b/.test(c),
    say: "`git diff --quiet` is BLIND to untracked files, so it reports a clean tree when a brand-new file is present — and flakes ignore untracked files, which is how an eval passes over a file git cannot see. Use `[ -z \"$(git status --porcelain)\" ]`.",
  },
  {
    id: "B1",
    test: (c) => /\bgit\s+checkout\s+--\s/.test(c),
    say: "`git checkout -- <path>` restores from the INDEX, not from HEAD, so it PRESERVES a staged mistake and discards only the unstaged part. Name the source: `git checkout HEAD -- <path>`.",
  },
  {
    id: "C5",
    test: (c) => /\bgh\s+api\b/.test(c) && !/--paginate|\bgraphql\b|--slurp/.test(c) && !/-X\s*(?:POST|PATCH|PUT|DELETE)|--method\s*(?:POST|PATCH|PUT|DELETE)/i.test(c),
    say: "REST list endpoints truncate at 30 (max 100) with NO marker in the body — a complete-looking array, HTTP 200. Use `gh api --paginate`, and treat `length == per_page` as 'assume truncated'.",
  },
  {
    id: "C11",
    test: (c) => /\bgh\b[^|]*--jq\b/.test(c) || /\|\s*jq\s+(?!-e\b)-r\b/.test(c),
    say: "A wrong or renamed `jq` path yields `null`, not an error, and passes through as exit 0 — absent, null and 'my path was wrong' are indistinguishable. Use `jq -e` for scalars, or assert the shape with `has(\"field\")`.",
  },
];

function main() {
  let raw = "";
  try {
    raw = require("fs").readFileSync(0, "utf8");
  } catch {
    process.exit(0); // no stdin — nothing to inspect
  }
  if (!raw.trim()) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // never throw on a malformed payload: a throw disarms silently
  }

  const name = payload && payload.tool_name;
  if (name !== "Bash") process.exit(0);

  const input = (payload && payload.tool_input) || {};
  const cmd = typeof input.command === "string" ? input.command : "";
  if (!cmd.trim()) process.exit(0);

  const hits = [];
  for (const r of RULES) {
    let fired = false;
    try {
      fired = r.test(cmd);
    } catch {
      fired = false; // a broken rule must not take the others down
    }
    if (fired) hits.push(r);
  }
  if (hits.length === 0) process.exit(0);

  const lines = [
    "silent-instruments: this command can exit 0 having measured nothing.",
    "",
  ];
  for (const h of hits) lines.push(`  [${h.id}] ${h.say}`);
  lines.push("");
  lines.push(
    "Before this output becomes a claim, cross-check it with a DIFFERENTLY SHAPED",
  );
  lines.push(
    "instrument — one that could disagree. Full entries, with the measurements and",
  );
  lines.push("primary sources: the skill's references/catalogue.md.");

  process.stderr.write(lines.join("\n") + "\n");
  process.exit(2); // surface to Claude; reverts nothing, blocks nothing
}

try {
  main();
} catch {
  process.exit(0); // an advisory must never wedge a turn
}
