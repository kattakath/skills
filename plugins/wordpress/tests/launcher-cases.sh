#!/usr/bin/env bash
# wordpress launcher cases: the setting wins, the env var is the fallback, neither fails loud.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
launch="$(dirname "$here")/scripts/launch.sh"
pass=0
ok() { pass=$((pass + 1)); echo "ok   $1"; }
out=$(env -i PATH=/usr/bin:/bin WP_LAUNCHER="echo from-setting" WORDPRESS_MCP_COMMAND="echo from-env" sh "$launch")
[ "$out" = from-setting ] || { echo "FAIL setting must win: $out" >&2; exit 1; }
ok "setting beats env"
out=$(env -i PATH=/usr/bin:/bin WP_LAUNCHER= WORDPRESS_MCP_COMMAND="echo from-env" sh "$launch")
[ "$out" = from-env ] || { echo "FAIL env fallback: $out" >&2; exit 1; }
ok "empty setting (the unset shape) falls back to WORDPRESS_MCP_COMMAND"
if err=$(env -i PATH=/usr/bin:/bin WP_LAUNCHER= sh "$launch" 2>&1); then echo "FAIL must exit non-zero" >&2; exit 1; fi
case "$err" in *"no wordpress MCP launcher"*) ok "neither set: one actionable message" ;; *) echo "FAIL message: $err" >&2; exit 1 ;; esac
[ "$pass" -ge 3 ] || { echo "expected >= 3 cases, ran $pass" >&2; exit 1; }
echo "wordpress launcher: $pass cases passed"
