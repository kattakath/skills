#!/usr/bin/env node
// @ts-check
/**
 * poll-guard: a PreToolUse(Bash) adapter that DENIES waiting on CI in the foreground. A loop that
 * sleeps around `gh pr checks` / `gh run` / the runs API, or a blocking `gh run watch` /
 * `gh pr checks --watch`, holds the turn for the whole run and the run ends no sooner. ci-watch
 * (or ONE run_in_background watch) is the wait. A one-shot gh read is fine, and so is any command
 * run with run_in_background: true.
 *
 * Measured before it shipped (2026-11-28, 55,639 Bash calls in 1,155 local transcripts, counts
 * only): 74 hits (0.13%); a hand-checked sample was mostly real foreground waits. Heredoc bodies
 * are cut first, because a script being WRITTEN is data, not a wait.
 *
 * Contract (nix-dev-toolkit references/cli-contract.md, "never wire a CLI straight in as a
 * hook"): a finding prints ONE stdout JSON deny and exits 0; anything else, a parse failure
 * included, prints nothing and exits 0. It never exits 2 and never rewrites the command (no
 * updatedInput: auto mode can deny a rewrite).
 */
"use strict";

const fs = require("node:fs");

const REASON =
  "poll-guard: this waits on CI in the foreground, which holds the turn for the whole run. A push to the default branch is already watched by ci-watch; otherwise start ONE watch in the background (`node <ci-watch>/scripts/ci-watch.js --sha <sha>`, or this command with run_in_background: true) and carry on.";

/**
 * The command with every heredoc body removed (`<<EOF`, `<<-'EOF'`, `<<"EOF"` through its line).
 * @param {string} cmd
 */
function stripHeredocs(cmd) {
  const out = [];
  /** @type {string | null} */
  let end = null;
  for (const l of cmd.split("\n")) {
    if (end !== null) {
      if (l.replace(/^\t+/, "") === end) end = null;
      continue;
    }
    out.push(l);
    const m = l.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (m) end = m[2];
  }
  return out.join("\n");
}

/**
 * @param {string} command
 * @param {boolean} background
 * @returns {string | null} the deny reason, or null
 */
function classify(command, background) {
  if (!command || background) return null;
  // Quoted literals are data (an echo, a commit message). A double-quoted string that holds a
  // $(...) or backtick substitution runs code, so it stays.
  const cmd = stripHeredocs(command)
    .replace(/'[^']*'/g, "''")
    .replace(/"([^"\\]|\\.)*"/g, (s) => (/\$\(|(^|[^\\])`/.test(s) ? s : '""')); // \` is a literal backtick
  const ghCI = /\bgh\s+(pr\s+checks|run\s+(view|list|watch)|api\s+[^\n]*actions\/runs|pr\s+view)\b/;
  const loop = /\b(while|until)\b[\s\S]*\bdo\b|\bfor\b[\s\S]*\bdo\b/;
  const watcher = /\bgh\s+run\s+watch\b|\bgh\s+pr\s+checks\b[^\n|;&]*--watch\b/;
  if ((loop.test(cmd) && /\bsleep\b/.test(cmd) && ghCI.test(cmd)) || watcher.test(cmd)) return REASON;
  return null;
}

function hook() {
  let evt;
  try {
    evt = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const input = (evt && evt.tool_input) || {};
  const reason = classify(String(input.command || ""), input.run_in_background === true);
  if (!reason) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) + "\n",
  );
}

if (require.main === module) {
  try {
    hook();
  } catch {
    // An adapter bug must never block a call: no output, exit 0.
  }
  process.exit(0);
}
module.exports = { classify, stripHeredocs };
