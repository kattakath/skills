#!/usr/bin/env node
/**
 * desktop-commander-guard.js — a PreToolUse gate on desktop-commander's own tools.
 *
 * WHY THE PLUGIN CARRIES THIS AND NOT THE OPERATOR'S REPO. desktop-commander is
 * wanted for exactly one thing: it runs commands OUTSIDE Claude Code's Bash tool,
 * so a worktree-isolated session whose worktree was deleted can still act. That is
 * also the whole risk — routing around the Bash tool routes around every
 * PreToolUse hook attached to Bash, and around the permission rules written in
 * terms of Bash command text.
 *
 * The operator's own Bash guard cannot close that: its hook is registered with
 * matcher `"Bash"`, so it is structurally never handed an MCP tool call. The
 * mitigation therefore belongs to the plugin that introduces the capability —
 * which also makes it work in every repo rather than only in the one repo whose
 * `.claude/` happens to hold a guard.
 *
 * TWO RULES, deliberately different in strength:
 *
 *   Rule A (BLOCK) — mirror the command-text denies that a filesystem sandbox
 *   cannot express. A macOS Seatbelt profile confines where writes land; it says
 *   nothing about `git push --force`, `gh pr merge`, or a command that prints a
 *   secret to stdout, because those have no filesystem component. Keychain reads
 *   in particular go through securityd over mach IPC, so no file rule touches
 *   them. These are blocked here, on the tool's own `command` argument.
 *
 *   Rule B (ADVISE) — when Bash is available, say so. This server is a FALLBACK.
 *   Using `start_process` for routine work when Bash works is strictly worse:
 *   same effect, none of the supervision. A non-blocking systemMessage, because a
 *   hard block here would be unfixable from inside a genuinely locked session —
 *   the one case the server exists for.
 *
 * HISTORY WORTH KEEPING: the operator's repo previously carried the OPPOSITE rule
 * — a nudge pushing a bare `ls`/`find`/`stat`/`ps`/`kill` TOWARD this server, on
 * the reasoning that tool preference was "not a safety concern". That was true
 * while desktop-commander was one server behind a gateway; it inverted when the
 * server became the deliberate way around the Bash tool. It was removed
 * 2026-10-07 and this file is its replacement, pointing the other way.
 *
 * FAIL OPEN, LOUDLY. A throw here would deny every call and strand the session.
 * Every failure path emits an explicit allow, so a bug in this file costs
 * supervision, never availability — the same trade the operator's own hooks make.
 *
 * MATCHER NOTE: hooks.json matches `desktop-commander__`, the SERVER segment,
 * rather than a full `mcp__plugin_…` prefix. Claude Code's plugin tool names are
 * `mcp__plugin_<plugin>_<server>__<tool>`, and a hardcoded full prefix in this
 * fleet has gone stale three times. The server segment survives a prefix change.
 */
"use strict";

// Tools that execute a command or write a file — the ones worth inspecting.
// A read-only tool (read_file, list_directory, get_config, …) is not gated:
// the Seatbelt profile already handles which paths are readable.
const EXEC_TOOLS = /(?:start_process|interact_with_process)$/;
const WRITE_TOOLS = /(?:write_file|edit_block|move_file|create_directory|write_pdf)$/;

/**
 * Rule A patterns. Each entry is [regex, reason].
 *
 * Anchored at a command position (start of string, or after a shell separator)
 * so a substring inside a longer word cannot trigger, and a compound command
 * cannot hide the real verb behind a harmless first segment. Mirrors the shape
 * the operator's Bash guard arrived at after measuring that a whole-command
 * anchor alone let `sudo`/`env`/`timeout` wrappers walk straight past it.
 */
const CMD_POS = String.raw`(?:^|[;&|(]|&&|\|\||\n)\s*(?:(?:sudo|env|timeout|nice|command|builtin|noglob|stdbuf|nohup|time)\s+(?:-\S+\s+|\S+=\S+\s+|\d+[smhd]?\s+)*)*`;

const DENY = [
  [`${CMD_POS}secret\\s+reveal\\b`, "prints a secret VALUE to stdout"],
  [
    `${CMD_POS}security\\s+find-(?:generic|internet)-password\\b[^\\n;&|]*\\s-\\S*w`,
    "prints a Keychain secret VALUE to stdout",
  ],
  [`${CMD_POS}(?:agenix|age)\\s[^\\n;&|]*(?:-d\\b|--decrypt\\b)`, "prints age plaintext to stdout"],
  [
    // `git\s[^…]*\spush` REQUIRED a token between "git " and " push", so the
    // commonest form — `git push --force` — never matched. Caught by
    // tests/guard-cases.sh on the first run; the optional group is the fix.
    `${CMD_POS}git\\s+(?:[^\\n;&|]*\\s)?push\\b[^\\n;&|]*\\s(?:--force|-f)(?:\\s|$)`,
    "force-push without a lease (use --force-with-lease)",
  ],
  [`${CMD_POS}gh\\s+pr\\s+merge\\b`, "merges a pull request"],
];

// `--force-with-lease` is explicitly ALLOWED: it is the safe way to update an
// agent's own rebased branch, and the operator's policy says so. The deny above
// requires `--force` or `-f` as a whole token, so the lease form does not match —
// asserted in tests/guard-cases.sh rather than left to the reader.

function allow(systemMessage) {
  const out = systemMessage ? { decision: "approve", systemMessage } : { decision: "approve" };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

function block(reason) {
  const msg = `desktop-commander: refused — ${reason}. This runs outside the Bash tool, so the operator's Bash rules do not see it; that is not a licence to bypass them. Route this through Bash, or ask the operator.`;
  process.stdout.write(JSON.stringify({ decision: "block", reason: msg, systemMessage: msg }));
  process.exit(0);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  raw += c;
});
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    allow(); // unparseable input is not a reason to strand the session
  }

  const tool = String((payload && payload.tool_name) || "");
  const input = (payload && payload.tool_input) || {};

  // Not one of ours (the matcher is deliberately broad) — say nothing.
  if (!/desktop-commander__/.test(tool)) allow();

  const isExec = EXEC_TOOLS.test(tool);
  const isWrite = WRITE_TOOLS.test(tool);
  if (!isExec && !isWrite) allow();

  if (isExec) {
    // `command` for start_process; `input` for interact_with_process (a REPL line).
    const cmd = String(input.command || input.input || "");
    if (cmd.trim()) {
      for (const [pattern, reason] of DENY) {
        let re;
        try {
          re = new RegExp(pattern, "i");
        } catch {
          continue; // a malformed pattern must not take the whole guard down
        }
        if (re.test(cmd)) block(reason);
      }
    }
  }

  allow(
    "desktop-commander is the FALLBACK for a session whose Bash tool is refusing. " +
      "If Bash works here, prefer it — same result, and it keeps the operator's hooks " +
      "and permission rules in the loop. Note the Seatbelt fence covers file paths " +
      "only; the command-text rules still apply to you.",
  );
});
