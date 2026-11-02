#!/usr/bin/env bash
# Case suite for mac-send-guard.js.
#
# Every case exits 0 now (a match ASKS rather than blocks), so the exit code alone
# no longer separates the halves. Each case is classified from stdout instead:
#   ask   — exit 0 and stdout is hook JSON with permissionDecision "ask"
#   allow — exit 0 and stdout is EMPTY
# Asserts BOTH halves plus resilience, because each half fails differently:
#   must-ASK    — a rule that stopped matching is a silent regression
#   must-ALLOW  — an over-broad rule interrupts ordinary work with a prompt, which
#                 trains the operator to click through it
#   never-throw — the guard exits 0 with no output on any error, so a throw would
#                 fail OPEN and disarm every rule above without reporting anything
set -uo pipefail

GUARD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/mac-send-guard.js"
pass=0; fail=0

# Prints ask | allow | other(<detail>). Decodes the JSON rather than grepping it.
run() {
  local out rc
  out=$(printf '%s' "$2" | node "$GUARD" 2>/dev/null); rc=$?
  [ "$rc" = 0 ] || { echo "other(exit=$rc)"; return; }
  [ -z "$out" ] && { echo allow; return; }
  printf '%s' "$out" | node -e '
    let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
      try {
        const h = JSON.parse(s).hookSpecificOutput || {};
        const ok = h.hookEventName === "PreToolUse" && h.permissionDecision === "ask"
          && typeof h.permissionDecisionReason === "string" && h.permissionDecisionReason.length > 0;
        console.log(ok ? "ask" : "other(json)");
      } catch { console.log("other(not-json)"); }
    });'
}

expect() { # name json want(ask|allow)
  local got; got=$(run "$1" "$2")
  if [ "$got" = "$3" ]; then
    printf '  ok    %-52s %s\n' "$1" "$got"; pass=$((pass+1))
  else
    printf '  FAIL  %-52s want=%s got=%s\n' "$1" "$3" "$got"; fail=$((fail+1))
  fi
}

# The decoded reason must be ONE line: it is what the operator reads in the prompt and
# what Claude reads if the call is declined. The raw JSON is always one line, so check
# the decoded string.
one_line() { # name json
  local got
  got=$(printf '%s' "$2" | node "$GUARD" 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (x) => (s += x)).on("end", () => {
      try { const r = JSON.parse(s).hookSpecificOutput.permissionDecisionReason;
        console.log(/[\r\n]/.test(r) ? "multi" : "one"); } catch { console.log("none"); }
    });')
  if [ "$got" = one ]; then
    printf '  ok    %-52s one line\n' "$1"; pass=$((pass+1))
  else
    printf '  FAIL  %-52s reason=%s\n' "$1" "$got"; fail=$((fail+1))
  fi
}

echo "must ASK (exit 0, permissionDecision=ask)"
expect "osascript + System Events keystroke" \
  '{"tool_name":"Bash","tool_input":{"command":"osascript -e '\''tell application \"System Events\" to keystroke \"a\"'\''"}}' ask
expect "cliclick click" \
  '{"tool_name":"Bash","tool_input":{"command":"cliclick c:100,200 # click at the panel"}}' ask
expect "multi-line app_type, no element_index" \
  '{"tool_name":"mcp__computer-use__app_type","tool_input":{"text":"line one\nline two","coordinate":[10,20]}}' ask
expect "request_access on the panel service" \
  '{"tool_name":"mcp__computer-use__request_access","tool_input":{"apps":["com.apple.appkit.xpc.openAndSavePanelService","WhatsApp"]}}' ask

echo "must ALLOW (exit 0, no output)"
expect "osascript reading a property (no input verb)" \
  '{"tool_name":"Bash","tool_input":{"command":"osascript -e '\''id of app \"WhatsApp\"'\''"}}' allow
expect "ordinary bash" \
  '{"tool_name":"Bash","tool_input":{"command":"ls -la ~/Documents"}}' allow
expect "multi-line app_type WITH element_index" \
  '{"tool_name":"mcp__computer-use__app_type","tool_input":{"text":"line one\nline two","element_index":53}}' allow
expect "multi-line app_type WITH target=focused" \
  '{"tool_name":"mcp__computer-use__app_type","tool_input":{"text":"a\nb","target":"focused"}}' allow
expect "single-line app_type by coordinate" \
  '{"tool_name":"mcp__computer-use__app_type","tool_input":{"text":"hello","coordinate":[10,20]}}' allow
expect "request_access for a normal app" \
  '{"tool_name":"mcp__computer-use__request_access","tool_input":{"apps":["WhatsApp"]}}' allow
expect "element_index 0 is a real target, not falsy" \
  '{"tool_name":"mcp__computer-use__app_type","tool_input":{"text":"a\nb","element_index":0}}' allow

echo "must NEVER THROW (exit 0, no output)"
expect "empty stdin"        '' allow
expect "malformed json"     '{not json' allow
expect "no tool_input"      '{"tool_name":"Bash"}' allow
expect "null tool_input"    '{"tool_name":"Bash","tool_input":null}' allow
expect "unrelated tool"     '{"tool_name":"Read","tool_input":{"file_path":"/tmp/x"}}' allow

echo "reason is ONE line (one per rule)"
one_line "osascript + System Events keystroke" \
  '{"tool_name":"Bash","tool_input":{"command":"osascript -e '\''tell application \"System Events\" to keystroke \"a\"'\''"}}'
one_line "multi-line app_type, no element_index" \
  '{"tool_name":"mcp__computer-use__app_type","tool_input":{"text":"line one\nline two","coordinate":[10,20]}}'
one_line "request_access on the panel service" \
  '{"tool_name":"mcp__computer-use__request_access","tool_input":{"apps":["com.apple.appkit.xpc.openAndSavePanelService","WhatsApp"]}}'

echo
echo "passed ${pass}, failed ${fail}"
[ "$fail" -eq 0 ]

exit 1  # MQ-EJECT-TEST: deliberate failure, never merge
