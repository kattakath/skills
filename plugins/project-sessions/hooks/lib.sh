# shellcheck shell=bash
# Shared by hooks/session-start and hooks/user-prompt-submit. Sourced, never run.
#
# Why the hooks act instead of telling the model to: a measured eval (10 fresh `claude -p`
# runs, 2.1.330) saw the SessionStart line reach the agent 10/10, the skill loaded 2/10 and
# `ensure` run 0/10.

PS_BIN=$HERE/../bin/project-session
PS_BASE=${XDG_STATE_HOME:-$HOME/.local/state}/project-sessions

# Auto mode: PROJECT_SESSIONS_AUTO=0 off, =1 on (evals under -p), else only when attended.
# Measured 2.1.330: CLAUDE_CODE_SESSION_ATTENDED is 1 interactive, 0 under -p.
auto_on() {
  case ${PROJECT_SESSIONS_AUTO:-} in
    0) return 1 ;;
    1) return 0 ;;
  esac
  [ "${CLAUDE_CODE_SESSION_ATTENDED:-}" = 1 ]
}

# The modes passed on verbatim; the same list as hooks/pre-tool-use. `plan` is not mirrored.
mirror_mode() {
  case $1 in
    default | acceptEdits | auto | dontAsk | bypassPermissions) printf '%s' "$1" ;;
  esac
}

# Bound a `status` call without timeout(1), which stock macOS lacks. Sets LINE; returns 1 on
# error, timeout or empty output.
bounded_status() { # cwd sid
  local out pid i=0
  out=$(mktemp 2>/dev/null) || return 1
  "$PS_BIN" status "$1" ${2:+--session "$2"} >"$out" 2>/dev/null &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$i" -ge "${PROJECT_SESSION_HOOK_TICKS:-20}" ]; then
      kill "$pid"
      wait "$pid"
      rm -f "$out"
      return 1
    fi
    sleep 0.1
    i=$((i + 1))
  done
  wait "$pid" || { rm -f "$out"; return 1; }
  LINE=$(head -1 "$out")
  rm -f "$out"
  [ -n "$LINE" ]
}

# Per-repo result of the last detached ensure: $RES.out, $RES.err, then $RES.rc written last.
result_path() { printf '%s/%s.ensure' "$PS_BASE" "$(printf '%s' "$1" | tr -c 'A-Za-z0-9_-' '-')"; }

# Why the last ensure failed, else nothing: its own last `project-session:` line, or, when that
# only says "claude exited N", claude's first line (the "Workspace not trusted" message).
last_failure() { # res
  local rc why
  rc=$(cat "$1.rc" 2>/dev/null) || return 0
  [ "$rc" = 0 ] && return 0
  why=$(grep '^project-session: ' "$1.err" 2>/dev/null | tail -1 | sed 's/^project-session: //')
  case $why in '' | "claude exited "*) why=$(head -1 "$1.err" 2>/dev/null) ;; esac
  printf '%s' "${why:-ensure exited $rc}" | cut -c1-200
}

# Live states, as in bin/project-session's klass: nothing to ensure.
is_live() { case $1 in working | blocked | idle | running) return 0 ;; esac; return 1; }

# Start `ensure` detached unless it would be pointless or unsafe:
#   - the session is live (nothing to do)
#   - none exists and the caller's mode is not mirrorable (a create without the mode runs in
#     default mode forever, and SendMessage from another mode is held; measured 2.1.330)
#   - an ensure already holds this repo's lock (no stacking)
#   - the last ensure exited 5: a resume started a copy, and retrying makes more
# All three fds are redirected, so the hook's pipe closes and Claude Code does not wait.
# No env is passed to the session it creates: `--bg` hands it to the daemon, so a client env
# prefix does not arrive while the daemon is running (PROJECT_SESSIONS_AUTO=0 read back unset,
# measured 2.1.330, 1.4.1). Its
# own hooks stay out through `status --session` alone.
# Returns 0 when it spawned, 2 when one is already running, 1 when it skipped.
spawn_ensure() { # cwd name state mode
  local res
  res=$(result_path "$2")
  is_live "$3" && return 1
  [ "$3" = none ] && [ -z "$4" ] && return 1
  [ "$(cat "$res.rc" 2>/dev/null)" = 5 ] && return 1
  mkdir -p "$PS_BASE" 2>/dev/null || return 1
  [ -d "$PS_BASE/$(printf '%s' "$2" | tr -c 'A-Za-z0-9_-' '-').lock" ] && return 2
  rm -f "$res.rc"
  (
    (
      "$PS_BIN" ensure "$1" ${4:+--permission-mode "$4"} >"$res.out" 2>"$res.err"
      echo $? >"$res.rc"
    ) </dev/null >/dev/null 2>&1 &
  )
  return 0
}

# Spawn (as above), then wait up to 1 s for a fast answer: a refusal (untrusted folder) or a
# live/resumed result. Never waits for a create to finish. Sets SHOWN (the state to show:
# the status state, "starting", or ensure's verb) and WHY (a failure to report, or empty).
# shellcheck disable=SC2034 # SHOWN and WHY are read by the sourcing hook
start_ensure() { # cwd name state mode
  local res sp i=0 got
  res=$(result_path "$2")
  SHOWN=$3 WHY=
  spawn_ensure "$@"
  sp=$?
  case $sp in
    2) SHOWN=starting ;;
    0)
      SHOWN=starting
      while [ ! -f "$res.rc" ] && [ "$i" -lt "${PROJECT_SESSION_ENSURE_TICKS:-10}" ]; do
        sleep 0.1
        i=$((i + 1))
      done
      if [ -f "$res.rc" ]; then
        WHY=$(last_failure "$res")
        got=$(head -1 "$res.out" 2>/dev/null)
        [ -z "$WHY" ] && [ -n "$got" ] && SHOWN=${got%% *}
      fi
      ;;
    *) is_live "$3" || WHY=$(last_failure "$res") ;; # skipped: a standing failure still shows
  esac
  return 0
}

emit() { # event message
  jq -cn --arg e "$1" --arg m "$2" '{hookSpecificOutput: {hookEventName: $e, additionalContext: $m}}'
}
