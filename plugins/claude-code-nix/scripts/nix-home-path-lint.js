#!/usr/bin/env node
/**
 * PostToolUse home-path lint (Write|Edit), .nix only.
 *
 * Enforces the runtime-path direction of the "Paths — two axes" convention
 * (CLAUDE.md § Conventions): a *runtime* path must be $HOME/XDG-relative, never a
 * hardcoded per-user home dir. So a `.nix` VALUE line containing `/Users/<name>`
 * or `/home/<name>` is flagged for reconsideration (use $HOME / XDG /
 * config.home.homeDirectory instead) — except the one line that DECLARES a
 * home, `users.users.<name>.home = "/Users/<name>";`, where the literal is
 * required (see HOME_DECLARATION_BEFORE below).
 *
 * Gate half: nix-config's ast-grep/rules/nix-hardcoded-home-path.yml carries the
 * same regex and exemptions and runs in CI on every commit, not just on Claude's
 * own writes. The two MUST stay in sync — change one, change the other. Last
 * synced 2026-09-16 with nix-config PR #532.
 *
 * Deliberately NOT flagged (the other axis): Nix SOURCE path literals like
 * `../../claude/CLAUDE.md` — those are eval-relative to the .nix file, copied to
 * /nix/store, and MUST be repo-relative. This lint only ever sees absolute
 * /Users//home/ strings, which are never source literals, so that axis is safe.
 *
 * Advisory, not a hard gate: comment lines are ignored, and a hardcoded home
 * path can rarely be intentional — so it surfaces the finding to Claude (exit 2,
 * message on stderr) to reconsider, without reverting the write. Never wedges a
 * turn: any unexpected error exits 0.
 *
 * Input: hook JSON on stdin (tool_input.file_path), same as autostage-nix.js.
 */

const fs = require("node:fs");
const path = require("node:path");

// A per-user home dir: /Users/<name> (macOS) or /home/<name> (Linux), where
// <name> starts lowercase (so /Users/Shared, a bare /home, and /Users/$USER are
// NOT matched).
//
// TERMINATOR, not a literal trailing slash (synced with nix-config PR #532,
// 2026-09-16). The old pattern required a `/` AFTER the user segment, so a path
// that ENDS at the home directory — `home = "/Users/izzy";` — slipped through
// both this hook and its gate half. `(?:$|[^a-z0-9._-])` accepts end-of-line or
// any character that cannot continue a username, so `/Users/izzy`,
// `/Users/izzy/x`, `/Users/izzy"` and `/Users/izzy ` all match. `$` is
// end-of-STRING here (no `m` flag) — correct, because the test runs per line.
// Same regex as nix-config's ast-grep/rules/nix-hardcoded-home-path.yml, whose
// `($|[^a-z0-9._-])` is the same set.
const HOME_PATH = /\/(?:Users|home)\/[a-z][a-z0-9._-]*(?:$|[^a-z0-9._-])/g;

// The NON-OPERATOR user segments — a Tart GUEST account (`admin`), the
// evalModules fixture user (`tester`), the option-`example` placeholder (`me`)
// and the composition-API fixture identity (`stranger`, nix-config
// modules/parts/checks.nix, "exercised AS A STRANGER WOULD"). None of them is
// a path on a fleet machine, so none has a $HOME/XDG spelling. Introduced with
// the tart-vms capsule, ADR-002 wave 5; `stranger` joined in nix-config PR #532.
// KEEP IN SYNC with ast-grep/rules/nix-hardcoded-home-path.yml, whose header
// carries the per-name rationale and the file:line each one lives at — that
// file is the gate half of this advisory hook. Global flag: every exempt match
// on a line is REMOVED before the line is tested, so an exempt path alongside a
// real one no longer hides the real one (the old `&& !EXEMPT.test(line)` did).
const EXEMPT_USER = /\/(?:Users|home)\/(?:admin|tester|me|stranger)(?:$|[^a-z0-9._-])/g;

// STRUCTURAL exemption: `users.users.<name>.home = "/Users/<name>";` DECLARES
// where a home is. It is the one place the literal is not just allowed but
// required — $HOME is undefined at eval, and `config.users.users.<n>.home` there
// would be a self-reference. The ast-grep rule exempts it by SHAPE (a string
// inside a binding whose attrpath matches `(^|\.)home$`), so it survives an
// account rename and every OTHER use of a home path stays an error.
//
// LINE-BASED APPROXIMATION of that shape (added 2026-09-16, nix-config PR #532):
// the text on the same line BEFORE the home path must end with an attrpath whose
// last segment is `home`, then `=`, then the opening `"` — i.e. the string is
// the direct value of a `…home =` binding. That covers every spelling the rule's
// tests pin, plus the one-line form nix-config's checks.nix actually uses:
//   users.users.izzy.home = "/Users/izzy";          (dotted attrpath)
//   home = "/Users/izzy";                           (inside users.users.izzy = { … })
//   { users.users.stranger.home = "/Users/stranger"; }   (one-line attrset)
// Known limits, accepted for an advisory hook:
//   * The binding must be on ONE line. `home =` with the string on the next line
//     is FLAGGED (false positive) — the LHS is not on the string's line.
//   * Any attrpath ending in `.home` is exempt (e.g. `programs.foo.home = …`),
//     exactly as the rule's `(^|\.)home$` is — the shape is the name, not the
//     `users.users.` prefix, in both places.
//   * The rule's `inside … stopBy: end` also exempts a string NESTED anywhere
//     under a `home = { … }` attrset. This hook does NOT (only the string that
//     is the binding's DIRECT value is exempt), so here the hook is the STRICTER
//     of the two.
//   * Only a `"…"` string is recognised, not an `''…''` indented string — a
//     home DECLARATION in an indented string does not occur.
const HOME_DECLARATION_BEFORE = /(?:^|[\s{;(])(?:[^\s=]+\.)?home\s*=\s*"$/;

try {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    process.exit(0);
  }
  if (!raw.trim()) process.exit(0);

  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const ti = evt.tool_input || {};
  const file = ti.file_path || (evt.tool_response && evt.tool_response.filePath) || "";
  if (!file || !file.endsWith(".nix")) process.exit(0);

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const abs = path.resolve(projectDir, file);
  if (!abs.startsWith(path.resolve(projectDir))) process.exit(0);

  let content = "";
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch {
    process.exit(0); // file gone / unreadable — nothing to lint
  }

  const hits = [];
  content.split("\n").forEach((line, i) => {
    // Strip a trailing comment so `# … /Users/ismail …` prose is ignored; only
    // the code portion of the line is linted. (A `#` inside a string alongside a
    // home path is vanishingly rare and acceptable for an advisory lint.)
    const code = line.split("#")[0].replace(EXEMPT_USER, "");
    for (const m of code.matchAll(HOME_PATH)) {
      if (HOME_DECLARATION_BEFORE.test(code.slice(0, m.index))) continue;
      hits.push({ n: i + 1, text: line.trim() });
      break;
    }
  });

  if (hits.length === 0) process.exit(0);

  const rel = path.relative(projectDir, abs);
  const lines = hits
    .slice(0, 5)
    .map((h) => `  ${rel}:${h.n}: ${h.text}`)
    .join("\n");
  const more = hits.length > 5 ? `\n  …and ${hits.length - 5} more` : "";

  process.stderr.write(
    `Hardcoded per-user home path in a .nix value (CLAUDE.md § Conventions → "Paths — two axes"):\n` +
      `${lines}${more}\n` +
      `Runtime paths must be $HOME/XDG-relative — use $HOME, config.home.homeDirectory, or an XDG dir, ` +
      `not a literal /Users/<name> or /home/<name>. (Nix SOURCE path literals like ../../foo are exempt and correct — ` +
      `this only flags absolute home dirs.) Reconsider unless this absolute path is genuinely intentional.\n`,
  );
  process.exit(2); // surface to Claude to reconsider; does not revert the write
} catch {
  process.exit(0); // a PostToolUse lint must never wedge a turn
}
