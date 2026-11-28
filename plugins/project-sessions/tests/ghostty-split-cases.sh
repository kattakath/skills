#!/usr/bin/env bash
# bin/ghostty-split against a stub osascript that records the script (stdin) and its argv. Ported
# from kattakath/nix-config packages/ghostty-split-test.sh (16 cases), with the exit codes moved
# to the CLI contract (2 usage, was 64; 3 Ghostty unavailable, was 69) and two cases added
# (--help on stdout exit 0, an unknown option). The live split is measured by hand on a Mac.
# Prints "ghostty-split: <pass> passed, <fail> failed"; exit 0 only when all pass.
set -uo pipefail
GS="$(cd "$(dirname "$0")/../bin" && pwd)/ghostty-split"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
cat >"$T/bin/osascript" <<'EOS'
#!/usr/bin/env bash
[ "$1" = - ] || { echo "stub: expected the script on stdin (-), got $1" >&2; exit 9; }
shift
cat >"$T/script"
printf '%s\0' "$@" >"$T/argv"
case "${MODE:-ok}" in
  ok) echo "TERM-ID-1" ;;
  norun) echo "execution error: Ghostty is not running (1001)" >&2; exit 1 ;;
  nowin) echo "execution error: Ghostty has no window (1002)" >&2; exit 1 ;;
  wait) cmd=$(tr '\0' '\n' <"$T/argv" | head -1); (cd /tmp && bash -c "$cmd") >/dev/null 2>&1 & echo "TERM-ID-2" ;;
esac
EOS
chmod +x "$T/bin/osascript"
export PATH="$T/bin:$PATH" T
pass=0 fail=0
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "FAIL ghostty-split: $1"; }
arg() { tr '\0' '\n' <"$T/argv" | sed -n "${1}p"; }

tricky='printf "%s\n" "it'"'"'s \"q\" \\ $HOME" | tee /dev/null && echo `date`'
MODE=ok "$GS" --cwd /tmp -- "$tricky" 2>/dev/null; rc=$?
[ "$rc" = 0 ] && ok || bad "shell line rc $rc"
[ "$(arg 1)" = "$tricky" ] && ok || bad "one argument not verbatim: '$(arg 1)'"
[ "$(arg 2)" = /tmp ] && ok || bad "--cwd not argv 2: '$(arg 2)'"
[ "$(arg 3)" = run ] && ok || bad "default not run: '$(arg 3)'"
MODE=ok "$GS" --type-only -- 'secret reveal x' 2>/dev/null
[ "$(arg 3)" = type ] && ok || bad "--type-only argv 3 was '$(arg 3)'"
grep -q 'if pressEnter then' "$T/script" && ok || bad "pressEnter branch missing"
"$GS" --wait --type-only -- true 2>/dev/null; rc=$?
[ "$rc" = 2 ] && ok || bad "--wait with --type-only rc $rc, want 2"
MODE=ok "$GS" --cwd /tmp -- "$tricky" 2>/dev/null
grep -qF "$tricky" "$T/script" && bad "the command leaked into the script TEXT" || ok
grep -q 'split t direction down with configuration cfg' "$T/script" && ok || bad "script shape changed"

MODE=ok "$GS" -- echo 'a b' "c'd" '$x' 2>/dev/null
[ "$(bash -c "set -- $(arg 1); printf '%s|' \"\$@\"")" = "echo|a b|c'd|\$x|" ] && ok || bad "argv quoting: '$(arg 1)'"

MODE=norun "$GS" -- true 2>"$T/err"; rc=$?
[ "$rc" = 3 ] && grep -q 'not running' "$T/err" && ok || bad "not running rc $rc, want 3: $(cat "$T/err")"
MODE=nowin "$GS" -- true 2>"$T/err"; rc=$?
[ "$rc" = 3 ] && grep -q 'no window' "$T/err" && ok || bad "no window rc $rc, want 3: $(cat "$T/err")"

MODE="wait" "$GS" --wait -- 'exit 7' 2>/dev/null; rc=$?
[ "$rc" = 7 ] && ok || bad "--wait rc $rc, want 7"
MODE="wait" "$GS" --wait -- 'true' 2>/dev/null; rc=$?
[ "$rc" = 0 ] && ok || bad "--wait true rc $rc"

"$GS" 2>/dev/null; rc=$?
[ "$rc" = 2 ] && ok || bad "no command rc $rc, want 2"
"$GS" --cwd /nonexistent -- true 2>/dev/null; rc=$?
[ "$rc" = 2 ] && ok || bad "missing --cwd rc $rc, want 2"

# Added: --help is the contract's (stdout, exit 0, no osascript call); an unknown flag is usage.
rm -f "$T/argv"
out=$("$GS" --help 2>"$T/err"); rc=$?
[ "$rc" = 0 ] && case $out in "usage: ghostty-split"*) true ;; *) false ;; esac && [ ! -s "$T/err" ] && [ ! -e "$T/argv" ] &&
  ok || bad "--help: rc $rc, stdout '${out%%$'\n'*}', stderr '$(cat "$T/err")'"
out=$("$GS" --bogus -- true 2>"$T/err"); rc=$?
[ "$rc" = 2 ] && [ -z "$out" ] && grep -q '^usage: ghostty-split' "$T/err" && ok || bad "unknown option rc $rc, want 2 with usage on stderr"

echo "ghostty-split: $pass passed, $fail failed"
[ "$fail" = 0 ]
