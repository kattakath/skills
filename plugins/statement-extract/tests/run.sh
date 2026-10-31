#!/usr/bin/env bash
# statement-extract's whole gate: compile, unit + golden tests, minimum counts, fixture lint.
# Runs on plain system python3 (CI: ubuntu-24.04, 3.12). No network, no uv, no credentials.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
plugin=$(dirname "$here")
cd "$plugin"

# A developer machine usually exports an OTLP endpoint; the suite must never push to it.
unset OTEL_EXPORTER_OTLP_ENDPOINT OTEL_EXPORTER_OTLP_LOGS_ENDPOINT STATEMENT_EXTRACT_LOG

py=${PYTHON:-python3}
"$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else "need python >= 3.11")'

echo "== compile"
"$py" -m compileall -q lib tests
# compileall skips the extensionless launcher; compile it by path.
"$py" -c 'import py_compile, sys; py_compile.compile(sys.argv[1], doraise=True)' scripts/statement-extract

echo "== minimum counts"
# Floors, so a renamed directory cannot turn this suite into a green no-op. These are R1's
# real counts; RAISE THEM with each release (plan end state: adapters >= 7, cases >= 51).
adapters=$(find adapters -mindepth 2 -maxdepth 2 -name '*.toml' | wc -l | tr -d ' ')
cases=$(find adapters -path '*/fixtures/*.case.toml' | wc -l | tr -d ' ')
repairs=$("$py" -I -c 'import sys; sys.path.insert(0, "lib")
from statement_extract.repairs.ofx import REPAIRS; print(len(REPAIRS))')
echo "adapters=$adapters cases=$cases repairs=$repairs"
[ "$adapters" -ge 4 ] || { echo "expected >= 4 adapters, found $adapters" >&2; exit 1; }
[ "$cases" -ge 33 ] || { echo "expected >= 33 fixture cases, found $cases" >&2; exit 1; }
[ "$repairs" -ge 4 ] || { echo "expected >= 4 repairs, found $repairs" >&2; exit 1; }

echo "== unit + golden"
(cd tests && "$py" -m unittest)

echo "== fixture lint"
"$py" scripts/statement-extract fixture lint

echo "statement-extract: all checks passed"
