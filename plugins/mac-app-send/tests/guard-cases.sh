#!/usr/bin/env bash
# Case suite for mac-send-guard.js.
#
# Asserts BOTH halves plus resilience, because each half fails differently:
#   must-BLOCK  — a rule that stopped matching is a silent regression
#   must-ALLOW  — an over-broad rule wedges ordinary work, which is worse
#   never-throw — the guard exits 0 on any error, so a throw would fail OPEN and
#                 disarm every rule above without reporting anything
set -uo pipefail

GUARD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/mac-send-guard.js"
pass=0; fail=0

run() { printf '%s' "$2" | node "$GUARD" >/dev/null 2>&1; echo $?; }

expect() { # name json want
  local got; got=$(run "$1" "$2")
  if [ "$got" = "$3" ]; then
    printf '  ok    %-52s exit=%s\n' "$1" "$got"; pass=$((pass+1))
  else
    printf '  FAIL  %-52s want=%s got=%s\n' "$1" "$3" "$got"; fail=$((fail+1))
  fi
}

echo "must BLOCK (exit 2)"
expect "osascript + System Events keystroke" \
  '{"tool_name":"Bash","tool_input":{"command":"osascript -e '\''tell application \"System Events\" to keystroke \"a\"'\''"}}' 2
expect "cliclick click" \
  '{"tool_name":"Bash","tool_input":{"command":"cliclick c:100,200 # click at the panel"}}' 2
expect "multi-line app_type, no element_index" \
  '{"tool_name":"mcp__computer-use__app_type","tool_input":{"text":"line one\nline two","coordinate":[10,20]}}' 2
expect "request_access on the panel service" \
  '{"tool_name":"mcp__computer-use__request_access","tool_input":{"apps":["com.apple.appkit.xpc.openAndSavePanelService","WhatsApp"]}}' 2

echo "must ALLOW (exit 0)"
expect "osascript reading a property (no input verb)" \
  '{"tool_name":"Bash","tool_input":{"command":"osascript -e '\''id of app \"WhatsApp\"'\''"}}' 0
expect "ordinary bash" \
  '{"tool_name":"Bash","tool_input":{"command":"ls -la ~/Documents"}}' 0
expect "multi-line app_type WITH element_index" \
  '{"tool_name":"mcp__computer-use__app_type","tool_input":{"text":"line one\nline two","element_index":53}}' 0
expect "multi-line app_type WITH target=focused" \
  '{"tool_name":"mcp__computer-use__app_type","tool_input":{"text":"a\nb","target":"focused"}}' 0
expect "single-line app_type by coordinate" \
  '{"tool_name":"mcp__computer-use__app_type","tool_input":{"text":"hello","coordinate":[10,20]}}' 0
expect "request_access for a normal app" \
  '{"tool_name":"mcp__computer-use__request_access","tool_input":{"apps":["WhatsApp"]}}' 0
expect "element_index 0 is a real target, not falsy" \
  '{"tool_name":"mcp__computer-use__app_type","tool_input":{"text":"a\nb","element_index":0}}' 0

echo "must NEVER THROW (exit 0)"
expect "empty stdin"        '' 0
expect "malformed json"     '{not json' 0
expect "no tool_input"      '{"tool_name":"Bash"}' 0
expect "null tool_input"    '{"tool_name":"Bash","tool_input":null}' 0
expect "unrelated tool"     '{"tool_name":"Read","tool_input":{"file_path":"/tmp/x"}}' 0

echo
echo "passed ${pass}, failed ${fail}"
[ "$fail" -eq 0 ]
