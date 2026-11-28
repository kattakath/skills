#!/usr/bin/env bash
# lock-parity.py exit codes: 0 match, 3 lag, anything else a broken check. A crash must
# never exit 0 or 3, or the watcher would close the issue or report a lag that isn't one.
set -u
here=$(cd "$(dirname "$0")" && pwd)
py="$here/lock-parity.py"
t=$(mktemp -d)
pass=0 fail=0

lock() { # lock <file> <rev>: a minimal flake.lock with a nixpkgs root input
  printf '{"nodes":{"nixpkgs":{"locked":{"rev":"%s"},"original":{"url":"u"}},"root":{"inputs":{"nixpkgs":"nixpkgs"}}},"root":"root","version":7}\n' "$2" > "$1"
}
expect() { # expect <name> <code> <args...>
  local name=$1 want=$2; shift 2
  python3 -I "$py" "$@" >/dev/null 2>&1; local got=$?
  if [ "$got" = "$want" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL $name: exit $got, want $want"; fi
}

lock "$t/a" aaaa; lock "$t/b" bbbb
echo '{"nodes":{},"root":"root"}' > "$t/shape"
expect "match" 0 "$t/a" "$t/a"
expect "lag" 3 "$t/b" "$t/a"
expect "missing nix-config lock" 1 "$t/none" "$t/a"
expect "changed lock shape" 1 "$t/shape" "$t/a"
expect "no arguments" 2
expect "real lock parses" 0 "$here/../flake.lock"

# pin-watch.sh against a stub gh: it logs every call, serves FAKE_LIST for `issue list` and
# FAKE_LAST for `issue view`. `api user/<id>` applies the caller's REAL --jq filter to
# FAKE_USER (a /users JSON), or fails when FAKE_USER is unset, so the User-only guard is
# tested too. Writes are create/comment/close; the log says which happened.
mkdir -p "$t/bin"
cat > "$t/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$LOG"
case "$1 $2" in
  "issue list") printf '%s\n' "${FAKE_LIST:-[]}" ;;
  "issue view") printf '%s\n' "${FAKE_LAST:-}" ;;
  "api user/"*)
    [ -n "${FAKE_USER:-}" ] || { echo "HTTP 404" >&2; exit 1; }
    filter=.; while [ $# -gt 0 ]; do [ "$1" = --jq ] && filter=$2; shift; done
    printf '%s\n' "$FAKE_USER" | jq -r "$filter" ;;
esac
EOF
chmod +x "$t/bin/gh"
T='markup-lsp: nixpkgs pin lags nix-config'
PERSON='{"login":"someone","type":"User"}'
watch() { # watch <name> <want-exit> <want-writes> <nix-config lock> ; env: FAKE_LIST FAKE_LAST FAKE_USER
  local name=$1 want=$2 writes=$3 lockf=$4
  : > "$t/log"
  LOG="$t/log" PATH="$t/bin:$PATH" ASSIGNEE_ID=42 bash "$here/pin-watch.sh" "$lockf" "$t/a" >/dev/null 2>&1
  local got=$? w
  w=$(grep -oE '^issue (create|comment|close)' "$t/log" | cut -d' ' -f2 | tr '\n' ' ' | sed 's/ $//')
  if [ "$got" = "$want" ] && [ "$w" = "$writes" ]; then pass=$((pass + 1))
  else fail=$((fail + 1)); echo "FAIL $name: exit $got writes [$w], want $want [$writes]"; fi
}
lagmsg=$(python3 -I "$py" "$t/b" "$t/a")
FAKE_USER="$PERSON" FAKE_LIST='[]' watch "lag, no issue, id resolves: create one" 0 "create" "$t/b"
grep -q -- '--assignee someone' "$t/log" || { fail=$((fail + 1)); echo "FAIL create is not assigned to the resolved login"; }
FAKE_USER='' FAKE_LIST='[]' watch "lag, id lookup fails: create unassigned" 0 "create" "$t/b"
grep -q -- '--assignee' "$t/log" && { fail=$((fail + 1)); echo "FAIL a failed lookup still assigned"; }
FAKE_USER='{"login":"x-ci[bot]","type":"Bot"}' FAKE_LIST='[]' watch "lag, id names a bot: create unassigned" 0 "create" "$t/b"
grep -q -- '--assignee' "$t/log" && { fail=$((fail + 1)); echo "FAIL a bot was assigned"; }
FAKE_LIST="[{\"number\":7,\"title\":\"$T\"}]" FAKE_LAST="$lagmsg" watch "lag, same message: no write" 0 "" "$t/b"
FAKE_LIST="[{\"number\":7,\"title\":\"$T\"}]" FAKE_LAST="older revs" watch "lag, new revs: one comment" 0 "comment" "$t/b"
FAKE_LIST="[{\"number\":7,\"title\":\"$T x\"}]" watch "lag, only a look-alike title: create" 0 "create" "$t/b"
FAKE_LIST="[{\"number\":7,\"title\":\"$T\"}]" watch "match, issue open: close it" 0 "close" "$t/a"
FAKE_LIST='[]' watch "match, no issue: nothing" 0 "" "$t/a"
FAKE_LIST='[]' watch "check broken: fail, no gh call" 1 "" "$t/shape"
[ -s "$t/log" ] && { fail=$((fail + 1)); echo "FAIL broken check still called gh"; }

echo "lock-parity: $pass passed, $fail failed"
[ "$fail" = 0 ]
