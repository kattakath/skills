#!/usr/bin/env bash
# Cases for scripts/staging-guard.js, in throwaway git repos with SYNTHETIC files only.
#
# A guard that cannot be shown to catch the leak AND stay quiet on ordinary work is
# decoration, and this one runs on every Bash call in every repo with the plugin enabled.
# Asserted:
#   1. every route by which a real statement could reach a commit ASKS (exit 0, stdout hook
#      JSON with permissionDecision "ask"; the exit code alone no longer tells the halves apart)
#   2. ordinary commits, fixtures, and non-commit commands are ALLOWED (exit 0, no output)
#   3. it FAILS OPEN on a malformed payload or a non-repo directory
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
GUARD="$here/../scripts/staging-guard.js"
[ -f "$GUARD" ] || { echo "FAIL: guard not found at $GUARD"; exit 1; }
command -v node >/dev/null || { echo "FAIL: node not on PATH"; exit 1; }
fail=0
tmp=$(mktemp -d "${TMPDIR:-/tmp}/se-guard.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

OFX='OFXHEADER:100
DATA:OFXSGML

<OFX><BANKMSGSRSV1></BANKMSGSRSV1></OFX>'

fresh() { # a new repo with one commit; prints its path
  local d="$tmp/r$RANDOM$RANDOM"
  mkdir -p "$d" && git -C "$d" init -q && git -C "$d" config user.email t@example.invalid \
    && git -C "$d" config user.name t && echo base >"$d/README" && git -C "$d" add README \
    && git -C "$d" commit -qm base && printf '%s' "$d"
}
payload() { # <cwd> <command>
  python3 -c 'import json,sys; print(json.dumps({"tool_name":"Bash","cwd":sys.argv[1],"tool_input":{"command":sys.argv[2]}}))' "$1" "$2"
}
reason_field() { # stdin: guard stdout; argv[1]: decision | lines
  # The JSON is decoded, never grepped: the raw JSON is always one line, so only the
  # decoded reason can show whether the reason itself is one line.
  python3 -c '
import json, sys
try:
    h = json.load(sys.stdin)["hookSpecificOutput"]
    r = h.get("permissionDecisionReason")
    if sys.argv[1] == "lines":
        print("one" if isinstance(r, str) and r and not any(c in r for c in "\r\n") else "multi")
    else:
        ok = h.get("hookEventName") == "PreToolUse" and h.get("permissionDecision") == "ask" and isinstance(r, str) and r
        print("ask" if ok else "other(json)")
except Exception:
    print("other(not-json)")' "$1"
}
want() { # <ask|allow> <label> <cwd> <command>
  local out err rc got f="$tmp/stderr"
  out=$(payload "$3" "$4" | node "$GUARD" 2>"$f"); rc=$?
  err=$(cat "$f")
  if [ "$rc" != 0 ]; then got="exit-$rc"
  elif [ -z "$out" ]; then got=allow
  else got=$(printf '%s' "$out" | reason_field decision)
  fi
  # allow must also be SILENT on stderr: a note there means it fell into a fail-open path
  if [ "$got" = "$1" ] && { [ "$1" = ask ] || [ -z "$err" ]; }; then
    printf 'ok   %-5s  %s\n' "$got" "$2"
  else
    printf 'FAIL want %s (silent on allow), got %s: %s   <- %s\n' "$1" "$got" "$err" "$2"; fail=1
  fi
}

echo "-- 1. asks"
r=$(fresh); printf '%s' "$OFX" >"$r/export.qfx"; git -C "$r" add export.qfx
want ask "staged .qfx at the repo root" "$r" 'git commit -m add'
r=$(fresh); printf '%s' "$OFX" >"$r/notes.txt"; git -C "$r" add notes.txt
want ask "staged OFX content under a .txt name" "$r" 'git commit -m add'
r=$(fresh); mkdir -p "$r/sub"; printf '%s' "$OFX" >"$r/sub/a.ofx"; git -C "$r" add sub/a.ofx
want ask "git -C <dir> commit form" "$tmp" "git -C $r commit -m add"
r=$(fresh); printf '%s' "$OFX" >"$r/later.qbo"
want ask "git add <file> && git commit (add has not run yet)" "$r" 'git add later.qbo && git commit -m add'
r=$(fresh); printf '%s' "$OFX" >"$r/x.qfx"
want ask "git add -A; git commit" "$r" 'git add -A; git commit -m add'
r=$(fresh); printf 'x\n' >"$r/t.qfx"; git -C "$r" add t.qfx; git -C "$r" commit -qm t --no-verify; printf '%s' "$OFX" >"$r/t.qfx"
want ask "git commit -am on a modified tracked .qfx" "$r" 'git commit -am update'
r=$(fresh); mkdir -p "$r/plugins/statement-extract/adapters/x"; printf '%%PDF-1.4\n' >"$r/plugins/statement-extract/adapters/x/s.pdf"; git -C "$r" add -A
want ask "a PDF inside the plugin" "$r" 'git commit -m add'
r=$(fresh); mkdir -p "$r/plugins/statement-extract/fixtures"; printf '%%PDF-1.4\n' >"$r/plugins/statement-extract/fixtures/s.pdf"; git -C "$r" add -A
want ask "a PDF inside the plugin, even under fixtures/" "$r" 'git commit -m add'
r=$(fresh); mkdir -p "$r/plugins/statement-extract/scripts"; printf 'a,b\n' >"$r/plugins/statement-extract/scripts/rows.csv"; git -C "$r" add -A
want ask "a CSV inside the plugin outside fixtures/" "$r" 'git commit -m add'
r=$(fresh); mkdir -p "$r/plugins/statement-extract"; printf 'x' >"$r/plugins/statement-extract/a.xlsx"; git -C "$r" add -A
want ask "an XLSX inside the plugin" "$r" 'git commit -m add'

echo "-- 2. allowed"
r=$(fresh); mkdir -p "$r/plugins/statement-extract/adapters/td/fixtures"
printf '%s' "$OFX" >"$r/plugins/statement-extract/adapters/td/fixtures/case.qfx"
printf 'a,b\n' >"$r/plugins/statement-extract/adapters/td/fixtures/case.csv"; git -C "$r" add -A
want allow "synthetic fixtures under fixtures/" "$r" 'git commit -m fixtures'
r=$(fresh); echo 'print(1)' >"$r/main.py"; git -C "$r" add main.py
want allow "an ordinary commit" "$r" 'git commit -m code'
r=$(fresh); printf 'a,b\n' >"$r/report.csv"; printf '%%PDF-1.4\n' >"$r/paper.pdf"; git -C "$r" add -A
want allow "a CSV and a PDF in another project" "$r" 'git commit -m data'
r=$(fresh); printf '%s' "$OFX" >"$r/x.qfx"
want allow "an untracked .qfx that this commit does not add" "$r" 'git add README && git commit -m readme'
want allow "not a commit: git status" "$r" 'git status'
want allow "not a commit: echo mentions it" "$r" 'echo "remember to git commit later"'
want allow "a committish word elsewhere" "$r" 'ls commits/'

echo "-- 2b. the reason is ONE line, even when several files trip it"
r=$(fresh); mkdir -p "$r/plugins/statement-extract/scripts"; printf '%s' "$OFX" >"$r/export.qfx"
printf 'a,b\n' >"$r/plugins/statement-extract/scripts/rows.csv"; git -C "$r" add -A
got=$(payload "$r" 'git commit -m add' | node "$GUARD" 2>/dev/null | reason_field lines)
[ "$got" = one ] && echo "ok   one    two problems joined into one reason line" \
  || { echo "FAIL two-problem reason is not one line (got $got)"; fail=1; }

echo "-- 3. fails open"
out=$(printf 'not json' | node "$GUARD" 2>"$tmp/stderr"); rc=$?; err=$(cat "$tmp/stderr")
[ "$rc" = 0 ] && [ -z "$out" ] && printf 'ok   allow  malformed payload (note: %s)\n' "${err%%$'\n'*}" \
  || { echo "FAIL malformed payload exit $rc stdout '$out'"; fail=1; }
mkdir -p "$tmp/notarepo"
want allow "a directory that is not a repo" "$tmp/notarepo" 'git commit -m x'

[ "$fail" = 0 ] && echo "staging-guard: all cases passed" || echo "staging-guard: FAILURES above"
exit $fail
