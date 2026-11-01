#!/usr/bin/env bash
# statement-extract's whole gate: compile, unit + golden tests, minimum counts, fixture lint.
# Runs on plain system python3 (CI: ubuntu-24.04, 3.12). No network, no uv, no credentials.
#   --pdf-smoke  instead: generate PDFs in-run and read them back through poppler.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
plugin=$(dirname "$here")
cd "$plugin"

# A developer machine usually exports an OTLP endpoint; the suite must never push to it.
unset OTEL_EXPORTER_OTLP_ENDPOINT OTEL_EXPORTER_OTLP_LOGS_ENDPOINT STATEMENT_EXTRACT_LOG

py=${PYTHON:-python3}
"$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else "need python >= 3.11")'

if [ "${1:-}" = "--pdf-smoke" ]; then
  echo "== pdf reader smoke ($(pdftotext -v 2>&1 | head -1))"
  (cd tests && "$py" pdf_smoke.py)
  echo "statement-extract: pdf smoke passed"
  exit 0
fi

echo "== compile"
"$py" -m compileall -q lib tests
# compileall skips the extensionless launcher; compile it by path.
"$py" -c 'import py_compile, sys; py_compile.compile(sys.argv[1], doraise=True)' scripts/statement-extract
# Adapter hooks live beside their TOML, outside lib/.
"$py" -m compileall -q adapters

echo "== minimum counts"
# Floors, so a renamed directory cannot turn this suite into a green no-op. These are R1's
# real counts; RAISE THEM with each release (plan end state: adapters >= 7, cases >= 51).
# R1: 4 adapters / 33 cases. R3: + Desjardins and closed Scotiabank chequing PDFs.
# R3b: + PDF adapters for TD, CIBC, Scotiabank card/LOC, Tangerine and BMO (16 / 92).
# R2: + Wise CSV (11 cases) and Wise PDF (3 cases): 18 / 106 with R3b.
# Older prints: + TD chequing 2018 and Scotiabank chequing 2020 adapters, 6 cases: 20 / 112.
# Positions: + CIBC/BMO mortgage details, TD annual mortgage, NSLSC loan (9 cases): 24 / 121 with older prints.
adapters=$(find adapters -mindepth 2 -maxdepth 2 -name '*.toml' | wc -l | tr -d ' ')
cases=$(find adapters -path '*/fixtures/*.case.toml' | wc -l | tr -d ' ')
repairs=$("$py" -I -c 'import sys; sys.path.insert(0, "lib")
from statement_extract.repairs.ofx import REPAIRS; print(len(REPAIRS))')
echo "adapters=$adapters cases=$cases repairs=$repairs"
[ "$adapters" -ge 24 ] || { echo "expected >= 24 adapters, found $adapters" >&2; exit 1; }
[ "$cases" -ge 121 ] || { echo "expected >= 121 fixture cases, found $cases" >&2; exit 1; }
[ "$repairs" -ge 4 ] || { echo "expected >= 4 repairs, found $repairs" >&2; exit 1; }

echo "== unit + golden"
(cd tests && "$py" -m unittest)

echo "== fixture lint"
"$py" scripts/statement-extract fixture lint

echo "== commit guard cases"
bash tests/guard-cases.sh

echo "statement-extract: all checks passed"
