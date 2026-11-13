#!/usr/bin/env bash
# The single-quoted $( ) strings are literal commands fed to the guard, never expanded.
# shellcheck disable=SC2016
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

expect "osascript heredoc clicking a menu" \
  '{"tool_name":"Bash","tool_input":{"command":"osascript <<'\''EOF'\''\ntell application \"System Events\" to tell process \"X\" to click menu bar item 1\nEOF"}}' ask
expect "osascript inside \$( )" \
  '{"tool_name":"Bash","tool_input":{"command":"r=$(osascript -e '\''tell app \"System Events\" to keystroke \"v\"'\''); echo $r"}}' ask
expect "osascript after cd && and a VAR= prefix" \
  '{"tool_name":"Bash","tool_input":{"command":"cd /tmp && X=1 /usr/bin/osascript -e '\''tell app \"System Events\" to key code 36'\''"}}' ask
expect "osascript under sudo" \
  '{"tool_name":"Bash","tool_input":{"command":"sudo osascript -e '\''tell app \"System Events\" to keystroke \"q\"'\''"}}' ask
expect "osascript inside bash -c" \
  '{"tool_name":"Bash","tool_input":{"command":"bash -c \"osascript -e '\''tell app \\\"System Events\\\" to keystroke \\\"q\\\"'\''\""}}' ask
expect "osascript piped from a shell heredoc" \
  '{"tool_name":"Bash","tool_input":{"command":"zsh <<EOF\nosascript -e '\''tell app \"System Events\" to keystroke \"q\"'\''\nEOF"}}' ask

expect "heredoc-written script then osascript by path" \
  '{"tool_name":"Bash","tool_input":{"command":"cat > s.applescript <<'\''EOF'\''\ntell application \"System Events\" to keystroke \"a\"\nEOF\nosascript s.applescript"}}' ask

echo "must ALLOW (exit 0, no output)"
# The 2026-11-07 false positives: the words as DATA, nothing runs osascript.
expect "grep PATTERN naming osascript + System Events" \
  '{"tool_name":"Bash","tool_input":{"command":"grep -n '\''osascript\\|System Events\\|keystroke'\'' modules/home/claude-guardrails.nix | head"}}' allow
expect "echo osascript; echo keystroke" \
  '{"tool_name":"Bash","tool_input":{"command":"echo osascript; echo keystroke"}}' allow
expect "printf writing an osascript line to a file" \
  '{"tool_name":"Bash","tool_input":{"command":"printf '\''%s'\'' \"osascript -e '\''tell application \\\"System Events\\\" to get name'\''\" > v/12-osascript"}}' allow
expect "cat heredoc writing an injection script" \
  '{"tool_name":"Bash","tool_input":{"command":"cat > s.applescript <<'\''EOF'\''\ntell application \"System Events\" to keystroke \"a\"\nEOF\necho osascript next"}}' allow
expect "osascript read, System Events in a later grep" \
  '{"tool_name":"Bash","tool_input":{"command":"osascript -e '\''id of app \"Finder\"'\''; grep -c '\''System Events'\'' notes.md"}}' allow
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

DEEP_BAD=$(python3 -I -c 'print("echo " + "$(" * 5000 + "osascript -e \"tell application \\\"System Events\\\" to keystroke \\\"a\\\"\"" + ")" * 5000)')
DEEP_OK=$(python3 -I -c 'print("echo " + "$(" * 5000 + "ls" + ")" * 5000)')
mkb() { node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",tool_input:{command:process.argv[1]}}))' "$1"; }
KS="osascript -e 'tell application \"System Events\" to keystroke \"a\"'"

echo "parser fixes ported from smtp-egress — must ASK"
expect "depth: 5000-deep \$( around an injection"         "$(mkb "$DEEP_BAD")" ask
expect "comment: cliclick before a # comment"             "$(mkb 'cliclick c:1,2 # done')" ask
expect "wrapper value: sudo -u X osascript keystroke"     "$(mkb "sudo -u someuser $KS")" ask
expect "wrapper value: timeout -s KILL 5 osascript"       "$(mkb "timeout -s KILL 5 $KS")" ask
expect "wrapper value: nice -n 5 cliclick"                "$(mkb 'nice -n 5 cliclick c:1,2')" ask
expect "command (no -v) still runs: command cliclick"     "$(mkb 'command cliclick c:1,2')" ask
expect "combined flags: bash -lc '…keystroke'"            "$(mkb "bash -lc 'osascript -e \"tell application \\\"System Events\\\" to keystroke \\\"a\\\"\"'")" ask
expect "combined flags: sh -ec 'cliclick'"                "$(mkb "sh -ec 'cliclick c:1,2'")" ask
expect "eval \"osascript … keystroke\""                   "$(mkb "eval \"$KS\"")" ask
expect "env -S 'cliclick …'"                              "$(mkb "env -S 'cliclick c:1,2'")" ask
expect "heredoc piped to a shell: cat <<EOF | bash"       "$(mkb $'cat <<EOF | bash\nosascript -e \'tell application "System Events" to keystroke "a"\'\nEOF')" ask
expect "echo '…' | sh"                                    "$(mkb "echo 'cliclick c:1,2' | sh")" ask

echo "parser fixes ported from smtp-egress — must ALLOW"
expect "depth: 5000-deep \$( with nothing dangerous"      "$(mkb "$DEEP_OK")" allow
expect "comment naming keystroke after an osascript read" "$(mkb "osascript -e 'id of app \"Finder\"' # not a keystroke via System Events")" allow
expect "wrapper value: sudo -u osascript ls (value word)" "$(mkb 'sudo -u osascript ls -la')" allow
expect "wrapper value: timeout -s KILL 5 ls"              "$(mkb 'timeout -s KILL 5 ls')" allow
expect "command -v osascript / command -v cliclick"       "$(mkb 'command -v osascript; command -v cliclick')" allow
expect "combined flags: bash -lc with a read only"        "$(mkb "bash -lc \"osascript -e 'id of app \\\"Finder\\\"'\"")" allow
expect "eval of a harmless command"                       "$(mkb 'eval "ls -la"')" allow
expect "cat <<EOF | bash with nothing dangerous"          "$(mkb $'cat <<EOF | bash\necho hello\nEOF')" allow
expect "echo naming keystroke | grep (no shell)"          "$(mkb "echo 'osascript keystroke System Events' | grep -c keystroke")" allow

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
