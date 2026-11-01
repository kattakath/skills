#!/usr/bin/env bash
# beancount's whole gate: compile, then unit + golden tests under an interpreter that has
# beancount. Locally that is $BEANCOUNT_PYTHON (nix-config's local.beancount); CI makes a venv
# with the pinned versions and points PYTHON at it. No network, no data, no credentials.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
plugin=$(dirname "$here")
cd "$plugin"

py=${PYTHON:-${BEANCOUNT_PYTHON:-python3}}
"$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else "need python >= 3.11")'
"$py" -c 'import beancount' 2>/dev/null || {
  echo "beancount is not importable from $py; set PYTHON or BEANCOUNT_PYTHON" >&2
  exit 1
}

echo "== compile"
"$py" -m compileall -q lib tests
"$py" -c 'import py_compile, sys; py_compile.compile(sys.argv[1], doraise=True)' scripts/beancount-kit

echo "== minimum counts"
# A floor, so a renamed directory cannot turn this suite into a green no-op.
tests=$(grep -c '^    def test_' tests/test_build.py)
echo "tests=$tests"
[ "$tests" -ge 23 ] || { echo "expected >= 23 tests, found $tests" >&2; exit 1; }

echo "== unit + golden"
# -I drops cwd and the script dir from sys.path; the test file inserts lib/ and tests/ itself.
"$py" -I tests/test_build.py

echo "beancount: all checks passed"
