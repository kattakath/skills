// poll-guard through its real hook entry (stdin JSON in, stdout out), case table.
// Prints "poll-guard: <pass> passed, <fail> failed"; exit 0 only when all pass.
"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const GUARD = process.env.POLL_GUARD || path.join(__dirname, "..", "scripts", "poll-guard.js");

/** [label, command, run_in_background, expect deny] */
const CASES = [
  // denied: foreground waits on CI
  ["until-loop on gh pr checks", 'until gh pr checks 12 | grep -qv pending; do sleep 20; done', false, true],
  ["while-loop on gh run view status", 'while [ "$(gh run view 9 --json status -q .status)" != completed ]; do sleep 10; done', false, true],
  ["for-seq loop with gh pr checks and sleep", 'for i in $(seq 1 30); do gh pr checks 5 && break; sleep 15; done', false, true],
  ["for-seq loop on the runs API", 'for i in $(seq 1 60); do gh api repos/o/r/actions/runs?head_sha=abc --jq .total_count; sleep 5; done', false, true],
  ["multi-line poll script inline", 'R=o/r\nfor i in $(seq 1 40); do\n  OUT=$(gh pr checks 30 2>&1)\n  echo "$OUT" | grep -q pending || break\n  sleep 15\ndone', false, true],
  ["gh run watch in the foreground", "gh run watch 123 --exit-status", false, true],
  ["timeout-wrapped gh run watch", "timeout 480 gh run watch 35 --exit-status --interval 15 >/dev/null 2>&1", false, true],
  ["gh pr checks --watch", "gh pr checks 42 --watch --fail-fast", false, true],
  ["while true poll on gh run list", 'while true; do gh run list -L 1 --json status; sleep 30; done', false, true],
  ["poll after a cd", 'cd ~/r && until gh run view 7 --json conclusion -q .conclusion | grep -q .; do sleep 9; done', false, true],
  ["gh pr view in a sleep loop", 'for n in 1 2 3; do gh pr view 9 --json mergeStateStatus; sleep 60; done', false, true],
  // allowed
  ["the same poll with run_in_background", 'until gh pr checks 12 | grep -qv pending; do sleep 20; done', true, false],
  ["gh run watch in the background", "gh run watch 123 --exit-status", true, false],
  ["one-shot gh pr checks", "gh pr checks 12", false, false],
  ["one-shot gh run view", "gh run view 99 --log-failed | tail -50", false, false],
  ["a loop over PRs with no sleep", 'for n in 1 2 3; do gh pr view $n --json title; done', false, false],
  ["a sleep loop with no gh CI call", 'until curl -fs localhost:8080/health; do sleep 1; done', false, false],
  ["writing a poll script to scratch (heredoc is data)", "cat > \"$S/w.sh\" <<'EOF'\nfor i in $(seq 1 120); do gh pr checks 3 && break; sleep 30; done\nEOF\nchmod +x \"$S/w.sh\"", false, false],
  ["running a wait script by path", 'bash "$S/wait-stable.sh" abc123', false, false],
  ["ci-watch --sha by hand", "node ci-watch.js --sha abc123", false, false],
  ["gh run rerun, no wait", "gh run rerun 99 --failed", false, false],
  ["echo that mentions the words", 'echo "never gh run watch in a loop with sleep; do not"', false, false],
  ["markdown note with escaped backticks naming a watcher", 'echo "gotcha: \\`gh pr checks --watch --fail-fast\\` trips on skipped checks" >> notes.md', false, false],
  ["single-quoted commit message mentioning a poll", "git commit -m 'ci: until gh pr checks; do sleep 5; done is banned'", false, false],
];

let pass = 0;
let fail = 0;
for (const [label, command, bg, wantDeny] of CASES) {
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, run_in_background: bg } });
  const r = spawnSync("node", [GUARD], { input, encoding: "utf8" });
  let deny = false;
  if (r.stdout.trim()) {
    try {
      deny = JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === "deny";
    } catch {
      deny = false;
    }
  }
  const quietOk = wantDeny || r.stdout === "";
  if (r.status === 0 && deny === wantDeny && quietOk) pass++;
  else {
    fail++;
    console.log(`FAIL poll-guard: ${label}: exit ${r.status}, deny ${deny}, want ${wantDeny}, stdout '${r.stdout.slice(0, 80)}'`);
  }
}
// Garbage in: nothing out, exit 0 (the adapter must never block a call by failing).
const g = spawnSync("node", [GUARD], { input: "not json", encoding: "utf8" });
if (g.status === 0 && g.stdout === "" && g.stderr === "") pass++;
else {
  fail++;
  console.log(`FAIL poll-guard: garbage input: exit ${g.status}, stdout '${g.stdout}'`);
}
console.log(`poll-guard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
