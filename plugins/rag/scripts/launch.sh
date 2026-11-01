#!/bin/sh
# rag launcher: start the postgres MCP server the operator NAMED, never a built-in default.
# The command comes from the `launcher` setting, else $RAG_POSTGRES_COMMAND. This marketplace
# ships no binary, so a default would only work on one fleet.
set -eu
cmd=${RAG_LAUNCHER:-${RAG_POSTGRES_COMMAND:-}}
if [ -z "$cmd" ]; then
  printf 'rag: no postgres MCP launcher. Set the launcher setting (/plugin configure rag) or export RAG_POSTGRES_COMMAND. It must start a stdio Postgres MCP server already pointed at your RAG database.\n' >&2
  exit 1
fi
unset RAG_LAUNCHER
set -f
# shellcheck disable=SC2086 # word-splitting the launcher string is the documented contract
exec $cmd "$@"
