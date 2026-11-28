#!/usr/bin/env bash
# Case suite for bin/project-session and hooks/session-start. No real `claude` runs:
# tests/fixtures/claude is first on PATH and logs every call, and every case that could
# reach `claude` asserts the log, so a PATH slip cannot start a real session unnoticed.
#
#   name      https / ssh scp / ssh:// with port / nested groups / no remote / worktree
#   decide    ensure --dry-run: none, done, failed, live, worktree cwd, other repo, interactive
#             row, duplicates, unknown state, vanished cwd
#   act       create and resume argv exactly (with and without --permission-mode); trust
#             refusal passed through verbatim
#   ids       no session id on stdout unless --debug
#   lock      a fresh lock refuses, a stale one is taken over
#   hook      silent outside git, in a background session and past its time bound
#   auto      gating matrix (attended / unattended / AUTO=0 / AUTO=1 / background / outside
#             git); SessionStart runs ensure detached in the mirrored mode and returns within
#             its bound; resume on start, create deferred without a mode; untrusted reported;
#             UserPromptSubmit line, create in the caller's mode, plan not mirrored, fail-open
#   mode hook amends `project-session ensure` with the caller's mode; leaves other commands,
#             a command that names a mode, plan mode and garbage alone
# Run:  bash plugins/project-sessions/tests/run.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PS="$HERE/../bin/project-session"
HOOK="$HERE/../hooks/session-start"
PTU="$HERE/../hooks/pre-tool-use"
UPS="$HERE/../hooks/user-prompt-submit"
pass=0
fail=0
T="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$T"' EXIT
export PATH="$HERE/fixtures:$PATH" STUB_LOG="$T/log" STUB_AGENTS="$T/agents.json" XDG_STATE_HOME="$T/state"
unset CLAUDE_CODE_TASK_LIST_ID PROJECT_SESSION_CLAUDE STUB_UNTRUSTED STUB_SLEEP STUB_BG_SLEEP STUB_ENV_LOG \
  CLAUDE_CODE_SESSION_ATTENDED PROJECT_SESSIONS_AUTO PROJECT_SESSION_HOOK_TICKS PROJECT_SESSION_ENSURE_TICKS

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
agents "$(row "$R" stopped 100 $ID1)"
dry "stopped (reboot, service off) is resumable" "would-resume $N"
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
: >"$STUB_LOG"
run "$PS" ensure "$R" --permission-mode bypassPermissions
check "resume with --permission-mode: argv stays bare" \
  "$RC:$(grep -- '--bg' "$STUB_LOG")" "0:$R|TASK=<unset>|--bg --resume $ID2"
agents "$(row "$R" failed 100 $ID1)"
: >"$STUB_LOG"
run "$PS" ensure "$R"
check "failed: resumed by bare full id" "$RC:$OUT:$(grep -- '--bg' "$STUB_LOG")" "0:resumed $N:$R|TASK=<unset>|--bg --resume $ID1"

agents "$(row "$R" "done" 100 $ID1)"
STUB_COPY=1 run "$PS" ensure "$R"
check "resume that started a copy: exit 5, nothing on stdout" "$RC:$OUT" "5:"
contains "resume that started a copy: says so" "$ERR" "did not continue the same session"

agents
: >"$STUB_LOG"
run "$PS" ensure "$T/wt" --prompt "hello there"
check "create: output" "$RC:$OUT" "0:created $N"
check "create: argv and cwd, no --settings" "$(grep -- '--bg' "$STUB_LOG")" "$R|TASK=<unset>|--bg --name $N hello there"
uuid_free "create ids" "$OUT"
: >"$STUB_LOG"
run "$PS" ensure "$R" --permission-mode bypassPermissions --prompt "hi"
check "create with --permission-mode: passed on create" \
  "$RC:$(grep -- '--bg' "$STUB_LOG")" "0:$R|TASK=<unset>|--bg --name $N --permission-mode bypassPermissions hi"

# No task list is set: the session keeps Claude Code's default per-session list (1.4.0).
: >"$STUB_LOG"
run "$PS" ensure "$R" --prompt hi
check "task list: create passes no --settings" "$RC:$(grep -- '--bg' "$STUB_LOG" | grep -c -- '--settings')" "0:0"
# The scrub stays: a daemon a create or resume starts inherits the client env.
: >"$STUB_LOG"
CLAUDE_CODE_TASK_LIST_ID=github.com:x/caller run "$PS" ensure "$R" --prompt hi
check "scrub: the caller's list never reaches a create's client env" "$(grep -- '--bg' "$STUB_LOG" | cut -d'|' -f2)" "TASK=<unset>"
: >"$STUB_LOG"
CLAUDE_CODE_TASK_LIST_ID=github.com:x/caller run "$PS" ensure "$R" --permission-mode bypassPermissions --prompt hi
check "scrub: ...also a create with --permission-mode" "$(grep -- '--bg' "$STUB_LOG" | cut -d'|' -f2)" "TASK=<unset>"
agents "$(row "$R" "done" 100 $ID1)"
: >"$STUB_LOG"
CLAUDE_CODE_TASK_LIST_ID=github.com:x/caller run "$PS" ensure "$R"
check "scrub: the caller's list never reaches a resume's client env" "$RC:$(grep -- '--bg' "$STUB_LOG" | cut -d'|' -f2)" "0:TASK=<unset>"
agents
run "$PS" ensure "$R" --permission-mode
check "--permission-mode without a value fails" "$RC" "1"

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

# --- auto (SessionStart + UserPromptSubmit) ----------------------------------------
RES="$XDG_STATE_HOME/project-sessions/github-com-o-r.ensure"
ss_in() { # sid cwd [mode]
  if [ -n "${3:-}" ]; then
    printf '{"session_id":"%s","cwd":"%s","hook_event_name":"SessionStart","source":"startup","permission_mode":"%s"}' "$1" "$2" "$3"
  else
    printf '{"session_id":"%s","cwd":"%s","hook_event_name":"SessionStart","source":"startup"}' "$1" "$2"
  fi
}
ups_in() { # sid cwd mode
  printf '{"session_id":"%s","cwd":"%s","hook_event_name":"UserPromptSubmit","permission_mode":"%s","prompt":"hi"}' "$1" "$2" "$3"
}
ssrun() { ss_in "$@" | "$HOOK"; }
upsrun() { ups_in "$@" | "$UPS"; }
ctx() { printf '%s' "$OUT" | jq -r .hookSpecificOutput.additionalContext; }
settle() { # wait for a detached ensure to finish (up to 8 s)
  local i=0
  while [ ! -f "$RES.rc" ] && [ "$i" -lt 80 ]; do sleep 0.1; i=$((i + 1)); done
}
fresh() { : >"$STUB_LOG"; rm -f "$RES.rc" "$RES.out" "$RES.err"; }
bgs() { grep -- '--bg' "$STUB_LOG"; }
SS_AUTO="project-sessions: this repo's project session is"
HAND="Hand multi-step work to it with SendMessage to \`$N\`; keep only coordination here."

# SessionStart gating matrix: no session yet, caller in bypassPermissions.
for c in 'unset||manual' '0||manual' '1||auto' '1|0|manual' '0|1|auto' '|1|auto' '|0|manual'; do
  att=${c%%|*} rest=${c#*|} auto=${rest%%|*} want=${rest#*|}
  agents
  fresh
  if [ "$att" = unset ]; then
    # shellcheck disable=SC2016 # $1/$2 expand in the child sh
    run env ${auto:+PROJECT_SESSIONS_AUTO=$auto} sh -c 'printf "%s" "$1" | "$2"' _ "$(ss_in $ID1 "$R" bypassPermissions)" "$HOOK"
  else
    # shellcheck disable=SC2016 # $1/$2 expand in the child sh
    run env CLAUDE_CODE_SESSION_ATTENDED="$att" ${auto:+PROJECT_SESSIONS_AUTO=$auto} sh -c 'printf "%s" "$1" | "$2"' _ "$(ss_in $ID1 "$R" bypassPermissions)" "$HOOK"
  fi
  settle
  if [ "$want" = auto ]; then
    check "auto gate ATTENDED=$att AUTO=$auto: starts the session" "$(ctx)" "$SS_AUTO \`$N\` (created). $HAND"
    check "auto gate ATTENDED=$att AUTO=$auto: create argv in the mirrored mode" "$(bgs)" \
      "$R|TASK=<unset>|--bg --name $N --permission-mode bypassPermissions You are this repository's project session. Wait for tasks sent to you with SendMessage, do them here, and reply to the sender when each one is done."
  else
    check "auto gate ATTENDED=$att AUTO=$auto: names only" "$(ctx)" \
      "project-sessions: this repo has no project session yet (name \`$N\`). Before multi-step work here, load the \`project-sessions\` skill."
    check "auto gate ATTENDED=$att AUTO=$auto: starts nothing" "$(grep -c -- '--bg' "$STUB_LOG")" "0"
  fi
done
export PROJECT_SESSIONS_AUTO=1

agents
fresh
run ssrun $ID1 "$T" bypassPermissions
check "auto: silent outside git" "$RC:$OUT:$ERR" "0::"
agents "$(row "$R" idle 100 $ID2)"
fresh
run ssrun $ID2 "$R" bypassPermissions
check "auto: silent inside the project session itself" "$RC:$OUT:$ERR:$(grep -c -- '--bg' "$STUB_LOG")" "0:::0"
# Inside a background session the ONLY guard is `status --session` (1.4.0 dropped the task-list
# check, 1.4.1 the AUTO=0 prefix, which never reached the session). Model the worst case: AUTO=1
# and no task list. Each state the session's own row can
# hold, including the null-state row of a session that has just started.
for st in idle working blocked "done" null; do
  if [ "$st" = null ]; then
    printf '[{"cwd":"%s","kind":"background","startedAt":1,"sessionId":"%s","name":"%s","state":null,"status":"busy"}]' "$R" $ID2 "$N" >"$STUB_AGENTS"
  else
    agents "$(row "$R" "$st" 100 $ID2)"
  fi
  fresh
  # shellcheck disable=SC2016 # $1/$2 expand in the child sh
  run env -u CLAUDE_CODE_TASK_LIST_ID PROJECT_SESSIONS_AUTO=1 sh -c 'printf "%s" "$1" | "$2"' _ "$(ss_in $ID2 "$R" bypassPermissions)" "$HOOK"
  check "background session ($st): SessionStart silent through status --session alone" "$RC:$OUT:$ERR:$(grep -c -- '--bg' "$STUB_LOG")" "0:::0"
  fresh
  # shellcheck disable=SC2016 # $1/$2 expand in the child sh
  run env -u CLAUDE_CODE_TASK_LIST_ID PROJECT_SESSIONS_AUTO=1 sh -c 'printf "%s" "$1" | "$2"' _ "$(ups_in $ID2 "$R" bypassPermissions)" "$UPS"
  check "background session ($st): UserPromptSubmit silent through status --session alone" "$RC:$OUT:$ERR:$(grep -c -- '--bg' "$STUB_LOG")" "0:::0"
  check "background session ($st): the hooks asked status with the caller's id" "$(grep -c 'agents --json --all' "$STUB_LOG")" "1"
done
# The hooks no longer read the variable: a caller whose list happens to equal the name is a
# normal interactive session, and is told about the project session.
agents "$(row "$R" idle 100 $ID2)"
fresh
CLAUDE_CODE_TASK_LIST_ID=$N run ssrun $ID1 "$R" bypassPermissions
check "hooks ignore CLAUDE_CODE_TASK_LIST_ID: SessionStart still names the session" "$(ctx)" "$SS_AUTO \`$N\` (idle). $HAND"
fresh
CLAUDE_CODE_TASK_LIST_ID=$N run upsrun $ID1 "$R" bypassPermissions
contains "hooks ignore CLAUDE_CODE_TASK_LIST_ID: UserPromptSubmit still names the session" "$(ctx)" "Project session for this repo: \`$N\` (idle)."
fresh
run ssrun $ID1 "$R" bypassPermissions
check "auto: live session is named, nothing run" "$(ctx):$(grep -c -- '--bg' "$STUB_LOG")" "$SS_AUTO \`$N\` (idle). $HAND:0"

# Detached: a slow --bg must not hold the hook (through a pipe, as Claude Code reads it).
agents
fresh
start=$SECONDS
OUT=$(STUB_BG_SLEEP=4 PROJECT_SESSION_ENSURE_TICKS=2 ssrun $ID1 "$R" acceptEdits)
took=$((SECONDS - start))
check "auto: returns within its bound while --bg is still running" "$([ "$took" -le 2 ] && echo fast || echo "slow ${took}s")" "fast"
check "auto: ensure not finished when the hook returned" "$([ -f "$RES.rc" ] && echo finished || echo running)" "running"
check "auto: says starting" "$(ctx)" "$SS_AUTO \`$N\` (starting). $HAND"
settle
check "auto: the detached ensure created it in the mirrored mode" "$(bgs | cut -d' ' -f1-5)" "$R|TASK=<unset>|--bg --name $N --permission-mode acceptEdits"
check "auto: ensure finished cleanly" "$(cat "$RES.rc"):$(cat "$RES.out")" "0:created $N"

agents
fresh
# No AUTO prefix (1.4.1): it never reached the session (measured 2.1.330). Auto mode here comes
# from ATTENDED, so the client env holds no PROJECT_SESSIONS_AUTO unless the hook adds one.
# shellcheck disable=SC2016 # $1/$2 expand in the child sh
STUB_ENV_LOG="$T/envlog" run env -u PROJECT_SESSIONS_AUTO CLAUDE_CODE_SESSION_ATTENDED=1 sh -c 'printf "%s" "$1" | "$2"' _ "$(ss_in $ID1 "$R" bypassPermissions)" "$HOOK"
settle
check "auto: the hook passes no PROJECT_SESSIONS_AUTO to the create" "$(cat "$T/envlog")" "AUTO=<unset>"

agents
fresh
run ssrun $ID1 "$R"
check "auto: no mode in the input (2.1.330): create deferred to the first prompt" \
  "$(ctx):$(grep -c -- '--bg' "$STUB_LOG")" "$SS_AUTO \`$N\` (not started; your first prompt starts it). $HAND:0"
fresh
run ssrun $ID1 "$R" plan
check "auto: plan mode is not mirrored, nothing created" "$(grep -c -- '--bg' "$STUB_LOG")" "0"

agents "$(row "$R" "done" 100 $ID1)"
fresh
run ssrun $ID2 "$R"
settle
check "auto: a stopped session is resumed on start, bare, with no mode needed" "$(bgs)" "$R|TASK=<unset>|--bg --resume $ID1"
check "auto: resumed is reported" "$(ctx)" "$SS_AUTO \`$N\` (resumed). $HAND"

agents
fresh
STUB_UNTRUSTED=1 run ssrun $ID1 "$R" bypassPermissions
check "auto: untrusted folder says so in one line" "$(ctx)" \
  "project-sessions: this repo's project session \`$N\` could not start: Workspace not trusted. Run \`claude\` in $R once and accept the trust prompt, then retry."
check "auto: one line only" "$(ctx | grep -c .)" "1"

agents
fresh
mkdir -p "$LK"
run ssrun $ID1 "$R" bypassPermissions
check "auto: an ensure in flight is not stacked" "$(ctx):$(grep -c -- '--bg' "$STUB_LOG")" "$SS_AUTO \`$N\` (starting). $HAND:0"
rmdir "$LK"

for g in 'not json' '' '{"cwd":42}'; do
  run sh -c 'printf "%s" "$1" | "$2"' _ "$g" "$HOOK"
  check "auto: SessionStart fails open on garbage: '$g'" "$RC:$ERR" "0:"
done

# UserPromptSubmit
UPS_LIVE="Project session for this repo: \`$N\` (idle). For multi-step work, SendMessage it the task instead of doing it here."
agents "$(row "$R" idle 100 $ID2)"
for c in 'unset||off' '0||off' '1||on' '1|0|off' '0|1|on'; do
  att=${c%%|*} rest=${c#*|} auto=${rest%%|*} want=${rest#*|}
  if [ "$att" = unset ]; then
    # shellcheck disable=SC2016 # $1/$2 expand in the child sh
    run env -u PROJECT_SESSIONS_AUTO ${auto:+PROJECT_SESSIONS_AUTO=$auto} sh -c 'printf "%s" "$1" | "$2"' _ "$(ups_in $ID1 "$R" default)" "$UPS"
  else
    # shellcheck disable=SC2016 # $1/$2 expand in the child sh
    run env -u PROJECT_SESSIONS_AUTO CLAUDE_CODE_SESSION_ATTENDED="$att" ${auto:+PROJECT_SESSIONS_AUTO=$auto} sh -c 'printf "%s" "$1" | "$2"' _ "$(ups_in $ID1 "$R" default)" "$UPS"
  fi
  if [ "$want" = on ]; then
    check "prompt gate ATTENDED=$att AUTO=$auto: one line" "$RC:$(ctx)" "0:$UPS_LIVE"
    check "prompt gate: event name" "$(printf '%s' "$OUT" | jq -r .hookSpecificOutput.hookEventName)" "UserPromptSubmit"
  else
    check "prompt gate ATTENDED=$att AUTO=$auto: silent" "$RC:$OUT:$ERR" "0::"
  fi
done
fresh
run upsrun $ID1 "$R" bypassPermissions
check "prompt: live session, nothing run" "$(ctx):$(grep -c -- '--bg' "$STUB_LOG")" "$UPS_LIVE:0"
run upsrun $ID2 "$R" bypassPermissions
check "prompt: silent inside the project session itself" "$RC:$OUT:$ERR" "0::"
run upsrun $ID1 "$T" bypassPermissions
check "prompt: silent outside git" "$RC:$OUT:$ERR" "0::"

agents
fresh
STUB_BG_SLEEP=2 run upsrun $ID1 "$R" bypassPermissions
settle
check "prompt: no session: starting" "$(ctx)" "Project session for this repo: \`$N\` (starting). For multi-step work, SendMessage it the task instead of doing it here."
check "prompt: creates it in the caller's mode" "$(bgs | cut -d' ' -f1-5)" "$R|TASK=<unset>|--bg --name $N --permission-mode bypassPermissions"
fresh
run upsrun $ID1 "$R" plan
check "prompt: plan mode creates nothing and says why" "$(ctx):$(grep -c -- '--bg' "$STUB_LOG")" \
  "Project session for this repo: \`$N\` (not started: permission mode \`plan\` is not mirrored).:0"
UNTRUSTED_LINE="Project session for this repo: \`$N\` could not start: Workspace not trusted. Run \`claude\` in $R once and accept the trust prompt, then retry."
fresh
STUB_UNTRUSTED=1 run upsrun $ID1 "$R" bypassPermissions
check "prompt: an untrusted folder is reported on the same prompt" "$(ctx)" "$UNTRUSTED_LINE"
settle
run upsrun $ID1 "$R" plan
check "prompt: the last failure is still reported" "$(ctx)" "$UNTRUSTED_LINE"
agents "$(row "$R" "done" 100 $ID1)"
fresh
STUB_COPY=1 run upsrun $ID2 "$R" default
settle
contains "prompt: a resume that started a copy is reported" "$(ctx)" "could not start: resume of $N did not continue the same session"
: >"$STUB_LOG"
STUB_COPY=1 run upsrun $ID2 "$R" default
check "prompt: ...and never retried (exit 5)" "$(grep -c -- '--bg' "$STUB_LOG"):$(ctx | grep -c 'could not start')" "0:1"
fresh
agents "$(row "$R" idle 100 $ID2)"
STUB_SLEEP=3 PROJECT_SESSION_HOOK_TICKS=5 run upsrun $ID1 "$R" default
check "prompt: silent past its time bound" "$RC:$OUT:$ERR" "0::"
printf 'not json' >"$STUB_AGENTS"
run upsrun $ID1 "$R" default
check "prompt: silent when claude agents is broken" "$RC:$OUT:$ERR" "0::"
for g in 'not json' '' '{"cwd":42}' '[]'; do
  run sh -c 'printf "%s" "$1" | "$2"' _ "$g" "$UPS"
  check "prompt: fails open on garbage: '$g'" "$RC:$ERR" "0:"
done
unset PROJECT_SESSIONS_AUTO

# --- mode hook ---------------------------------------------------------------------
ptu() { # command mode -> OUT ERR RC
  run sh -c 'jq -cn --arg c "$1" --arg m "$2" "{session_id:\"s\",cwd:\"/\",permission_mode:\$m,hook_event_name:\"PreToolUse\",tool_name:\"Bash\",tool_input:{command:\$c,description:\"d\",timeout:9,run_in_background:false}}" | "$3"' _ "$1" "$2" "$PTU"
}
amended() { printf '%s' "$OUT" | jq -r .hookSpecificOutput.updatedInput.command; }
# shellcheck disable=SC2016 # literal ${CLAUDE_PLUGIN_ROOT}, as the skill writes it
P='"${CLAUDE_PLUGIN_ROOT}/bin/project-session"'
ptu "$P ensure" bypassPermissions
check "mode hook: adds the caller's mode" "$RC:$(amended)" "0:$P ensure --permission-mode bypassPermissions"
check "mode hook: no permissionDecision, so the normal flow decides" \
  "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput | has("permissionDecision")')" "false"
check "mode hook: other tool_input fields survive" \
  "$(printf '%s' "$OUT" | jq -c '.hookSpecificOutput.updatedInput | [.description, .timeout, .run_in_background]')" '["d",9,false]'
check "mode hook: event name" "$(printf '%s' "$OUT" | jq -r .hookSpecificOutput.hookEventName)" "PreToolUse"
ptu "cd /x && $P ensure /x --prompt 'a b' && echo ok" acceptEdits
check "mode hook: flag goes right after ensure, the rest kept" "$(amended)" "cd /x && $P ensure --permission-mode acceptEdits /x --prompt 'a b' && echo ok"
ptu "/p/bin/project-session ensure" default
check "mode hook: Manual arrives as default, passed verbatim" "$(amended)" "/p/bin/project-session ensure --permission-mode default"
for c in "$P ensure --permission-mode auto" "$P status" "git commit -m 'make project-session ensure faster'" \
  "grep -n 'project-session ensure' README.md" "echo hi" \
  "cat >f <<'X'
$P ensure
X" "git commit -m 'subject
$P ensure in the body'"; do
  ptu "$c" bypassPermissions
  check "mode hook: untouched: $c" "$RC:$OUT:$ERR" "0::"
done
ptu "$P ensure" plan
check "mode hook: plan mode is not mirrored" "$RC:$OUT:$ERR" "0::"
ptu "$P ensure" 'x; rm -rf /'
check "mode hook: an unknown mode is not spliced in" "$RC:$OUT:$ERR" "0::"
run sh -c 'printf "project-session ensure not json" | "$1"' _ "$PTU"
check "mode hook: garbage fails open" "$RC:$OUT:$ERR" "0::"
run sh -c 'printf "%s" "{\"tool_name\":\"Write\",\"permission_mode\":\"auto\",\"tool_input\":{\"command\":\"project-session ensure\"}}" | "$1"' _ "$PTU"
check "mode hook: only Bash calls" "$RC:$OUT:$ERR" "0::"

# --- wiring -------------------------------------------------------------------------
# shellcheck disable=SC2016 # the literal ${CLAUDE_PLUGIN_ROOT} is what hooks.json holds
check "hooks.json: SessionStart runs the hook script" \
  "$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$HERE/../hooks/hooks.json")" '"${CLAUDE_PLUGIN_ROOT}"/hooks/session-start'
# shellcheck disable=SC2016
check "hooks.json: PreToolUse on Bash runs the mode hook" \
  "$(jq -r '.hooks.PreToolUse[0] | .matcher + " " + .hooks[0].command' "$HERE/../hooks/hooks.json")" 'Bash "${CLAUDE_PLUGIN_ROOT}"/hooks/pre-tool-use'
# shellcheck disable=SC2016
check "hooks.json: UserPromptSubmit runs the prompt hook" \
  "$(jq -r '.hooks.UserPromptSubmit[0].hooks[0].command' "$HERE/../hooks/hooks.json")" '"${CLAUDE_PLUGIN_ROOT}"/hooks/user-prompt-submit'
check "scripts are executable" "$([ -x "$PS" ] && [ -x "$HOOK" ] && [ -x "$PTU" ] && [ -x "$UPS" ] && echo yes)" "yes"

FLOOR=195
total=$((pass + fail))
[ "$total" -ge "$FLOOR" ] || {
  printf 'FAIL case floor: %s cases ran, floor is %s\n' "$total" "$FLOOR"
  fail=$((fail + 1))
}
printf 'project-sessions: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
