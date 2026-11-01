#!/usr/bin/env bash
# plaid-pfc's gate: compile, minimum counts, unit tests. Plain system python3, stdlib only,
# no network (refresh is tested against a synthetic CSV).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
plugin=$(dirname "$here")
cd "$plugin"

py=${PYTHON:-python3}
"$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else "need python >= 3.11")'

echo "== compile"
"$py" -m compileall -q lib tests
"$py" -c 'import py_compile, sys; py_compile.compile(sys.argv[1], doraise=True)' scripts/pfc

echo "== minimum counts"
# Floors, so a broken pin or a renamed test file cannot turn this into a green no-op.
# Pin: PFC v2 as fetched 2026-11-01 (127 detailed, 18 primary). Tests: 12 at first release.
names=$("$py" -I -c 'import json; print(len(json.load(open("data/pfc-v2.json"))["detailed"]))')
tests=$(grep -c '    def test_' tests/test_pfc.py)
echo "names=$names tests=$tests"
[ "$names" -ge 127 ] || { echo "expected >= 127 pinned names, found $names" >&2; exit 1; }
[ "$tests" -ge 12 ] || { echo "expected >= 12 tests, found $tests" >&2; exit 1; }

echo "== unit"
(cd tests && "$py" -m unittest -q)

echo "== launcher"
scripts/pfc validate FOOD_AND_DRINK_COFFEE NEEDS_REVIEW
if scripts/pfc validate FOOD_AND_DRINK_PIZZA_PARTY 2>/dev/null; then
  echo "an invented name passed validation" >&2; exit 1
fi
echo "plaid-pfc: all checks passed"
