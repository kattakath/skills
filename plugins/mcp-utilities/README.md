# mcp-utilities

Two **keyless, account-free** MCP servers, both pinned. Nothing here needs a token, a
Keychain read or a companion binary.

| server | what it does | tools | spawn |
|---|---|---|---|
| `memory` | persistent knowledge graph (entities, relations, observations) | 9 | plugin script → `npx @modelcontextprotocol/server-memory@2.0.1` |
| `sequential-thinking` | a step-by-step reasoning scaffold | 1 | `npx @modelcontextprotocol/server-sequential-thinking@2.0.0` |

Tool counts are measured with `tools/list` (memory re-measured 2026-11-01 on 2.0.1).

## Why `terraform` and `mcpfinder` left (2026-11-01)

Both named a binary that only `kattakath/nix-config` puts on PATH (`terraform-mcp-server`,
`nix-mcp-mcpfinder`), so for anyone else they never started. `mcpfinder` cannot be a
plain `npx` entry: it needs Node ≥ 22.5 for `node:sqlite`, and its `@1.1.0` pin was a
security control against a later `add_mcp_server_config`. Nobody enabled this plugin on
the fleet either. Registry search now goes through the web, per `capability-broker`.

## `memory` gets a script, and that is deliberate

Run as a plain `npx` entry, the server puts its graph **inside the installed package
directory**. Measured 2026-10-02 by writing one entity and grepping for it:

```
~/.npm/_npx/15b07286cbcc3329/node_modules/@modelcontextprotocol/server-memory/dist/memory.jsonl
```

That is a cache, not storage. `npm cache clean` wipes it, and npx reinstalling the
package over that path replaces `dist/` and takes the graph with it. For a server whose
entire value is surviving between sessions that is a silent total loss — it starts
cleanly afterwards and just reports an empty graph.

`scripts/memory-server.sh` exports `MEMORY_FILE_PATH` before exec'ing the same upstream
package, so the graph lands at:

```
${XDG_DATA_HOME:-$HOME/.local/share}/mcp-memory/graph.jsonl
```

Verified end to end: `create_entities` through the wrapper, then the entity read back out
of that file. The shell does the `$HOME` expansion, so this does not depend on whether a
plugin `.mcp.json` expands `${HOME}` inside an `env` value.

Set `MEMORY_FILE_PATH` yourself to override it; the script honours an existing value.
