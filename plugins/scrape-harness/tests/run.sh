#!/usr/bin/env bash
# scrape-harness hook cases: the agent-contract gates (valid / invalid / older harness) and the bounded,
# value-free SessionStart status. Stdlib python3 only, no network, a synthetic consumer (fixtures/).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
py=${PYTHON:-python3}
"$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else "need python >= 3.11 (tomllib)")'
chmod +x "$here/fixtures/stubcli"

# A floor, so a renamed test file or a lost class cannot turn this into a green no-op (17 at 1.3.0).
tests=$(grep -c '    def test_' "$here/test_guard.py")
echo "tests=$tests"
[ "$tests" -ge 17 ] || { echo "expected >= 17 cases, found $tests" >&2; exit 1; }

(cd "$here" && "$py" -m unittest -q test_guard)
echo "scrape-harness: all hook cases passed"
