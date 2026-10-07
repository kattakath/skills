#!/usr/bin/env bash
# Cases for scripts/desktop-commander-guard.js.
#
# THE NEGATIVE FIXTURES ARE THE POINT. The rule this guard replaces — a nudge in
# the operator's repo pointing the other way — had ZERO test coverage, and it is
# the one rule that silently inverted when desktop-commander stopped being a
# gateway server and became the deliberate way around the Bash tool. A guard that
# cannot be shown to refuse anything, and to stay QUIET on ordinary work, is
# decoration.
#
# Four things are asserted, not three:
#   1. the command-text denies BLOCK (the ones a filesystem sandbox cannot express)
#   2. `--force-with-lease` is NOT blocked — the operator's policy allows it, and
#      a guard that caught it would push work onto an unguarded path
#   3. the fallback advisory appears on an ordinary exec, and NOT on read-only
#      tools or on other servers' tools
#   4. the guard FAILS OPEN — a malformed payload must never strand a session
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
GUARD="$here/../scripts/desktop-commander-guard.js"
[ -f "$GUARD" ] || { echo "FAIL: guard script not found at $GUARD"; exit 1; }

# The live tool-name shape: mcp__plugin_<plugin>_<server>__<tool>.
T=mcp__plugin_desktop-commander_desktop-commander
fail=0

# run <tool> <json-escaped-command> -> prints the guard's decision
run() {
  python3 -c '
import json,sys
print(json.dumps({"tool_name": sys.argv[1], "tool_input": {"command": sys.argv[2]}}))
' "$1" "$2" | node "$GUARD"
}

want_block() {
  got=$(run "$1" "$2")
  if printf '%s' "$got" | grep -q '"decision":"block"'; then
    echo "ok   BLOCK  $3"
  else
    echo "FAIL want block, got: $got   <- $3"; fail=1
  fi
}

want_allow() {
  got=$(run "$1" "$2")
  if printf '%s' "$got" | grep -q '"decision":"approve"'; then
    echo "ok   allow  $3"
  else
    echo "FAIL want approve, got: $got   <- $3"; fail=1
  fi
}

echo "== 1. command-text denies a file sandbox cannot express =="
want_block "${T}__start_process" 'secret reveal gh:token'                         "secret reveal"
want_block "${T}__start_process" 'security find-generic-password -a me -s x -w'   "keychain read with -w"
want_block "${T}__start_process" 'agenix -d secrets/foo.age'                      "agenix -d"
want_block "${T}__start_process" 'age --decrypt -i key file.age'                  "age --decrypt"
want_block "${T}__start_process" 'git push --force origin main'                   "git push --force"
want_block "${T}__start_process" 'gh pr merge 42 --squash'                        "gh pr merge"

echo "== 2. wrappers and compounds must not walk past the anchor =="
want_block "${T}__start_process" 'sudo secret reveal gh:token'                    "sudo-wrapped"
want_block "${T}__start_process" 'echo hi && secret reveal gh:token'              "hidden behind a compound"
want_block "${T}__start_process" 'timeout 5 gh pr merge 42'                       "timeout-wrapped"
want_block "${T}__interact_with_process" 'secret reveal gh:token'                 "via interact_with_process"

echo "== 3. the ALLOWED lease form, and ordinary work =="
want_allow "${T}__start_process" 'git push --force-with-lease origin feature'     "--force-with-lease (policy allows)"
want_allow "${T}__start_process" 'git status --porcelain'                         "git status"
want_allow "${T}__start_process" 'nix flake check'                                "nix flake check"
want_allow "${T}__start_process" 'gh pr view 42 --json state'                     "gh pr view (not merge)"

echo "== 4. scope: read-only tools and other servers stay untouched =="
got=$(run "${T}__read_file" '/etc/hosts')
printf '%s' "$got" | grep -q 'systemMessage' \
  && { echo "FAIL read_file should get NO advisory: $got"; fail=1; } \
  || echo "ok   quiet  read_file (read-only, no advisory)"
got=$(run "mcp__plugin_page-lab_kapture__click" 'whatever')
[ "$got" = '{"decision":"approve"}' ] \
  && echo "ok   quiet  another server's tool" \
  || { echo "FAIL foreign tool should be a bare approve: $got"; fail=1; }

echo "== 5. the fallback advisory IS present on an ordinary exec =="
got=$(run "${T}__start_process" 'ls -l')
printf '%s' "$got" | grep -q 'FALLBACK' \
  && echo "ok   advise start_process carries the prefer-Bash note" \
  || { echo "FAIL expected the fallback advisory: $got"; fail=1; }

echo "== 6. FAIL OPEN — a bug here must never strand a locked session =="
got=$(printf 'not json at all' | node "$GUARD")
printf '%s' "$got" | grep -q '"decision":"approve"' \
  && echo "ok   allow  unparseable payload fails open" \
  || { echo "FAIL unparseable payload must approve, got: $got"; fail=1; }
got=$(printf '{}' | node "$GUARD")
printf '%s' "$got" | grep -q '"decision":"approve"' \
  && echo "ok   allow  empty payload fails open" \
  || { echo "FAIL empty payload must approve, got: $got"; fail=1; }

echo
[ "$fail" -eq 0 ] && echo "all desktop-commander guard cases passed" || echo "SOME CASES FAILED"
exit "$fail"
