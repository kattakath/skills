#!/bin/sh
# chrome-devtools-mcp launcher — attaches to a browser in EITHER of the two modes it
# can be in. Ported from kattakath/nix-config's modules/shared/mcp.nix (the
# `nix-mcp-chrome-devtools` wrapper) for the MCP ownership split, #657 batch 2.
#
# WHY A SCRIPT AND NOT A PLAIN `.mcp.json` ENTRY — this is the whole point, do not
# "simplify" it away. No single upstream flag attaches in both modes:
#
#   --browser-url   needs /json/version to answer. A consent-mode browser 404s every
#                   /json/* route, so this fails there.
#   --autoConnect   trusts the profile's DevToolsActivePort file. A browser started
#                   with an explicit --remote-debugging-port does not necessarily have
#                   a current one, so this fails there.
#
# A `.mcp.json` has no conditionals, so the naive single-flag form silently LOSES one
# mode. That is a capability regression, not a simplification.
#
# Probe order: try the HTTP endpoint first (cheap, definitive), fall back to
# autoConnect. Line 1 of DevToolsActivePort is the port the browser actually bound and
# is trustworthy even when line 2 (a cached UUID) is stale — Opera does not always
# refresh it.
#
# Configuration is by environment, because a plugin file cannot carry a /nix/store
# path and must stay machine-agnostic. Defaults match the fleet's live values.
set -eu

port="${CDP_PORT:-9222}"
dir="${CDP_USER_DATA_DIR:-$HOME/Library/Application Support/Chromium}"
active="$dir/DevToolsActivePort"

# --categoryExtensions is OFF unless asked for: it widens the tool surface onto
# extension pages, so it is opt-in rather than inherited.
ext=""
case "${CDP_CATEGORY_EXTENSIONS:-0}" in
  1 | true | yes) ext="--categoryExtensions" ;;
esac

# --no-performance-crux is load-bearing, not cosmetic: without it, traced URLs are
# sent to Google. Keep both telemetry flags.
#
# Prepended rather than assigned with `set --`, so any argument the caller passes is
# still forwarded instead of being silently dropped. The plugin passes none today; a
# launcher that discards argv is a trap for whoever adds one later.
set -- --no-usage-statistics --no-performance-crux "$@"

ports="$port"
if [ -r "$active" ]; then
  recorded="$(sed -n 1p "$active" 2>/dev/null | tr -d '[:space:]')"
  case "$recorded" in
    '' | *[!0-9]*) ;;
    "$port") ;;
    *) ports="$ports $recorded" ;;
  esac
fi

for p in $ports; do
  if /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:$p/json/version" >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    exec npx -y chrome-devtools-mcp@latest --browser-url="http://127.0.0.1:$p" $ext "$@"
  fi
done

# shellcheck disable=SC2086
exec npx -y chrome-devtools-mcp@latest --autoConnect --userDataDir="$dir" $ext "$@"
