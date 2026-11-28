#!/usr/bin/env bash
# Case suite for bin/project-session and hooks/session-start. No real `claude` runs:
# tests/fixtures/claude is first on PATH and logs every call, and every case that could
# reach `claude` asserts the log, so a PATH slip cannot start a real session unnoticed.
#
#   name      https / ssh scp / ssh:// with port / nested groups / no remote / worktree
#   decide    ensure --dry-run: none, done, failed, live, worktree cwd, other repo, interactive
#             row, duplicates, unknown state, vanished cwd
#   act       create and resume argv exactly; trust refusal passed through verbatim
#   ids       no session id on stdout unless --debug
#   lock      a fresh lock refuses, a stale one is taken over
#   hook      silent outside git, in a background session and past its time bound
# Run:  bash plugins/project-sessions/tests/run.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PS="$HERE/../bin/project-session"
HOOK="$HERE/../hooks/session-start"
pass=0
fail=0
T="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$T"' EXIT
export PATH="$HERE/fixtures:$PATH" STUB_LOG="$T/log" STUB_AGENTS="$T/agents.json" XDG_STATE_HOME="$T/state"
unset CLAUDE_CODE_TASK_LIST_ID PROJECT_SESSION_CLAUDE STUB_UNTRUSTED STUB_SLEEP

check() { # label got want
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); else
    fail=$((fail + 1))
    printf 'FAIL %s\n  got:  %s\n  want: %s\n' "$1" "$2" "$3"
  fi
}
contains() { # label haystack needle
  case $2 in *"$3"*) pass=$((pass + 1)) ;; *)
    fail=$((fail + 1))
    printf 'FAIL %s\n  got:  %s\n  want to contain: %s\n' "$1" "$2" "$3"
    ;;
  esac
}
run() { # args... -> OUT ERR RC
  local o e
  o=$(mktemp) e=$(mktemp)
  "$@" >"$o" 2>"$e"
  RC=$?
  OUT=$(cat "$o") ERR=$(cat "$e")
  rm -f "$o" "$e"
}
uuid_free() { # label text
  if printf '%s' "$2" | grep -Eq '[0-9a-f]{8}-[0-9a-f]{4}-'; then
    fail=$((fail + 1))
    printf 'FAIL %s: a session id reached stdout: %s\n' "$1" "$2"
  else pass=$((pass + 1)); fi
}

# --- repos ------------------------------------------------------------------
mkrepo() { # dir [origin]
  mkdir -p "$1" && git -C "$1" init -q && git -C "$1" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  [ -n "${2:-}" ] && git -C "$1" remote add origin "$2"
  return 0
}
R="$T/r"
mkrepo "$R" https://github.com/o/r.git
git -C "$R" worktree add -q "$T/wt" -b wt
O="$T/other"
mkrepo "$O" https://github.com/o/r.git # same name, different repo
L="$T/local"
mkrepo "$L"

# --- name ---------------------------------------------------------------------
for c in \
  'https://github.com/o/r.git|github.com:o/r' \
  'https://github.com/o/r|github.com:o/r' \
  'https://github.com/o/r/|github.com:o/r' \
  'https://user@GitHub.com/o/r.git|github.com:o/r' \
  'git@github.com:o/r.git|github.com:o/r' \
  'git@github.com:o/r|github.com:o/r' \
  'ssh://git@gitlab.com:2222/g/sub/r.git|gitlab.com:g/sub/r' \
  'ssh://gitlab.com/g/sub/r|gitlab.com:g/sub/r' \
  'git@gitlab.com:g/sub/r.git|gitlab.com:g/sub/r'; do
  run "$PS" url-name "${c%%|*}"
  check "url-name ${c%%|*}" "$OUT" "${c#*|}"
done
for u in file:///srv/r.git /srv/r.git ./a:b; do
  run "$PS" url-name "$u"
  check "url-name $u is not a host" "$RC:$OUT" "1:"
done
run "$PS" name "$R"
check "name: https remote" "$OUT" "github.com:o/r"
run "$PS" name "$T/wt"
check "name: worktree maps to its repo" "$OUT" "github.com:o/r"
run "$PS" name "$L"
check "name: no remote" "$OUT" "local:$L"
mkdir -p "$L/sub"
run "$PS" name "$L/sub"
check "name: subdir of a no-remote repo" "$OUT" "local:$L"
run "$PS" name "$T"
check "name: outside git exits 2" "$RC" "2"

# --- decide (--dry-run) ---------------------------------------------------------
N=github.com:o/r
ID1=11111111-1111-4111-8111-111111111111
ID2=22222222-2222-4222-8222-222222222222
row() { # cwd state startedAt sessionId [kind] [name]
  printf '{"id":"%s","cwd":"%s","kind":"%s","startedAt":%s,"sessionId":"%s","name":"%s","state":%s}' \
    "${4:0:8}" "$1" "${5:-background}" "$3" "$4" "${6:-$N}" "$([ "$2" = null ] && echo null || echo "\"$2\"")"
}
agents() { (IFS=,; printf '[%s]' "$*") >"$STUB_AGENTS"; }
dry() { # label want [rc] -- agents already written
  : >"$STUB_LOG"
  run "$PS" ensure "$R" --dry-run
  check "dry: $1" "$RC:$OUT" "${3:-0}:$2"
  uuid_free "dry ids: $1" "$OUT"
  check "dry never starts a session: $1" "$(grep -c -- '--bg' "$STUB_LOG")" "0"
  check "dry read the agents list: $1" "$(grep -c 'agents --json --all' "$STUB_LOG")" "1"
}
agents
dry "none" "would-create $N"
agents "$(row "$R" "done" 100 $ID1)"
dry "done" "would-resume $N"
agents "$(row "$R" failed 100 $ID1)"
dry "failed is resumable" "would-resume $N"
agents "$(row "$R" idle 100 $ID1)"
dry "idle is live" "live $N"
agents "$(row "$R" working 100 $ID1)"
dry "working is live" "live $N"
agents "$(row "$R" blocked 100 $ID1)"
dry "blocked is live" "live $N"
agents "$(row "$T/wt" idle 100 $ID1)"
dry "worktree cwd counts as the repo" "live $N"
agents "$(row "$O" idle 100 $ID1)"
dry "same name in another repo is not a match" "would-create $N"
agents "$(row "$R" null 100 $ID1 interactive)"
dry "an interactive session is not a project session" "would-create $N"
agents "$(row "$R" idle 100 $ID1 background other-name)"
dry "a different name is not a match" "would-create $N"
agents "$(row "$T/gone" idle 100 $ID1)"
dry "a row whose cwd vanished is skipped" "would-create $N"
agents "$(row "$R" "done" 100 $ID1)" "$(row "$R" "done" 200 $ID2)"
dry "duplicates still resume" "would-resume $N"
check "duplicates are reported on stderr" "$ERR" "duplicates 2"
agents "$(row "$R" "done" 100 $ID1)" "$(row "$R" idle 50 $ID2)"
dry "live beats a newer stopped one" "live $N"
agents "$(row "$R" null 100 $ID1)"
dry "unknown state fails closed" "" 3
contains "unknown state says why" "$ERR" "unknown state"
printf '[{"cwd":"%s","kind":"background","startedAt":1,"sessionId":"%s","name":"%s","state":null,"status":"busy"}]' "$R" $ID1 "$N" >"$STUB_AGENTS"
dry "null state with a status is live" "live $N"
printf '[{"cwd":"%s","kind":"background","startedAt":1,"sessionId":"%s","name":"%s","state":"done","status":"idle","pid":4242}]' "$R" $ID1 "$N" >"$STUB_AGENTS"
dry "a done row with a pid is a resumed idle session, live (measured 2.1.330)" "live $N"
printf '[{"cwd":"%s","kind":"background","startedAt":1,"name":"%s","state":"done"}]' "$R" "$N" >"$STUB_AGENTS"
dry "a stopped row without a sessionId fails closed, never creates" "" 3
agents "$(row "$R" mystery 100 $ID1)" "$(row "$R" "done" 200 $ID2)"
dry "unknown + stopped still fails closed" "" 3

# --- act ------------------------------------------------------------------------
agents "$(row "$R" "done" 100 $ID1)" "$(row "$R" "done" 200 $ID2)"
: >"$STUB_LOG"
run "$PS" ensure "$T/wt"
check "resume: output" "$RC:$OUT" "0:resumed $N"
check "resume: argv is bare --bg --resume <newest full id>, from the repo root" \
  "$(grep -- '--bg' "$STUB_LOG")" "$R|TASK=<unset>|--bg --resume $ID2"
uuid_free "resume ids" "$OUT"

agents "$(row "$R" "done" 100 $ID1)"
STUB_COPY=1 run "$PS" ensure "$R"
check "resume that started a copy: exit 5, nothing on stdout" "$RC:$OUT" "5:"
contains "resume that started a copy: says so" "$ERR" "did not continue the same session"

agents
: >"$STUB_LOG"
run "$PS" ensure "$T/wt" --prompt "hello there"
check "create: output" "$RC:$OUT" "0:created $N"
check "create: argv, task list and cwd" "$(grep -- '--bg' "$STUB_LOG")" "$R|TASK=$N|--bg --name $N hello there"
uuid_free "create ids" "$OUT"

: >"$STUB_LOG"
run "$PS" ensure "$R" --debug
contains "debug shows the id" "$OUT" "99999999"

: >"$STUB_LOG"
STUB_UNTRUSTED=1 run "$PS" ensure "$R"
check "untrusted: non-zero, nothing on stdout" "$RC:$OUT" "1:"
contains "untrusted: claude's message verbatim" "$ERR" "Workspace not trusted. Run \`claude\` in $R once and accept the trust prompt"

printf 'not json' >"$STUB_AGENTS"
: >"$STUB_LOG"
run "$PS" ensure "$R"
check "broken agents list: fails, never creates" "$RC:$OUT:$(grep -c -- '--bg' "$STUB_LOG")" "4::0"

# --- status ------------------------------------------------------------------------
agents
run "$PS" status "$R"
check "status: none" "$OUT" "$N none"
agents "$(row "$R" "done" 200 $ID1)" "$(row "$R" idle 100 $ID2)"
run "$PS" status "$R"
check "status: live state wins" "$OUT" "$N idle"
run "$PS" status "$R" --session $ID2
check "status: caller is a background session" "$OUT" "background $N"
uuid_free "status ids" "$OUT"

# --- lock ---------------------------------------------------------------------------
agents
LK="$XDG_STATE_HOME/project-sessions/github-com-o-r.lock"
mkdir -p "$LK" && date +%s >"$LK/at"
PROJECT_SESSION_LOCK_WAIT_S=1 run "$PS" ensure "$R"
check "fresh lock refuses" "$RC" "75"
echo 1 >"$LK/at"
run "$PS" ensure "$R"
check "stale lock is taken over" "$RC:$OUT" "0:created $N"
check "lock released after ensure" "$([ -e "$LK" ] && echo held || echo free)" "free"

# --- hook ---------------------------------------------------------------------------
hook() { printf '{"session_id":"%s","cwd":"%s","hook_event_name":"SessionStart"}' "$1" "$2" | "$HOOK"; }
agents
run hook $ID1 "$T"
check "hook: silent outside git" "$RC:$OUT:$ERR" "0::"
run hook $ID1 "$R"
check "hook: none" "$(printf '%s' "$OUT" | jq -r .hookSpecificOutput.additionalContext)" \
  "project-sessions: this repo has no project session yet (name \`$N\`). Before multi-step work here, load the \`project-sessions\` skill."
check "hook: event name" "$(printf '%s' "$OUT" | jq -r .hookSpecificOutput.hookEventName)" "SessionStart"
agents "$(row "$R" idle 100 $ID2)"
run hook $ID1 "$T/wt"
contains "hook: names the live session" "$OUT" "is \`$N\` (idle)"
run hook $ID2 "$R"
check "hook: silent inside the project session itself" "$RC:$OUT:$ERR" "0::"
STUB_SLEEP=3 PROJECT_SESSION_HOOK_TICKS=5 run hook $ID1 "$R"
check "hook: silent past its time bound" "$RC:$OUT:$ERR" "0::"
printf 'not json' >"$STUB_AGENTS"
run hook $ID1 "$R"
check "hook: silent when claude agents is broken" "$RC:$OUT:$ERR" "0::"

# --- wiring -------------------------------------------------------------------------
# shellcheck disable=SC2016 # the literal ${CLAUDE_PLUGIN_ROOT} is what hooks.json holds
check "hooks.json: SessionStart runs the hook script" \
  "$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$HERE/../hooks/hooks.json")" '"${CLAUDE_PLUGIN_ROOT}"/hooks/session-start'
check "scripts are executable" "$([ -x "$PS" ] && [ -x "$HOOK" ] && echo yes)" "yes"

FLOOR=70
total=$((pass + fail))
[ "$total" -ge "$FLOOR" ] || {
  printf 'FAIL case floor: %s cases ran, floor is %s\n' "$total" "$FLOOR"
  fail=$((fail + 1))
}
printf 'project-sessions: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
