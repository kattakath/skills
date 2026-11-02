#!/usr/bin/env node
/**
 * PreToolUse guard for macOS computer-use automation.
 *
 * Each rule catches a move that was MEASURED to cost a turn, asks the operator to
 * confirm it, and names the move that works. The point is to spend zero inference
 * rediscovering any of them.
 *
 * Rule 1 — osascript/cliclick input injection.
 *   When an `app_*` tool refuses a target, its refusal says verbatim: "Do not
 *   attempt to work around this restriction — never use AppleScript, System
 *   Events, shell commands, or any other method to send clicks or keystrokes to
 *   this app." This rule makes that mechanical. It matches ONLY input injection
 *   (System Events + keystroke/click), so reading a property with osascript, and
 *   the sanctioned macos-automator MCP, both stay allowed.
 *
 * Rule 2 — multi-line app_type without element_index.
 *   `app_type` targeted by COORDINATE delivers raw keystrokes. In chat apps Enter
 *   sends, so a multi-line message arrives as one bubble per line and cannot be
 *   recalled. Targeting by `element_index` (or `target`) sets AXValue as a
 *   whole-field replace and the newlines survive.
 *
 * Rule 3 — request_access on the Open/Save panel service.
 *   `com.apple.appkit.xpc.openAndSavePanelService` is not an installed app, so
 *   the call returns `notInstalled`, is short-circuited, and is NEVER shown to
 *   the user. It can never be granted. The way through is display-scope control,
 *   which is a different consent surface the user approves themselves.
 *
 * Contract: hook JSON on stdin. A match prints ONE line of hook JSON on stdout,
 * permissionDecision "ask", and exits 0: the operator gets a confirm prompt whose
 * reason is also what Claude reads if the call is declined or nobody is present,
 * so the reason is one line, verdict first, then the better route. No match:
 * exit 0 with no output. ANY unexpected error exits 0 with no output — a guard
 * that throws must not wedge a turn. That fail-open is also why tests assert the
 * must-ALLOW half: a guard that silently matches nothing is not a weak guard, it
 * is NO guard.
 */

const fs = require("node:fs");

// System Events input injection. Requires osascript/cliclick AND an actual
// input verb — `osascript -e 'tell app "Finder" to get name'` is not injection.
const INJECTOR = /\b(osascript|cliclick)\b/i;
const INPUT_VERB = /\b(keystroke|key code|click at|perform action|System Events)\b/i;

const PANEL_SERVICE = /openAndSavePanelService/i;

// One line on stdout, written synchronously: process.stdout.write to a pipe is async on
// macOS and process.exit can truncate it, and an empty stdout reads as ALLOW.
function ask(reason) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: reason.replace(/\s+/g, " ").trim(),
    },
  };
  fs.writeSync(1, JSON.stringify(out) + "\n");
  process.exit(0);
}

try {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    process.exit(0);
  }
  if (!raw.trim()) process.exit(0);

  const ev = JSON.parse(raw);
  const tool = ev.tool_name || "";
  const input = ev.tool_input || {};

  // ── Rule 1 ────────────────────────────────────────────────────────────────
  if (tool === "Bash") {
    const cmd = String(input.command || "");
    if (INJECTOR.test(cmd) && INPUT_VERB.test(cmd)) {
      ask(
        "mac-app-send: osascript/cliclick input injection works around a computer-use refusal that forbids it — prefer request_full_control then computer_batch (reading a value with osascript is fine). Allow anyway?"
      );
    }
  }

  // ── Rule 2 ────────────────────────────────────────────────────────────────
  if (/app_type$/.test(tool)) {
    const text = String(input.text ?? "");
    const targeted =
      input.element_index !== undefined && input.element_index !== null;
    const focused = input.target === "focused";
    if (text.includes("\n") && !targeted && !focused) {
      ask(
        "mac-app-send: multi-line app_type by coordinate sends raw keystrokes, so Enter sends one bubble per line — prefer app_ax_find role=AXTextArea then app_type element_index=N mode=replace, and screenshot the draft before Return. Allow anyway?"
      );
    }
  }

  // ── Rule 3 ────────────────────────────────────────────────────────────────
  if (/request_access$/.test(tool)) {
    const apps = Array.isArray(input.apps) ? input.apps : [];
    if (apps.some((a) => PANEL_SERVICE.test(String(a)))) {
      ask(
        "mac-app-send: request_access on openAndSavePanelService returns notInstalled, drops every other app in the call and is never shown to the user — prefer request_full_control then computer_batch, driving the panel's popups by keyboard. Allow anyway?"
      );
    }
  }

  process.exit(0);
} catch {
  // Never wedge a turn.
  process.exit(0);
}
