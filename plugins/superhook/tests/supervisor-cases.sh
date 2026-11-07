#!/usr/bin/env bash
# Case suite for scripts/superhook.js (the supervisor) and scripts/superhook-digest.js.
#
# superhook sits in front of a consumer's GUARDS, so the halves that matter are:
#   must-BLOCK  every block the inner hook emits reaches the harness — JSON block, JSON
#               deny, exit 2 — and a repeated PreToolUse deny is NEVER downgraded (the
#               1.0.x loop breaker turned the 3rd identical retry into an allow)
#   no-ALLOW    the wrapper never synthesizes an approve/allow: on PreToolUse that skips
#               the permission prompt (https://code.claude.com/docs/en/hooks, PreToolUse
#               decision control). Crash / empty / noop = no decision at all.
#   never-wedge a crash exits 0; a Stop gate that blocks 3x identically is released
#   wiring      hooks.json budgets: each inner timeout sits under the harness timeout, and
#               PreToolUse fails closed (onFailure: block) if the wrapper cannot run
#
# Inner hooks are stubs (tests/fixtures/stub-hook.js); no consumer repo is needed.
# Run:  bash plugins/superhook/tests/supervisor-cases.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUP="$HERE/../scripts/superhook.js"
DIG="$HERE/../scripts/superhook-digest.js"
HOOKS_JSON="$HERE/../hooks/hooks.json"
STUB="$HERE/fixtures/stub-hook.js"
pass=0; fail=0

PROJ=""
fresh() { [ -n "$PROJ" ] && rm -rf "$PROJ"; PROJ="$(mktemp -d)"; mkdir -p "$PROJ/.claude/hooks"; }
trap '[ -n "$PROJ" ] && rm -rf "$PROJ"; [ -n "${SPACED:-}" ] && rm -rf "$SPACED"' EXIT

PAYLOAD='{"session_id":"t","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"true"}}'

# sup <event> <inner argv...>  -> sets OUT, ERR, RC
sup() {
  local o e
  o=$(mktemp); e=$(mktemp)
  printf '%s' "$PAYLOAD" | CLAUDE_PROJECT_DIR="$PROJ" node "$SUP" "$@" >"$o" 2>"$e"; RC=$?
  OUT=$(cat "$o"); ERR=$(cat "$e"); rm -f "$o" "$e"
}

# j <python expr over d=parsed OUT>  -> prints result, or __NOJSON__
j() { printf '%s' "$OUT" | python3 -I -c '
import json, sys
try: d = json.loads(sys.stdin.read())
except Exception: print("__NOJSON__"); sys.exit()
print(eval(sys.argv[1]))' "$1"; }

check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then printf '  ok    %s\n' "$1"; pass=$((pass+1))
  else printf '  FAIL  %s\n        got:  %s\n        want: %s\n' "$1" "$2" "$3"; fail=$((fail+1)); fi
}
logcount() { /usr/bin/grep -c "\"action\":\"$1\"" "$PROJ/.claude/hooks/superhook.log" 2>/dev/null || true; }
no_decision='"decision" not in d and "permissionDecision" not in d.get("hookSpecificOutput", {})'

echo "must-BLOCK"
fresh
for i in 1 2 3 4; do
  sup PreToolUse -- node "$STUB" block
  check "PreToolUse JSON block #$i passes through" "$RC|$(j 'd["decision"]')" "0|block"
done
check "4 identical PreToolUse blocks logged loop-detected once" "$(logcount loop-detected)" "1"
check "no PreToolUse loop-break ever" "$(logcount loop-break)" "0"

fresh
for i in 1 2 3; do
  sup PreToolUse -- node "$STUB" deny
  check "PreToolUse permissionDecision deny #$i passes through" "$RC|$(j 'd["hookSpecificOutput"]["permissionDecision"]')" "0|deny"
done

fresh
for i in 1 2 3; do
  sup PreToolUse -- node "$STUB" exit2
  check "PreToolUse exit-2 block #$i keeps exit 2 + stderr" "$RC|$ERR" "2|stub: exit-2 block"
done

fresh
sup PreToolUse -- node "$STUB" numreason
check "a non-string reason still blocks" "$RC|$(j 'd["decision"]')|$(logcount pass-block)" "0|block|1"

fresh
sup PreToolUse -- node "$STUB" ask
check "PreToolUse ask passes through" "$RC|$(j 'd["hookSpecificOutput"]["permissionDecision"]')" "0|ask"

fresh
sup PreToolUse -- node "$STUB" block
sup PreToolUse -- node "$STUB" block
sup PreToolUse -- node "$STUB" approve
check "approve passes through" "$(j 'd["decision"]')" "approve"
sup PreToolUse -- node "$STUB" block
check "an approve resets the count" "$(logcount loop-detected)" "0"

echo "no-ALLOW"
fresh
sup PreToolUse -- node "$STUB" crash
check "PreToolUse crash: exit 0, no decision" "$RC|$(j "$no_decision")" "0|True"
check "PreToolUse crash: systemMessage says the gate did not run" "$(j '"did NOT run" in d["systemMessage"]')" "True"
check "crash logged crash-safe" "$(logcount crash-safe)" "1"

fresh
sup PreToolUse -- node "$PROJ/missing-hook.js"
check "missing inner script: exit 0, no decision" "$RC|$(j "$no_decision")" "0|True"

fresh
sup PreToolUse -- node "$STUB" unknown
check "exit 3: crash-safe, no decision" "$RC|$(j "$no_decision")|$(logcount crash-safe)" "0|True|1"

fresh
sup PreToolUse -- node "$STUB" empty
check "PreToolUse empty output stays empty (no synthesized approve)" "$RC|$OUT" "0|"

fresh
sup PreToolUse
check "no inner command: empty, exit 0" "$RC|$OUT|$(logcount noop)" "0||1"

fresh
sup PostToolUse -- node "$STUB" crash
check "non-decision event crash: silent" "$RC|$OUT" "0|"

fresh
sup PostToolUse -- node "$STUB" plain
check "plain text passes through verbatim" "$RC|$OUT" "0|stub plain text"

echo "never-wedge (Stop)"
fresh
sup Stop -- node "$STUB" block
check "Stop block #1 passes" "$(j 'd["decision"]')" "block"
sup Stop -- node "$STUB" block
check "Stop block #2 passes" "$(j 'd["decision"]')" "block"
sup Stop -- node "$STUB" block
check "Stop block #3 released: no decision, systemMessage" "$RC|$(j "$no_decision and 'overridden' in d['systemMessage']")" "0|True"
check "Stop release logged loop-break" "$(logcount loop-break)" "1"
sup Stop -- node "$STUB" block
check "counter restarts after a release" "$(j 'd["decision"]')" "block"

fresh
sup Stop -- node "$STUB" exit2
sup Stop -- node "$STUB" exit2
check "Stop exit-2 #2 still blocks" "$RC" "2"
sup Stop -- node "$STUB" exit2
check "Stop exit-2 #3 released too" "$RC|$(j "$no_decision")|$(logcount loop-break)" "0|True|1"

fresh
sup Stop -- node "$STUB" crash
check "Stop crash: exit 0, no decision" "$RC|$(j "$no_decision")" "0|True"

echo "argv"
SPACED="$(mktemp -d)/dir with space"; mkdir -p "$SPACED"; cp "$STUB" "$SPACED/"
fresh
sup PreToolUse -- node "$SPACED/stub-hook.js" block
check "argv form survives a path with a space" "$RC|$(j 'd["decision"]')" "0|block"
sup PreToolUse -- "node '$SPACED/stub-hook.js' deny"
check "single-string form runs through a shell" "$(j 'd["hookSpecificOutput"]["permissionDecision"]')" "deny"

echo "digest"
fresh
for i in 1 2 3; do sup PreToolUse -- node "$STUB" block; done
d_out=$(CLAUDE_PROJECT_DIR="$PROJ" node "$DIG"); d_rc=$?
check "digest surfaces loop-detected" "$d_rc|$(printf '%s' "$d_out" | /usr/bin/grep -c 'PreToolUse: 1 loop-detected')" "0|1"
printf '{"reviewedAt":"%s"}' "$(date -u +%Y-%m-%dT%H:%M:%S.999Z)" >"$PROJ/.claude/hooks/.superhook-state.json"
sleep 0.01
check "digest silent after review" "$(CLAUDE_PROJECT_DIR="$PROJ" node "$DIG")" ""
printf 'not json\n' >"$PROJ/.claude/hooks/superhook.log"
check "digest survives a garbage log" "$(CLAUDE_PROJECT_DIR="$PROJ" node "$DIG"; echo "rc=$?")" "rc=0"

echo "node-check (POSIX sh, runs when node cannot)"
NC="$HERE/../scripts/node-check.sh"
NODIR=$(mktemp -d); FAKEDIR=$(mktemp -d)
printf '#!/bin/sh\nexit 0\n' >"$FAKEDIR/node"; chmod +x "$FAKEDIR/node"
# nc <PATH value>  -> sets OUT, ERR, RC. /bin/sh by absolute path, as hooks.json starts it;
# run from an empty dir, since some shells read an empty PATH element as the cwd.
nc() {
  local o e
  o=$(mktemp); e=$(mktemp)
  (cd "$NODIR" && env -i PATH="$1" /bin/sh "$NC" >"$o" 2>"$e"); RC=$?
  OUT=$(cat "$o"); ERR=$(cat "$e"); rm -f "$o" "$e"
}
nc "$PATH"
check "node on PATH: silent, exit 0" "$RC|$OUT|$ERR" "0||"
nc "$FAKEDIR"
check "any node on PATH counts (a lookup, not a hardcoded path)" "$RC|$OUT|$ERR" "0||"
missing='"node is not on PATH" in d["systemMessage"] and "BLOCKS every Bash" in d["systemMessage"] and d["hookSpecificOutput"]["hookEventName"] == "SessionStart" and "NOT on PATH" in d["hookSpecificOutput"]["additionalContext"]'
nc "$NODIR"
check "node absent: SessionStart JSON with systemMessage, exit 0" "$RC|$(j "$missing")|$ERR" "0|True|"
nc ""
check "empty PATH: same JSON, exit 0" "$RC|$(j "$missing")|$ERR" "0|True|"
check "message names all three floor plugins" "$(j 'all(p in d["systemMessage"] for p in ("superhook", "nix-flake-kit", "brain-signals"))')" "True"
rm -rf "$NODIR" "$FAKEDIR"
nc_wired=$(python3 -I -c '
import json, sys
cmds = [h["command"] for e in json.load(open(sys.argv[1]))["hooks"]["SessionStart"] for h in e["hooks"]]
c = [x for x in cmds if "node-check.sh" in x]
print(len(c) == 1 and c[0].startswith("/bin/sh ") and "node " not in c[0])' "$HOOKS_JSON")
check "hooks.json starts node-check with /bin/sh, never node" "$nc_wired" "True"

echo "wiring"
# Budgets are read from the sources, never restated here.
wiring=$(python3 -I - "$HOOKS_JSON" "$SUP" <<'PY'
import json, re, sys
hooks = json.load(open(sys.argv[1]))["hooks"]
src = open(sys.argv[2]).read()
stop_ms = int(re.search(r"Stop: (\d[\d_]*)", src).group(1).replace("_", ""))
dflt_ms = int(re.search(r"DEFAULT_INNER_TIMEOUT_MS = (\d[\d_]*)", src).group(1).replace("_", ""))
stop = hooks["Stop"][0]["hooks"][0]
pre = hooks["PreToolUse"][0]
print(stop["timeout"] * 1000 > stop_ms,
      pre["hooks"][0]["timeout"] * 1000 > dflt_ms,
      pre["matcher"] == "Bash",
      pre["hooks"][0].get("onFailure") == "block",
      "onFailure" not in stop)
PY
)
check "inner budgets < harness timeouts; Bash matcher; PreToolUse fails closed; Stop does not" "$wiring" "True True True True True"

total=$((pass+fail))
echo "superhook: $pass passed, $fail failed ($total cases)"
# A floor, so a moved fixture cannot pass as zero cases.
if [ "$total" -lt 45 ]; then echo "FAIL: only $total cases ran (floor 45)"; exit 1; fi
[ "$fail" -eq 0 ]
