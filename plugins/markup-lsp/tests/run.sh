#!/usr/bin/env bash
# markup-lsp test suite.
#
#   bash plugins/markup-lsp/tests/run.sh          static checks, nix flake check, build, LSP smoke
#   bash plugins/markup-lsp/tests/run.sh --cache  also: a dry-run must build nothing but the
#                                                 buildEnv on THIS system (the cache gate)
#
# Run from the repo root. Needs nix (flakes) and python3.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
root=$(cd "$here/../.." && pwd)
cache=0
[ "${1:-}" = "--cache" ] && cache=1

echo "== static"
python3 -I "$here/tests/static_check.py" "$root"

if [ "$cache" = 1 ]; then
  echo "== cache gate ($(nix eval --impure --raw --expr builtins.currentSystem))"
  plan=$(nix build --dry-run "$here" 2>&1)
  # Lines under "will be built" are .drv paths; the only one allowed is the buildEnv itself.
  built=$(printf '%s\n' "$plan" | awk '/will be built/{on=1;next} /will be fetched/{on=0} on && /\.drv$/' | grep -v -- '-markup-lsp-servers\.drv$' || true)
  if [ -n "$built" ]; then
    echo "FAIL a first install would compile locally:" >&2
    printf '%s\n' "$built" >&2
    exit 1
  fi
  echo "ok   nothing to compile; every server substitutes from cache"
fi

echo "== nix flake check"
nix flake check "$here"

echo "== build"
out=$(nix build "$here" --no-link --print-out-paths)
echo "$out"

echo "== LSP smoke"
python3 -I "$here/tests/lsp_smoke.py" "$here" "$out/bin"
