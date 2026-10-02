# mcp-utilities

The four **keyless, domain-free** MCP servers the fleet gateway carried until it was
purged on 2026-10-02. Nothing here needs an account, a token or a Keychain read.

| server | what it does | tools | spawn |
|---|---|---|---|
| `memory` | persistent knowledge graph (entities, relations, observations) | 9 | plugin script → `npx` |
| `sequential-thinking` | a step-by-step reasoning scaffold | 1 | bare `npx` |
| `terraform` | Terraform Registry provider / module / policy docs | 9 | `terraform-mcp-server` on PATH |
| `mcpfinder` | cross-registry MCP **server discovery** | 4 | `nix-mcp-mcpfinder` on PATH |

Tool counts are measured, not estimated — `tools/list` against each server, 2026-10-02.

## Why one plugin and not four

Granularity is not free: the plugin name appears in **every** tool name
(`mcp__plugin_mcp-utilities_terraform__search_providers`), and an enabled plugin loads
all of its servers together. So the question is only ever *"are these enabled
together?"*, and for these four the answer is measured rather than guessed — all four ran
simultaneously on the gateway, in one `fleet.publicMcpServers` roster, for months. There
is no observed session that wanted `memory` but not `terraform`.

Four plugins would also have produced `mcp__plugin_memory_memory__read_graph` — the
plugin name stuttering against the server name — for no gain.

## Two servers need a companion on PATH

A plugin's `.mcp.json` can only name a **bare command**; it cannot carry a `/nix/store`
path, which rotates on every rebuild. So the two servers that are not a plain `npx`
fetch name a binary that **`kattakath/nix-config` installs**, the same arrangement
`claude-code-nix` has with `mcp-nixos` and `gmail` has with its launchers:

| command | comes from | already on PATH? |
|---|---|---|
| `terraform-mcp-server` | nixpkgs 1.3.0, via `modules/shared/home.nix` | **yes** — added there ahead of this move |
| `nix-mcp-mcpfinder` | `packages/mcpfinder-mcp.nix`, via `modules/shared/home.nix` | **no** — needs the paired nix-config PR |

Without its command on PATH a server simply fails to start. Nothing in this repo can fix
that.

### Why `mcpfinder` cannot be a bare `npx` entry

This was tried, in #43, and reverted in #44. Re-measured **2026-10-02**, unchanged:

```
$ npx -y @mcpfinder/server@1.1.0
Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
Node.js v20.20.2
```

`node:sqlite` arrived in Node 22.5. The fleet's default Node is **20.x**, so the Node a
plugin's bare `npx` resolves to can never satisfy this package. Under the pinned
`nodejs-24.20.0` the same spec starts and lists its four tools — so the launcher exists
only to put that Node in front of `npx`, which is exactly what nix-config's `resend`
wrapper already does for a different npm CLI.

The `@1.1.0` pin is a **security control**, not a tidiness pin: a later release could
reintroduce `add_mcp_server_config`, which writes client config files imperatively — the
one thing this fleet's whole adoption model exists to avoid. #44 rejected "just unpin
it" on exactly that ground, and so does this.

In #44 the answer was "it stays on the gateway". There is no gateway now, so the choice
became *pinned launcher* or *dark capability*. A wrapper doing `fnm exec --using=22` was
rejected again for the reason #44 gave: it needs that Node installed in fnm on every
machine, which reintroduces the machine-bound coupling the move exists to remove.

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

## Known rough edges, recorded not hidden

- **`terraform` logs a TFE error at startup.** `NewSessionHandler failed to create TFE
  client … credentials.tfrc.json: no such file` on stderr, then
  `Session has no valid TFE client - TFE tools will not be available`. That is the
  no-credentials path working as intended: the nine **registry** tools load, the private
  HCP/Terraform-Enterprise ones stay absent. Supplying a token is out of scope here.
- **`mcpfinder` logs a Glama 401.** One of its three upstream registries wants an API
  key; search still answers from the Official MCP Registry and Smithery.
- **Claude Desktop loads no plugins.** The portal that used to serve these four also
  served Desktop. Desktop therefore loses all four and this plugin cannot give them back.
- **nix-config's allow-rules are keyed to the old names.** `.claude/settings.json` there
  still pre-approves `mcp__plugin_hm_kattakath-portal__memory_*` and names `mcpfinder`'s
  four read-only tools under that dead prefix. Until they are re-spelled these servers
  prompt on every call — fail-safe, but noisy. Handled in the paired nix-config PR.
