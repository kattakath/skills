#!/usr/bin/env bash
# rag launcher cases: the setting wins, the env var is the fallback, neither fails loud.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
launch="$(dirname "$here")/scripts/launch.sh"
pass=0
ok() { pass=$((pass + 1)); echo "ok   $1"; }
out=$(env -i PATH=/usr/bin:/bin RAG_LAUNCHER="echo from-setting" RAG_POSTGRES_COMMAND="echo from-env" sh "$launch")
[ "$out" = from-setting ] || { echo "FAIL setting must win: $out" >&2; exit 1; }
ok "setting beats env"
out=$(env -i PATH=/usr/bin:/bin RAG_LAUNCHER= RAG_POSTGRES_COMMAND="echo from-env" sh "$launch")
[ "$out" = from-env ] || { echo "FAIL env fallback: $out" >&2; exit 1; }
ok "empty setting (the unset shape) falls back to RAG_POSTGRES_COMMAND"
if err=$(env -i PATH=/usr/bin:/bin RAG_LAUNCHER= sh "$launch" 2>&1); then echo "FAIL must exit non-zero" >&2; exit 1; fi
case "$err" in *"no postgres MCP launcher"*) ok "neither set: one actionable message" ;; *) echo "FAIL message: $err" >&2; exit 1 ;; esac
[ "$pass" -ge 3 ] || { echo "expected >= 3 cases, ran $pass" >&2; exit 1; }
echo "rag launcher: $pass cases passed"
