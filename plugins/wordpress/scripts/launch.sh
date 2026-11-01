#!/bin/sh
# wordpress launcher: start the wordpress MCP server the operator NAMED, never a built-in default.
# The command comes from the `launcher` setting, else $WORDPRESS_MCP_COMMAND. This marketplace
# ships no binary, so a default would only work on one fleet.
set -eu
cmd=${WP_LAUNCHER:-${WORDPRESS_MCP_COMMAND:-}}
if [ -z "$cmd" ]; then
  printf 'wordpress: no wordpress MCP launcher. Set the launcher setting (/plugin configure wordpress) or export WORDPRESS_MCP_COMMAND. It must start a stdio WordPress MCP server that finds its own site URL and credentials.\n' >&2
  exit 1
fi
unset WP_LAUNCHER
set -f
# shellcheck disable=SC2086 # word-splitting the launcher string is the documented contract
exec $cmd "$@"
