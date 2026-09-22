#!/usr/bin/env node
/**
 * PreToolUse guard for macOS computer-use automation.
 *
 * Each rule blocks a move that was MEASURED to cost a turn, and replaces it with
 * the move that works. The point is to spend zero inference rediscovering any of
 * them.
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
 * Contract: hook JSON on stdin; exit 2 + stderr blocks and explains; exit 0
 * allows. ANY unexpected error exits 0 — a guard that throws must not wedge a
 * turn. That fail-open is also why tests assert the must-ALLOW half: a guard that
 * silently matches nothing is not a weak guard, it is NO guard.
 */

const fs = require("node:fs");

// System Events input injection. Requires osascript/cliclick AND an actual
// input verb — `osascript -e 'tell app "Finder" to get name'` is not injection.
const INJECTOR = /\b(osascript|cliclick)\b/i;
const INPUT_VERB = /\b(keystroke|key code|click at|perform action|System Events)\b/i;

const PANEL_SERVICE = /openAndSavePanelService/i;

function block(msg) {
  process.stderr.write(msg + "\n");
  process.exit(2);
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
      block(
        "BLOCKED — sending synthetic clicks/keystrokes via osascript or cliclick.\n" +
          "\n" +
          "When a computer-use tool refuses a target, its refusal explicitly forbids\n" +
          "working around it this way. The refusal is about GRANT SCOPE, and the\n" +
          "sanctioned path is a different consent surface:\n" +
          "\n" +
          "  request_full_control   then   computer_batch\n" +
          "\n" +
          "The user approves display-scope themselves; if already approved this\n" +
          "session the call returns immediately.\n" +
          "\n" +
          "(Reading a value with osascript is fine — this matched an INPUT verb.)"
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
      block(
        "BLOCKED — multi-line app_type without element_index.\n" +
          "\n" +
          "Targeted by coordinate, app_type delivers RAW KEYSTROKES. In chat apps\n" +
          "Enter sends, so this arrives as one bubble per line and cannot be recalled.\n" +
          "\n" +
          "Fix:\n" +
          "  app_ax_find  role=AXTextArea            -> note the [N]\n" +
          "  app_type     element_index=N  mode=replace  text=<whole message>\n" +
          "\n" +
          "That sets AXValue as a whole-field replace and the newlines survive.\n" +
          "Confirm the result reads 'set AXValue (whole-field replace)', then\n" +
          "screenshot the draft BEFORE pressing Return."
      );
    }
  }

  // ── Rule 3 ────────────────────────────────────────────────────────────────
  if (/request_access$/.test(tool)) {
    const apps = Array.isArray(input.apps) ? input.apps : [];
    if (apps.some((a) => PANEL_SERVICE.test(String(a)))) {
      block(
        "BLOCKED — the Open/Save panel service can never be granted.\n" +
          "\n" +
          "com.apple.appkit.xpc.openAndSavePanelService is not an installed app, so\n" +
          "request_access returns notInstalled, short-circuits the WHOLE call (any\n" +
          "other apps in it are dropped too) and is never shown to the user.\n" +
          "\n" +
          "Use display-scope instead:\n" +
          "  request_full_control   then   computer_batch\n" +
          "\n" +
          "Inside the panel: List view first, and drive its popup menus with the\n" +
          "KEYBOARD — clicks on those menus are still refused."
      );
    }
  }

  process.exit(0);
} catch {
  // Never wedge a turn.
  process.exit(0);
}
