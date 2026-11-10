#!/usr/bin/env bash
# Case suite for scripts/stop-limbo.js (the Stop hook).
#
# Three halves, as in silent-instruments' lint-cases.sh:
#   must-WARN   a case that stopped matching is a silent regression
#   must-QUIET  the important half: this hook runs at the end of EVERY turn, so a rule
#               that fires on ordinary replies trains the reader to ignore it
#   never-throw a crash must exit 0 with no output (fail open), never wedge a turn
#
# The hook always exits 0. A warning is stdout JSON {"systemMessage": "…"} and must
# carry NO `decision` and NO `hookSpecificOutput` — on Stop both of those continue the
# conversation, which would turn warn mode into block mode. Quiet = exit 0 AND empty
# stdout AND empty stderr. Fixtures are synthetic transcripts in tests/fixtures/.
#
# Run:  bash plugins/brain-signals/tests/stop-limbo-cases.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/../scripts/stop-limbo.js"
FX="$HERE/fixtures"
DATA="$(mktemp -d)"
trap 'rm -rf "$DATA"' EXIT
export CLAUDE_PLUGIN_DATA="$DATA"
LOG="$DATA/stop-limbo.jsonl"
pass=0; fail=0; warns=0

# input <fixture|-> <last_assistant_message|-> <background_tasks json|-> [stop_hook_active]
# "-" omits the field, so both the native path and the transcript fallback are exercised.
input() {
  python3 -I -c '
import json, sys
fx, msg, bg, active = sys.argv[1:5]
d = {"session_id": "test-session", "hook_event_name": "Stop", "stop_hook_active": active == "true"}
if fx != "-": d["transcript_path"] = fx
if msg != "-": d["last_assistant_message"] = msg
if bg != "-": d["background_tasks"] = json.loads(bg)
print(json.dumps(d))' "$1" "$2" "$3" "${4:-false}"
}

# run <json> -> "exit:<code> out:<bytes> err:<bytes>" ; sets $OUT
run() {
  local o e c
  o=$(mktemp); e=$(mktemp)
  printf '%s' "$1" | node "$HOOK" >"$o" 2>"$e"; c=$?
  OUT=$(cat "$o")
  RC="exit:$c out:$(wc -c <"$o" | tr -d ' ') err:$(wc -c <"$e" | tr -d ' ')"
  rm -f "$o" "$e"
}

# A warning's shape: systemMessage only, naming the case(s).
shape() {
  printf '%s' "$OUT" | python3 -I -c '
import json, sys
try:
    d = json.load(sys.stdin)
    assert set(d) == {"systemMessage"}, sorted(d)
    print(d["systemMessage"])
except Exception:
    pass'
}

# warn <case[,case]> <label> <json>
warn() {
  run "$3"
  local text; text=$(shape)
  local ok=1 c
  [ "${RC%% *}" = "exit:0" ] || ok=0
  for c in ${1//,/ }; do printf '%s' "$text" | grep -q "\[$c\]" || ok=0; done
  if [ $ok = 1 ]; then
    printf '  ok    WARN   %-28s %s\n' "$1" "$2"; pass=$((pass+1))
    warns=$((warns + $(printf '%s' "$1" | tr ',' '\n' | grep -c .)))
  else
    printf '  FAIL  WARN   %-28s %s (%s: %s)\n' "$1" "$2" "$RC" "$OUT"; fail=$((fail+1))
  fi
}
# quiet <label> <json>
quiet() {
  run "$2"
  if [ "$RC" = "exit:0 out:0 err:0" ]; then printf '  ok    QUIET  %s\n' "$1"; pass=$((pass+1))
  else printf '  FAIL  QUIET  %s (%s: %s)\n' "$1" "$RC" "$OUT"; fail=$((fail+1)); fi
}

RUNNING='[{"id":"bt1","type":"shell","status":"running","description":"tests","command":"make test"}]'

echo "== loop guard =="
quiet "stop_hook_active=true"            "$(input "$FX/open-question.jsonl" 'Want me to open the PR?' '[]' true)"

echo "== open-question =="
warn open-question "native text ends in ?"       "$(input "$FX/open-question.jsonl" $'The build is fixed.\n\nWant me to open the PR?' '[]')"
warn open-question "transcript fallback"         "$(input "$FX/open-question.jsonl" - '[]')"
warn open-question "bold **Proceed?**"           "$(input "$FX/open-question.jsonl" $'Ready.\n\n**Proceed?**' '[]')"
warn open-question "offer without ?"             "$(input "$FX/open-question.jsonl" $'Done.\n\nLet me know if you want the docs too.' '[]')"
warn open-question "AskUserQuestion only in an earlier turn" "$(input "$FX/ask-previous-turn.jsonl" - '[]')"
quiet "AskUserQuestion after the text"           "$(input "$FX/ask-after-text.jsonl" 'Two layouts fit. Which one do you want?' '[]')"
quiet "statement, not a question"                "$(input "$FX/open-question.jsonl" 'The build is fixed and pushed.' '[]')"
quiet "? only inside a code fence"               "$(input "$FX/open-question.jsonl" $'Pattern:\n\n```\n^a+?\n```' '[]')"
quiet "question mid-reply, verdict last"         "$(input "$FX/open-question.jsonl" $'Why did it fail? A stale lock.\n\nFixed by deleting it.' '[]')"
quiet "\"I'll let you know when it finishes\""   "$(input "$FX/open-question.jsonl" "I'll let you know when it finishes." '[]')"
warn open-question "question before a trailing --- rule" "$(input "$FX/open-question.jsonl" $'Done.\n\nWant me to push?\n\n---' '[]')"
warn open-question "typographic quotes around the offer" "$(input "$FX/open-question.jsonl" $'Done.\n\n\u201cShould I push?\u201d' '[]')"
quiet "? only inside inline code"               "$(input "$FX/open-question.jsonl" 'Done. The glob is `foo?`' '[]')"
quiet "verdict, then a trailing --- rule"        "$(input "$FX/open-question.jsonl" $'Done and pushed.\n\n---' '[]')"

echo "== silent-wait =="
warn silent-wait "native background_tasks running"   "$(input "$FX/bg-running.jsonl" 'Started the suite.' "$RUNNING")"
warn silent-wait "fallback: bash launch, no notification" "$(input "$FX/bg-running.jsonl" - -)"
warn silent-wait "fallback: async agent, no notification" "$(input "$FX/agent-running.jsonl" - -)"
warn silent-wait,open-question "both at once"        "$(input "$FX/bg-running.jsonl" 'Started the suite. Want me to push too?' "$RUNNING")"
quiet "native background_tasks empty"                "$(input "$FX/bg-running.jsonl" 'Started the suite.' '[]')"
quiet "native running, reply says waiting"           "$(input "$FX/bg-running.jsonl" "Started the suite in the background; I'll report when it lands." "$RUNNING")"
quiet "native running, reply has ⏳"                 "$(input "$FX/bg-running.jsonl" '⏳ suite running.' "$RUNNING")"
quiet "native running, typographic I\u2019ll report"    "$(input "$FX/bg-running.jsonl" $'Started the suite. I\u2019ll report back.' "$RUNNING")"
quiet "native running, reply names the notification" "$(input "$FX/bg-running.jsonl" 'Started the suite; a notification arrives when it ends.' "$RUNNING")"
quiet "native: only a teammate in flight"            "$(input "$FX/bg-running.jsonl" 'Started the suite.' '[{"id":"tm1","type":"teammate","status":"running"}]')"
quiet "native: only a paused task"                   "$(input "$FX/bg-running.jsonl" 'Started the suite.' '[{"id":"bt2","type":"subagent","status":"paused","description":"report"}]')"
quiet "native: only a [daemon] shell"                "$(input "$FX/bg-running.jsonl" 'Started the suite.' '[{"id":"bt3","type":"shell","status":"running","description":"SSM tunnel loop [daemon]"}]')"
warn silent-wait "native: daemon plus real work"     "$(input "$FX/bg-running.jsonl" 'Started the suite.' '[{"id":"bt3","type":"shell","status":"running","description":"SSM tunnel [daemon]"},{"id":"bt1","type":"shell","status":"running","description":"tests"}]')"
quiet "native task already completed"                "$(input "$FX/bg-running.jsonl" 'Started the suite.' '[{"id":"bt1","type":"shell","status":"completed"}]')"
quiet "fallback: completed notification"             "$(input "$FX/bg-completed.jsonl" - -)"
quiet "fallback: agent stopped by TaskStop"          "$(input "$FX/agent-stopped.jsonl" - -)"
quiet "fallback: agent running, reply says waiting"  "$(input "$FX/agent-running.jsonl" 'Launched it; waiting for the notification.' -)"

echo "== never-throw (fail open) =="
quiet "malformed transcript, fallback path"          "$(input "$FX/malformed.jsonl" - -)"
quiet "missing transcript, fallback path"            "$(input "$FX/does-not-exist.jsonl" - -)"
quiet "malformed transcript, open question (exemption unknowable)" "$(input "$FX/malformed.jsonl" 'Want me to?' '[]')"
quiet "no transcript_path at all"                    "$(input - - -)"
quiet "stdin is not JSON"                            "not json at all"
quiet "stdin is a JSON array"                        '[1,2,3]'
quiet "stdin empty"                                  ""
warn silent-wait "native fields still work with a malformed transcript" "$(input "$FX/malformed.jsonl" 'Started.' "$RUNNING")"

echo "== log: one line per warned case, no reply text =="
got=$(python3 -I -c '
import json, sys
n = 0
for line in open(sys.argv[1]):
    d = json.loads(line)
    assert set(d) - {"tasks"} == {"ts", "case", "session_id"}, sorted(d)
    if "tasks" in d:
        assert d["case"] == "silent-wait"
        for t in d["tasks"]:
            assert set(t) == {"type", "status", "description"} and len(t["description"]) <= 80
    assert d["case"] in ("open-question", "silent-wait") and d["session_id"] == "test-session"
    n += 1
print(n)' "$LOG" 2>&1)
if [ "$got" = "$warns" ]; then printf '  ok    LOG    %s lines, keys ts/case/session_id (+ tasks on silent-wait), no reply text\n' "$got"; pass=$((pass+1))
else printf '  FAIL  LOG    expected %s lines, got: %s\n' "$warns" "$got"; fail=$((fail+1)); fi

# A floor, so a moved fixtures dir or a broken helper cannot pass as zero cases.
total=$((pass + fail))
if [ "$total" -lt 30 ]; then echo "FAIL: only $total cases ran (floor 30)"; fail=$((fail+1)); fi
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
