A portable MCP client-config catalog: the plain `mcpServers` shape every MCP server's own
README shows for `.mcp.json` / `claude_desktop_config.json` — "paste this into your client."

This is a different artifact from `mcp/`: that directory holds one `server.json` per the MCP
Registry's publish schema (a *declaration* standard, no config shape at all). This one is the
*client* shape — what actually launches a server, with placeholders standing in for whatever a
given host would supply.

## Contract

- Every `env` value is a placeholder (`${VAR_NAME}`), never a real secret, a Keychain hint, or
  anything host-specific. A consumer substitutes its own secret-management story on read.
- No knowledge of any particular harness (Nix, agenix, a specific fleet) belongs in this file.
  Where a consumer's actual shape diverges — per-account fan-out, an OAuth-bridging wrapper
  around a remote server, a store path — that divergence stays on the consumer's side.
- `catalog.mcp.json` is data, not code: adding or updating an entry is a plain edit, validated
  by nothing more than being well-formed JSON.

## Consumers

`nix-config`'s MCP gateway reads this file as its declarative data source (the "adapter"
pattern: this repo owns the portable shape, nix-config owns the harness and secrets).
