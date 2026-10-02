#!/bin/sh
# @modelcontextprotocol/server-memory launcher — the ONLY thing it adds over a plain
# `.mcp.json` entry is MEMORY_FILE_PATH, and that one line is why the script exists.
# Do not "simplify" it back to a bare npx entry.
#
# MEASURED 2026-10-02 with no MEMORY_FILE_PATH set, running the server through npx and
# calling create_entities once, then grepping for the marker:
#
#   ~/.npm/_npx/15b07286cbcc3329/node_modules/@modelcontextprotocol/server-memory/dist/memory.jsonl
#
# The graph lands INSIDE the installed package directory, in the npx cache. That is not
# storage, it is a scratch dir that happens to persist: `npm cache clean` wipes it, and
# npx reinstalling the package over that path replaces `dist/` and takes the graph with
# it. A knowledge graph whose whole value is surviving between sessions cannot live
# there, and the loss would be silent — the server starts fine and simply reports an
# empty graph.
#
# XDG, not a hardcoded path: $XDG_DATA_HOME when the session has one, else the spec's
# own default. The shell does the expansion, so this works regardless of whether a
# plugin `.mcp.json` would have expanded `${HOME}` in an `env` value.
set -eu

data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/mcp-memory"
mkdir -p "$data_dir"

MEMORY_FILE_PATH="${MEMORY_FILE_PATH:-$data_dir/graph.jsonl}"
export MEMORY_FILE_PATH

exec npx -y @modelcontextprotocol/server-memory "$@"
