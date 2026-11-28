#!/usr/bin/env bash
# Case suite for scripts/send-guard.js (the PreToolUse hook on Slack send tools).
#
#   allow       a normal message: checklist injected, NO permissionDecision
#   deny        a link whose label is a URL (markdown or <url|label>); a "Sent using" footer
#   any-prefix  the suffix match covers every connector prefix; other tools stay silent
#   fail-open   garbage, empty or non-object input: exit 0, nothing on stdout
#   wiring      hooks.json matches the three send tools by suffix and nothing else
# Run:  bash plugins/slack-etiquette/tests/run.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
G="$HERE/../scripts/send-guard.js"
HOOKS="$HERE/../hooks/hooks.json"
pass=0; fail=0

check() { # label got want
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s\n  got:  %s\n  want: %s\n' "$1" "$2" "$3"; fi
}

# ev <tool> <message>  -> hook JSON on stdout
ev() { node -e 'process.stdout.write(JSON.stringify({hook_event_name:"PreToolUse",tool_name:process.argv[1],tool_input:{channel_id:"C0",message:process.argv[2]}}))' "$1" "$2"; }
# decision <stdin-json>  -> "deny" | "none" | "silent" ; plus exit code
run() { OUT="$(printf '%s' "$1" | node "$G")"; RC=$?; }
decision() {
  [ -z "$OUT" ] && { echo silent; return; }
  node -e 'const o=JSON.parse(process.argv[1]).hookSpecificOutput||{};process.stdout.write(o.permissionDecision||"none")' "$OUT"
}
ctx_lines() { node -e 'const o=JSON.parse(process.argv[1]).hookSpecificOutput||{};process.stdout.write(String((o.additionalContext||"").split("\n").length))' "$OUT"; }

T=mcp__claude_ai_Slack__slack_send_message

# ---- allow ------------------------------------------------------------------------
run "$(ev $T $'**Deploy done.** `v1.2.3` is live.\n- see [github.com/o/r/pull/7](https://github.com/o/r/pull/7)')"
check "allow: exit 0" "$RC" 0
check "allow: no decision" "$(decision)" none
check "allow: checklist <= 6 lines" "$( [ "$(ctx_lines)" -le 6 ] && echo ok)" ok
run "$(ev $T 'tail label [r/pull/7](https://github.com/o/r/pull/7) and <https://x.dev/a|x.dev/a>')"
check "allow: substring labels" "$(decision)" none
run "$(ev $T 'I was sent using the old link, see [docs](https://example.com)')"
check "allow: 'sent using' mid-sentence is not a footer" "$(decision)" none

# ---- deny -------------------------------------------------------------------------
run "$(ev $T 'See [https://github.com/o/r/pull/7](https://github.com/o/r/pull/7)')"
check "deny: markdown URL label" "$(decision)" deny
check "deny: reason names unfurl" "$(printf '%s' "$OUT" | grep -c unfurl)" 1
run "$(ev $T 'See [www.example.com](https://www.example.com)')"
check "deny: www label" "$(decision)" deny
run "$(ev $T 'See <https://example.com/x|https://example.com/x>')"
check "deny: mrkdwn URL label" "$(decision)" deny
run "$(ev $T $'Done.\n\n_Sent using Claude_')"
check "deny: hand-typed footer" "$(decision)" deny
run "$(ev $T $'Done.\n*Sent using* Claude\nSent using Claude')"
check "deny: double footer" "$(decision)" deny
check "deny: still exit 0" "$RC" 0

# ---- any connector prefix; other tools silent ----------------------------------------
for t in mcp__plugin_slack_slack__slack_send_message mcp__0b1c2d3e-uuid__slack_send_message_draft mcp__claude_ai_Slack__slack_schedule_message; do
  run "$(ev "$t" 'See [https://a.dev](https://a.dev)')"; check "prefix: $t denies" "$(decision)" deny
  run "$(ev "$t" 'fine')"; check "prefix: $t allows" "$(decision)" none
done
run "$(node -e 'process.stdout.write(JSON.stringify({tool_name:"mcp__x__slack_send_message",tool_input:{text:"[http://a](http://a)"}}))')"
check "field: text is checked too" "$(decision)" deny
run "$(ev mcp__claude_ai_Slack__slack_read_channel 'See [https://a.dev](https://a.dev)')"
check "other tool: silent" "$(decision)" silent
run "$(ev mcp__x__slack_send_message_draft_extra 'See [https://a.dev](https://a.dev)')"
check "suffix must end the name" "$(decision)" silent

# ---- fail open ----------------------------------------------------------------------
for g in 'not json {' '' 'null' '42' '{"tool_name":7}' '{"tool_name":"mcp__x__slack_send_message","tool_input":"str"}'; do
  run "$g"; check "fail-open rc: ${g:-<empty>}" "$RC" 0
done
run 'not json {'; check "fail-open: garbage silent" "$(decision)" silent
run '{"tool_name":"mcp__x__slack_send_message","tool_input":"str"}'; check "fail-open: bad input allows" "$(decision)" none

# ---- wiring -------------------------------------------------------------------------
m() { node -e 'const h=require(process.argv[1]);const re=new RegExp(h.hooks.PreToolUse[0].matcher);process.stdout.write(String(re.test(process.argv[2])))' "$HOOKS" "$1"; }
check "matcher: claude.ai send" "$(m mcp__claude_ai_Slack__slack_send_message)" true
check "matcher: plugin draft" "$(m mcp__plugin_slack_slack__slack_send_message_draft)" true
check "matcher: uuid schedule" "$(m mcp__0b1c__slack_schedule_message)" true
check "matcher: read tool" "$(m mcp__claude_ai_Slack__slack_read_thread)" false
check "matcher: Bash" "$(m Bash)" false

printf '%d passed, %d failed\n' "$pass" "$fail"
FLOOR=34
[ "$fail" -eq 0 ] && [ "$pass" -ge "$FLOOR" ] || { [ "$pass" -lt "$FLOOR" ] && echo "case floor: $pass < $FLOOR"; exit 1; }
