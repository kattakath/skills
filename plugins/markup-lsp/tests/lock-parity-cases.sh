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

echo "lock-parity: $pass passed, $fail failed"
[ "$fail" = 0 ]
